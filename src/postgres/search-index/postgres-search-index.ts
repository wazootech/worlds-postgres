import type {
  ReindexRequest,
  ReindexResponse,
  SearchIndexInterface,
  SearchRequest,
  SearchResponse,
  SearchResult,
} from "@worlds/sdk/search-index";
import { buildSearchResultId } from "@worlds/sdk/search-index";
import type { EmbeddingService } from "@worlds/sdk/search-index/embedding-service";
import type { QuadFilter } from "@worlds/sdk/quad-store";
import { isTextualLiteral } from "@worlds/sdk/quad-store";
import {
  fromQuadRow,
  type QuadRow,
} from "@/postgres/rdfjs-store/quad-record.ts";
import { quoteFtsLanguage } from "@/postgres/schema/postgres-schema-builder.ts";
import type { PostgresSql } from "@/postgres/sql/postgres-sql.ts";

const XSD_STRING = "http://www.w3.org/2001/XMLSchema#string";
const RDF_LANGSTRING = "http://www.w3.org/1999/02/22-rdf-syntax-ns#langString";

/** Default vector dimension for the search chunks table (matches the schema). */
const DEFAULT_VECTOR_DIMENSION = 1536;

/** Maximum supported vector dimension (matches the schema builder's default cap). */
const MAX_VECTOR_DIMENSION = 1536;

/** Default search result limit for the hybrid path (mirrors @worlds/libsql). */
const DEFAULT_HYBRID_TOP_K = 100;

/** RRF rank-offset constant, consistent with @worlds/libsql's 1/(60 + rank). */
const RRF_K = 60;

/**
 * PostgresSearchIndexOptions defines configuration options for PostgresSearchIndex.
 */
export interface PostgresSearchIndexOptions {
  sql: PostgresSql;
  tableName?: string;
  quadsTableName?: string;
  searchChunksTableName?: string;

  /**
   * embeddingService optionally projects text into dense vectors. When set,
   * search() runs hybrid RRF fusion (keyword FTS + vector cosine over the
   * reindexed chunks table) and reindex() populates the chunk `embedding`
   * column. When unset, search() keeps the reference's exact keyword scan
   * over the live quads table and reindex() writes text-only chunk rows.
   */
  embeddingService?: EmbeddingService;

  /**
   * vectorDimensions pins the chunk embedding width and, when set, is used
   * to validate every embedding produced by embeddingService (and to size
   * the chunks table created by ensureSchema). Defaults to the schema
   * default of 1536; when omitted, dimension mismatches surface as Postgres
   * errors instead of being checked up front.
   */
  vectorDimensions?: number;

  /**
   * ftsLanguage is the regconfig used for the chunks table's generated
   * tsvector and the hybrid keyword branch's plainto_tsquery (default
   * "english"). Must match the language the chunks table was created with.
   */
  ftsLanguage?: string;
}

/** HybridChunkRow is one fused search row from the chunks table. */
interface HybridChunkRow {
  subject: string;
  predicate: string;
  graph: string;
  text: string;
  combined_rank: string | number;
}

/**
 * PostgresSearchIndex is a PostgreSQL-backed search index satisfying
 * SearchIndexInterface.
 *
 * Two search modes:
 *
 * - Keyword-only (no embeddingService): mirrors the reference
 *   `RdfjsSearchIndex` semantics exactly (object-text-only matching per the
 *   worlds-libsql#22 contract, case-insensitive substring, textual-literal
 *   filter, QuadFilter graph scoping) as a SQL scan over the live quads
 *   table — so keyword parity is a property of the backend, not of shared
 *   JS. All matches are returned with score 1.0 (no topK cut), like the
 *   reference.
 *
 * - Hybrid (embeddingService set): Reciprocal Rank Fusion over the
 *   reindexed chunks table, consistent with @worlds/libsql — a keyword
 *   branch (`tsv @@ plainto_tsquery(ftsLanguage, ...)` ranked with
 *   `ts_rank_cd`) and a vector branch (`embedding <=> query_embedding`
 *   cosine, LIMIT topK), each ranked 1..topK and fused as
 *   `1/(60 + rank)` summed. A query-time embedding failure degrades to the
 *   keyword branch alone; an empty query runs the vector branch alone.
 */
export class PostgresSearchIndex implements SearchIndexInterface {
  private readonly sql: PostgresSql;
  private readonly tableName: string;
  private readonly chunksTableName: string;
  private readonly embeddingService?: EmbeddingService;
  private readonly vectorDimensions: number;
  private readonly ftsLanguage: string;

  constructor(options: PostgresSearchIndexOptions) {
    this.sql = options.sql;
    this.tableName = options.quadsTableName ?? "worlds_quads";
    this.chunksTableName = options.searchChunksTableName ??
      "worlds_search_chunks";
    this.embeddingService = options.embeddingService;
    this.vectorDimensions = options.vectorDimensions ??
      DEFAULT_VECTOR_DIMENSION;
    this.ftsLanguage = options.ftsLanguage ?? "english";
    // Validate eagerly so a typo surfaces at construction, not at query time.
    quoteFtsLanguage(this.ftsLanguage);
    if (
      !Number.isInteger(this.vectorDimensions) ||
      this.vectorDimensions < 1 ||
      this.vectorDimensions > MAX_VECTOR_DIMENSION
    ) {
      throw new Error(
        `vectorDimensions must be a finite integer in [1, ${MAX_VECTOR_DIMENSION}], ` +
          `received: ${String(this.vectorDimensions)}`,
      );
    }
  }

  /**
   * Performs keyword search across PostgreSQL quads with the reference's
   * exact matching semantics: textual literals only (xsd:string and
   * rdf:langString), case-insensitive substring on the object text,
   * QuadFilter scoping, and result ids derived the same way as the
   * reference. Like the reference, all matches are returned (no topK cut).
   *
   * When an embeddingService is configured, search() instead returns fused
   * hybrid results over the reindexed chunks table (see hybridSearch).
   */
  async search(request: SearchRequest): Promise<SearchResponse> {
    if (this.embeddingService) {
      return await this.hybridSearch(request);
    }
    return await this.keywordScanSearch(request);
  }

  /**
   * keywordScanSearch is the parity keyword path: a SQL scan over the live
   * quads table matching the reference's exact substring semantics.
   */
  private async keywordScanSearch(
    request: SearchRequest,
  ): Promise<SearchResponse> {
    const query = request.query;
    const where: string[] = [
      `payload->'o'->>'t' = 'L'`,
      `payload->'o'->>'dt' IN ($1, $2)`,
    ];
    const params: string[] = [XSD_STRING, RDF_LANGSTRING];
    const bind = (value: string): string => {
      params.push(value);
      return `$${params.length}`;
    };

    // Case-insensitive substring, escaping LIKE wildcards so the query is
    // treated literally (matching the reference's String.includes).
    const escaped = query.replaceAll("\\", "\\\\").replaceAll("%", "\\%")
      .replaceAll("_", "\\_");
    where.push(
      `lower(payload->'o'->>'v') LIKE '%' || lower(${
        bind(escaped)
      }) || '%' ESCAPE '\\'`,
    );

    const scoping = this.filterSql(bind, request.include, request.exclude);
    where.push(...scoping.where);

    const sqlText = `SELECT payload FROM ${this.tableName}` +
      ` WHERE ${where.join(" AND ")}`;
    const rows = await this.sql.unsafe<{ payload: string }>(sqlText, params);

    const results: SearchResult[] = [];
    for (const row of rows) {
      const quad = fromQuadRow({ payload: row.payload });
      const text = quad.object.value;
      const base = {
        subject: quad.subject.value,
        predicate: quad.predicate.value,
        graph: quad.graph.value,
        text,
      };
      results.push({
        id: await buildSearchResultId(base),
        ...base,
        score: 1.0,
      });
    }
    return { results };
  }

  /**
   * hybridSearch fuses a tsvector keyword branch and a pgvector cosine
   * branch over the reindexed chunks table with Reciprocal Rank Fusion
   * (`1/(60 + rank)` summed), consistent with @worlds/libsql. An embedding
   * failure degrades to the keyword branch alone; an empty query runs the
   * vector branch alone. Requires the chunks table (see ensureSchema).
   */
  private async hybridSearch(request: SearchRequest): Promise<SearchResponse> {
    let vectorJson: string | undefined;
    if (this.embeddingService) {
      try {
        const [vector] = await this.embeddingService.embed([request.query]);
        if (vector.length !== this.vectorDimensions) {
          throw new Error(
            `query embedding length ${vector.length} does not match ` +
              `vectorDimensions ${this.vectorDimensions}`,
          );
        }
        vectorJson = JSON.stringify(Array.from(vector));
      } catch (error) {
        // Gracefully degrade to keyword-only search if the embedding
        // service fails, mirroring @worlds/libsql.
        console.warn(
          `[Search Warning] Embedding service failure. Degrading to ` +
            `keyword-only search fallback. Reason: ${(error as Error).message}`,
        );
      }
    }

    const { sql, params } = this.buildHybridQuery(request, { vectorJson });
    const rows = await this.sql.unsafe<HybridChunkRow>(sql, params);

    const minScore = request.minScore ?? 0;
    const results: SearchResult[] = [];
    for (const row of rows) {
      const score = Number(row.combined_rank);
      if (score < minScore) continue;
      const base = {
        subject: row.subject,
        predicate: row.predicate,
        graph: row.graph,
        text: row.text,
      };
      results.push({
        id: await buildSearchResultId(base),
        ...base,
        score,
      });
    }
    return { results };
  }

  /**
   * buildHybridQuery assembles the RRF fusion SQL over the chunks table,
   * mirroring @worlds/libsql's buildSearchQuery structure: ranked keyword
   * matches, ranked vector neighbors, a FULL OUTER JOIN fused by chunk id,
   * QuadFilter scoping on the chunk columns, and a final topK cut.
   */
  private buildHybridQuery(
    request: SearchRequest,
    options: { vectorJson?: string },
  ): { sql: string; params: unknown[] } {
    const params: unknown[] = [];
    const bind = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    const limit = Math.max(1, Math.floor(request.topK ?? DEFAULT_HYBRID_TOP_K));
    const hasKeyword = request.query.trim().length > 0;
    const hasVector = !!options.vectorJson;

    const scoping = this.chunkFilterSql(bind, request.include, request.exclude);
    const filterClause = scoping.where.length > 0
      ? `WHERE ${scoping.where.join(" AND ")}`
      : "";

    if (hasVector && hasKeyword) {
      const langParam = bind(this.ftsLanguage);
      const queryParam = bind(request.query);
      const ftsLimit = bind(limit);
      const vecParam = bind(options.vectorJson);
      const vecLimit = bind(limit);
      const finalLimit = bind(limit);
      const sql = `
        WITH fts_matches AS (
          SELECT id,
            row_number() OVER (
              ORDER BY ts_rank_cd(tsv, plainto_tsquery(${langParam}::regconfig, ${queryParam})) DESC
            ) AS rank_number
          FROM ${this.chunksTableName}
          WHERE tsv @@ plainto_tsquery(${langParam}::regconfig, ${queryParam})
          LIMIT ${ftsLimit}
        ), vec_matches AS (
          SELECT id,
            row_number() OVER (ORDER BY embedding <=> ${vecParam}::vector) AS rank_number
          FROM ${this.chunksTableName}
          ORDER BY embedding <=> ${vecParam}::vector
          LIMIT ${vecLimit}
        ), fused AS (
          SELECT c.subject, c.predicate, c.graph, c.text,
            (COALESCE(1.0 / (${RRF_K} + fts_matches.rank_number), 0.0) +
             COALESCE(1.0 / (${RRF_K} + vec_matches.rank_number), 0.0)) AS combined_rank
          FROM fts_matches
          FULL OUTER JOIN vec_matches ON vec_matches.id = fts_matches.id
          JOIN ${this.chunksTableName} c ON c.id = COALESCE(fts_matches.id, vec_matches.id)
          ${filterClause}
          ORDER BY combined_rank DESC
          LIMIT ${finalLimit}
        )
        SELECT * FROM fused`;
      return { sql, params };
    }

    if (hasVector) {
      const vecParam = bind(options.vectorJson);
      const vecLimit = bind(limit);
      const finalLimit = bind(limit);
      const sql = `
        WITH vec_matches AS (
          SELECT id,
            row_number() OVER (ORDER BY embedding <=> ${vecParam}::vector) AS rank_number
          FROM ${this.chunksTableName}
          ORDER BY embedding <=> ${vecParam}::vector
          LIMIT ${vecLimit}
        ), fused AS (
          SELECT c.subject, c.predicate, c.graph, c.text,
            COALESCE(1.0 / (${RRF_K} + vec_matches.rank_number), 0.0) AS combined_rank
          FROM vec_matches
          JOIN ${this.chunksTableName} c ON c.id = vec_matches.id
          ${filterClause}
          ORDER BY combined_rank DESC
          LIMIT ${finalLimit}
        )
        SELECT * FROM fused`;
      return { sql, params };
    }

    if (hasKeyword) {
      const langParam = bind(this.ftsLanguage);
      const queryParam = bind(request.query);
      const ftsLimit = bind(limit);
      const finalLimit = bind(limit);
      const sql = `
        WITH fts_matches AS (
          SELECT id,
            row_number() OVER (
              ORDER BY ts_rank_cd(tsv, plainto_tsquery(${langParam}::regconfig, ${queryParam})) DESC
            ) AS rank_number
          FROM ${this.chunksTableName}
          WHERE tsv @@ plainto_tsquery(${langParam}::regconfig, ${queryParam})
          LIMIT ${ftsLimit}
        ), fused AS (
          SELECT c.subject, c.predicate, c.graph, c.text,
            COALESCE(1.0 / (${RRF_K} + fts_matches.rank_number), 0.0) AS combined_rank
          FROM fts_matches
          JOIN ${this.chunksTableName} c ON c.id = fts_matches.id
          ${filterClause}
          ORDER BY combined_rank DESC
          LIMIT ${finalLimit}
        )
        SELECT * FROM fused`;
      return { sql, params };
    }

    return {
      sql: `SELECT NULL::text AS subject, NULL::text AS predicate, ` +
        `NULL::text AS graph, NULL::text AS text, 0::numeric AS combined_rank ` +
        `WHERE 1 = 0`,
      params: [],
    };
  }

  /**
   * filterSql translates a QuadFilter (include = AND, exclude = OR-reject)
   * into SQL over the payload's term records. Graph criteria treat the
   * default graph as the empty value, exactly like filterQuads.
   */
  private filterSql(
    bind: (value: string) => string,
    include?: QuadFilter["include"],
    exclude?: QuadFilter["exclude"],
  ): { where: string[] } {
    const where: string[] = [];
    const criteriaSql = (
      criteria: NonNullable<QuadFilter["include"]> | undefined,
    ): string[] => {
      const parts: string[] = [];
      const inJsonArray = (param: string): string =>
        `IN (SELECT jsonb_array_elements_text(${param}::jsonb))`;
      if (criteria?.subjects?.length) {
        parts.push(
          `payload->'s'->>'v' ${
            inJsonArray(bind(JSON.stringify(criteria.subjects)))
          }`,
        );
      }
      if (criteria?.predicates?.length) {
        parts.push(
          `payload->'p'->>'v' ${
            inJsonArray(bind(JSON.stringify(criteria.predicates)))
          }`,
        );
      }
      if (criteria?.graphs?.length) {
        const arrayParam = bind(JSON.stringify(criteria.graphs));
        parts.push(
          `((payload->'g'->>'t' = 'D' AND '' ${inJsonArray(arrayParam)}) ` +
            `OR (payload->'g'->>'t' = 'N' AND payload->'g'->>'v' ${
              inJsonArray(arrayParam)
            }))`,
        );
      }
      return parts;
    };
    const includeParts = criteriaSql(include);
    if (includeParts.length > 0) {
      where.push(`(${includeParts.join(" AND ")})`);
    }
    const excludeParts = criteriaSql(exclude);
    if (excludeParts.length > 0) {
      where.push(`NOT (${excludeParts.join(" OR ")})`);
    }
    return { where };
  }

  /**
   * chunkFilterSql translates a QuadFilter into column scoping over the
   * chunks table (subject/predicate/graph IN / NOT IN). The graph column
   * stores the quad's graph value directly — the empty string for the
   * default graph, matching filterQuads.
   */
  private chunkFilterSql(
    bind: (value: string) => string,
    include?: QuadFilter["include"],
    exclude?: QuadFilter["exclude"],
  ): { where: string[] } {
    const where: string[] = [];
    const criteriaSql = (
      criteria: NonNullable<QuadFilter["include"]> | undefined,
      negate: boolean,
    ): string[] => {
      const parts: string[] = [];
      const inList = (values: string[], column: string): string =>
        `${column} ${negate ? "NOT " : ""}IN (${values.map(bind).join(", ")})`;
      if (criteria?.subjects?.length) {
        parts.push(inList(criteria.subjects, "subject"));
      }
      if (criteria?.predicates?.length) {
        parts.push(inList(criteria.predicates, "predicate"));
      }
      if (criteria?.graphs?.length) {
        parts.push(inList(criteria.graphs, "graph"));
      }
      return parts;
    };
    const includeParts = criteriaSql(include, false);
    if (includeParts.length > 0) {
      where.push(`(${includeParts.join(" AND ")})`);
    }
    const excludeParts = criteriaSql(exclude, true);
    if (excludeParts.length > 0) {
      where.push(`(${excludeParts.join(" OR ")})`);
    }
    return { where };
  }

  /**
   * ensureSchema creates the search chunks table (pgvector embedding column,
   * generated tsvector in the configured ftsLanguage, HNSW cosine index, GIN
   * tsvector index) — idempotent. Called by createPostgresSdk when an
   * embedding service is configured; direct users must run it (or the shared
   * schema builder) before hybrid search or reindex.
   */
  public async ensureSchema(): Promise<void> {
    const dimension = this.vectorDimensions;
    const ftsLanguage = quoteFtsLanguage(this.ftsLanguage);
    await this.sql.unsafe(`CREATE EXTENSION IF NOT EXISTS vector`);
    await this.sql.unsafe(
      `CREATE TABLE IF NOT EXISTS ${this.chunksTableName} (` +
        "id TEXT PRIMARY KEY," +
        "graph TEXT NOT NULL," +
        "subject TEXT NOT NULL," +
        "predicate TEXT NOT NULL," +
        "text TEXT NOT NULL," +
        `embedding vector(${dimension}),` +
        `tsv tsvector GENERATED ALWAYS AS (to_tsvector(${ftsLanguage}, text)) STORED` +
        ")",
    );
    await this.sql.unsafe(
      `CREATE INDEX IF NOT EXISTS idx_${this.chunksTableName}_embedding ` +
        `ON ${this.chunksTableName} USING hnsw (embedding vector_cosine_ops)`,
    );
    await this.sql.unsafe(
      `CREATE INDEX IF NOT EXISTS idx_${this.chunksTableName}_tsv ` +
        `ON ${this.chunksTableName} USING gin (tsv)`,
    );
  }

  /**
   * Rebuilds the search chunk table from durable quads in PostgreSQL —
   * the vector/hybrid seam (embedding + tsvector per chunk). Paginates
   * every quad with keyset paging over the ordered key columns (no quads
   * skipped or duplicated across pages) and, when an embedding service is
   * configured, populates each textual chunk's `embedding` column. Keyword
   * search does not depend on this projection (it scans the live quads
   * table), so reindex is optional for keyword parity.
   */
  async reindex(request?: ReindexRequest): Promise<ReindexResponse> {
    const pageSize = Math.max(1, Math.floor(request?.readPageSize ?? 1000));
    let processedQuadCount = 0;
    let chunkRowCount = 0;
    let cursor: readonly [string, string, string, string] | null = null;

    for (;;) {
      const params: unknown[] = [];
      const bind = (value: string): string => {
        params.push(value);
        return `$${params.length}`;
      };

      const scoping = this.filterSql(
        bind,
        request?.include,
        request?.exclude,
      );
      const where = [...scoping.where];
      if (cursor) {
        params.push(...cursor);
        const offset = params.length;
        where.push(
          `(skey, pkey, okey, gkey) > ($${offset - 3}, $${offset - 2}, ` +
            `$${offset - 1}, $${offset})`,
        );
      }
      params.push(pageSize);
      const sqlText =
        `SELECT skey, pkey, okey, gkey, payload FROM ${this.tableName}` +
        (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
        ` ORDER BY skey, pkey, okey, gkey LIMIT $${params.length}`;
      const rows = await this.sql.unsafe<QuadRow>(sqlText, params);

      if (rows.length === 0) {
        break;
      }

      const quads = rows.map((row) => fromQuadRow(row));
      processedQuadCount += quads.length;

      const textualQuads = quads.filter((quad) =>
        isTextualLiteral(quad.object)
      );
      let vectors: Array<Float32Array | number[]> | undefined;
      if (this.embeddingService && textualQuads.length > 0) {
        vectors = await this.embeddingService.embed(
          textualQuads.map((quad) => quad.object.value),
        );
        for (const vector of vectors) {
          if (vector.length !== this.vectorDimensions) {
            throw new Error(
              `embedding length ${vector.length} does not match ` +
                `vectorDimensions ${this.vectorDimensions}`,
            );
          }
        }
      }

      for (let i = 0; i < textualQuads.length; i++) {
        const quad = textualQuads[i]!;
        const id = [
          quad.subject.value,
          quad.predicate.value,
          quad.object.value,
        ].join(":");
        const embedding = vectors?.[i];
        await this.sql.unsafe(
          `INSERT INTO ${this.chunksTableName} ` +
            "(id, graph, subject, predicate, text, embedding) " +
            "VALUES ($1, $2, $3, $4, $5, $6::vector) " +
            "ON CONFLICT (id) DO UPDATE SET " +
            "text = EXCLUDED.text, embedding = EXCLUDED.embedding",
          [
            id,
            quad.graph.value,
            quad.subject.value,
            quad.predicate.value,
            quad.object.value,
            embedding ? JSON.stringify(Array.from(embedding)) : null,
          ],
        );
        chunkRowCount++;
      }

      if (rows.length < pageSize) {
        break;
      }
      const last = rows[rows.length - 1]!;
      cursor = [last.skey, last.pkey, last.okey, last.gkey];
    }

    return {
      processedQuadCount,
      chunkRowCount,
    };
  }
}
