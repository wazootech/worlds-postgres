/**
 * Commit-time projection through the shared SQL core, over PGlite + pgvector.
 * The conformance suite covers the converged contract; these tests pin what is
 * Postgres-specific: the factory wiring, deletion and rebuild behavior against
 * the Postgres schema, and large commits staying one transaction.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { rejected } from "@/postgres/testing/assertions.ts";
import { DataFactory } from "@wazoo/sparql-engine";
import { FakeEmbeddingService } from "@worlds/sdk/search-index/embedding-service";
import { createPostgresWorldsSdk } from "@/postgres/sdk/mod.ts";
import { createPGliteSql } from "@/postgres/sql/pglite-adapter.ts";
import {
  CONFORMANCE_VECTOR_DIMENSIONS,
  createPostgresCommitHarness,
  type PostgresCommitHarness,
} from "@/postgres/testing/postgres-commit-subject.ts";

const { namedNode, literal, quad } = DataFactory;
const p = namedNode("urn:t:p");
const textQuad = (name: string, graph = "urn:t:g") =>
  quad(
    namedNode(`urn:t:${name}`),
    p,
    literal(`${name} text`),
    namedNode(graph),
  );

const chunkSubjects = async (harness: PostgresCommitHarness) =>
  (await harness.sql.unsafe<{ subject: string }>(
    "SELECT subject FROM worlds_search_chunks",
  )).map((row) => row.subject).sort();

test("the SDK factory projects chunks at commit, so import is searchable without reindex", async () => {
  const sql = await createPGliteSql();
  try {
    const sdk = await createPostgresWorldsSdk({
      sql,
      embeddingService: new FakeEmbeddingService(),
      vectorDimensions: CONFORMANCE_VECTOR_DIMENSIONS,
    });
    await sdk.import({
      source: {
        kind: "serialized",
        contentType: "application/n-quads",
        data: '<urn:t:a> <urn:t:p> "pelican migration" <urn:t:g> .\n',
      },
    });
    const { results } = await sdk.search({ query: "pelican" });
    assert.deepStrictEqual(results?.map((hit) => hit.subject), ["urn:t:a"]);
  } finally {
    await sql.end();
  }
});

test("an embedding failure at commit rejects the import and writes nothing", async () => {
  const sql = await createPGliteSql();
  try {
    const sdk = await createPostgresWorldsSdk({
      sql,
      embeddingService: {
        embed: () => Promise.reject(new Error("embedding service unavailable")),
      },
      vectorDimensions: CONFORMANCE_VECTOR_DIMENSIONS,
    });
    await rejected(
      () =>
        sdk.import({
          source: { kind: "quads", quads: [textQuad("a")] },
        }),
      Error,
    );
    assert.deepStrictEqual(await sql.unsafe("SELECT 1 FROM worlds_quads"), []);
  } finally {
    await sql.end();
  }
});

test("deleting a quad removes its chunk rows; re-adding writes them back", async () => {
  const harness = await createPostgresCommitHarness(new FakeEmbeddingService());
  try {
    const { commit } = harness.subject;
    await commit({ insertions: [textQuad("a"), textQuad("b")], deletions: [] });
    await commit({ insertions: [], deletions: [textQuad("a")] });
    assert.deepStrictEqual(await chunkSubjects(harness), ["urn:t:b"]);
    await commit({ insertions: [textQuad("a")], deletions: [] });
    assert.deepStrictEqual(await chunkSubjects(harness), [
      "urn:t:a",
      "urn:t:b",
    ]);
  } finally {
    await harness.close();
  }
});

test("a commit larger than the shared write batch size is still one transaction", async () => {
  const harness = await createPostgresCommitHarness(new FakeEmbeddingService());
  try {
    const many = Array.from({ length: 1200 }, (_, i) => textQuad(`q${i}`));
    harness.subject.failNextWrite();
    await rejected(
      () => harness.subject.commit({ insertions: many, deletions: [] }),
      Error,
      "injected write failure",
    );
    assert.deepStrictEqual((await harness.subject.storedQuads()).length, 0);
    assert.deepStrictEqual((await harness.subject.chunkedQuadIds()).length, 0);
    await harness.subject.commit({ insertions: many, deletions: [] });
    assert.deepStrictEqual((await harness.subject.storedQuads()).length, 1200);
    assert.deepStrictEqual(
      (await harness.subject.chunkedQuadIds()).length,
      1200,
    );
  } finally {
    await harness.close();
  }
});

test("a patch that repeats a quad stores it once with one set of chunks", async () => {
  const harness = await createPostgresCommitHarness(new FakeEmbeddingService());
  try {
    await harness.subject.commit({
      insertions: [textQuad("a"), textQuad("a")],
      deletions: [],
    });
    assert.deepStrictEqual((await harness.subject.storedQuads()).length, 1);
    assert.deepStrictEqual(await chunkSubjects(harness), ["urn:t:a"]);
  } finally {
    await harness.close();
  }
});

test("a full reindex drops orphan chunk rows; a scoped one touches only its scope", async () => {
  const harness = await createPostgresCommitHarness(new FakeEmbeddingService());
  try {
    await harness.subject.commit({
      insertions: [textQuad("a", "urn:t:g1"), textQuad("b", "urn:t:g2")],
      deletions: [],
    });
    const orphan = (id: string, graph: string) =>
      harness.sql.unsafe(
        "INSERT INTO worlds_search_chunks (id, graph, subject, predicate, text) " +
          "VALUES ($1, $2, $3, 'urn:t:p', 'gone')",
        [`${id}#0`, graph, `urn:t:${id}`],
      );
    await orphan("orphan1", "urn:t:g1");
    await orphan("orphan2", "urn:t:g2");
    // Scoped to g1: only g1's rows are replaced, so orphan2 survives.
    await harness.index.reindex({ include: { graphs: ["urn:t:g1"] } });
    assert.deepStrictEqual(await chunkSubjects(harness), [
      "urn:t:a",
      "urn:t:b",
      "urn:t:orphan1",
      "urn:t:orphan2",
    ]);
    const report = await harness.index.reindex();
    assert.deepStrictEqual(report.processedQuadCount, 2);
    assert.deepStrictEqual(await chunkSubjects(harness), [
      "urn:t:a",
      "urn:t:b",
    ]);
  } finally {
    await harness.close();
  }
});
