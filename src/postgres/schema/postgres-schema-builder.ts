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
 * Returns SQL statements to initialize PostgreSQL extensions, quad store
 * tables, and search indexes.
 *
 * The quads table is the lossless layout shared by all Worlds backends: four
 * term-key columns as the composite primary key (skey/pkey/okey/gkey —
 * quads differing only by graph never collide) plus a JSONB `payload`
 * holding the exact term record (literal language/direction/datatype and
 * RDF-star nesting round-trip losslessly). The search chunks table carries
 * the pgvector embedding column and a generated tsvector for hybrid search.
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

-- Quads table: term-keyed rows with a lossless JSONB payload
CREATE TABLE IF NOT EXISTS ${quadsTable} (
  skey TEXT NOT NULL,
  pkey TEXT NOT NULL,
  okey TEXT NOT NULL,
  gkey TEXT NOT NULL,
  payload JSONB NOT NULL,
  PRIMARY KEY (skey, pkey, okey, gkey)
);

-- Secondary indexes for single-position probes
CREATE INDEX IF NOT EXISTS idx_${quadsTable}_pkey ON ${quadsTable} (pkey);
CREATE INDEX IF NOT EXISTS idx_${quadsTable}_okey ON ${quadsTable} (okey);
CREATE INDEX IF NOT EXISTS idx_${quadsTable}_gkey ON ${quadsTable} (gkey);

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
