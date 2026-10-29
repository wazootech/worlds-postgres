import type * as rdfjs from "@rdfjs/types";

import { PgEventEmitter } from "./pg-event-emitter.ts";
import type { Listener } from "./pg-event-emitter.ts";

/**
 * PgQuadStream is a minimal RDF/JS Stream backed by an async page generator
 * (SQL keyset-paginated match queries), with the same listener semantics as
 * the indexeddb and sqlite streams:
 *
 * - attaching a `data` listener switches to flow mode and emits each quad
 *   as pages arrive,
 * - attaching a `readable` listener (or calling `read()`) enables pull mode,
 * - attaching only `end`/`error` listeners (a bare completion signal) runs
 *   the generator to exhaustion and ends,
 * - `end` is only emitted after the generator is exhausted and every quad
 *   has been consumed.
 *
 * It implements the full EventEmitter surface required by the `rdfjs.Stream`
 * interface without depending on Node's `events` module.
 */
export class PgQuadStream extends PgEventEmitter
  implements rdfjs.Stream<rdfjs.Quad> {
  private _ended = false;
  private _flowing = false;
  private _readStarted = false;
  private _started = false;
  private _buffer: rdfjs.Quad[] = [];

  /** quads supplies the quads as an async generator (one page per chunk). */
  public constructor(
    private readonly quads: () => AsyncGenerator<rdfjs.Quad>,
  ) {
    super();
  }

  public read(): rdfjs.Quad | null {
    this._readStarted = true;
    this._ensureStarted();
    const quad = this._buffer.shift();
    if (quad === undefined) {
      return null;
    }
    return quad;
  }

  public [Symbol.iterator](): Iterator<rdfjs.Quad> {
    return this._buffer[Symbol.iterator]();
  }

  public destroy(error?: Error): void {
    if (error) {
      this.emit("error", error);
    }
    this._ended = true;
    this.removeAllListeners();
  }

  /** Typed overloads mirror the Node-style surface of rdfjs.Stream. */
  public override on(
    eventName: "data",
    listener: (quad: rdfjs.Quad) => void,
  ): this;
  public override on(eventName: "readable", listener: () => void): this;
  public override on(eventName: "end", listener: () => void): this;
  public override on(
    eventName: "error",
    listener: (error: Error) => void,
  ): this;
  public override on(eventName: string | symbol, listener: Listener): this;
  public override on(eventName: string | symbol, listener: Listener): this {
    super.on(eventName, listener);
    if (eventName === "data" && !this._ended && !this._flowing) {
      this._flowing = true;
      this._ensureStarted();
    }
    if (eventName === "readable" && !this._ended) {
      this._readStarted = true;
      this._ensureStarted();
    }
    if (eventName === "end" && !this._ended) {
      this._ensureStarted();
    }
    return this;
  }

  /** _ensureStarted lazily pumps the generator on a microtask. */
  private _ensureStarted(): void {
    if (this._started || this._ended) {
      return;
    }
    this._started = true;
    queueMicrotask(async () => {
      if (this._ended) {
        return;
      }
      try {
        for await (const quad of this.quads()) {
          if (this._ended) {
            return;
          }
          if (this._flowing) {
            this.emit("data", quad);
          } else if (this._readStarted) {
            // Pull mode: buffer for read().
            this._buffer.push(quad);
            this.emit("readable");
          }
          // Bare completion mode (end/error listeners only): quads are
          // skipped — the generator still runs to exhaustion.
        }
        if (!this._ended) {
          this._end();
        }
      } catch (error) {
        if (!this._ended) {
          this.emit(
            "error",
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      }
    });
  }

  private _end(): void {
    if (this._ended) {
      return;
    }
    this._ended = true;
    this.emit("end");
  }
}
