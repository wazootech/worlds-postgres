import { DataFactory } from "@wazoo/sparql-engine";
import type { Quad } from "@rdfjs/types";
import type { EmbeddingService } from "@worlds/sdk/search-index/embedding-service";
import type { SearchResponse } from "@worlds/sdk/search-index";
import { buildPostgresSchemaSql } from "@/postgres/schema/postgres-schema-builder.ts";
import { PostgresRdfjsStore } from "@/postgres/rdfjs-store/postgres-rdfjs-store.ts";
import { createPGliteSql } from "@/postgres/sql/pglite-adapter.ts";
import { PostgresSearchIndex } from "./postgres-search-index.ts";

export const { namedNode, literal, defaultGraph, quad } = DataFactory;

export const ex = (suffix: string) => namedNode(`http://example.org/${suffix}`);

export const EX_ABOUT = "http://example.org/about";
export const XSD_INTEGER = "http://www.w3.org/2001/XMLSchema#integer";

export function textQuad(
  subject: string,
  predicate: string,
  text: string,
  graph?: string,
): Quad {
  return quad(
    ex(subject),
    ex(predicate),
    literal(text),
    graph === undefined ? defaultGraph() : namedNode(graph),
  );
}

export function hits(
  response: SearchResponse,
): NonNullable<SearchResponse["results"]> {
  return response.results ?? [];
}

/**
 * LookupEmbeddingService maps exact texts (chunk texts and the query) to
 * hand-picked vectors, so vector ranking is deterministic in the tests.
 */
export class LookupEmbeddingService implements EmbeddingService {
  public constructor(private readonly lookup: Map<string, number[]>) {}

  public embed(texts: string[]): Promise<Array<number[]>> {
    return Promise.resolve(
      texts.map((text) => this.lookup.get(text) ?? new Array(3).fill(0)),
    );
  }
}

/**
 * KeywordEmbeddingService projects each text to a one-hot vector by which of
 * the configured keywords it contains — deterministic for reindex tests.
 */
export class KeywordEmbeddingService implements EmbeddingService {
  public constructor(private readonly keywords: string[]) {}

  public embed(texts: string[]): Promise<Array<number[]>> {
    return Promise.resolve(
      texts.map((text) => {
        const vector = new Array(this.keywords.length).fill(0) as number[];
        this.keywords.forEach((keyword, index) => {
          if (text.toLowerCase().includes(keyword)) vector[index] = 1;
        });
        return vector;
      }),
    );
  }
}

/**
 * BipolarKeywordEmbeddingService projects each text to [1] when it contains
 * the keyword and [-1] otherwise — non-zero, so every chunk stays indexed by
 * the HNSW cosine index (pgvector skips zero vectors in HNSW scans).
 */
export class BipolarKeywordEmbeddingService implements EmbeddingService {
  public constructor(private readonly keyword: string) {}

  public embed(texts: string[]): Promise<Array<number[]>> {
    return Promise.resolve(
      texts.map((text) => [
        text.toLowerCase().includes(this.keyword) ? 1 : -1,
      ]),
    );
  }
}

/** ThrowingEmbeddingService simulates an embedding API outage. */
export class ThrowingEmbeddingService implements EmbeddingService {
  public embed(): Promise<Array<number[]>> {
    throw new Error("embedding API down");
  }
}

export interface FreshIndex {
  index: PostgresSearchIndex;
  sql: Awaited<ReturnType<typeof createPGliteSql>>;
  close: () => Promise<void>;
}

export async function freshIndex(
  options: {
    embeddingService?: EmbeddingService;
    vectorDimensions?: number;
    ftsLanguage?: string;
  } = {},
): Promise<FreshIndex> {
  const dimension = options.vectorDimensions ?? 3;
  const sql = await createPGliteSql({
    schemaSql: buildPostgresSchemaSql({
      vectorDimension: dimension,
      ftsLanguage: options.ftsLanguage,
    }),
  });
  const index = new PostgresSearchIndex({
    sql,
    embeddingService: options.embeddingService,
    vectorDimensions: options.vectorDimensions,
    ftsLanguage: options.ftsLanguage,
  });
  return { index, sql, close: () => sql.end() };
}

export async function importQuads(
  sql: FreshIndex["sql"],
  quads: Quad[],
): Promise<void> {
  const store = new PostgresRdfjsStore({ sql });
  await store.ensureSchema();
  await store.applyPatch({ insertions: quads, deletions: [] });
}

/** Deterministic hybrid corpus: distinct cosine distances for every chunk. */
export const HYBRID_QUADS: Quad[] = [
  textQuad("ethan", "about", "Ethan loves bagels"),
  textQuad("gregory", "about", "Gregory loves donuts"),
  textQuad("sandra", "about", "Sandra likes pizza"),
  textQuad("wendy", "about", "Wendy studies databases"),
];

export const HYBRID_LOOKUP = new Map<string, number[]>([
  // Query vector lands exactly on Ethan's chunk.
  ["bagels", [1, 0, 0]],
  ["", [1, 0, 0]],
  ["Ethan loves bagels", [1, 0, 0]],
  ["Maya eats bagels", [1, 0, 0]],
  // Unit vectors with distinct directions give distinct cosine distances
  // from [1,0,0]: wendy 0.5, gregory 1.0, sandra 1.5 — deterministic ranks 1..4.
  ["Wendy studies databases", [0.5, 0.866, 0]],
  ["Gregory loves donuts", [0, 1, 0]],
  ["Sandra likes pizza", [-0.5, 0.866, 0]],
]);

export async function hybridIndex(): Promise<FreshIndex> {
  const fresh = await freshIndex({
    embeddingService: new LookupEmbeddingService(HYBRID_LOOKUP),
    vectorDimensions: 3,
  });
  await importQuads(fresh.sql, HYBRID_QUADS);
  await fresh.index.reindex();
  return fresh;
}
