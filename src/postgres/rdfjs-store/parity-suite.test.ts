/**
 * Phase-4 parity suite (workspace#65, #72) — consumes the shared
 * @worlds/sdk/testing harness with the zero-dependency in-memory reference
 * (@worlds/sdk/memory's createMemoryWorldsSdk) against the postgres SDK facade
 * (createPostgresWorldsSdk over the real PostgresRdfjsStore, PGlite substrate).
 *
 * Every candidate factory call gets a fresh in-memory PGlite instance, so
 * no state leaks between cases or between the round-trip's two stores.
 *
 * Search ordering is compared set-wise (strictSearchOrder: false):
 * SQL keyword-scan order is a store implementation detail, not a parity
 * contract.
 */
import { assertEquals } from "@std/assert";
import { parityCorpus, runParitySuite } from "@worlds/sdk/testing";
import { createMemoryWorldsSdk } from "@worlds/sdk/memory";
import type { WorldsSdkInterface } from "@worlds/sdk";
import { createPostgresWorldsSdk } from "@/postgres/sdk/mod.ts";
import { createPGliteSql } from "@/postgres/sql/pglite-adapter.ts";

async function createFreshPostgresWorldsSdk(): Promise<WorldsSdkInterface> {
  const sql = await createPGliteSql();
  return await createPostgresWorldsSdk({ sql });
}

Deno.test(
  "parity suite - @worlds/postgres agrees with the in-memory reference on the full corpus",
  async () => {
    const report = await runParitySuite({
      reference: () => createMemoryWorldsSdk(),
      candidate: () => createFreshPostgresWorldsSdk(),
      strictSearchOrder: false,
    });

    assertEquals(
      report.results.length,
      parityCorpus.fixtures.length + parityCorpus.replaceCases.length,
      "every corpus fixture and replace case runs on both stores",
    );
    assertEquals(
      report.ok,
      true,
      report.results
        .map(
          (r) =>
            `${r.name}: ${r.failures.join("; ")}` +
            `${r.notes ? ` [notes: ${r.notes.join("; ")}]` : ""}`,
        )
        .join("\n"),
    );

    // The reference-gated fixtures must be clean on both stores — any
    // divergence there is a real parity break, not a declared-category note.
    const referenceGated = report.results.filter(
      (r) => r.name !== "rdfStarWorld",
    );
    for (const result of referenceGated) {
      assertEquals(
        result.ok,
        true,
        `${result.name}: ${result.failures.join("; ")}`,
      );
      assertEquals(
        result.notes,
        undefined,
        `${result.name} must have no notes`,
      );
    }
  },
);
