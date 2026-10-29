import type { SearchRequest } from "@worlds/sdk/search-index";
import { chunkFilterSql } from "./postgres-search-filter-sql.ts";

/** Default search result limit for the hybrid path (mirrors @worlds/libsql). */
const DEFAULT_HYBRID_TOP_K = 100;

/** RRF rank-offset constant, consistent with @worlds/libsql's 1/(60 + rank). */
const RRF_K = 60;

/**
 * buildHybridQuery assembles the RRF fusion SQL over the chunks table,
 * mirroring @worlds/libsql's buildSearchQuery structure: ranked keyword
 * matches, ranked vector neighbors, a FULL OUTER JOIN fused by chunk id,
 * QuadFilter scoping on the chunk columns, and a final topK cut.
 */
export function buildHybridQuery(
  request: SearchRequest,
  options: { vectorJson?: string },
  ctx: { chunksTableName: string; ftsLanguage: string },
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const bind = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  const limit = Math.max(1, Math.floor(request.topK ?? DEFAULT_HYBRID_TOP_K));
  const hasKeyword = request.query.trim().length > 0;
  const hasVector = !!options.vectorJson;

  const scoping = chunkFilterSql(bind, request.include, request.exclude);
  const filterClause = scoping.where.length > 0
    ? `WHERE ${scoping.where.join(" AND ")}`
    : "";

  if (hasVector && hasKeyword) {
    const langParam = bind(ctx.ftsLanguage);
    const queryParam = bind(request.query);
    const ftsLimit = bind(limit);
    const vecParam = bind(options.vectorJson);
    const vecLimit = bind(limit);
    const finalLimit = bind(limit);
    const sql = `
      WITH fts_matches AS (
        SELECT id,
          row_number() OVER (
            ORDER BY ts_rank_cd(tsv, plainto_tsquery(${langParam}::regconfig, ${queryParam})) DESC
          ) AS rank_number
        FROM ${ctx.chunksTableName}
        WHERE tsv @@ plainto_tsquery(${langParam}::regconfig, ${queryParam})
        LIMIT ${ftsLimit}
      ), vec_matches AS (
        SELECT id,
          row_number() OVER (ORDER BY embedding <=> ${vecParam}::vector) AS rank_number
        FROM ${ctx.chunksTableName}
        ORDER BY embedding <=> ${vecParam}::vector
        LIMIT ${vecLimit}
      ), fused AS (
        SELECT c.subject, c.predicate, c.graph, c.text,
          (COALESCE(1.0 / (${RRF_K} + fts_matches.rank_number), 0.0) +
           COALESCE(1.0 / (${RRF_K} + vec_matches.rank_number), 0.0)) AS combined_rank
        FROM fts_matches
        FULL OUTER JOIN vec_matches ON vec_matches.id = fts_matches.id
        JOIN ${ctx.chunksTableName} c ON c.id = COALESCE(fts_matches.id, vec_matches.id)
        ${filterClause}
        ORDER BY combined_rank DESC
        LIMIT ${finalLimit}
      )
      SELECT * FROM fused`;
    return { sql, params };
  }

  if (hasVector) {
    const vecParam = bind(options.vectorJson);
    const vecLimit = bind(limit);
    const finalLimit = bind(limit);
    const sql = `
      WITH vec_matches AS (
        SELECT id,
          row_number() OVER (ORDER BY embedding <=> ${vecParam}::vector) AS rank_number
        FROM ${ctx.chunksTableName}
        ORDER BY embedding <=> ${vecParam}::vector
        LIMIT ${vecLimit}
      ), fused AS (
        SELECT c.subject, c.predicate, c.graph, c.text,
          COALESCE(1.0 / (${RRF_K} + vec_matches.rank_number), 0.0) AS combined_rank
        FROM vec_matches
        JOIN ${ctx.chunksTableName} c ON c.id = vec_matches.id
        ${filterClause}
        ORDER BY combined_rank DESC
        LIMIT ${finalLimit}
      )
      SELECT * FROM fused`;
    return { sql, params };
  }

  if (hasKeyword) {
    const langParam = bind(ctx.ftsLanguage);
    const queryParam = bind(request.query);
    const ftsLimit = bind(limit);
    const finalLimit = bind(limit);
    const sql = `
      WITH fts_matches AS (
        SELECT id,
          row_number() OVER (
            ORDER BY ts_rank_cd(tsv, plainto_tsquery(${langParam}::regconfig, ${queryParam})) DESC
          ) AS rank_number
        FROM ${ctx.chunksTableName}
        WHERE tsv @@ plainto_tsquery(${langParam}::regconfig, ${queryParam})
        LIMIT ${ftsLimit}
      ), fused AS (
        SELECT c.subject, c.predicate, c.graph, c.text,
          COALESCE(1.0 / (${RRF_K} + fts_matches.rank_number), 0.0) AS combined_rank
        FROM fts_matches
        JOIN ${ctx.chunksTableName} c ON c.id = fts_matches.id
        ${filterClause}
        ORDER BY combined_rank DESC
        LIMIT ${finalLimit}
      )
      SELECT * FROM fused`;
    return { sql, params };
  }

  return {
    sql: `SELECT NULL::text AS subject, NULL::text AS predicate, ` +
      `NULL::text AS graph, NULL::text AS text, 0::numeric AS combined_rank ` +
      `WHERE 1 = 0`,
    params: [],
  };
}
