/** PostgresSearchIndex reindex tests over PGlite + pgvector. */
import { assertAlmostEquals, assertEquals, assertRejects } from "@std/assert";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import type { Quad } from "@rdfjs/types";
import { PostgresSearchIndex } from "./postgres-search-index.ts";
import {
  BipolarKeywordEmbeddingService,
  ex,
  freshIndex,
  hits,
  HYBRID_LOOKUP,
  importQuads,
  KeywordEmbeddingService,
  LookupEmbeddingService,
  quad,
  textQuad,
} from "./postgres-search-index-test-helpers.ts";

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
  "reindex splits long literals into multiple chunk rows via the textSplitter",
  async () => {
    const longText =
      "Ethan researched the history of bagels across many regions and " +
      "documented how boiling and baking change the texture of the dough " +
      "over time in his notebook.";
    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: 30,
      chunkOverlap: 0,
    });
    const expectedDocs = await splitter.createDocuments([longText]);
    assertEquals(expectedDocs.length, 6);

    const { sql, close } = await freshIndex({ vectorDimensions: 1 });
    try {
      await importQuads(sql, [
        textQuad("ethan", "about", longText),
        textQuad("gregory", "about", "Gregory prefers donuts"),
      ]);

      const splitIndex = new PostgresSearchIndex({
        sql,
        embeddingService: new BipolarKeywordEmbeddingService("bagel"),
        vectorDimensions: 1,
        textSplitter: splitter,
      });
      const report = await splitIndex.reindex({ readPageSize: 5 });
      assertEquals(report.processedQuadCount, 2);
      // 6 split pieces for Ethan's long literal + 1 for Gregory's.
      assertEquals(report.chunkRowCount, 7);

      const ethanRows = await sql.unsafe<{
        id: string;
        text: string;
        embedding: string;
      }>(
        "SELECT id, text, embedding::text AS embedding " +
          "FROM worlds_search_chunks WHERE subject = $1 ORDER BY id",
        ["http://example.org/ethan"],
      );
      assertEquals(ethanRows.length, 6);
      assertEquals(
        ethanRows.map((row) => row.text),
        expectedDocs.map((doc) => doc.pageContent),
      );
      // Every split piece is embedded; only the piece containing "bagels"
      // gets [1], the rest [-1] (non-zero, so HNSW keeps indexing them).
      assertEquals(
        ethanRows.filter((row) => row.embedding === "[1]").length,
        1,
      );
      assertEquals(
        ethanRows.filter((row) => row.embedding === "[-1]").length,
        5,
      );

      // Hybrid search returns a split piece (not the full literal); the
      // piece containing "bagels" wins both branches at rank 1.
      const bagelsDoc = expectedDocs.find((doc) =>
        doc.pageContent.toLowerCase().includes("bagels")
      )!;
      const res = hits(await splitIndex.search({ query: "bagels" }));
      assertEquals(res.length, 7);
      assertEquals(res[0]!.text, bagelsDoc.pageContent);
      assertAlmostEquals(res[0]!.score, 2 / 61, 6);
    } finally {
      await close();
    }
  },
);

Deno.test(
  "reindex refresh clears stale chunk rows when the split changes",
  async () => {
    const longText =
      "Ethan researched the history of bagels across many regions and " +
      "documented how boiling and baking change the texture of the dough.";
    const { sql, close } = await freshIndex();
    try {
      await importQuads(sql, [textQuad("ethan", "about", longText)]);

      // Coarse split first.
      const coarse = new RecursiveCharacterTextSplitter({
        chunkSize: 60,
        chunkOverlap: 0,
      });
      const coarseIndex = new PostgresSearchIndex({
        sql,
        textSplitter: coarse,
      });
      const coarseReport = await coarseIndex.reindex();
      assertEquals(
        coarseReport.chunkRowCount,
        (await coarse.createDocuments([longText])).length,
      );

      // Finer split must replace the coarse rows, not accumulate.
      const fine = new RecursiveCharacterTextSplitter({
        chunkSize: 30,
        chunkOverlap: 0,
      });
      const fineIndex = new PostgresSearchIndex({
        sql,
        textSplitter: fine,
      });
      const fineReport = await fineIndex.reindex();
      const fineDocs = await fine.createDocuments([longText]);
      assertEquals(fineReport.chunkRowCount, fineDocs.length);

      const rows = await sql.unsafe<{ text: string }>(
        "SELECT text FROM worlds_search_chunks ORDER BY id",
      );
      assertEquals(rows.length, fineDocs.length);
      assertEquals(
        rows.map((row) => row.text),
        fineDocs.map((doc) => doc.pageContent),
      );
    } finally {
      await close();
    }
  },
);
