/**
 * Options for initializing PostgreSQL schema for Worlds.
 */
export interface PostgresSchemaOptions {
  /** Table name for RDF Quads (default: "worlds_quads") */
  quadsTableName?: string;
  /** Table name for Search Chunks (default: "worlds_search_chunks") */
  searchChunksTableName?: string;
  /** Vector dimension size for pgvector embeddings (default: 1536) */
  vectorDimension?: number;
}

/**
 * Returns SQL statements to initialize PostgreSQL extensions, quad store tables, and search indexes.
 */
export function buildPostgresSchemaSql(
  options: PostgresSchemaOptions = {},
): string {
  const quadsTable = options.quadsTableName ?? "worlds_quads";
  const chunksTable = options.searchChunksTableName ?? "worlds_search_chunks";
  const dimension = options.vectorDimension ?? 1536;

  return `
-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Quads table storing graph statements
CREATE TABLE IF NOT EXISTS ${quadsTable} (
  graph TEXT NOT NULL,
  subject TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object TEXT NOT NULL,
  datatype TEXT,
  language TEXT,
  PRIMARY KEY (graph, subject, predicate, object)
);

-- Hexastore permutation indexes for quad queries
CREATE INDEX IF NOT EXISTS idx_${quadsTable}_gspo ON ${quadsTable} (graph, subject, predicate, object);
CREATE INDEX IF NOT EXISTS idx_${quadsTable}_spog ON ${quadsTable} (subject, predicate, object, graph);
CREATE INDEX IF NOT EXISTS idx_${quadsTable}_posg ON ${quadsTable} (predicate, object, subject, graph);
CREATE INDEX IF NOT EXISTS idx_${quadsTable}_osgp ON ${quadsTable} (object, subject, graph, predicate);

-- Search chunks table for hybrid vector/text search
CREATE TABLE IF NOT EXISTS ${chunksTable} (
  id TEXT PRIMARY KEY,
  graph TEXT NOT NULL,
  subject TEXT NOT NULL,
  predicate TEXT NOT NULL,
  text TEXT NOT NULL,
  embedding vector(${dimension}),
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED
);

-- HNSW vector similarity index for cosine distance
CREATE INDEX IF NOT EXISTS idx_${chunksTable}_embedding 
  ON ${chunksTable} USING hnsw (embedding vector_cosine_ops);

-- GIN full-text search index
CREATE INDEX IF NOT EXISTS idx_${chunksTable}_tsv 
  ON ${chunksTable} USING gin (tsv);
`;
}
