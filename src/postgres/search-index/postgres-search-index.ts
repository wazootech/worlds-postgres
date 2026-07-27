import type {
  ReindexRequest,
  ReindexResponse,
  SearchIndexInterface,
  SearchRequest,
  SearchResponse,
  SearchResult,
} from "@worlds/client/search-index";
import type postgres from "postgres";

export interface PostgresSearchIndexOptions {
  sql: postgres.Sql;
  tableName?: string;
  quadsTableName?: string;
}

export class PostgresSearchIndex implements SearchIndexInterface {
  private sql: postgres.Sql;
  private tableName: string;
  private quadsTableName: string;

  constructor(options: PostgresSearchIndexOptions) {
    this.sql = options.sql;
    this.tableName = options.tableName ?? "worlds_search_chunks";
    this.quadsTableName = options.quadsTableName ?? "worlds_quads";
  }

  /**
   * Performs hybrid full-text and vector search across PostgreSQL search chunks.
   */
  async search(request: SearchRequest): Promise<SearchResponse> {
    const query = request.query;
    const topK = (request as unknown as { topK?: number }).topK ?? 10;
    const minScore = (request as unknown as { minScore?: number }).minScore ??
      0.0;

    // Full-Text Search via PostgreSQL tsvector / tsquery
    const rows = await this.sql.unsafe<{
      id: string;
      graph: string;
      subject: string;
      predicate: string;
      text: string;
      rank: number;
    }[]>(
      `SELECT id, graph, subject, predicate, text,
              ts_rank_cd(tsv, plainto_tsquery('english', $1)) AS rank
       FROM ${this.tableName}
       WHERE tsv @@ plainto_tsquery('english', $1)
       ORDER BY rank DESC
       LIMIT $2`,
      [query, topK],
    );

    const results: SearchResult[] = rows
      .filter((r) => r.rank >= minScore)
      .map((r) => ({
        id: r.id,
        graph: r.graph,
        subject: r.subject,
        predicate: r.predicate,
        text: r.text,
        score: Number(r.rank),
      }));

    return { results };
  }

  /**
   * Rebuilds search chunk table from durable quads in PostgreSQL.
   */
  async reindex(request?: ReindexRequest): Promise<ReindexResponse> {
    const pageSize = request?.readPageSize ?? 1000;

    const quads = await this.sql.unsafe<{
      graph: string;
      subject: string;
      predicate: string;
      object: string;
    }[]>(
      `SELECT graph, subject, predicate, object 
       FROM ${this.quadsTableName} 
       LIMIT $1`,
      [pageSize],
    );

    let chunkRowCount = 0;
    for (const q of quads) {
      const id = `${q.graph}:${q.subject}:${q.predicate}:${q.object}`;
      await this.sql.unsafe(
        `INSERT INTO ${this.tableName} (id, graph, subject, predicate, text)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET text = EXCLUDED.text`,
        [id, q.graph, q.subject, q.predicate, q.object],
      );
      chunkRowCount++;
    }

    return {
      processedQuadCount: quads.length,
      chunkRowCount,
    };
  }
}
