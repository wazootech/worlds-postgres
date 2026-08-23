/**
 * PGlite adapter — wraps `@electric-sql/pglite` into the `PostgresSql`
 * surface so the Worlds postgres backend runs fully in-memory (WASM
 * PostgreSQL) for tests and local development.
 *
 * The pgvector extension is wired at construction, so `CREATE EXTENSION
 * vector` works for the vector search chunk table.
 */
import { PGlite, type PGliteOptions } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import type { PostgresSql } from "@/postgres/sql/postgres-sql.ts";

/** PGliteSql implements PostgresSql over a PGlite instance. */
export class PGliteSql implements PostgresSql {
  public constructor(
    public readonly db: PGlite,
    private readonly exec: (query: string) => Promise<unknown>,
  ) {}

  public async unsafe<T>(
    query: string,
    params?: unknown[],
  ): Promise<T[]> {
    const result = await this.db.query<T>(query, params ?? []);
    return result.rows;
  }

  public begin<T>(
    fn: (
      tx: { unsafe<T2>(query: string, params?: unknown[]): Promise<T2[]> },
    ) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      return await fn({
        unsafe: async <T2>(query: string, params?: unknown[]) => {
          const result = await tx.query<T2>(query, params ?? []);
          return result.rows;
        },
      });
    });
  }

  public async end(): Promise<void> {
    await this.db.close();
  }
}

/**
 * createPGliteSql creates an in-memory PGlite-backed PostgresSql. The
 * optional `schemaSql` (e.g. the shared schema builder's output) is applied
 * on startup via PGlite's multi-statement exec.
 */
export async function createPGliteSql(
  options: {
    dataDir?: string;
    schemaSql?: string;
  } = {},
): Promise<PGliteSql> {
  const pgliteOptions: PGliteOptions = {
    extensions: { vector },
  };
  if (options.dataDir) {
    pgliteOptions.dataDir = options.dataDir;
  }
  const db = new PGlite(pgliteOptions);
  const adapter = new PGliteSql(db, (query: string) => db.exec(query));
  if (options.schemaSql) {
    await db.exec(options.schemaSql);
  }
  return adapter;
}
