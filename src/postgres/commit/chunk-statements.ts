import type { EmbeddedChunk } from "@worlds/sdk/search-index/quad-chunker";
import type { PostgresStatement } from "./postgres-commit-driver.ts";

/** escapeLike escapes LIKE wildcards so a quad id prefix match stays exact. */
function escapeLike(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}

/**
 * buildDeleteChunksStatement removes every chunk row of the quads with these
 * content hashes. Row ids are `${quad_id}#<localIndex>`, so a quad's rows are
 * the ids with its hash as prefix.
 */
export function buildDeleteChunksStatement(
  chunksTableName: string,
  quadIds: Iterable<string>,
): PostgresStatement {
  return {
    sql: `DELETE FROM ${chunksTableName} WHERE id LIKE ANY($1::text[])`,
    params: [[...quadIds].map((id) => `${escapeLike(id)}#%`)],
  };
}

/**
 * buildChunkRowStatements replaces the chunk rows of the quads in `rows`: it
 * deletes their previous rows (so a changed split never leaves stale rows) and
 * upserts the new ones with one statement. Rows are already chunked and
 * embedded, so nothing external runs while they are written.
 *
 * Row ids are `${quad_id}#<localIndex>`: unique per split piece and stable
 * across reruns for a deterministic splitter.
 */
export function buildChunkRowStatements(
  chunksTableName: string,
  rows: EmbeddedChunk[],
): PostgresStatement[] {
  if (rows.length === 0) return [];
  const localIndexByQuad = new Map<string, number>();
  const records = rows.map(({ chunk, vector }) => {
    const localIndex = localIndexByQuad.get(chunk.quad_id) ?? 0;
    localIndexByQuad.set(chunk.quad_id, localIndex + 1);
    return {
      id: `${chunk.quad_id}#${localIndex}`,
      graph: chunk.graph,
      subject: chunk.subject,
      predicate: chunk.predicate,
      text: chunk.value,
      embedding: vector ? JSON.stringify(Array.from(vector)) : null,
    };
  });
  return [
    buildDeleteChunksStatement(chunksTableName, localIndexByQuad.keys()),
    {
      sql:
        `INSERT INTO ${chunksTableName} ` +
        "(id, graph, subject, predicate, text, embedding) " +
        "SELECT id, graph, subject, predicate, text, embedding::vector " +
        "FROM json_to_recordset($1::json) AS x(" +
        "id TEXT, graph TEXT, subject TEXT, predicate TEXT, text TEXT, " +
        "embedding TEXT) " +
        "ON CONFLICT (id) DO UPDATE SET " +
        "text = EXCLUDED.text, embedding = EXCLUDED.embedding",
      params: [JSON.stringify(records)],
    },
  ];
}
