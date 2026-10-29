import type * as rdfjs from "@rdfjs/types";
import type { PostgresSql } from "@/postgres/sql/postgres-sql.ts";
import type { MatchContext } from "@/postgres/rdfjs-store/postgres-rdfjs-match-sql.ts";

/** collectQuads drains a quad stream into an array. */
export async function collectQuads(
  stream: rdfjs.Stream<rdfjs.Quad>,
): Promise<rdfjs.Quad[]> {
  const quads: rdfjs.Quad[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (q: rdfjs.Quad) => quads.push(q));
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
  return quads;
}

/**
 * removeMatchesPages is the async generator backing removeMatches:
 * it loads the matching quads, deletes them in one SQL transaction, then
 * yields each removed quad.
 */
export async function* removeMatchesPages(
  store: {
    getQuads(
      subject?: rdfjs.Term | null,
      predicate?: rdfjs.Term | null,
      object?: rdfjs.Term | null,
      graph?: rdfjs.Term | null,
    ): Promise<rdfjs.Quad[]>;
    applyPatch(
      patch: { insertions: rdfjs.Quad[]; deletions: rdfjs.Quad[] },
    ): Promise<void>;
  },
  subject?: rdfjs.Term | null,
  predicate?: rdfjs.Term | null,
  object?: rdfjs.Term | null,
  graph?: rdfjs.Term | null,
): AsyncGenerator<rdfjs.Quad> {
  const matches = await store.getQuads(subject, predicate, object, graph);
  if (matches.length > 0) {
    await store.applyPatch({ insertions: [], deletions: matches });
    for (const quad of matches) {
      yield quad;
    }
  }
}

/** createStoreContext resolves the store options to their effective settings. */
export function createStoreContext(options: {
  sql: PostgresSql;
  tableName?: string;
  matchPageSize?: number;
}): MatchContext {
  return {
    sql: options.sql,
    tableName: options.tableName ?? "worlds_quads",
    matchPageSize: options.matchPageSize ?? 1000,
  };
}

/** countRows returns the table's current row count. */
export async function countRows(ctx: MatchContext): Promise<number> {
  const rows = await ctx.sql.unsafe<{ count: string }>(
    `SELECT COUNT(*) AS count FROM ${ctx.tableName}`,
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * chainWrite runs `work` after the previous queued write, then `after`, and
 * returns the write's promise plus the new (never-rejecting) queue tail.
 */
export function chainWrite(
  queue: Promise<void>,
  work: () => Promise<void>,
  after: () => Promise<void>,
): { next: Promise<void>; queue: Promise<void> } {
  const next = queue.then(async () => {
    await work();
    await after();
  });
  return {
    next,
    queue: next.then(
      () => {},
      () => {},
    ),
  };
}
