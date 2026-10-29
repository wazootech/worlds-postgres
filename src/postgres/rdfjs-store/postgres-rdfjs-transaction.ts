import type * as rdfjs from "@rdfjs/types";
import type { Patch } from "@worlds/sdk";
import { quadKey } from "@/postgres/rdfjs-store/quad-record.ts";

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

/** PatchApplier is the store surface a transaction commits through. */
export interface PatchApplier {
  applyPatch(patch: Patch): Promise<void>;
}

/** PostgresTransactionImpl buffers a SPARQL update patch atomically. */
export class PostgresTransactionImpl implements PostgresTransaction {
  /** quad key -> quad, for insert; a Map keeps the last insert of a key. */
  private readonly inserted = new Map<string, rdfjs.Quad>();
  /** quad key -> quad, buffered for deletion (net of any insert of the same key). */
  private readonly deleted = new Map<string, rdfjs.Quad>();

  public constructor(private readonly store: PatchApplier) {}

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
