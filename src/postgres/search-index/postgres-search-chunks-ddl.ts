import { quoteFtsLanguage } from "@/postgres/schema/postgres-schema-builder.ts";
import type { PostgresSearchContext } from "./postgres-search-types.ts";

/**
 * ensureSchema creates the search chunks table (pgvector embedding column,
 * generated tsvector in the configured ftsLanguage, HNSW cosine index, GIN
 * tsvector index) — idempotent. Called by createPostgresWorldsSdk when an
 * embedding service is configured; direct users must run it (or the shared
 * schema builder) before hybrid search or reindex.
 */
export async function ensureSearchChunksTable(
  ctx: Pick<
    PostgresSearchContext,
    "sql" | "chunksTableName" | "vectorDimensions" | "ftsLanguage"
  >,
): Promise<void> {
  const dimension = ctx.vectorDimensions;
  const ftsLanguage = quoteFtsLanguage(ctx.ftsLanguage);
  await ctx.sql.unsafe(`CREATE EXTENSION IF NOT EXISTS vector`);
  await ctx.sql.unsafe(
    `CREATE TABLE IF NOT EXISTS ${ctx.chunksTableName} (` +
      "id TEXT PRIMARY KEY," +
      "graph TEXT NOT NULL," +
      "subject TEXT NOT NULL," +
      "predicate TEXT NOT NULL," +
      "text TEXT NOT NULL," +
      `embedding vector(${dimension}),` +
      `tsv tsvector GENERATED ALWAYS AS (to_tsvector(${ftsLanguage}, text)) STORED` +
      ")",
  );
  await ctx.sql.unsafe(
    `CREATE INDEX IF NOT EXISTS idx_${ctx.chunksTableName}_embedding ` +
      `ON ${ctx.chunksTableName} USING hnsw (embedding vector_cosine_ops)`,
  );
  await ctx.sql.unsafe(
    `CREATE INDEX IF NOT EXISTS idx_${ctx.chunksTableName}_tsv ` +
      `ON ${ctx.chunksTableName} USING gin (tsv)`,
  );
}
