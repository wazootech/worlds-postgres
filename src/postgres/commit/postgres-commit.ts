import type { Patch, TransactionContext } from "@worlds/sdk/quad-store";
import type { SearchIndexOnImport } from "@worlds/sdk/search-index";
import { commitSqlPatch, type SqlCommitSummary } from "@worlds/sqlite/sql-core";
import type { PostgresSql } from "@/postgres/sql/postgres-sql.ts";
import { createPostgresCommitDriver } from "./postgres-commit-driver.ts";
import { createPostgresDialect } from "./postgres-dialect.ts";
import {
  DEFAULT_CHUNKS_TABLE,
  type PostgresSearchProjectionOptions,
  toProjectionOptions,
} from "./search-projection.ts";

/** PostgresCommitSearchOptions turns on commit-time chunk projection. */
export interface PostgresCommitSearchOptions extends PostgresSearchProjectionOptions {
  /**
   * searchIndexOnImport controls when chunk rows are written. "incremental"
   * (the default) projects in every commit; "deferred" skips projection during
   * an import and rebuilds once after it; "disabled" never projects at commit.
   */
  searchIndexOnImport?: SearchIndexOnImport;
}

/** PostgresCommitOptions configures createPostgresCommit. */
export interface PostgresCommitOptions {
  /** sql is the SQL surface (postgres.js Sql or the PGlite adapter). */
  sql: PostgresSql;

  /** quadsTableName is the quads table. */
  quadsTableName: string;

  /**
   * search enables chunk projection. Leave it unset for a store with no chunks
   * table: a commit then writes quads only.
   */
  search?: PostgresCommitSearchOptions;
}

/**
 * createPostgresCommit returns Postgres's durable commit: the shared
 * `commitSqlPatch` over a transactional driver and a Postgres dialect. One
 * commit is one SQL transaction (the quads, the deletions, the replace-import
 * wipe, and the chunk rows together), so it either lands whole or not at all.
 */
export function createPostgresCommit(
  options: PostgresCommitOptions,
): (patch: Patch, context?: TransactionContext) => Promise<SqlCommitSummary> {
  const { sql, quadsTableName, search } = options;
  const driver = createPostgresCommitDriver({ sql, quadsTableName });
  const dialect = createPostgresDialect({
    quadsTableName,
    chunksTableName: search
      ? (search.searchChunksTableName ?? DEFAULT_CHUNKS_TABLE)
      : undefined,
  });
  const commitOptions = {
    searchIndexOnImport: search?.searchIndexOnImport,
    projection: search ? toProjectionOptions(search) : undefined,
  };
  return (patch, context) =>
    commitSqlPatch(patch, context, driver, dialect, commitOptions);
}
