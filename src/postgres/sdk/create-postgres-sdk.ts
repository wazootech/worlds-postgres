import type { SparqlEngineInterface } from "@wazoo/sparql-engine";
import { WazooSparqlEngine } from "@wazoo/sparql-engine";
import { Sdk, type SdkInterface } from "@worlds/sdk";
import type { EmbeddingService } from "@worlds/sdk/search-index/embedding-service";
import type { TextSplitterInterface } from "@worlds/sdk/search-index/quad-chunker";
import { PostgresQuadStore } from "@/postgres/quad-store/mod.ts";
import { PostgresSearchIndex } from "@/postgres/search-index/mod.ts";
import { PostgresRdfjsStore } from "@/postgres/rdfjs-store/mod.ts";
import type { PostgresSql } from "@/postgres/sql/postgres-sql.ts";

/**
 * PostgresSdkOptions configures createPostgresSdk.
 */
export interface PostgresSdkOptions {
  /** sql is the SQL surface (postgres.js Sql or the PGlite adapter). */
  sql: PostgresSql;

  /** Table name for quads (defaults to "worlds_quads"). */
  tableName?: string;

  /** Table name for search chunks (defaults to "worlds_search_chunks"). */
  searchChunksTableName?: string;

  /**
   * embeddingService enables hybrid RRF search. When set, the SDK ensures
   * the search chunks schema and search() fuses a tsvector keyword branch
   * with a pgvector cosine branch over reindexed chunks (1/(60 + rank)).
   */
  embeddingService?: EmbeddingService;

  /**
   * vectorDimensions pins the chunk embedding width (default 1536) and
   * validates every embedding produced by embeddingService.
   */
  vectorDimensions?: number;

  /**
   * ftsLanguage is the regconfig for the chunks table's generated tsvector
   * and hybrid keyword queries (default "english").
   */
  ftsLanguage?: string;

  /**
   * textSplitter slices long literal values into multiple chunk rows during
   * reindex() (defaults to one chunk per textual literal).
   */
  textSplitter?: TextSplitterInterface;

  /**
   * SPARQL engine to wire as the SDK's sparqlEngine. Defaults to a
   * WazooSparqlEngine over the store with its `createTransaction` hook, so
   * SPARQL updates commit atomically (one SQL transaction per update).
   */
  queryEngine?: SparqlEngineInterface;
}

/**
 * createPostgresSdk assembles a Worlds SDK facade over a PostgreSQL-backed
 * quad store: the dedicated PostgresQuadStore (imports persist through the
 * store's applyPatch, one SQL transaction per import), the dedicated
 * PostgresSearchIndex (SQL keyword scan with the reference's exact matching
 * semantics), and a WazooSparqlEngine wired through the store's
 * createTransaction hook. The quads table (and its secondary indexes) is
 * ensured on construction.
 */
export async function createPostgresSdk(
  options: PostgresSdkOptions,
): Promise<SdkInterface> {
  const store = new PostgresRdfjsStore({
    sql: options.sql,
    tableName: options.tableName,
  });
  await store.ensureSchema();
  const searchIndex = new PostgresSearchIndex({
    sql: options.sql,
    quadsTableName: options.tableName,
    searchChunksTableName: options.searchChunksTableName,
    embeddingService: options.embeddingService,
    vectorDimensions: options.vectorDimensions,
    ftsLanguage: options.ftsLanguage,
    textSplitter: options.textSplitter,
  });
  if (options.embeddingService) {
    await searchIndex.ensureSchema();
  }
  return new Sdk({
    quadStore: new PostgresQuadStore({
      sql: options.sql,
      tableName: options.tableName,
    }),
    sparqlEngine: options.queryEngine ??
      new WazooSparqlEngine({
        store,
        createTransaction: () => store.createTransaction(),
      }),
    searchIndex,
  });
}
