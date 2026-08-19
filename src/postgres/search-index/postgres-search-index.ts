import type {
  ReindexRequest,
  ReindexResponse,
  SearchIndexInterface,
  SearchRequest,
  SearchResponse,
  SearchResult,
} from "@worlds/sdk/search-index";
import { buildSearchResultId } from "@worlds/sdk/search-index";
import type { QuadFilter } from "@worlds/sdk/quad-store";
import { fromQuadRow } from "@/postgres/rdfjs-store/quad-record.ts";
import type { PostgresSql } from "@/postgres/sql/postgres-sql.ts";

const XSD_STRING = "http://www.w3.org/2001/XMLSchema#string";
const RDF_LANGSTRING = "http://www.w3.org/1999/02/22-rdf-syntax-ns#langString";

/**
 * PostgresSearchIndexOptions defines configuration options for PostgresSearchIndex.
 */
export interface PostgresSearchIndexOptions {
  sql: PostgresSql;
  tableName?: string;
  quadsTableName?: string;
  searchChunksTableName?: string;
}

/**
 * PostgresSearchIndex is a PostgreSQL-backed search index satisfying
 * SearchIndexInterface.
 *
 * The keyword path mirrors the reference `RdfjsSearchIndex` semantics
 * exactly (object-text-only matching per the worlds-libsql#22 contract,
 * case-insensitive substring, textual-literal filter, QuadFilter graph
 * scoping) as a SQL scan over the live quads table — so keyword parity is a
 * property of the backend, not of shared JS. The `reindex` projection into
 * the chunks table (pgvector embedding + tsvector) remains the vector/hybrid
 * seam.
 */
export class PostgresSearchIndex implements SearchIndexInterface {
  private readonly sql: PostgresSql;
  private readonly tableName: string;
  private readonly chunksTableName: string;

  constructor(options: PostgresSearchIndexOptions) {
    this.sql = options.sql;
    this.tableName = options.quadsTableName ?? "worlds_quads";
    this.chunksTableName = options.searchChunksTableName ??
      "worlds_search_chunks";
  }

  /**
   * Performs keyword search across PostgreSQL quads with the reference's
   * exact matching semantics: textual literals only (xsd:string and
   * rdf:langString), case-insensitive substring on the object text,
   * QuadFilter scoping, and result ids derived the same way as the
   * reference. Like the reference, all matches are returned (no topK cut).
   */
  async search(request: SearchRequest): Promise<SearchResponse> {
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
   * Rebuilds the search chunk table from durable quads in PostgreSQL —
   * the vector/hybrid seam (embedding + tsvector per chunk). Keyword
   * search does not depend on this projection (it scans the live quads
   * table), so reindex is optional for keyword parity.
   */
  async reindex(request?: ReindexRequest): Promise<ReindexResponse> {
    const pageSize = request?.readPageSize ?? 1000;
    const rows = await this.sql.unsafe<{
      skey: string;
      pkey: string;
      okey: string;
      gkey: string;
      payload: string;
    }>(
      `SELECT skey, pkey, okey, gkey, payload FROM ${this.tableName} ` +
        `LIMIT $1`,
      [pageSize],
    );

    let chunkRowCount = 0;
    for (const row of rows) {
      const quad = fromQuadRow(row);
      const id = [quad.subject.value, quad.predicate.value, quad.object.value]
        .join(":");
      await this.sql.unsafe(
        `INSERT INTO ${this.chunksTableName} (id, graph, subject, predicate, text) ` +
          "VALUES ($1, $2, $3, $4, $5) " +
          "ON CONFLICT (id) DO UPDATE SET text = EXCLUDED.text",
        [
          id,
          quad.graph.value,
          quad.subject.value,
          quad.predicate.value,
          quad.object.value,
        ],
      );
      chunkRowCount++;
    }

    return {
      processedQuadCount: rows.length,
      chunkRowCount,
    };
  }
}
