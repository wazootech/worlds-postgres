/** PostgresSearchIndex hybrid RRF search tests over PGlite + pgvector. */
import { assertAlmostEquals, assertEquals } from "@std/assert";
import { PostgresSearchIndex } from "./postgres-search-index.ts";
import {
  EX_ABOUT,
  freshIndex,
  hits,
  HYBRID_LOOKUP,
  hybridIndex,
  importQuads,
  LookupEmbeddingService,
  textQuad,
  ThrowingEmbeddingService,
} from "./postgres-search-index-test-helpers.ts";

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
