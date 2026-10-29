/** PostgresSearchIndex keyword-scan and ftsLanguage tests over PGlite + pgvector. */
import { assertAlmostEquals, assertEquals } from "@std/assert";
import {
  ex,
  freshIndex,
  hits,
  importQuads,
  literal,
  LookupEmbeddingService,
  namedNode,
  quad,
  textQuad,
  XSD_INTEGER,
} from "./postgres-search-index-test-helpers.ts";

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
