import type {
  ReindexRequest,
  ReindexResponse,
  SearchIndexInterface,
  SearchRequest,
  SearchResponse,
} from "@worlds/sdk/search-index";
import type { EmbeddingService } from "@worlds/sdk/search-index/embedding-service";
import type { TextSplitterInterface } from "@worlds/sdk/search-index/quad-chunker";
import { quoteFtsLanguage } from "@/postgres/schema/postgres-schema-builder.ts";
import type { PostgresSql } from "@/postgres/sql/postgres-sql.ts";
import { ensureSearchChunksTable } from "./postgres-search-chunks-ddl.ts";
import { hybridSearch, keywordScanSearch } from "./postgres-search-queries.ts";
import { reindexChunks } from "./postgres-search-reindex.ts";
import type { PostgresSearchContext } from "./postgres-search-types.ts";

/** Default vector dimension for the search chunks table (matches the schema). */
const DEFAULT_VECTOR_DIMENSION = 1536;

/** Maximum supported vector dimension (matches the schema builder's default cap). */
const MAX_VECTOR_DIMENSION = 1536;

/**
 * Identity splitter: one chunk per textual literal, preserving the original
 * reindex behavior when no textSplitter is configured. Pass a real splitter
 * (e.g. LangChain's RecursiveCharacterTextSplitter) to break long literals
 * into multiple chunk rows, consistent with @worlds/libsql.
 */
const IDENTITY_TEXT_SPLITTER: TextSplitterInterface = {
  createDocuments(texts, metadatas) {
    return Promise.resolve(
      texts.map((text, index) => ({
        pageContent: text,
        metadata: metadatas?.[index],
      })),
    );
  },
};

/**
 * PostgresSearchIndexOptions defines configuration options for PostgresSearchIndex.
 */
export interface PostgresSearchIndexOptions {
  sql: PostgresSql;
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

  /**
   * textSplitter slices long literal values into multiple chunk rows during
   * reindex() (each row embedded and FTS-indexed separately), consistent
   * with @worlds/libsql. Defaults to an identity splitter (one chunk per
   * textual literal, the original behavior).
   */
  textSplitter?: TextSplitterInterface;
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
  private readonly textSplitter: TextSplitterInterface;

  constructor(options: PostgresSearchIndexOptions) {
    this.sql = options.sql;
    this.tableName = options.quadsTableName ?? "worlds_quads";
    this.chunksTableName = options.searchChunksTableName ??
      "worlds_search_chunks";
    this.embeddingService = options.embeddingService;
    this.vectorDimensions = options.vectorDimensions ??
      DEFAULT_VECTOR_DIMENSION;
    this.ftsLanguage = options.ftsLanguage ?? "english";
    this.textSplitter = options.textSplitter ?? IDENTITY_TEXT_SPLITTER;
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

  /** context exposes the resolved settings to the extracted helpers. */
  private get context(): PostgresSearchContext {
    return {
      sql: this.sql,
      tableName: this.tableName,
      chunksTableName: this.chunksTableName,
      embeddingService: this.embeddingService,
      vectorDimensions: this.vectorDimensions,
      ftsLanguage: this.ftsLanguage,
      textSplitter: this.textSplitter,
    };
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
      return await hybridSearch(this.context, request);
    }
    return await keywordScanSearch(this.context, request);
  }

  /**
   * ensureSchema creates the search chunks table (pgvector embedding column,
   * generated tsvector in the configured ftsLanguage, HNSW cosine index, GIN
   * tsvector index) — idempotent. Called by createPostgresWorldsSdk when an
   * embedding service is configured; direct users must run it (or the shared
   * schema builder) before hybrid search or reindex.
   */
  public async ensureSchema(): Promise<void> {
    await ensureSearchChunksTable(this.context);
  }

  /**
   * Rebuilds the search chunk table from durable quads in PostgreSQL —
   * the vector/hybrid seam (embedding + tsvector per chunk). Paginates
   * every quad with keyset paging over the ordered key columns (no quads
   * skipped or duplicated across pages), splits textual literals into chunk
   * rows via the configured textSplitter (identity by default), and, when
   * an embedding service is configured, populates each chunk's `embedding`
   * column. Keyword search does not depend on this projection (it scans the
   * live quads table), so reindex is optional for keyword parity.
   */
  async reindex(request?: ReindexRequest): Promise<ReindexResponse> {
    return await reindexChunks(this.context, request);
  }
}
