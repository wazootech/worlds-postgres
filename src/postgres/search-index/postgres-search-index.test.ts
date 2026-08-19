/**
 * PostgresSearchIndex integration tests over PGlite + pgvector (WASM
 * PostgreSQL, in-memory). Covers the worlds-postgres#10 gaps: hybrid RRF
 * search (keyword tsvector branch + pgvector cosine branch fused as
 * 1/(60 + rank)), reindex() embedding population with keyset pagination,
 * ftsLanguage, and the keyword-parity scan — all against a live database.
 */
import { assertAlmostEquals, assertEquals, assertRejects } from "@std/assert";
import { DataFactory } from "@wazoo/sparql-engine";
import type { Quad } from "@rdfjs/types";
import type { EmbeddingService } from "@worlds/sdk/search-index/embedding-service";
import type { SearchResponse } from "@worlds/sdk/search-index";
import { buildPostgresSchemaSql } from "@/postgres/schema/postgres-schema-builder.ts";
import { PostgresRdfjsStore } from "@/postgres/rdfjs-store/postgres-rdfjs-store.ts";
import { createPGliteSql } from "@/postgres/sql/pglite-adapter.ts";
import { PostgresSearchIndex } from "./postgres-search-index.ts";

const { namedNode, literal, defaultGraph, quad } = DataFactory;

const ex = (suffix: string) => namedNode(`http://example.org/${suffix}`);

const EX_ABOUT = "http://example.org/about";
const XSD_INTEGER = "http://www.w3.org/2001/XMLSchema#integer";

function textQuad(
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

function hits(
  response: SearchResponse,
): NonNullable<SearchResponse["results"]> {
  return response.results ?? [];
}

/**
 * LookupEmbeddingService maps exact texts (chunk texts and the query) to
 * hand-picked vectors, so vector ranking is deterministic in the tests.
 */
class LookupEmbeddingService implements EmbeddingService {
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
class KeywordEmbeddingService implements EmbeddingService {
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

/** ThrowingEmbeddingService simulates an embedding API outage. */
class ThrowingEmbeddingService implements EmbeddingService {
  public embed(): Promise<Array<number[]>> {
    throw new Error("embedding API down");
  }
}

interface FreshIndex {
  index: PostgresSearchIndex;
  sql: Awaited<ReturnType<typeof createPGliteSql>>;
  close: () => Promise<void>;
}

async function freshIndex(
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

async function importQuads(
  sql: FreshIndex["sql"],
  quads: Quad[],
): Promise<void> {
  const store = new PostgresRdfjsStore({ sql });
  await store.ensureSchema();
  await store.applyPatch({ insertions: quads, deletions: [] });
}

/** Deterministic hybrid corpus: distinct cosine distances for every chunk. */
const HYBRID_QUADS: Quad[] = [
  textQuad("ethan", "about", "Ethan loves bagels"),
  textQuad("gregory", "about", "Gregory loves donuts"),
  textQuad("sandra", "about", "Sandra likes pizza"),
  textQuad("wendy", "about", "Wendy studies databases"),
];

const HYBRID_LOOKUP = new Map<string, number[]>([
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

async function hybridIndex(): Promise<FreshIndex> {
  const fresh = await freshIndex({
    embeddingService: new LookupEmbeddingService(HYBRID_LOOKUP),
    vectorDimensions: 3,
  });
  await importQuads(fresh.sql, HYBRID_QUADS);
  await fresh.index.reindex();
  return fresh;
}

Deno.test(
  "keyword-only search scans live quads with the reference's exact semantics",
  async () => {
    const { index, sql, close } = await freshIndex();
    try {
      await importQuads(sql, [
        textQuad("ethan", "about", "Ethan loves bagels"),
        textQuad("gregory", "about", "Gregory loves donuts"),
        // Non-textual objects must never match.
        quad(ex("s"), ex("p"), ex("o")),
        quad(ex("ethan"), ex("about"), literal("42", namedNode(XSD_INTEGER))),
      ]);

      const res = hits(await index.search({ query: "BAGELS" }));
      assertEquals(res.length, 1);
      assertEquals(res[0]!.text, "Ethan loves bagels");
      assertEquals(res[0]!.subject, "http://example.org/ethan");
      assertEquals(res[0]!.score, 1.0);

      // Case-insensitive substring, like the reference's String.includes.
      const partial = hits(await index.search({ query: "loves ba" }));
      assertEquals(partial.length, 1);
      const none = hits(await index.search({ query: "croissant" }));
      assertEquals(none.length, 0);
    } finally {
      await close();
    }
  },
);

Deno.test(
  "hybrid search fuses keyword FTS and vector ranks with 1/(60 + rank) RRF",
  async () => {
    const { index, close } = await hybridIndex();
    try {
      const res = hits(await index.search({ query: "bagels" }));
      assertEquals(res.length, 4);

      const [ethan, wendy, gregory, sandra] = res;
      // Ethan matches both branches at rank 1: 1/61 + 1/61.
      assertEquals(ethan!.text, "Ethan loves bagels");
      assertAlmostEquals(ethan!.score, 2 / 61, 6);
      // The rest match the vector branch only, ranked by cosine distance.
      assertEquals(wendy!.text, "Wendy studies databases");
      assertAlmostEquals(wendy!.score, 1 / 62, 6);
      assertEquals(gregory!.text, "Gregory loves donuts");
      assertAlmostEquals(gregory!.score, 1 / 63, 6);
      assertEquals(sandra!.text, "Sandra likes pizza");
      assertAlmostEquals(sandra!.score, 1 / 64, 6);

      // topK truncates the fused ranking.
      const top2 = hits(await index.search({ query: "bagels", topK: 2 }));
      assertEquals(top2.length, 2);
      assertEquals(top2[0]!.text, "Ethan loves bagels");
      assertEquals(top2[1]!.text, "Wendy studies databases");

      // minScore filters the fused scores.
      const minScore = hits(
        await index.search({ query: "bagels", minScore: 0.02 }),
      );
      assertEquals(minScore.length, 1);
      assertEquals(minScore[0]!.text, "Ethan loves bagels");
    } finally {
      await close();
    }
  },
);

Deno.test(
  "hybrid search scopes by QuadFilter include/exclude on chunk columns",
  async () => {
    const { index, close } = await hybridIndex();
    try {
      const includeSubject = hits(
        await index.search({
          query: "bagels",
          include: { subjects: ["http://example.org/gregory"] },
        }),
      );
      assertEquals(includeSubject.length, 1);
      assertEquals(includeSubject[0]!.text, "Gregory loves donuts");

      const excludePredicate = hits(
        await index.search({
          query: "bagels",
          exclude: { predicates: [EX_ABOUT] },
        }),
      );
      assertEquals(excludePredicate.length, 0);
    } finally {
      await close();
    }
  },
);

Deno.test(
  "hybrid search scopes graphs: named graph IRI or empty string for the default graph",
  async () => {
    const fresh = await freshIndex({
      embeddingService: new LookupEmbeddingService(HYBRID_LOOKUP),
      vectorDimensions: 3,
    });
    const { index, sql, close } = fresh;
    try {
      await importQuads(sql, [
        textQuad("ethan", "about", "Ethan loves bagels"),
        textQuad("maya", "about", "Maya eats bagels", "urn:g1"),
      ]);
      await index.reindex();

      const named = hits(
        await index.search({
          query: "bagels",
          include: { graphs: ["urn:g1"] },
        }),
      );
      assertEquals(named.length, 1);
      assertEquals(named[0]!.subject, "http://example.org/maya");

      const defaultGraph = hits(
        await index.search({
          query: "bagels",
          include: { graphs: [""] },
        }),
      );
      assertEquals(defaultGraph.length, 1);
      assertEquals(defaultGraph[0]!.subject, "http://example.org/ethan");

      const excludeNamed = hits(
        await index.search({
          query: "bagels",
          exclude: { graphs: ["urn:g1"] },
        }),
      );
      assertEquals(excludeNamed.length, 1);
      assertEquals(excludeNamed[0]!.subject, "http://example.org/ethan");
    } finally {
      await close();
    }
  },
);

Deno.test(
  "hybrid search degrades to FTS-only when query-time embedding fails",
  async () => {
    // Reindex with text-only chunks (no embedding service), then search with
    // an index whose embedding service throws.
    const textOnly = await freshIndex();
    const { sql, close } = textOnly;
    try {
      await importQuads(sql, [
        textQuad("ethan", "about", "Ethan loves bagels"),
        textQuad("gregory", "about", "Gregory loves donuts"),
      ]);
      await textOnly.index.reindex();

      const degraded = new PostgresSearchIndex({
        sql,
        embeddingService: new ThrowingEmbeddingService(),
        vectorDimensions: 3,
      });
      const res = hits(await degraded.search({ query: "bagels" }));
      assertEquals(res.length, 1);
      assertEquals(res[0]!.text, "Ethan loves bagels");
      assertAlmostEquals(res[0]!.score, 1 / 61, 6);
    } finally {
      await close();
    }
  },
);

Deno.test(
  "hybrid search runs the vector branch alone for an empty query",
  async () => {
    const { index, close } = await hybridIndex();
    try {
      // The empty query embeds to Ethan's vector (HYBRID_LOOKUP[\"\"]), so
      // the vector branch alone ranks by cosine distance: ethan 1/61,
      // wendy 1/62, gregory 1/63, sandra 1/64.
      const res = hits(await index.search({ query: "" }));
      assertEquals(res.length, 4);
      const [ethan, wendy, gregory, sandra] = res;
      assertEquals(ethan!.text, "Ethan loves bagels");
      assertAlmostEquals(ethan!.score, 1 / 61, 6);
      assertEquals(wendy!.text, "Wendy studies databases");
      assertAlmostEquals(wendy!.score, 1 / 62, 6);
      assertEquals(gregory!.text, "Gregory loves donuts");
      assertAlmostEquals(gregory!.score, 1 / 63, 6);
      assertEquals(sandra!.text, "Sandra likes pizza");
      assertAlmostEquals(sandra!.score, 1 / 64, 6);
    } finally {
      await close();
    }
  },
);

Deno.test(
  "reindex keyset-paginates every quad and populates chunk embeddings",
  async () => {
    const fresh = await freshIndex({
      embeddingService: new KeywordEmbeddingService(["bagel", "donut"]),
      vectorDimensions: 2,
    });
    const { index, sql, close } = fresh;
    try {
      const textual: Quad[] = [];
      for (let i = 0; i < 15; i++) {
        textual.push(
          textQuad(
            `s${i}`,
            "about",
            i % 2 === 0
              ? `Subject ${i} enjoys bagels`
              : `Subject ${i} prefers donuts`,
          ),
        );
      }
      await importQuads(sql, [
        ...textual,
        quad(ex("iri"), ex("p"), ex("o")),
        quad(ex("iri2"), ex("p"), ex("o")),
      ]);

      // 17 quads, page size 5 → 4 pages. The keyset fix means every quad is
      // processed (the old LIMIT-only scan stopped after the first page).
      const report = await index.reindex({ readPageSize: 5 });
      assertEquals(report.processedQuadCount, 17);
      assertEquals(report.chunkRowCount, 15);

      const embedded = await sql.unsafe<{ count: string }>(
        "SELECT COUNT(*) AS count FROM worlds_search_chunks " +
          "WHERE embedding IS NOT NULL",
      );
      assertEquals(Number(embedded[0]!.count), 15);

      const bagelRow = await sql.unsafe<{ embedding: string }>(
        "SELECT embedding::text AS embedding FROM worlds_search_chunks " +
          "WHERE subject = $1",
        ["http://example.org/s0"],
      );
      assertEquals(bagelRow[0]!.embedding, "[1,0]");
      const donutRow = await sql.unsafe<{ embedding: string }>(
        "SELECT embedding::text AS embedding FROM worlds_search_chunks " +
          "WHERE subject = $1",
        ["http://example.org/s1"],
      );
      assertEquals(donutRow[0]!.embedding, "[0,1]");

      // Idempotent rerun reports the same counts.
      const again = await index.reindex({ readPageSize: 5 });
      assertEquals(again.processedQuadCount, 17);
      assertEquals(again.chunkRowCount, 15);
    } finally {
      await close();
    }
  },
);

Deno.test(
  "reindex honors the QuadFilter include scope and validates embedding length",
  async () => {
    const fresh = await freshIndex({
      embeddingService: new LookupEmbeddingService(HYBRID_LOOKUP),
      vectorDimensions: 3,
    });
    const { index, sql, close } = fresh;
    try {
      await importQuads(sql, [
        textQuad("ethan", "about", "Ethan loves bagels"),
        textQuad("gregory", "about", "Gregory loves donuts"),
      ]);

      const scoped = await index.reindex({
        include: { subjects: ["http://example.org/gregory"] },
      });
      assertEquals(scoped.processedQuadCount, 1);
      assertEquals(scoped.chunkRowCount, 1);
      const chunkRows = await sql.unsafe<{ subject: string }>(
        "SELECT subject FROM worlds_search_chunks",
      );
      assertEquals(chunkRows.length, 1);
      assertEquals(chunkRows[0]!.subject, "http://example.org/gregory");

      // A 3-dim embedding against a configured vectorDimensions of 2 must
      // be rejected up front.
      const mismatched = await freshIndex({
        embeddingService: new LookupEmbeddingService(HYBRID_LOOKUP),
        vectorDimensions: 2,
      });
      try {
        await importQuads(mismatched.sql, [
          textQuad("ethan", "about", "Ethan loves bagels"),
        ]);
        await assertRejects(
          () => mismatched.index.reindex(),
          Error,
          "vectorDimensions",
        );
      } finally {
        await mismatched.close();
      }
    } finally {
      await close();
    }
  },
);

Deno.test(
  "ftsLanguage flows into the generated tsvector and hybrid queries",
  async () => {
    // 'simple' does not stem: the exact token "bagels" matches, but the
    // stemmed spelling "bagel" matches only under a stemming config.
    const fresh = await freshIndex({
      embeddingService: new LookupEmbeddingService(
        new Map([
          ["bagels", [1, 0, 0]],
          ["bagel", [1, 0, 0]],
          ["Ethan loves bagels", [1, 0, 0]],
        ]),
      ),
      vectorDimensions: 3,
      ftsLanguage: "simple",
    });
    const { index, sql, close } = fresh;
    try {
      await importQuads(sql, [
        textQuad("ethan", "about", "Ethan loves bagels"),
      ]);
      await index.reindex();

      // Exact token: FTS branch (rank 1) + vector branch (rank 1) = 2/61.
      const exact = hits(await index.search({ query: "bagels" }));
      assertEquals(exact.length, 1);
      assertAlmostEquals(exact[0]!.score, 2 / 61, 6);

      // Stemmed spelling: 'simple' matches no token, so only the vector
      // branch contributes (rank 1) = 1/61.
      const stemmed = hits(await index.search({ query: "bagel" }));
      assertEquals(stemmed.length, 1);
      assertAlmostEquals(stemmed[0]!.score, 1 / 61, 6);
    } finally {
      await close();
    }
  },
);
