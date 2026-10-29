import type { ReindexRequest, ReindexResponse } from "@worlds/sdk/search-index";
import { chunkQuads } from "@worlds/sdk/search-index/quad-chunker";
import {
  fromQuadRow,
  type QuadRow,
} from "@/postgres/rdfjs-store/quad-record.ts";
import { escapeLike, filterSql } from "./postgres-search-filter-sql.ts";
import type { PostgresSearchContext } from "./postgres-search-types.ts";

/**
 * Rebuilds the search chunk table from durable quads in PostgreSQL —
 * the vector/hybrid seam (embedding + tsvector per chunk). Paginates
 * every quad with keyset paging over the ordered key columns (no quads
 * skipped or duplicated across pages), splits textual literals into chunk
 * rows via the configured textSplitter (identity by default), and, when
 * an embedding service is configured, populates each chunk's `embedding`
 * column. Keyword search does not depend on this projection (it scans the
 * live quads table), so reindex is optional for keyword parity.
 */
export async function reindexChunks(
  ctx: PostgresSearchContext,
  request?: ReindexRequest,
): Promise<ReindexResponse> {
  const pageSize = Math.max(1, Math.floor(request?.readPageSize ?? 1000));
  let processedQuadCount = 0;
  let chunkRowCount = 0;
  let cursor: readonly [string, string, string, string] | null = null;

  for (;;) {
    const params: unknown[] = [];
    const bind = (value: string): string => {
      params.push(value);
      return `$${params.length}`;
    };

    const scoping = filterSql(
      bind,
      request?.include,
      request?.exclude,
    );
    const where = [...scoping.where];
    if (cursor) {
      params.push(...cursor);
      const offset = params.length;
      where.push(
        `(skey, pkey, okey, gkey) > ($${offset - 3}, $${offset - 2}, ` +
          `$${offset - 1}, $${offset})`,
      );
    }
    params.push(pageSize);
    const sqlText =
      `SELECT skey, pkey, okey, gkey, payload FROM ${ctx.tableName}` +
      (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
      ` ORDER BY skey, pkey, okey, gkey LIMIT $${params.length}`;
    const rows = await ctx.sql.unsafe<QuadRow>(sqlText, params);

    if (rows.length === 0) {
      break;
    }

    const quads = rows.map((row) => fromQuadRow(row));
    processedQuadCount += quads.length;

    // Split textual literals into chunk rows (the identity splitter yields
    // one chunk per quad when no textSplitter is configured).
    const chunks = await chunkQuads(quads, ctx.textSplitter);

    // Refresh semantics (mirroring @worlds/libsql): clear this page's
    // previous chunk rows first, so split changes never leave stale rows.
    if (chunks.length > 0) {
      const quadIds = Array.from(new Set(chunks.map((c) => c.quad_id)));
      await ctx.sql.unsafe(
        `DELETE FROM ${ctx.chunksTableName} WHERE id LIKE ANY($1::text[])`,
        [quadIds.map((id) => `${escapeLike(id)}#%`)],
      );
    }

    // Row id is `${quad_id}#<localIndex>` — unique per split piece and
    // stable across reruns for a deterministic splitter.
    const localIndexByQuad = new Map<string, number>();
    const chunkRows = chunks.map((chunk) => {
      const localIndex = localIndexByQuad.get(chunk.quad_id) ?? 0;
      localIndexByQuad.set(chunk.quad_id, localIndex + 1);
      return {
        id: `${chunk.quad_id}#${localIndex}`,
        graph: chunk.graph,
        subject: chunk.subject,
        predicate: chunk.predicate,
        text: chunk.value,
      };
    });

    let vectors: Array<Float32Array | number[]> | undefined;
    if (ctx.embeddingService && chunkRows.length > 0) {
      vectors = await ctx.embeddingService.embed(
        chunkRows.map((row) => row.text),
      );
      for (const vector of vectors) {
        if (vector.length !== ctx.vectorDimensions) {
          throw new Error(
            `embedding length ${vector.length} does not match ` +
              `vectorDimensions ${ctx.vectorDimensions}`,
          );
        }
      }
    }

    for (let i = 0; i < chunkRows.length; i++) {
      const row = chunkRows[i]!;
      const embedding = vectors?.[i];
      await ctx.sql.unsafe(
        `INSERT INTO ${ctx.chunksTableName} ` +
          "(id, graph, subject, predicate, text, embedding) " +
          "VALUES ($1, $2, $3, $4, $5, $6::vector) " +
          "ON CONFLICT (id) DO UPDATE SET " +
          "text = EXCLUDED.text, embedding = EXCLUDED.embedding",
        [
          row.id,
          row.graph,
          row.subject,
          row.predicate,
          row.text,
          embedding ? JSON.stringify(Array.from(embedding)) : null,
        ],
      );
      chunkRowCount++;
    }

    if (rows.length < pageSize) {
      break;
    }
    const last = rows[rows.length - 1]!;
    cursor = [last.skey, last.pkey, last.okey, last.gkey];
  }

  return {
    processedQuadCount,
    chunkRowCount,
  };
}
