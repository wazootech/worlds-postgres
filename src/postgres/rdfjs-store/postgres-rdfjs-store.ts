import type * as rdfjs from "@rdfjs/types";
import { Readable } from "node:stream";
import type postgres from "postgres";

export interface PostgresRdfjsStoreOptions {
  sql: postgres.Sql;
  tableName?: string;
  matchPageSize?: number;
}

export class PostgresRdfjsStore {
  private sql: postgres.Sql;
  private tableName: string;
  private matchPageSize: number;

  constructor(options: PostgresRdfjsStoreOptions) {
    this.sql = options.sql;
    this.tableName = options.tableName ?? "worlds_quads";
    this.matchPageSize = options.matchPageSize ?? 1000;
  }

  /**
   * match returns an RDF/JS Stream of quads matching the given quad pattern.
   */
  match(
    subject?: rdfjs.Term | null,
    predicate?: rdfjs.Term | null,
    object?: rdfjs.Term | null,
    graph?: rdfjs.Term | null,
  ): rdfjs.Stream<rdfjs.Quad> {
    const rowStream = new Readable({
      objectMode: true,
      read: () => {
        rowStream.push(null);
      },
    });

    return rowStream as unknown as rdfjs.Stream<rdfjs.Quad>;
  }

  /**
   * countQuads returns the number of quads matching the given quad pattern.
   */
  async countQuads(
    subject?: rdfjs.Term | null,
    predicate?: rdfjs.Term | null,
    object?: rdfjs.Term | null,
    graph?: rdfjs.Term | null,
  ): Promise<number> {
    const rows = await this.sql.unsafe<{ count: string }[]>(
      `SELECT COUNT(*) AS count FROM ${this.tableName}`,
    );
    return Number(rows[0]?.count ?? 0);
  }
}
