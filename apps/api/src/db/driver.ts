/**
 * The database surface the routes actually use.
 *
 * Everything above this file speaks only `query` and `transaction`, which is
 * what lets the desktop app run the identical routes against PGlite (Postgres
 * compiled to WASM) while a self-hosted server runs them against real Postgres.
 * Keep this interface to the intersection of the two — no pooling, no COPY, no
 * LISTEN/NOTIFY.
 */

export interface DbResult<T> {
  rows: T[];
  /** Null for statements that report no count, matching node-postgres. */
  rowCount: number | null;
}

export interface DbClient {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<DbResult<T>>;
  /**
   * Runs a script of several statements. Only the migration runner needs this:
   * node-postgres accepts multiple statements through `query`, but PGlite's
   * parameterised path is one statement at a time.
   */
  exec?(sql: string): Promise<void>;
}

export interface DbDriver extends DbClient {
  /** Runs `fn` inside a transaction, rolling back on any throw. */
  transaction<T>(fn: (client: DbClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
