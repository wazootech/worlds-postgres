/**
 * Runs the shared commit conformance suite (@worlds/sdk/testing) against
 * Postgres's real commit path, over PGlite: all ten cases, with the converged
 * contract (atomic commit, embedding failure throws, replace import keeps the
 * old graph on failure, default mode "incremental").
 *
 * Postgres commits through the shared SQL core (`@worlds/sqlite/sql-core`) in
 * one SQL transaction and projects chunk rows at commit, so nothing is excluded.
 * `commit-atomicity.test.ts` adds the quad-side checks the suite's chunk-only
 * view cannot make, and `reindex-atomicity.test.ts` pins the reindex contract.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { runCommitConformanceSuite } from "@worlds/sdk/testing";
import { createPostgresCommitHarness } from "./postgres-commit-subject.ts";

test("PostgresRdfjsStore passes the shared commit conformance suite", async () => {
  const closers: Array<() => Promise<void>> = [];
  try {
    const report = await runCommitConformanceSuite({
      create: async ({ embeddingService, searchIndexOnImport }) => {
        const harness = await createPostgresCommitHarness(
          embeddingService,
          searchIndexOnImport,
        );
        closers.push(harness.close);
        return harness.subject;
      },
      contract: {
        atomic: true,
        embeddingFailure: "throws",
        replaceImportFailure: "keeps-old-graph",
        defaultSearchIndexOnImport: "incremental",
      },
    });
    const failures = report.results.flatMap((result) =>
      result.failures.map((failure) => `${result.name}: ${failure}`)
    );
    assert(
      report.results.length === 10,
      `expected 10 cases, ran ${report.results.length}`,
    );
    assert(report.ok, failures.join("\n"));
    // A skipped case is left out of `results` and named in `notes`.
    assert(
      report.results.some((result) => result.name.includes("later-write")),
      `the later-write case must run: ${report.notes?.join("; ")}`,
    );
  } finally {
    for (const close of closers) await close();
  }
});
