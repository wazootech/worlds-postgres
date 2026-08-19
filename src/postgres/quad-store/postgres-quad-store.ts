import type {
  ExportRequest,
  ExportResponse,
  ImportRequest,
  QuadStoreInterface,
} from "@worlds/sdk/quad-store";
import {
  exportQuadsResponse,
  materializeImportQuads,
} from "@worlds/sdk/quad-store";
import { PostgresRdfjsStore } from "@/postgres/rdfjs-store/postgres-rdfjs-store.ts";
import type { PostgresSql } from "@/postgres/sql/postgres-sql.ts";

/**
 * PostgresQuadStoreOptions defines the configuration options for PostgresQuadStore.
 */
export interface PostgresQuadStoreOptions {
  sql: PostgresSql;
  tableName?: string;
}

/**
 * PostgresQuadStore is a PostgreSQL-backed quad store satisfying the
 * QuadStoreInterface contract. Imports parse serialized sources with the
 * SDK's shared parser and persist through the store's applyPatch (one SQL
 * transaction per import, replace-mode clearing); exports reconstruct quads
 * losslessly from the JSONB payload.
 */
export class PostgresQuadStore implements QuadStoreInterface {
  private readonly store: PostgresRdfjsStore;

  constructor(options: PostgresQuadStoreOptions) {
    this.store = new PostgresRdfjsStore({
      sql: options.sql,
      tableName: options.tableName,
    });
  }

  /**
   * Imports quad data into PostgreSQL. Serialized sources (N-Quads,
   * Turtle, TriG) are parsed with the SDK's shared parser.
   */
  async import(request: ImportRequest): Promise<void> {
    await this.store.ensureSchema();
    const mode = request.mode ?? "merge";
    const quads = await materializeImportQuads(request.source);
    await this.store.applyPatch(
      { insertions: quads, deletions: [] },
      { importMode: mode },
    );
  }

  /** Exports quad data from PostgreSQL, losslessly. */
  async export(request: ExportRequest): Promise<ExportResponse> {
    const quads = await this.store.getQuads();
    return await exportQuadsResponse(quads, request);
  }
}
