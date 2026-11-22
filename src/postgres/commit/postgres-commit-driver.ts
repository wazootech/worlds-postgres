import type { SqlCommitDriver } from "@worlds/sqlite/sql-core";
import {
  fromQuadRow,
  type QuadRow,
  splitQuadKey,
} from "@/postgres/rdfjs-store/quad-record.ts";
import type { PostgresSql } from "@/postgres/sql/postgres-sql.ts";

/** PostgresStatement is one parameterized statement for `PostgresSql.unsafe`. */
export interface PostgresStatement {
  /** sql is the statement text, using `$n` placeholders. */
  sql: string;

  /** params are the positional bind values. */
  params?: unknown[];
}

/**
 * MAX_ATOMIC_STATEMENTS is the atomic limit for Postgres: a transaction holds
 * any number of statements, so a commit never takes the chunked fallback path.
 */
export const MAX_ATOMIC_STATEMENTS = Number.MAX_SAFE_INTEGER;

/** WRITE_BATCH_SIZE is the shared default, used only for rebuild writes. */
export const WRITE_BATCH_SIZE = 500;

/** PostgresCommitDriverOptions configures createPostgresCommitDriver. */
export interface PostgresCommitDriverOptions {
  /** sql is the SQL surface (postgres.js Sql or the PGlite adapter). */
  sql: PostgresSql;

  /** quadsTableName is the quads table. */
  quadsTableName: string;
}

/** QuadCursor is the keyset position after the last paged quad. */
type QuadCursor = readonly [string, string, string, string];

/**
 * createPostgresCommitDriver adapts a PostgresSql to the shared SQL commit core.
 * `executeBatch` runs its statements in one SQL transaction, so every commit is
 * atomic whatever its size: `commitSqlPatch` always takes its single-batch path.
 */
export function createPostgresCommitDriver(
  options: PostgresCommitDriverOptions,
): SqlCommitDriver<PostgresStatement> {
  const { sql, quadsTableName } = options;
  return {
    maxAtomicStatements: MAX_ATOMIC_STATEMENTS,
    writeBatchSize: WRITE_BATCH_SIZE,

    async executeBatch(statements) {
      if (statements.length === 0) return;
      await sql.begin(async (tx) => {
        for (const statement of statements) {
          await tx.unsafe(statement.sql, statement.params);
        }
      });
    },

    // One recordset parameter however many keys, so there is nothing to chunk.
    async lookupExisting(keys) {
      if (keys.length === 0) return new Set();
      const records = keys.map((key) => {
        const [skey, pkey, okey, gkey] = splitQuadKey(key);
        return { skey, pkey, okey, gkey };
      });
      const rows = await sql.unsafe<QuadRow>(
        `SELECT q.skey, q.pkey, q.okey, q.gkey FROM ${quadsTableName} q ` +
          "JOIN json_to_recordset($1::json) AS x(" +
          "skey TEXT, pkey TEXT, okey TEXT, gkey TEXT) " +
          "ON q.skey = x.skey AND q.pkey = x.pkey " +
          "AND q.okey = x.okey AND q.gkey = x.gkey",
        [JSON.stringify(records)],
      );
      return new Set(
        rows.map((row) => [row.skey, row.pkey, row.okey, row.gkey].join("\0")),
      );
    },

    async streamQuads({ after, pageSize }) {
      const params: unknown[] = [];
      const bind = (value: unknown): string => {
        params.push(value);
        return `$${params.length}`;
      };
      const where: string[] = [];
      if (after) {
        const [skey, pkey, okey, gkey] = (after as QuadCursor).map(bind);
        where.push(
          `(skey, pkey, okey, gkey) > (${skey}, ${pkey}, ${okey}, ${gkey})`,
        );
      }
      const rows = await sql.unsafe<QuadRow>(
        `SELECT skey, pkey, okey, gkey, payload FROM ${quadsTableName}` +
          (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
          ` ORDER BY skey, pkey, okey, gkey LIMIT ${bind(pageSize)}`,
        params,
      );
      const last = rows[rows.length - 1];
      return {
        quads: rows.map((row) => fromQuadRow(row)),
        next: last && rows.length === pageSize
          ? [last.skey, last.pkey, last.okey, last.gkey] as QuadCursor
          : undefined,
      };
    },
  };
}
