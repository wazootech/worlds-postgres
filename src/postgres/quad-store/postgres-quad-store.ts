import type * as rdfjs from "@rdfjs/types";
import type {
  ExportRequest,
  ExportResponse,
  ImportRequest,
  QuadStoreInterface,
} from "@worlds/client/quad-store";
import { DataFactory } from "n3";
import type postgres from "postgres";

const { quad, namedNode, literal, defaultGraph } = DataFactory;

export interface PostgresQuadStoreOptions {
  sql: postgres.Sql;
  tableName?: string;
}

export class PostgresQuadStore implements QuadStoreInterface {
  private sql: postgres.Sql;
  private tableName: string;

  constructor(options: PostgresQuadStoreOptions) {
    this.sql = options.sql;
    this.tableName = options.tableName ?? "worlds_quads";
  }

  /**
   * Imports quad data into PostgreSQL.
   */
  async import(request: ImportRequest): Promise<void> {
    const { mode = "merge", source } = request;

    if (mode === "replace") {
      await this.sql.unsafe(`DELETE FROM ${this.tableName}`);
    }

    if (source.kind === "quads") {
      await this.insertQuads(Array.from(source.quads));
    } else if (source.kind === "dataset") {
      await this.insertQuads(Array.from(source.dataset));
    } else {
      throw new Error(
        "Serialized import source format handling requires N3 parser integration.",
      );
    }
  }

  /**
   * Exports quad data from PostgreSQL.
   */
  async export(request: ExportRequest): Promise<ExportResponse> {
    if (request.format.kind === "quads") {
      const rows = await this.sql.unsafe<{
        graph: string;
        subject: string;
        predicate: string;
        object: string;
        datatype: string | null;
        language: string | null;
      }[]>(
        `SELECT graph, subject, predicate, object, datatype, language FROM ${this.tableName}`,
      );

      const quads: rdfjs.Quad[] = rows.map((row) => {
        const g = row.graph ? namedNode(row.graph) : defaultGraph();
        const s = namedNode(row.subject);
        const p = namedNode(row.predicate);
        const o = row.datatype
          ? literal(row.object, namedNode(row.datatype))
          : row.language
          ? literal(row.object, row.language)
          : row.object.startsWith("http://") ||
              row.object.startsWith("https://") || row.object.startsWith("urn:")
          ? namedNode(row.object)
          : literal(row.object);
        return quad(s, p, o, g);
      });

      return { kind: "quads", quads };
    }

    throw new Error("Serialized export format not implemented.");
  }

  private async insertQuads(quads: rdfjs.Quad[]): Promise<void> {
    if (quads.length === 0) return;

    const values = quads.map((q) => ({
      graph: q.graph.value ?? "",
      subject: q.subject.value,
      predicate: q.predicate.value,
      object: q.object.value,
      datatype: q.object.termType === "Literal"
        ? q.object.datatype.value
        : null,
      language: q.object.termType === "Literal" ? q.object.language : null,
    }));

    await this.sql.unsafe(
      `INSERT INTO ${this.tableName} (graph, subject, predicate, object, datatype, language)
       SELECT * FROM json_to_recordset($1::json) AS x(
         graph TEXT, subject TEXT, predicate TEXT, object TEXT, datatype TEXT, language TEXT
       )
       ON CONFLICT (graph, subject, predicate, object) DO NOTHING`,
      [JSON.stringify(values)],
    );
  }
}
