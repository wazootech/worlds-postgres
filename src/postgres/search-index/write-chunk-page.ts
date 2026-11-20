import type { EmbeddedChunk } from "@worlds/sdk/search-index/quad-chunker";
import type { PostgresSql } from "@/postgres/sql/postgres-sql.ts";

/**
 * escapeLike escapes LIKE wildcards so a literal prefix match stays exact
 * (chunk row ids embed content-hash quad ids).
 */
function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\%")
    .replaceAll("_", "\_");
}

/**
 * writeChunkPage replaces the chunk rows of one page of quads in a single SQL
 * transaction: it deletes the page's previous rows (so a changed split never
 * leaves stale rows) and upserts the new ones with one statement. A failure
 * rolls the whole page back, leaving its earlier rows intact. Rows are already
 * chunked and embedded, so nothing external runs inside the transaction.
 *
 * Row ids are `${quad_id}#<localIndex>`: unique per split piece and stable
 * across reruns for a deterministic splitter. It returns the rows written.
 */
export async function writeChunkPage(
  sql: PostgresSql,
  chunksTableName: string,
  rows: EmbeddedChunk[],
): Promise<number> {
  if (rows.length === 0) return 0;

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
  const stalePatterns = [...localIndexByQuad.keys()].map(
    (id) => `${escapeLike(id)}#%`,
  );

  await sql.begin(async (tx) => {
    await tx.unsafe(
      `DELETE FROM ${chunksTableName} WHERE id LIKE ANY($1::text[])`,
      [stalePatterns],
    );
    await tx.unsafe(
      `INSERT INTO ${chunksTableName} ` +
        "(id, graph, subject, predicate, text, embedding) " +
        "SELECT id, graph, subject, predicate, text, embedding::vector " +
        "FROM json_to_recordset($1::json) AS x(" +
        "id TEXT, graph TEXT, subject TEXT, predicate TEXT, text TEXT, " +
        "embedding TEXT) " +
        "ON CONFLICT (id) DO UPDATE SET " +
        "text = EXCLUDED.text, embedding = EXCLUDED.embedding",
      [JSON.stringify(records)],
    );
  });
  return records.length;
}
