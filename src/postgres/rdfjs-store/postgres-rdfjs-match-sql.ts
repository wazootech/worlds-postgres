import type * as rdfjs from "@rdfjs/types";
import type { PostgresSql } from "@/postgres/sql/postgres-sql.ts";
import {
  fromQuadRow,
  type QuadRow,
} from "@/postgres/rdfjs-store/quad-record.ts";
import { termKey } from "@/postgres/term/term-key.ts";

/** MatchContext is the store state the match helpers read. */
export interface MatchContext {
  sql: PostgresSql;
  tableName: string;
  matchPageSize: number;
}

/** matchWhere builds the WHERE clause + params for a quad pattern. */
export function matchWhere(
  subject?: rdfjs.Term | null,
  predicate?: rdfjs.Term | null,
  object?: rdfjs.Term | null,
  graph?: rdfjs.Term | null,
): { where: string[]; args: string[] } {
  const where: string[] = [];
  const args: string[] = [];
  const bind = (
    column: string,
    term: rdfjs.Term | null | undefined,
  ): void => {
    if (term != null) {
      where.push(`${column} = $${args.length + 1}`);
      args.push(termKey(term));
    }
  };
  bind("skey", subject);
  bind("pkey", predicate);
  bind("okey", object);
  bind("gkey", graph);
  return { where, args };
}

/**
 * matchPages is the async generator backing match(): keyset pagination
 * over the ordered key columns, so no quads are skipped or duplicated
 * across page boundaries.
 */
export async function* matchPages(
  ctx: MatchContext,
  subject?: rdfjs.Term | null,
  predicate?: rdfjs.Term | null,
  object?: rdfjs.Term | null,
  graph?: rdfjs.Term | null,
): AsyncGenerator<rdfjs.Quad> {
  const { sql, tableName, matchPageSize } = ctx;
  const { where, args } = matchWhere(subject, predicate, object, graph);
  let cursor: string[] | null = null;
  for (;;) {
    const pageWhere = [...where];
    const pageArgs = [...args];
    if (cursor) {
      pageWhere.push(
        `(skey, pkey, okey, gkey) > ($1, $2, $3, $4)`,
      );
      pageArgs.push(...cursor);
    }
    const sqlText = `SELECT skey, pkey, okey, gkey, payload FROM ${tableName}` +
      (pageWhere.length > 0 ? ` WHERE ${pageWhere.join(" AND ")}` : "") +
      ` ORDER BY skey, pkey, okey, gkey LIMIT ${matchPageSize}`;
    const rows = await sql.unsafe<QuadRow>(sqlText, pageArgs);
    if (rows.length === 0) {
      return;
    }
    for (const row of rows) {
      yield fromQuadRow(row);
    }
    if (rows.length < matchPageSize) {
      return;
    }
    const last = rows[rows.length - 1]!;
    cursor = [last.skey, last.pkey, last.okey, last.gkey];
  }
}

/** countMatching returns the number of quads matching the pattern. */
export async function countMatching(
  ctx: MatchContext,
  subject?: rdfjs.Term | null,
  predicate?: rdfjs.Term | null,
  object?: rdfjs.Term | null,
  graph?: rdfjs.Term | null,
): Promise<number> {
  const { sql, tableName } = ctx;
  const { where, args } = matchWhere(subject, predicate, object, graph);
  const sqlText = `SELECT COUNT(*) AS count FROM ${tableName}` +
    (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "");
  const rows = await sql.unsafe<{ count: string }>(sqlText, args);
  return Number(rows[0]?.count ?? 0);
}
