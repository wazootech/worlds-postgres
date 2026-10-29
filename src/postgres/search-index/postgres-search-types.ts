import type { EmbeddingService } from "@worlds/sdk/search-index/embedding-service";
import type { TextSplitterInterface } from "@worlds/sdk/search-index/quad-chunker";
import type { PostgresSql } from "@/postgres/sql/postgres-sql.ts";

/** HybridChunkRow is one fused search row from the chunks table. */
export interface HybridChunkRow {
  subject: string;
  predicate: string;
  graph: string;
  text: string;
  combined_rank: string | number;
}

/**
 * PostgresSearchContext carries the resolved PostgresSearchIndex settings the
 * extracted query, reindex, and DDL helpers operate on.
 */
export interface PostgresSearchContext {
  sql: PostgresSql;
  tableName: string;
  chunksTableName: string;
  embeddingService?: EmbeddingService;
  vectorDimensions: number;
  ftsLanguage: string;
  textSplitter: TextSplitterInterface;
}
