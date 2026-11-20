/**
 * The quad-side halves of the conformance cases that cannot run as-is against
 * Postgres (see commit-conformance.test.ts): a failed commit rolls the whole
 * transaction back, and a failed replace import keeps the old graph.
 */
import { assertEquals, assertRejects } from "@std/assert";
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

Deno.test("a failed commit rolls back every write in the patch", async () => {
  const harness = await createPostgresCommitHarness(new FakeEmbeddingService());
  try {
    await harness.subject.commit({
      insertions: [text("base")],
      deletions: [],
    });
    harness.subject.failNextWrite();
    await assertRejects(
      () =>
        harness.subject.commit({
          insertions: [text("one"), text("two")],
          deletions: [text("base")],
        }),
      Error,
      "injected write failure",
    );
    // The deletion and both insertions were rolled back together.
    assertEquals(await keys(harness), ["urn:t:base"]);
    // The store is usable afterwards.
    await harness.subject.commit({ insertions: [text("one")], deletions: [] });
    assertEquals(await keys(harness), ["urn:t:base", "urn:t:one"]);
  } finally {
    await harness.close();
  }
});

Deno.test("a failed replace import keeps the old graph", async () => {
  const harness = await createPostgresCommitHarness(new FakeEmbeddingService());
  try {
    await harness.subject.commit(
      { insertions: [text("base"), text("three")], deletions: [] },
      { importMode: "merge" },
    );
    harness.subject.failNextWrite();
    await assertRejects(
      () =>
        harness.subject.commit(
          { insertions: [text("one")], deletions: [] },
          { importMode: "replace" },
        ),
      Error,
      "injected write failure",
    );
    // The wipe ran in the same transaction as the insert, so it rolled back.
    assertEquals(await keys(harness), ["urn:t:base", "urn:t:three"]);
  } finally {
    await harness.close();
  }
});
