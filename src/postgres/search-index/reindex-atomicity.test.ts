/**
 * reindex() chunks and embeds a page before writing it, then replaces that
 * page's chunk rows in one SQL transaction. These tests pin the failure
 * contract: an embedding or write failure leaves the failing page's existing
 * rows untouched, earlier pages stay indexed, and embedding inputs are
 * de-duplicated. They are the reindex equivalents of the shared conformance
 * cases Postgres cannot run at commit time (see commit-conformance.test.ts).
 */
import { assertEquals, assertRejects } from "@std/assert";
import { DataFactory } from "@wazoo/sparql-engine";
import type { EmbeddingService } from "@worlds/sdk/search-index/embedding-service";
import {
  CONFORMANCE_VECTOR_DIMENSIONS,
  createPostgresCommitHarness,
  type PostgresCommitHarness,
} from "@/postgres/testing/postgres-commit-subject.ts";

const { namedNode, literal, quad } = DataFactory;
const p = namedNode("urn:t:p");
const g = namedNode("urn:t:g");
const textQuad = (name: string, value = `${name} text`) =>
  quad(namedNode(`urn:t:${name}`), p, literal(value), g);

/** ScriptedEmbeddings stamps each vector with a version and can fail on a chosen call. */
class ScriptedEmbeddings implements EmbeddingService {
  public version = 1;
  public failOnCall: number | null = null;
  public readonly calls: string[][] = [];

  public embed(texts: string[]): Promise<Array<number[]>> {
    this.calls.push(texts);
    if (this.failOnCall === this.calls.length) {
      return Promise.reject(new Error("embedding service unavailable"));
    }
    return Promise.resolve(texts.map(() => {
      const vector = new Array<number>(CONFORMANCE_VECTOR_DIMENSIONS).fill(0);
      vector[0] = this.version;
      return vector;
    }));
  }
}

/** versions maps each chunk row's subject to the version stamped on its vector. */
async function versions(
  harness: PostgresCommitHarness,
): Promise<Record<string, number | null>> {
  const rows = await harness.sql.unsafe<
    { subject: string; embedding: string | null }
  >("SELECT subject, embedding::text AS embedding FROM worlds_search_chunks");
  return Object.fromEntries(
    rows.map((row) => [
      row.subject,
      row.embedding === null ? null : JSON.parse(row.embedding)[0],
    ]).sort(([a], [b]) => String(a).localeCompare(String(b))),
  );
}

/** indexed creates four textual quads, two per page at readPageSize 2, indexed at version 1. */
async function indexedHarness() {
  const embeddings = new ScriptedEmbeddings();
  const harness = await createPostgresCommitHarness(embeddings);
  await harness.subject.commit({
    insertions: ["a1", "a2", "a3", "a4"].map((n) => textQuad(n)),
    deletions: [],
  });
  await harness.index.reindex({ readPageSize: 2 });
  assertEquals(await versions(harness), {
    "urn:t:a1": 1,
    "urn:t:a2": 1,
    "urn:t:a3": 1,
    "urn:t:a4": 1,
  });
  return { embeddings, harness };
}

Deno.test("an embedding failure on a later page keeps that page's old rows and earlier pages", async () => {
  const { embeddings, harness } = await indexedHarness();
  try {
    embeddings.version = 2;
    embeddings.failOnCall = embeddings.calls.length + 2; // page two
    await assertRejects(
      () => harness.index.reindex({ readPageSize: 2 }),
      Error,
      "failed to vectorize literal chunk blocks",
    );
    // Page one was rewritten, page two still has its previous vectors.
    assertEquals(await versions(harness), {
      "urn:t:a1": 2,
      "urn:t:a2": 2,
      "urn:t:a3": 1,
      "urn:t:a4": 1,
    });
  } finally {
    await harness.close();
  }
});

Deno.test("a failed page write rolls the page back", async () => {
  const { embeddings, harness } = await indexedHarness();
  try {
    embeddings.version = 2;
    harness.sql.failNextTransaction();
    await assertRejects(
      () => harness.index.reindex({ readPageSize: 2 }),
      Error,
      "injected write failure",
    );
    // The delete and the upsert were one transaction, so nothing changed.
    assertEquals(await versions(harness), {
      "urn:t:a1": 1,
      "urn:t:a2": 1,
      "urn:t:a3": 1,
      "urn:t:a4": 1,
    });
  } finally {
    await harness.close();
  }
});

Deno.test("an embedding failure on a fresh index writes no chunk rows", async () => {
  const embeddings = new ScriptedEmbeddings();
  embeddings.failOnCall = 1;
  const harness = await createPostgresCommitHarness(embeddings);
  try {
    await harness.subject.commit({
      insertions: [textQuad("a1"), textQuad("a2")],
      deletions: [],
    });
    await assertRejects(() => harness.index.reindex(), Error);
    assertEquals(await versions(harness), {});
  } finally {
    await harness.close();
  }
});

Deno.test("reindex embeds each distinct chunk text once", async () => {
  const embeddings = new ScriptedEmbeddings();
  const harness = await createPostgresCommitHarness(embeddings);
  try {
    await harness.subject.commit({
      insertions: [
        textQuad("a1", "same"),
        textQuad("a2", "same"),
        textQuad("a3", "other"),
      ],
      deletions: [],
    });
    const report = await harness.index.reindex();
    assertEquals(report.chunkRowCount, 3);
    assertEquals(embeddings.calls.length, 1);
    assertEquals([...embeddings.calls[0]!].sort(), ["other", "same"]);
    // Every chunk row, including the duplicate text, got a vector.
    assertEquals(await versions(harness), {
      "urn:t:a1": 1,
      "urn:t:a2": 1,
      "urn:t:a3": 1,
    });
  } finally {
    await harness.close();
  }
});
