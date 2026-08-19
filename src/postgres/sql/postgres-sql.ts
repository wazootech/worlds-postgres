/**
 * PostgresSql is the minimal SQL surface the Worlds postgres backend needs.
 *
 * It is a structural subset of postgres.js's `Sql` (the production client),
 * so a real `postgres({...})` instance satisfies it directly; the PGlite
 * adapter (`createPGliteSql`) implements the same surface over
 * `@electric-sql/pglite` for tests and local development.
 *
 * The `begin` callback deliberately receives only `{ unsafe }` — postgres.js
 * transactions are `TransactionSql`, a narrower type that lacks `begin`/`end`
 * — so the interface stays assignable from both drivers.
 */
export interface PostgresSql {
  /** unsafe runs a parameterized statement and returns its rows. */
  unsafe<T>(query: string, params?: unknown[]): Promise<T[]>;

  /**
   * begin runs a callback inside one transaction (commit on resolve,
   * rollback on throw). The callback receives a transaction-scoped unsafe.
   */
  begin<T>(
    fn: (
      tx: { unsafe<T2>(query: string, params?: unknown[]): Promise<T2[]> },
    ) => Promise<T>,
  ): Promise<T>;

  /** end closes the underlying connection(s). */
  end(): Promise<void>;
}
