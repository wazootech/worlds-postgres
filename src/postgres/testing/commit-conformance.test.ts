/**
 * Runs the shared commit conformance suite (@worlds/sdk/testing) against
 * Postgres's real commit path, over PGlite.
 *
 * Postgres writes search chunk rows only in `reindex()`; its commit
 * (`applyPatch`) is one SQL transaction that never projects. The suite's cases
 * that expect commit-time projection therefore cannot pass, and this file pins
 * exactly which cases those are and why, so the day Postgres gains commit-time
 * projection they flip and this list must be updated. The quad-side halves of
 * those cases live in `commit-atomicity.test.ts`, and the reindex equivalents in
 * `reindex-atomicity.test.ts`.
 */
import { assertEquals } from "@std/assert";
import { runCommitConformanceSuite } from "@worlds/sdk/testing";
import { createPostgresCommitHarness } from "./postgres-commit-subject.ts";

/** Cases that hold for a backend whose commit never projects chunks. */
const APPLICABLE = [
  "disabled import writes no chunks",
  "default mode matches the contract",
  "re-writing a stored quad is idempotent",
];

/** Cases that expect commit-time projection (or commit-time embedding). */
const NEEDS_COMMIT_TIME_PROJECTION = [
  "incremental import projects chunks",
  "deferred import rebuilds once",
  "delete and re-insert keeps the quad",
  "embedding failure follows the contract",
  "write failure leaves no orphan chunks",
  "replace-import failure follows the contract",
];

Deno.test(
  "commit conformance: cases that apply pass; the rest need commit-time projection",
  async () => {
    const closers: Array<() => Promise<void>> = [];
    try {
      const report = await runCommitConformanceSuite({
        create: async ({ embeddingService }) => {
          const harness = await createPostgresCommitHarness(embeddingService);
          closers.push(harness.close);
          return harness.subject;
        },
        contract: {
          atomic: true,
          embeddingFailure: "throws",
          replaceImportFailure: "keeps-old-graph",
          // Nothing projects at commit, which is the "disabled" behavior.
          defaultSearchIndexOnImport: "disabled",
        },
      });
      const passed = report.results.filter((r) => r.ok).map((r) => r.name);
      const failed = report.results.filter((r) => !r.ok).map((r) => r.name);
      assertEquals(passed.sort(), [...APPLICABLE].sort());
      assertEquals(failed.sort(), [...NEEDS_COMMIT_TIME_PROJECTION].sort());
    } finally {
      for (const close of closers) await close();
    }
  },
);
