import type { CommitConformanceSubject } from "@worlds/sdk/testing";
import type { SearchIndexOnImport } from "@worlds/sdk/search-index";
import type { EmbeddingService } from "@worlds/sdk/search-index/embedding-service";
import { buildPostgresSchemaSql } from "@/postgres/schema/postgres-schema-builder.ts";
import { PostgresRdfjsStore } from "@/postgres/rdfjs-store/postgres-rdfjs-store.ts";
import { PostgresSearchIndex } from "@/postgres/search-index/postgres-search-index.ts";
import { createPGliteSql } from "@/postgres/sql/pglite-adapter.ts";
import type { PostgresSql } from "@/postgres/sql/postgres-sql.ts";

/** The vector width the shared conformance suite's embedding service returns. */
export const CONFORMANCE_VECTOR_DIMENSIONS = 32;

/**
 * FailOnceSql wraps a PostgresSql so a test can make the next transaction fail
 * after its statements ran but before it commits, which proves the rollback.
 * It also counts full search-index rebuilds: a transaction that clears the
 * whole chunks table without wiping the quads (a replace import wipes both).
 */
export class FailOnceSql implements PostgresSql {
  private failNext = false;
  private failLater = false;

  /**
   * lastLaterFailure is the statements the most recent `failLaterWrite`
   * transaction ran, in order, ending with the statement that was made to fail.
   * A test reads it to prove the failure followed the quad writes.
   */
  public lastLaterFailure: string[] = [];

  /** rebuilds is how many transactions cleared the chunks table alone. */
  public rebuilds = 0;

  public constructor(private readonly inner: PostgresSql) {}

  /** failNextTransaction arms one failure for the next `begin`. */
  public failNextTransaction(): void {
    this.failNext = true;
  }

  /**
   * failLaterWriteInNextTransaction arms one failure for the next `begin`: it
   * throws on the first chunk-row write that follows a quad insert, so the quad
   * writes have already run inside the open transaction.
   */
  public failLaterWriteInNextTransaction(): void {
    this.failLater = true;
  }

  public unsafe<T>(query: string, params?: unknown[]): Promise<T[]> {
    return this.inner.unsafe<T>(query, params);
  }

  public begin<T>(
    fn: (tx: {
      unsafe<T2>(query: string, params?: unknown[]): Promise<T2[]>;
    }) => Promise<T>,
  ): Promise<T> {
    return this.inner.begin(async (tx) => {
      const run: string[] = [];
      const armedLater = this.failLater;
      this.failLater = false;
      const result = await fn({
        unsafe: (query, params) => {
          run.push(query);
          if (
            armedLater &&
            query.startsWith("INSERT INTO worlds_search_chunks") &&
            run.some((q) => q.startsWith("INSERT INTO worlds_quads"))
          ) {
            this.lastLaterFailure = [...run];
            return Promise.reject(new Error("injected later write failure"));
          }
          return tx.unsafe(query, params);
        },
      });
      if (
        run.includes("DELETE FROM worlds_search_chunks") &&
        !run.includes("DELETE FROM worlds_quads")
      )
        this.rebuilds++;
      if (this.failNext) {
        this.failNext = false;
        throw new Error("injected write failure");
      }
      return result;
    });
  }

  public end(): Promise<void> {
    return this.inner.end();
  }
}

/** PostgresCommitHarness is a fresh in-memory Postgres wired for the suite. */
export interface PostgresCommitHarness {
  sql: FailOnceSql;
  store: PostgresRdfjsStore;
  index: PostgresSearchIndex;
  subject: CommitConformanceSubject;
  close: () => Promise<void>;
}

/**
 * createPostgresCommitHarness builds a PGlite database with the quads and
 * search chunks tables and returns the pieces plus the suite's subject. The
 * subject's `commit` is Postgres's real durable commit, `applyPatch`: the shared
 * SQL commit core in one SQL transaction, projecting chunks at commit.
 */
export async function createPostgresCommitHarness(
  embeddingService: EmbeddingService,
  searchIndexOnImport?: SearchIndexOnImport,
): Promise<PostgresCommitHarness> {
  const pglite = await createPGliteSql({
    schemaSql: buildPostgresSchemaSql({
      vectorDimension: CONFORMANCE_VECTOR_DIMENSIONS,
    }),
  });
  const sql = new FailOnceSql(pglite);
  const store = new PostgresRdfjsStore({
    sql,
    search: {
      embeddingService,
      vectorDimensions: CONFORMANCE_VECTOR_DIMENSIONS,
      searchIndexOnImport,
    },
  });
  await store.ensureSchema();
  const index = new PostgresSearchIndex({
    sql,
    embeddingService,
    vectorDimensions: CONFORMANCE_VECTOR_DIMENSIONS,
  });
  const subject: CommitConformanceSubject = {
    commit: (patch, context) => store.applyPatch(patch, context),
    storedQuads: () => store.getQuads(),
    chunkedQuadIds: async () => {
      const rows = await sql.unsafe<{ id: string }>(
        "SELECT id FROM worlds_search_chunks",
      );
      return rows.map((row) => row.id.split("#")[0]!);
    },
    failNextWrite: () => sql.failNextTransaction(),
    failLaterWrite: () => sql.failLaterWriteInNextTransaction(),
    fullRebuildCount: () => sql.rebuilds,
  };
  return { sql, store, index, subject, close: () => sql.end() };
}
