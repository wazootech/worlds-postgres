import type { ReindexRequest, ReindexResponse } from "@worlds/sdk/search-index";
import { rebuildSqlSearchIndex } from "@worlds/sqlite/sql-core";
import type { PostgresSql } from "@/postgres/sql/postgres-sql.ts";
import { createPostgresCommitDriver } from "./postgres-commit-driver.ts";
import { createPostgresDialect } from "./postgres-dialect.ts";
import {
  DEFAULT_CHUNKS_TABLE,
  type PostgresSearchProjectionOptions,
  toProjectionOptions,
} from "./search-projection.ts";

/** DEFAULT_READ_PAGE_SIZE is the quads read per page of a rebuild. */
const DEFAULT_READ_PAGE_SIZE = 1000;

/** hasCriteria is true when one side of a QuadFilter names anything to match. */
function hasCriteria(side: ReindexRequest["include"]): boolean {
  return side !== undefined && Object.values(side).some((v) => v?.length);
}

/**
 * rebuildPostgresChunks rebuilds chunk rows from the stored quads through the
 * shared `rebuildSqlSearchIndex`. Each page is chunked and embedded before it is
 * written, and written in one SQL transaction, so a failure writes nothing for
 * that page and leaves earlier pages indexed (the rebuild as a whole is not one
 * transaction because embedding calls an external service). Running it again
 * repairs a partial rebuild.
 *
 * An unscoped rebuild clears every chunk row in its first page's transaction,
 * which also drops rows of quads that no longer exist; an embedding failure on
 * a later page therefore leaves the pages after it unindexed until a rerun. A scoped one (include or exclude set) clears
 * nothing: it replaces only the rows of the quads in scope.
 */
export async function rebuildPostgresChunks(
  options: PostgresSearchProjectionOptions & {
    sql: PostgresSql;
    quadsTableName: string;
  },
  request?: ReindexRequest,
): Promise<ReindexResponse> {
  const { sql, quadsTableName } = options;
  const scoped = hasCriteria(request?.include) || hasCriteria(request?.exclude);
  const driver = createPostgresCommitDriver({
    sql,
    quadsTableName,
    filter: { include: request?.include, exclude: request?.exclude },
  });
  const dialect = createPostgresDialect({
    quadsTableName,
    chunksTableName: options.searchChunksTableName ?? DEFAULT_CHUNKS_TABLE,
  });
  let processedQuadCount = 0;
  const chunkRowCount = await rebuildSqlSearchIndex(
    {
      ...driver,
      streamQuads: async (page) => {
        const result = await driver.streamQuads(page);
        processedQuadCount += result.quads.length;
        return result;
      },
    },
    scoped ? { ...dialect, buildClearChunks: () => [] } : dialect,
    toProjectionOptions(options),
    {
      pageSize: Math.max(
        1,
        Math.floor(request?.readPageSize ?? DEFAULT_READ_PAGE_SIZE),
      ),
    },
  );
  return { processedQuadCount, chunkRowCount };
}
