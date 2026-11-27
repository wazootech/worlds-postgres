import type { SqlDialect } from "@worlds/sqlite/sql-core";
import {
  quadKey,
  splitQuadKey,
  toQuadRecord,
  toQuadRow,
} from "@/postgres/rdfjs-store/quad-record.ts";
import {
  buildChunkRowStatements,
  buildDeleteChunksStatement,
} from "./chunk-statements.ts";
import type { PostgresStatement } from "./postgres-commit-driver.ts";

/** PostgresDialectOptions configures createPostgresDialect. */
export interface PostgresDialectOptions {
  /** quadsTableName is the quads table. */
  quadsTableName: string;

  /**
   * chunksTableName is the search chunks table. Leave it unset when the store
   * keeps no chunk rows: the dialect then emits no chunk statements at all.
   */
  chunksTableName?: string;
}

/**
 * createPostgresDialect builds the statements for Postgres's schema: quads
 * keyed by their four term-key columns with a JSONB payload, and chunk rows
 * (pgvector embedding, generated tsvector) keyed `${quad_id}#<n>`. Each builder
 * emits few statements however many quads it covers (one `json_to_recordset`
 * parameter), so a commit is a short statement list inside one transaction.
 */
export function createPostgresDialect(
  options: PostgresDialectOptions,
): SqlDialect<PostgresStatement> {
  const { quadsTableName: quads, chunksTableName: chunks } = options;
  const clearChunks = (): PostgresStatement[] =>
    chunks ? [{ sql: `DELETE FROM ${chunks}` }] : [];
  const deleteQuads = (keys: string[]): PostgresStatement[] => [
    {
      sql:
        `DELETE FROM ${quads} ` +
        "WHERE (skey, pkey, okey, gkey) IN (" +
        "SELECT * FROM json_to_recordset($1::json) AS x(" +
        "skey TEXT, pkey TEXT, okey TEXT, gkey TEXT))",
      params: [
        JSON.stringify(
          keys.map((key) => {
            const [skey, pkey, okey, gkey] = splitQuadKey(key);
            return { skey, pkey, okey, gkey };
          }),
        ),
      ],
    },
  ];
  const deletions = (keys: string[], hashes: string[]) => [
    ...deleteQuads(keys),
    ...(chunks ? [buildDeleteChunksStatement(chunks, hashes)] : []),
  ];

  return {
    keyOf: (quad) => quadKey(quad),
    buildWipe: () => [{ sql: `DELETE FROM ${quads}` }, ...clearChunks()],
    buildClearChunks: clearChunks,
    // One text[] parameter however many hashes, so a page never nears
    // Postgres's bind-parameter limit.
    buildDeleteChunks: (hashes) =>
      chunks ? [buildDeleteChunksStatement(chunks, hashes)] : [],
    buildDeletions: deletions,
    // The core deletes a novel quad's key before inserting it, so nothing
    // conflicts but a duplicate within the statement, which DO NOTHING absorbs.
    buildInserts: (quadList) => [
      {
        sql:
          `INSERT INTO ${quads} (skey, pkey, okey, gkey, payload) ` +
          "SELECT * FROM json_to_recordset($1::json) AS x(" +
          "skey TEXT, pkey TEXT, okey TEXT, gkey TEXT, payload JSONB) " +
          "ON CONFLICT (skey, pkey, okey, gkey) DO NOTHING",
        // The payload is an object, not a string, so the JSONB column stores a
        // JSON object (a string would be a JSONB string and break payload->'o').
        params: [
          JSON.stringify(
            quadList.map((quad) => {
              const { skey, pkey, okey, gkey } = toQuadRow(quad);
              return { skey, pkey, okey, gkey, payload: toQuadRecord(quad) };
            }),
          ),
        ],
      },
    ],
    buildChunkRows: (rows) =>
      chunks ? buildChunkRowStatements(chunks, rows) : [],
    // Postgres commits atomically, so the fallback cleanup never runs; it is
    // the same removal a deletion does.
    buildCleanup: deletions,
  };
}
