import type { EmbeddingService } from "@worlds/sdk/search-index/embedding-service";
import type { TextSplitterInterface } from "@worlds/sdk/search-index/quad-chunker";
import type { SqlProjectionOptions } from "@worlds/sqlite/sql-core";

/** DEFAULT_CHUNKS_TABLE is the search chunks table name unless configured. */
export const DEFAULT_CHUNKS_TABLE = "worlds_search_chunks";

/** DEFAULT_VECTOR_DIMENSION is the chunk embedding width (matches the schema). */
export const DEFAULT_VECTOR_DIMENSION = 1536;

/** MAX_VECTOR_DIMENSION is the widest embedding the schema builder allows. */
export const MAX_VECTOR_DIMENSION = 1536;

/**
 * IDENTITY_TEXT_SPLITTER yields one chunk per textual literal, the behavior
 * when no textSplitter is configured. Pass a real splitter (for example
 * LangChain's RecursiveCharacterTextSplitter) to break long literals into
 * several chunk rows, consistent with @worlds/libsql.
 */
export const IDENTITY_TEXT_SPLITTER: TextSplitterInterface = {
  createDocuments(texts, metadatas) {
    return Promise.resolve(
      texts.map((text, index) => ({
        pageContent: text,
        metadata: metadatas?.[index],
      })),
    );
  },
};

/** PostgresSearchProjectionOptions is what chunk projection needs, at commit and in reindex. */
export interface PostgresSearchProjectionOptions {
  /** searchChunksTableName is the chunks table (default "worlds_search_chunks"). */
  searchChunksTableName?: string;

  /** embeddingService computes chunk vectors; without one chunk rows carry text only. */
  embeddingService?: EmbeddingService;

  /** vectorDimensions rejects an embedding of any other length (default 1536). */
  vectorDimensions?: number;

  /** textSplitter slices long literals into chunk rows (default: one chunk per literal). */
  textSplitter?: TextSplitterInterface;
}

/**
 * toProjectionOptions turns the backend's options into the shared core's
 * `projection`. An embedding failure throws and writes nothing, the converged
 * default of every Worlds backend.
 */
export function toProjectionOptions(
  options: PostgresSearchProjectionOptions,
): SqlProjectionOptions {
  return {
    textSplitter: options.textSplitter ?? IDENTITY_TEXT_SPLITTER,
    embeddingService: options.embeddingService,
    vectorDimensions: options.vectorDimensions ?? DEFAULT_VECTOR_DIMENSION,
  };
}
