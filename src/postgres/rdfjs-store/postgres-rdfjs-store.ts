/**
 * PostgresRdfjsStore — durable RDF/JS Store over PostgreSQL.
 *
 * The PostgreSQL quad primitive for the Worlds ecosystem, packaged with the
 * worlds impl per the agreed pattern (`SqliteStore` in `@worlds/sqlite`,
 * `IndexeddbStore` in `@worlds/indexeddb`, `LibsqlRdfjsStore` in
 * `@worlds/libsql`).
 *
 * Layout (mirrors the sqlite/indexeddb shape 1:1):
 *
 * - `worlds_quads` keyed by the four position term-key columns
 *   `(skey, pkey, okey, gkey)` as the composite primary key, plus a JSONB
 *   `payload` holding the lossless term record (literal language/direction/
 *   datatype and RDF-star nesting round-trip exactly) — quads that differ
 *   only by graph never collide;
 * - secondary indexes on `pkey`, `okey`, `gkey`;
 * - `match()` filters on every bound position by term-key equality (exact,
 *   no residual JS filtering needed) with keyset pagination
 *   (`ORDER BY (skey, pkey, okey, gkey)` + row-value comparisons);
 * - every write is atomic: commit() and applyPatch() run inside one
 *   `sql.begin` transaction; a thrown callback rolls back.
 *
 * The engine remains store-agnostic and consumes this store through its
 * `createTransaction` hook:
 *
 *   const store = new PostgresRdfjsStore({ sql });
 *   const engine = new WazooSparqlEngine({
 *     store,
 *     createTransaction: () => store.createTransaction(),
 *   });
 *
 * The SQL surface is `PostgresSql` — a structural subset of postgres.js's
 * `Sql` (production) that the PGlite adapter (`createPGliteSql`) also
 * satisfies, so tests run fully in-memory.
 */
import type * as rdfjs from "@rdfjs/types";
import { DataFactory } from "@wazoo/sparql-engine";
import type { Patch } from "@worlds/sdk";
import type { PostgresSql } from "@/postgres/sql/postgres-sql.ts";
import {
  fromQuadRow,
  quadKey,
  type QuadRow,
  splitQuadKey,
  toQuadRecord,
  toQuadRow,
} from "@/postgres/rdfjs-store/quad-record.ts";
import { PgQuadStream } from "@/postgres/rdfjs-store/pg-quad-stream.ts";
import { termKey } from "@/postgres/term/term-key.ts";

/**
 * PostgresRdfjsStoreOptions configures PostgresRdfjsStore.
 */
export interface PostgresRdfjsStoreOptions {
  /** sql is the SQL surface (postgres.js Sql or the PGlite adapter). */
  sql: PostgresSql;

  /** Table name for quads (defaults to "worlds_quads"). */
  tableName?: string;

  /** match() page size for keyset pagination (default 1000). */
  matchPageSize?: number;
}

/**
 * PostgresTransaction is the atomic patch contract a SPARQL update uses to
 * buffer writes. It is structurally identical to the engine's
 * `WazooSparqlTransaction` (and the worlds client's Transaction), so a store
 * producing it satisfies the engine's `createTransaction` hook with no
 * cross-package import.
 */
export interface PostgresTransaction {
  /** add buffers a single quad for insertion on the next commit. */
  add(quad: rdfjs.Quad): unknown;

  /** delete buffers a single quad for deletion on the next commit. */
  delete(quad: rdfjs.Quad): unknown;

  /** commit persists the buffered patch (one SQL transaction). */
  commit(): Promise<void>;

  /** rollback discards any uncommitted insertions and deletions. */
  rollback(): void;
}

/** PostgresTransactionImpl buffers a SPARQL update patch atomically. */
class PostgresTransactionImpl implements PostgresTransaction {
  /** quad key -> quad, for insert; a Map keeps the last insert of a key. */
  private readonly inserted = new Map<string, rdfjs.Quad>();
  /** quad key -> quad, buffered for deletion (net of any insert of the same key). */
  private readonly deleted = new Map<string, rdfjs.Quad>();

  public constructor(private readonly store: PostgresRdfjsStore) {}

  public add(quad: rdfjs.Quad): void {
    this.deleted.delete(quadKey(quad));
    this.inserted.set(quadKey(quad), quad);
  }

  public delete(quad: rdfjs.Quad): void {
    if (this.inserted.delete(quadKey(quad))) {
      return; // add + delete of the same quad nets to nothing
    }
    this.deleted.set(quadKey(quad), quad);
  }

  public commit(): Promise<void> {
    return this.store.applyPatch({
      insertions: [...this.inserted.values()],
      deletions: [...this.deleted.values()],
    });
  }

  public rollback(): void {
    this.inserted.clear();
    this.deleted.clear();
  }
}

/**
 * PostgresRdfjsStore is a durable RDF/JS Store over PostgreSQL. It implements
 * the read side of rdfjs.Store plus addQuad/removeQuad, and offers
 * createTransaction() for atomic SPARQL updates and applyPatch() for atomic
 * bulk patches (the SDK's replace-import path).
 */
export class PostgresRdfjsStore implements rdfjs.Store<rdfjs.Quad> {
  private readonly sql: PostgresSql;
  private readonly tableName: string;
  private readonly matchPageSize: number;
  /** serialized write queue: every mutation runs after the previous one. */
  private mutationQueue: Promise<void> = Promise.resolve();
  /** synchronous size approximation, refreshed after every write. */
  private liveCount = 0;

  public constructor(options: PostgresRdfjsStoreOptions) {
    this.sql = options.sql;
    this.tableName = options.tableName ?? "worlds_quads";
    this.matchPageSize = options.matchPageSize ?? 1000;
  }

  /**
   * ensureSchema creates the quads table and its secondary indexes
   * (idempotent) and seeds the live count. Called by the SDK factory; safe
   * to call again.
   */
  public async ensureSchema(): Promise<void> {
    await this.sql.unsafe(
      `CREATE TABLE IF NOT EXISTS ${this.tableName} (` +
        "skey TEXT NOT NULL," +
        "pkey TEXT NOT NULL," +
        "okey TEXT NOT NULL," +
        "gkey TEXT NOT NULL," +
        "payload JSONB NOT NULL," +
        "PRIMARY KEY (skey, pkey, okey, gkey)" +
        ")",
    );
    await this.sql.unsafe(
      `CREATE INDEX IF NOT EXISTS idx_${this.tableName}_pkey ON ${this.tableName} (pkey)`,
    );
    await this.sql.unsafe(
      `CREATE INDEX IF NOT EXISTS idx_${this.tableName}_okey ON ${this.tableName} (okey)`,
    );
    await this.sql.unsafe(
      `CREATE INDEX IF NOT EXISTS idx_${this.tableName}_gkey ON ${this.tableName} (gkey)`,
    );
    await this.refreshCount();
  }

  private async refreshCount(): Promise<void> {
    const rows = await this.sql.unsafe<{ count: string }>(
      `SELECT COUNT(*) AS count FROM ${this.tableName}`,
    );
    this.liveCount = Number(rows[0]?.count ?? 0);
  }

  /** flush resolves once every queued write has committed. */
  public flush(): Promise<void> {
    return this.mutationQueue;
  }

  /**
   * enqueueWrite serializes a write transaction behind all prior writes and
   * refreshes the live count on completion.
   */
  private enqueueWrite(work: () => Promise<void>): Promise<void> {
    const next = this.mutationQueue.then(async () => {
      await work();
      await this.refreshCount();
    });
    this.mutationQueue = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  /**
   * applyPatch persists a patch atomically — one SQL transaction.
   * context.importMode === "replace" clears the table first (the SDK's
   * replace-import contract).
   */
  public applyPatch(
    patch: Patch,
    context?: { importMode?: "replace" | "merge" },
  ): Promise<void> {
    return this.enqueueWrite(() => {
      return this.sql.begin(async (tx) => {
        if (context?.importMode === "replace") {
          await tx.unsafe(`DELETE FROM ${this.tableName}`);
        }
        if (patch.deletions.length > 0) {
          const keys = patch.deletions.map((quad) => {
            const [skey, pkey, okey, gkey] = splitQuadKey(quadKey(quad));
            return { skey, pkey, okey, gkey };
          });
          await tx.unsafe(
            `DELETE FROM ${this.tableName} ` +
              "WHERE (skey, pkey, okey, gkey) IN (" +
              "SELECT * FROM json_to_recordset($1::json) AS x(" +
              "skey TEXT, pkey TEXT, okey TEXT, gkey TEXT))",
            [JSON.stringify(keys)],
          );
        }
        if (patch.insertions.length > 0) {
          // Pass the payload as an object (not a string) so the JSONB
          // recordset column stores a proper JSON object — a string value
          // would be stored as a JSONB string and break payload->'o' probes.
          const rows = patch.insertions.map((quad) => {
            const row = toQuadRow(quad);
            return {
              skey: row.skey,
              pkey: row.pkey,
              okey: row.okey,
              gkey: row.gkey,
              payload: toQuadRecord(quad),
            };
          });
          await tx.unsafe(
            `INSERT INTO ${this.tableName} (skey, pkey, okey, gkey, payload) ` +
              "SELECT * FROM json_to_recordset($1::json) AS x(" +
              "skey TEXT, pkey TEXT, okey TEXT, gkey TEXT, payload JSONB) " +
              "ON CONFLICT (skey, pkey, okey, gkey) " +
              "DO UPDATE SET payload = EXCLUDED.payload",
            [JSON.stringify(rows)],
          );
        }
      });
    });
  }

  /** createTransaction returns a fresh transaction over this store. */
  public createTransaction(): PostgresTransaction {
    return new PostgresTransactionImpl(this);
  }

  public addQuad(quad: rdfjs.Quad): this;
  public addQuad(
    subject: rdfjs.Term,
    predicate: rdfjs.Term,
    object: rdfjs.Term,
    graph?: rdfjs.Term,
  ): this;
  public addQuad(
    quadOrSubject: rdfjs.Quad | rdfjs.Term,
    predicate?: rdfjs.Term,
    object?: rdfjs.Term,
    graph?: rdfjs.Term,
  ): this {
    const quad = predicate !== undefined && object !== undefined
      ? DataFactory.quad(
        // RDF 1.2 allows any term in any position (literal subjects in
        // quoted triples); the engine's position types are narrower, so cast.
        quadOrSubject as rdfjs.Quad_Subject,
        predicate as rdfjs.Quad_Predicate,
        object as rdfjs.Quad_Object,
        graph as rdfjs.Quad_Graph,
      )
      : quadOrSubject as rdfjs.Quad;
    // SQL writes are asynchronous; the rdfjs.Store interface types addQuad
    // as synchronous, so the write is queued and the caller can await it
    // via flush() or a later read. The SDK and engine never use this path
    // (they route through applyPatch / createTransaction).
    void this.enqueueWrite(async () => {
      const row = toQuadRow(quad);
      await this.sql.unsafe(
        `INSERT INTO ${this.tableName} (skey, pkey, okey, gkey, payload) ` +
          "VALUES ($1, $2, $3, $4, $5::jsonb) " +
          "ON CONFLICT (skey, pkey, okey, gkey) " +
          "DO UPDATE SET payload = EXCLUDED.payload",
        [row.skey, row.pkey, row.okey, row.gkey, row.payload],
      );
    });
    return this;
  }

  public removeQuad(quad: rdfjs.Quad): this {
    const [skey, pkey, okey, gkey] = splitQuadKey(quadKey(quad));
    void this.enqueueWrite(async () => {
      await this.sql.unsafe(
        `DELETE FROM ${this.tableName} ` +
          "WHERE skey = $1 AND pkey = $2 AND okey = $3 AND gkey = $4",
        [skey, pkey, okey, gkey],
      );
    });
    return this;
  }

  public remove(stream: rdfjs.Stream<rdfjs.Quad>): rdfjs.Stream<rdfjs.Quad> {
    stream.on("data", (q: rdfjs.Quad) => this.removeQuad(q));
    return stream;
  }

  public import(stream: rdfjs.Stream<rdfjs.Quad>): rdfjs.Stream<rdfjs.Quad> {
    stream.on("data", (q: rdfjs.Quad) => this.addQuad(q));
    return stream;
  }

  /** matchWhere builds the WHERE clause + params for a quad pattern. */
  private matchWhere(
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
  private async *matchPages(
    subject?: rdfjs.Term | null,
    predicate?: rdfjs.Term | null,
    object?: rdfjs.Term | null,
    graph?: rdfjs.Term | null,
  ): AsyncGenerator<rdfjs.Quad> {
    const { where, args } = this.matchWhere(subject, predicate, object, graph);
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
      const sqlText =
        `SELECT skey, pkey, okey, gkey, payload FROM ${this.tableName}` +
        (pageWhere.length > 0 ? ` WHERE ${pageWhere.join(" AND ")}` : "") +
        ` ORDER BY skey, pkey, okey, gkey LIMIT ${this.matchPageSize}`;
      const rows = await this.sql.unsafe<QuadRow>(sqlText, pageArgs);
      if (rows.length === 0) {
        return;
      }
      for (const row of rows) {
        yield fromQuadRow(row);
      }
      if (rows.length < this.matchPageSize) {
        return;
      }
      const last = rows[rows.length - 1]!;
      cursor = [last.skey, last.pkey, last.okey, last.gkey];
    }
  }

  /**
   * match returns an async paged stream of the matching quads. Every bound
   * position filters by exact term-key equality, so no residual JS filter is
   * needed.
   */
  public match(
    subject?: rdfjs.Term | null,
    predicate?: rdfjs.Term | null,
    object?: rdfjs.Term | null,
    graph?: rdfjs.Term | null,
  ): PgQuadStream {
    return new PgQuadStream(() =>
      this.matchPages(subject, predicate, object, graph)
    );
  }

  /** getQuads collects the matching quads into an array. */
  public async getQuads(
    subject?: rdfjs.Term | null,
    predicate?: rdfjs.Term | null,
    object?: rdfjs.Term | null,
    graph?: rdfjs.Term | null,
  ): Promise<rdfjs.Quad[]> {
    const stream = this.match(subject, predicate, object, graph);
    const quads: rdfjs.Quad[] = [];
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (q: rdfjs.Quad) => quads.push(q));
      stream.on("end", () => resolve());
      stream.on("error", reject);
    });
    return quads;
  }

  /** countQuads returns the number of quads matching the pattern. */
  public async countQuads(
    subject?: rdfjs.Term | null,
    predicate?: rdfjs.Term | null,
    object?: rdfjs.Term | null,
    graph?: rdfjs.Term | null,
  ): Promise<number> {
    const { where, args } = this.matchWhere(subject, predicate, object, graph);
    const sqlText = `SELECT COUNT(*) AS count FROM ${this.tableName}` +
      (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "");
    const rows = await this.sql.unsafe<{ count: string }>(sqlText, args);
    return Number(rows[0]?.count ?? 0);
  }

  /**
   * removeMatches deletes every matching quad in one SQL transaction and
   * streams the removed quads.
   */
  public removeMatches(
    subject?: rdfjs.Term | null,
    predicate?: rdfjs.Term | null,
    object?: rdfjs.Term | null,
    graph?: rdfjs.Term | null,
  ): PgQuadStream {
    return new PgQuadStream(() =>
      this.removeMatchesGenerator(subject, predicate, object, graph)
    );
  }

  /**
   * removeMatchesGenerator is the async generator backing removeMatches:
   * it loads the matching quads, deletes them in one SQL transaction, then
   * yields each removed quad.
   */
  private async *removeMatchesGenerator(
    subject?: rdfjs.Term | null,
    predicate?: rdfjs.Term | null,
    object?: rdfjs.Term | null,
    graph?: rdfjs.Term | null,
  ): AsyncGenerator<rdfjs.Quad> {
    const matches = await this.getQuads(subject, predicate, object, graph);
    if (matches.length > 0) {
      await this.applyPatch({ insertions: [], deletions: matches });
      for (const quad of matches) {
        yield quad;
      }
    }
  }

  /** deleteGraph removes every quad in the named graph. */
  public deleteGraph(
    graph: rdfjs.Quad_Graph | string,
  ): PgQuadStream {
    const graphTerm = typeof graph === "string"
      ? DataFactory.namedNode(graph)
      : graph;
    return this.removeMatches(null, null, null, graphTerm);
  }

  /**
   * size is the synchronous count approximation — refreshed after every
   * write transaction and on ensureSchema. PostgreSQL has no synchronous
   * count; consumers needing the exact count await countQuads() instead.
   */
  public get size(): number {
    return this.liveCount;
  }

  /** close releases the underlying SQL connections. */
  public async close(): Promise<void> {
    await this.sql.end();
  }
}
