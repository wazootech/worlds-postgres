import type * as rdfjs from "@rdfjs/types";
import { DataFactory } from "n3";
import type postgres from "postgres";

const { quad, namedNode, literal, defaultGraph } = DataFactory;

export interface PostgresRdfjsStoreOptions {
  sql: postgres.Sql;
  tableName?: string;
}

export class PostgresRdfjsStore implements rdfjs.Store {
  private sql: postgres.Sql;
  private tableName: string;

  constructor(options: PostgresRdfjsStoreOptions) {
    this.sql = options.sql;
    this.tableName = options.tableName ?? "worlds_quads";
  }

  match(
    subject?: rdfjs.Term | null,
    predicate?: rdfjs.Term | null,
    object?: rdfjs.Term | null,
    graph?: rdfjs.Term | null,
  ): rdfjs.Stream<rdfjs.Quad> & rdfjs.Readable {
    throw new Error(
      "Synchronous match stream not supported; use async query execution.",
    );
  }
}
