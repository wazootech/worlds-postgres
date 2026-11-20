import type { CommitConformanceSubject } from "@worlds/sdk/testing";
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
 */
export class FailOnceSql implements PostgresSql {
  private failNext = false;

  public constructor(private readonly inner: PostgresSql) {}

  /** failNextTransaction arms one failure for the next `begin`. */
  public failNextTransaction(): void {
    this.failNext = true;
  }

  public unsafe<T>(query: string, params?: unknown[]): Promise<T[]> {
    return this.inner.unsafe<T>(query, params);
  }

  public begin<T>(
    fn: (
      tx: { unsafe<T2>(query: string, params?: unknown[]): Promise<T2[]> },
    ) => Promise<T>,
  ): Promise<T> {
    return this.inner.begin(async (tx) => {
      const result = await fn(tx);
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
 * subject's `commit` is Postgres's real durable commit, `applyPatch`: one SQL
 * transaction. Postgres writes chunk rows only in `reindex()`, so nothing in
 * `commit` projects, and `fullRebuildCount` counts reindex calls.
 */
export async function createPostgresCommitHarness(
  embeddingService: EmbeddingService,
): Promise<PostgresCommitHarness> {
  const pglite = await createPGliteSql({
    schemaSql: buildPostgresSchemaSql({
      vectorDimension: CONFORMANCE_VECTOR_DIMENSIONS,
    }),
  });
  const sql = new FailOnceSql(pglite);
  const store = new PostgresRdfjsStore({ sql });
  await store.ensureSchema();
  const index = new PostgresSearchIndex({
    sql,
    embeddingService,
    vectorDimensions: CONFORMANCE_VECTOR_DIMENSIONS,
  });
  let rebuilds = 0;
  const reindex = index.reindex.bind(index);
  index.reindex = (request) => {
    rebuilds++;
    return reindex(request);
  };
  const subject: CommitConformanceSubject = {
    commit: (patch, context) =>
      store.applyPatch(patch, { importMode: context?.importMode }),
    storedQuads: () => store.getQuads(),
    chunkedQuadIds: async () => {
      const rows = await sql.unsafe<{ id: string }>(
        "SELECT id FROM worlds_search_chunks",
      );
      return rows.map((row) => row.id.split("#")[0]!);
    },
    failNextWrite: () => sql.failNextTransaction(),
    fullRebuildCount: () => rebuilds,
  };
  return { sql, store, index, subject, close: () => sql.end() };
}
