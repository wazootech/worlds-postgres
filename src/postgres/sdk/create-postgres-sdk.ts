import type { SparqlEngineInterface } from "@wazoo/sparql-engine";
import { WazooSparqlEngine } from "@wazoo/sparql-engine";
import { Sdk, type SdkInterface } from "@worlds/sdk";
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
    searchIndex: new PostgresSearchIndex({
      sql: options.sql,
      quadsTableName: options.tableName,
      searchChunksTableName: options.searchChunksTableName,
    }),
  });
}
