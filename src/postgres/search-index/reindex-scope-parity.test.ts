/**
 * Scoped-reindex parity with the shared SQL core (wazootech/worlds-sdk-ts#265):
 * `processedQuadCount` is every stored quad scanned, in scope or not; a scoped
 * rebuild replaces only the in-scope quads' chunk rows and keeps the rest; a
 * scope with no criteria is unscoped; an unscoped rebuild drops the stale rows
 * of quads that no longer exist. Each case runs through the public reindex().
 * The harness writes quads only (`searchIndexOnImport: "disabled"`), so every
 * chunk row here comes from reindex(); vectors carry a version so a refreshed
 * row is told apart from a kept one.
 */
import test from "node:test";
import assert from "node:assert/strict";
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
const NAMES = ["a1", "a2", "a3", "a4", "a5"];

/** VersionedEmbeddings stamps every vector with the current version. */
class VersionedEmbeddings implements EmbeddingService {
  public version = 1;

  public embed(texts: string[]): Promise<Array<number[]>> {
    return Promise.resolve(texts.map(() => {
      const vector = Array.from({ length: CONFORMANCE_VECTOR_DIMENSIONS }, () => 0);
      vector[0] = this.version;
      return vector;
    }));
  }
}

/** versions maps each chunk row's subject to its vector's version stamp. */
async function versions(h: PostgresCommitHarness) {
  const rows = await h.sql.unsafe<{ subject: string; embedding: string }>(
    "SELECT subject, embedding::text AS embedding FROM worlds_search_chunks",
  );
  return Object.fromEntries(
    rows.map((r) => [r.subject, JSON.parse(r.embedding)[0] as number])
      .sort(([a], [b]) => String(a).localeCompare(String(b))),
  );
}

/** indexed stores five quads (a1 in the default graph) and indexes them at version 1. */
async function indexed() {
  const embeddings = new VersionedEmbeddings();
  const harness = await createPostgresCommitHarness(embeddings, "disabled");
  await harness.subject.commit({
    insertions: NAMES.map((n) =>
      quad(
        namedNode(`urn:t:${n}`),
        p,
        literal(`${n} text`),
        n === "a1" ? DataFactory.defaultGraph() : g,
      )
    ),
    deletions: [],
  });
  await harness.index.reindex();
  return { embeddings, harness };
}

const all = (version: number) =>
  Object.fromEntries(NAMES.map((n) => [`urn:t:${n}`, version]));

test("a scoped include reindex refreshes in-scope rows, keeps the rest, and scans every quad", async () => {
  const { embeddings, harness } = await indexed();
  try {
    embeddings.version = 2;
    const report = await harness.index.reindex({
      include: { subjects: ["urn:t:a2", "urn:t:a4"] },
      readPageSize: 2,
    });
    assert.deepStrictEqual(report, { processedQuadCount: 5, chunkRowCount: 2 });
    assert.deepStrictEqual(await versions(harness), {
      ...all(1),
      "urn:t:a2": 2,
      "urn:t:a4": 2,
    });
  } finally {
    await harness.close();
  }
});

test("a scoped exclude reindex refreshes the rest, keeps the excluded, and scans every quad", async () => {
  const { embeddings, harness } = await indexed();
  try {
    embeddings.version = 2;
    const report = await harness.index.reindex({
      exclude: { graphs: ["urn:t:g"] }, // leaves only the default-graph a1
    });
    assert.deepStrictEqual(report, { processedQuadCount: 5, chunkRowCount: 1 });
    assert.deepStrictEqual(await versions(harness), {
      ...all(1),
      "urn:t:a1": 2,
    });
  } finally {
    await harness.close();
  }
});

test("a scope that matches nothing writes no rows and still scans every quad", async () => {
  const { embeddings, harness } = await indexed();
  try {
    embeddings.version = 2;
    const report = await harness.index.reindex({
      include: { subjects: ["urn:t:nobody"] },
    });
    assert.deepStrictEqual(report, { processedQuadCount: 5, chunkRowCount: 0 });
    assert.deepStrictEqual(await versions(harness), all(1));
  } finally {
    await harness.close();
  }
});

test("empty criteria are unscoped: every row is refreshed and a stale row is dropped", async () => {
  const { embeddings, harness } = await indexed();
  try {
    await harness.sql.unsafe("DELETE FROM worlds_quads WHERE skey LIKE $1", [
      "%a5%",
    ]);
    embeddings.version = 2;
    const report = await harness.index.reindex({
      include: { subjects: [], graphs: undefined },
      exclude: {},
    });
    assert.deepStrictEqual(report, { processedQuadCount: 4, chunkRowCount: 4 });
    const { "urn:t:a5": _gone, ...rest } = all(2);
    assert.deepStrictEqual(await versions(harness), rest);
  } finally {
    await harness.close();
  }
});

test("an unscoped reindex removes the chunk row of a deleted quad", async () => {
  const { harness } = await indexed();
  try {
    await harness.sql.unsafe("DELETE FROM worlds_quads WHERE skey LIKE $1", [
      "%a3%",
    ]);
    const report = await harness.index.reindex({ readPageSize: 2 });
    assert.deepStrictEqual(report, { processedQuadCount: 4, chunkRowCount: 4 });
    const { "urn:t:a3": _gone, ...rest } = all(1);
    assert.deepStrictEqual(await versions(harness), rest);
  } finally {
    await harness.close();
  }
});

test("a scoped reindex keeps the stale row of a deleted quad", async () => {
  const { harness } = await indexed();
  try {
    await harness.sql.unsafe("DELETE FROM worlds_quads WHERE skey LIKE $1", [
      "%a3%",
    ]);
    const report = await harness.index.reindex({
      include: { subjects: ["urn:t:a1"] },
    });
    assert.deepStrictEqual(report, { processedQuadCount: 4, chunkRowCount: 1 });
    assert.deepStrictEqual(await versions(harness), all(1));
  } finally {
    await harness.close();
  }
});

test("keyset paging covers every quad across pages for scoped and unscoped runs", async () => {
  const { embeddings, harness } = await indexed();
  try {
    embeddings.version = 2;
    for (const pageSize of [1, 2, 3, 5, 6]) {
      const unscoped = await harness.index.reindex({ readPageSize: pageSize });
      assert.deepStrictEqual(unscoped, {
        processedQuadCount: 5,
        chunkRowCount: 5,
      });
      const scoped = await harness.index.reindex({
        include: { predicates: ["urn:t:p"] },
        exclude: { subjects: ["urn:t:a3"] },
        readPageSize: pageSize,
      });
      assert.deepStrictEqual(scoped, {
        processedQuadCount: 5,
        chunkRowCount: 4,
      });
    }
    assert.deepStrictEqual(await versions(harness), all(2));
  } finally {
    await harness.close();
  }
});
