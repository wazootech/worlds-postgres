import type {
  SearchRequest,
  SearchResponse,
  SearchResult,
} from "@worlds/sdk/search-index";
import { buildSearchResultId } from "@worlds/sdk/search-index";
import { fromQuadRow } from "@/postgres/rdfjs-store/quad-record.ts";
import { filterSql } from "./postgres-search-filter-sql.ts";
import { buildHybridQuery } from "./postgres-search-hybrid-sql.ts";
import type {
  HybridChunkRow,
  PostgresSearchContext,
} from "./postgres-search-types.ts";

const XSD_STRING = "http://www.w3.org/2001/XMLSchema#string";
const RDF_LANGSTRING = "http://www.w3.org/1999/02/22-rdf-syntax-ns#langString";

/**
 * keywordScanSearch is the parity keyword path: a SQL scan over the live
 * quads table matching the reference's exact substring semantics.
 */
export async function keywordScanSearch(
  ctx: PostgresSearchContext,
  request: SearchRequest,
): Promise<SearchResponse> {
  const query = request.query;
  const where: string[] = [
    `payload->'o'->>'t' = 'L'`,
    `payload->'o'->>'dt' IN ($1, $2)`,
  ];
  const params: string[] = [XSD_STRING, RDF_LANGSTRING];
  const bind = (value: string): string => {
    params.push(value);
    return `$${params.length}`;
  };

  // Case-insensitive substring, escaping LIKE wildcards so the query is
  // treated literally (matching the reference's String.includes).
  const escaped = query.replaceAll("\\", "\\\\").replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
  where.push(
    `lower(payload->'o'->>'v') LIKE '%' || lower(${
      bind(escaped)
    }) || '%' ESCAPE '\\'`,
  );

  const scoping = filterSql(bind, request.include, request.exclude);
  where.push(...scoping.where);

  const sqlText = `SELECT payload FROM ${ctx.tableName}` +
    ` WHERE ${where.join(" AND ")}`;
  const rows = await ctx.sql.unsafe<{ payload: string }>(sqlText, params);

  const results: SearchResult[] = [];
  for (const row of rows) {
    const quad = fromQuadRow({ payload: row.payload });
    const text = quad.object.value;
    const base = {
      subject: quad.subject.value,
      predicate: quad.predicate.value,
      graph: quad.graph.value,
      text,
    };
    results.push({
      id: await buildSearchResultId(base),
      ...base,
      score: 1.0,
    });
  }
  return { results };
}

/**
 * hybridSearch fuses a tsvector keyword branch and a pgvector cosine
 * branch over the reindexed chunks table with Reciprocal Rank Fusion
 * (`1/(60 + rank)` summed), consistent with @worlds/libsql. An embedding
 * failure degrades to the keyword branch alone; an empty query runs the
 * vector branch alone. Requires the chunks table (see ensureSchema).
 */
export async function hybridSearch(
  ctx: PostgresSearchContext,
  request: SearchRequest,
): Promise<SearchResponse> {
  let vectorJson: string | undefined;
  if (ctx.embeddingService) {
    try {
      const [vector] = await ctx.embeddingService.embed([request.query]);
      if (vector.length !== ctx.vectorDimensions) {
        throw new Error(
          `query embedding length ${vector.length} does not match ` +
            `vectorDimensions ${ctx.vectorDimensions}`,
        );
      }
      vectorJson = JSON.stringify(Array.from(vector));
    } catch (error) {
      // Gracefully degrade to keyword-only search if the embedding
      // service fails, mirroring @worlds/libsql.
      console.warn(
        `[Search Warning] Embedding service failure. Degrading to ` +
          `keyword-only search fallback. Reason: ${(error as Error).message}`,
      );
    }
  }

  const { sql, params } = buildHybridQuery(request, { vectorJson }, ctx);
  const rows = await ctx.sql.unsafe<HybridChunkRow>(sql, params);

  const minScore = request.minScore ?? 0;
  const results: SearchResult[] = [];
  for (const row of rows) {
    const score = Number(row.combined_rank);
    if (score < minScore) continue;
    const base = {
      subject: row.subject,
      predicate: row.predicate,
      graph: row.graph,
      text: row.text,
    };
    results.push({
      id: await buildSearchResultId(base),
      ...base,
      score,
    });
  }
  return { results };
}
