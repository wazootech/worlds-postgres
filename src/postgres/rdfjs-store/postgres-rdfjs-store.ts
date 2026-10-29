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
import { PgQuadStream } from "@/postgres/rdfjs-store/pg-quad-stream.ts";
import {
  countMatching,
  type MatchContext,
  matchPages,
} from "@/postgres/rdfjs-store/postgres-rdfjs-match-sql.ts";
import {
  chainWrite,
  collectQuads,
  countRows,
  createStoreContext,
  removeMatchesPages,
} from "@/postgres/rdfjs-store/postgres-rdfjs-store-helpers.ts";
import {
  type PostgresTransaction,
  PostgresTransactionImpl,
} from "@/postgres/rdfjs-store/postgres-rdfjs-transaction.ts";
import {
  deleteQuad,
  ensureQuadsTable,
  insertQuad,
  resolveQuad,
  runPatch,
} from "@/postgres/rdfjs-store/postgres-rdfjs-write-sql.ts";

export type { PostgresTransaction };

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
 * PostgresRdfjsStore is a durable RDF/JS Store over PostgreSQL. It implements
 * the read side of rdfjs.Store plus addQuad/removeQuad, and offers
 * createTransaction() for atomic SPARQL updates and applyPatch() for atomic
 * bulk patches (the SDK's replace-import path).
 */
export class PostgresRdfjsStore implements rdfjs.Store<rdfjs.Quad> {
  private readonly ctx: MatchContext;
  /** serialized write queue: every mutation runs after the previous one. */
  private mutationQueue: Promise<void> = Promise.resolve();
  /** synchronous size approximation, refreshed after every write. */
  private liveCount = 0;

  public constructor(options: PostgresRdfjsStoreOptions) {
    this.ctx = createStoreContext(options);
  }

  /**
   * ensureSchema creates the quads table and its secondary indexes
   * (idempotent) and seeds the live count. Called by the SDK factory; safe
   * to call again.
   */
  public async ensureSchema(): Promise<void> {
    await ensureQuadsTable(this.ctx);
    await this.refreshCount();
  }

  private async refreshCount(): Promise<void> {
    this.liveCount = await countRows(this.ctx);
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
    const { next, queue } = chainWrite(
      this.mutationQueue,
      work,
      () => this.refreshCount(),
    );
    this.mutationQueue = queue;
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
    return this.enqueueWrite(() => runPatch(this.ctx, patch, context));
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
    const quad = resolveQuad(quadOrSubject, predicate, object, graph);
    // SQL writes are asynchronous; the rdfjs.Store interface types addQuad
    // as synchronous, so the write is queued and the caller can await it
    // via flush() or a later read. The SDK and engine never use this path
    // (they route through applyPatch / createTransaction).
    void this.enqueueWrite(() => insertQuad(this.ctx, quad));
    return this;
  }

  public removeQuad(quad: rdfjs.Quad): this {
    void this.enqueueWrite(() => deleteQuad(this.ctx, quad));
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
      matchPages(this.ctx, subject, predicate, object, graph)
    );
  }

  /** getQuads collects the matching quads into an array. */
  public async getQuads(
    subject?: rdfjs.Term | null,
    predicate?: rdfjs.Term | null,
    object?: rdfjs.Term | null,
    graph?: rdfjs.Term | null,
  ): Promise<rdfjs.Quad[]> {
    return await collectQuads(this.match(subject, predicate, object, graph));
  }

  /** countQuads returns the number of quads matching the pattern. */
  public async countQuads(
    subject?: rdfjs.Term | null,
    predicate?: rdfjs.Term | null,
    object?: rdfjs.Term | null,
    graph?: rdfjs.Term | null,
  ): Promise<number> {
    return await countMatching(this.ctx, subject, predicate, object, graph);
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
      removeMatchesPages(this, subject, predicate, object, graph)
    );
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
    await this.ctx.sql.end();
  }
}
