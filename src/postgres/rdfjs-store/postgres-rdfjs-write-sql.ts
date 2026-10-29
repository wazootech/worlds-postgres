import { DataFactory } from "@wazoo/sparql-engine";
import type * as rdfjs from "@rdfjs/types";
import type { Patch } from "@worlds/sdk";
import type { MatchContext } from "@/postgres/rdfjs-store/postgres-rdfjs-match-sql.ts";
import {
  quadKey,
  splitQuadKey,
  toQuadRecord,
  toQuadRow,
} from "@/postgres/rdfjs-store/quad-record.ts";

/** ensureQuadsTable creates the quads table and its secondary indexes (idempotent). */
export async function ensureQuadsTable(
  ctx: MatchContext,
): Promise<void> {
  const { sql, tableName } = ctx;
  await sql.unsafe(
    `CREATE TABLE IF NOT EXISTS ${tableName} (` +
      "skey TEXT NOT NULL," +
      "pkey TEXT NOT NULL," +
      "okey TEXT NOT NULL," +
      "gkey TEXT NOT NULL," +
      "payload JSONB NOT NULL," +
      "PRIMARY KEY (skey, pkey, okey, gkey)" +
      ")",
  );
  await sql.unsafe(
    `CREATE INDEX IF NOT EXISTS idx_${tableName}_pkey ON ${tableName} (pkey)`,
  );
  await sql.unsafe(
    `CREATE INDEX IF NOT EXISTS idx_${tableName}_okey ON ${tableName} (okey)`,
  );
  await sql.unsafe(
    `CREATE INDEX IF NOT EXISTS idx_${tableName}_gkey ON ${tableName} (gkey)`,
  );
}

/** runPatch applies a patch in one SQL transaction (replace mode clears first). */
export function runPatch(
  ctx: MatchContext,
  patch: Patch,
  context?: { importMode?: "replace" | "merge" },
): Promise<void> {
  const { sql, tableName } = ctx;
  return sql.begin(async (tx) => {
    if (context?.importMode === "replace") {
      await tx.unsafe(`DELETE FROM ${tableName}`);
    }
    if (patch.deletions.length > 0) {
      const keys = patch.deletions.map((quad) => {
        const [skey, pkey, okey, gkey] = splitQuadKey(quadKey(quad));
        return { skey, pkey, okey, gkey };
      });
      await tx.unsafe(
        `DELETE FROM ${tableName} ` +
          "WHERE (skey, pkey, okey, gkey) IN (" +
          "SELECT * FROM json_to_recordset($1::json) AS x(" +
          "skey TEXT, pkey TEXT, okey TEXT, gkey TEXT))",
        [JSON.stringify(keys)],
      );
    }
    if (patch.insertions.length > 0) {
      // Pass the payload as an object (not a string) so the JSONB
      // recordset column stores a proper JSON object — a string value
      // would be stored as a JSONB string and break payload->'o' probes.
      const rows = patch.insertions.map((quad) => {
        const row = toQuadRow(quad);
        return {
          skey: row.skey,
          pkey: row.pkey,
          okey: row.okey,
          gkey: row.gkey,
          payload: toQuadRecord(quad),
        };
      });
      await tx.unsafe(
        `INSERT INTO ${tableName} (skey, pkey, okey, gkey, payload) ` +
          "SELECT * FROM json_to_recordset($1::json) AS x(" +
          "skey TEXT, pkey TEXT, okey TEXT, gkey TEXT, payload JSONB) " +
          "ON CONFLICT (skey, pkey, okey, gkey) " +
          "DO UPDATE SET payload = EXCLUDED.payload",
        [JSON.stringify(rows)],
      );
    }
  });
}

/** insertQuad upserts a single quad (the addQuad write). */
export async function insertQuad(
  ctx: MatchContext,
  quad: rdfjs.Quad,
): Promise<void> {
  const { sql, tableName } = ctx;
  const row = toQuadRow(quad);
  await sql.unsafe(
    `INSERT INTO ${tableName} (skey, pkey, okey, gkey, payload) ` +
      "VALUES ($1, $2, $3, $4, $5::jsonb) " +
      "ON CONFLICT (skey, pkey, okey, gkey) " +
      "DO UPDATE SET payload = EXCLUDED.payload",
    [row.skey, row.pkey, row.okey, row.gkey, row.payload],
  );
}

/** deleteQuad removes a single quad (the removeQuad write). */
export async function deleteQuad(
  ctx: MatchContext,
  quad: rdfjs.Quad,
): Promise<void> {
  const { sql, tableName } = ctx;
  const [skey, pkey, okey, gkey] = splitQuadKey(quadKey(quad));
  await sql.unsafe(
    `DELETE FROM ${tableName} ` +
      "WHERE skey = $1 AND pkey = $2 AND okey = $3 AND gkey = $4",
    [skey, pkey, okey, gkey],
  );
}

/** resolveQuad builds the quad addQuad persists from its overloaded arguments. */
export function resolveQuad(
  quadOrSubject: rdfjs.Quad | rdfjs.Term,
  predicate?: rdfjs.Term,
  object?: rdfjs.Term,
  graph?: rdfjs.Term,
): rdfjs.Quad {
  return predicate !== undefined && object !== undefined
    ? DataFactory.quad(
      // RDF 1.2 allows any term in any position (literal subjects in
      // quoted triples); the engine's position types are narrower, so cast.
      quadOrSubject as rdfjs.Quad_Subject,
      predicate as rdfjs.Quad_Predicate,
      object as rdfjs.Quad_Object,
      graph as rdfjs.Quad_Graph,
    )
    : quadOrSubject as rdfjs.Quad;
}
