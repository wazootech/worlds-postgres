/**
 * The quad-side halves of the conformance cases that cannot run as-is against
 * Postgres (see commit-conformance.test.ts): a failed commit rolls the whole
 * transaction back, and a failed replace import keeps the old graph.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { rejected } from "@/postgres/testing/assertions.ts";
import { DataFactory } from "@wazoo/sparql-engine";
import { FakeEmbeddingService } from "@worlds/sdk/search-index/embedding-service";
import { createPostgresCommitHarness } from "./postgres-commit-subject.ts";

const { namedNode, literal, quad } = DataFactory;
const p = namedNode("urn:t:p");
const g = namedNode("urn:t:g");
const text = (name: string) =>
  quad(namedNode(`urn:t:${name}`), p, literal(`${name} text`), g);

const keys = async (
  harness: Awaited<ReturnType<typeof createPostgresCommitHarness>>,
) => (await harness.subject.storedQuads()).map((q) => q.subject.value).sort();

test("a failed commit rolls back every write in the patch", async () => {
  const harness = await createPostgresCommitHarness(new FakeEmbeddingService());
  try {
    await harness.subject.commit({
      insertions: [text("base")],
      deletions: [],
    });
    harness.subject.failNextWrite();
    await rejected(
      () =>
        harness.subject.commit({
          insertions: [text("one"), text("two")],
          deletions: [text("base")],
        }),
      Error,
      "injected write failure",
    );
    // The deletion and both insertions were rolled back together.
    assert.deepStrictEqual(await keys(harness), ["urn:t:base"]);
    // The store is usable afterwards.
    await harness.subject.commit({ insertions: [text("one")], deletions: [] });
    assert.deepStrictEqual(await keys(harness), ["urn:t:base", "urn:t:one"]);
  } finally {
    await harness.close();
  }
});

test("a failed replace import keeps the old graph", async () => {
  const harness = await createPostgresCommitHarness(new FakeEmbeddingService());
  try {
    await harness.subject.commit(
      { insertions: [text("base"), text("three")], deletions: [] },
      { importMode: "merge" },
    );
    harness.subject.failNextWrite();
    await rejected(
      () =>
        harness.subject.commit(
          { insertions: [text("one")], deletions: [] },
          { importMode: "replace" },
        ),
      Error,
      "injected write failure",
    );
    // The wipe ran in the same transaction as the insert, so it rolled back.
    assert.deepStrictEqual(await keys(harness), ["urn:t:base", "urn:t:three"]);
  } finally {
    await harness.close();
  }
});

test("failLaterWrite fails a chunk write after the quad inserts and rolls back", async () => {
  const harness = await createPostgresCommitHarness(new FakeEmbeddingService());
  try {
    await harness.subject.commit({
      insertions: [text("base")],
      deletions: [],
    });
    harness.subject.failLaterWrite?.();
    await rejected(
      () =>
        harness.subject.commit({
          insertions: [text("one"), text("two")],
          deletions: [],
        }),
      Error,
      "injected later write failure",
    );
    // The spy proves the failure was not the first write: a quad insert ran
    // first, and the statement that failed is a chunk-row write after it.
    const ran = harness.sql.lastLaterFailure;
    const quadInsert = ran.findIndex((q) =>
      q.startsWith("INSERT INTO worlds_quads")
    );
    const failed = ran.length - 1;
    assert(quadInsert >= 0, `no quad insert ran: ${ran.join(" | ")}`);
    assert(ran[failed]!.startsWith("INSERT INTO worlds_search_chunks"));
    assert(quadInsert < failed, "the failure must follow the quad inserts");
    // The quad inserts rolled back with the transaction.
    assert.deepStrictEqual(await keys(harness), ["urn:t:base"]);
  } finally {
    await harness.close();
  }
});
