import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import type { DbClient, DbDriver, DbResult } from '@paradocs/api/db/driver';

/**
 * PGlite is Postgres 16 compiled to WebAssembly, running in-process against a
 * directory on disk. It is what lets a local workspace execute the identical
 * migrations and route SQL as a self-hosted server — generated tsvector
 * columns, ts_headline, pg_trgm and recursive CTEs included — without asking
 * anyone to install a database.
 */

// Type OIDs we re-parse. PGlite hands back Date objects where node-postgres,
// as configured in pgDriver, hands back strings; the app must not be able to
// tell the two drivers apart.
const OID = { INT8: 20, DATE: 1082, TIMESTAMP: 1114, TIMESTAMPTZ: 1184 } as const;

const parsers = {
  // A DATE column holds a calendar day. Parsing it into a Date applies the local
  // timezone and can move it to the previous day.
  [OID.DATE]: (value: string) => value,
  [OID.INT8]: (value: string) => Number(value),
  [OID.TIMESTAMP]: (value: string) => isoFrom(value.endsWith('Z') ? value : `${value}Z`),
  [OID.TIMESTAMPTZ]: (value: string) => isoFrom(value),
};

function isoFrom(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

type PGliteQueryable = {
  query<T>(query: string, params?: unknown[]): Promise<{ rows: T[]; affectedRows?: number }>;
  exec(query: string): Promise<unknown>;
};

function clientFor(db: PGliteQueryable): DbClient {
  return {
    async query<T>(text: string, params: unknown[] = []): Promise<DbResult<T>> {
      const result = await db.query<T>(text, params);
      // PGlite reports affectedRows only for statements that change rows;
      // node-postgres also reports a count for SELECT, which callers use as a
      // truthy "did this exist" check.
      const rowCount = result.rows.length || result.affectedRows || 0;
      return { rows: result.rows, rowCount };
    },
    exec: async (sql: string) => {
      await db.exec(sql);
    },
  };
}

export interface LocalDatabase extends DbDriver {
  instance: PGlite;
}

export async function createPGliteDriver(dataDir: string): Promise<LocalDatabase> {
  const db = await PGlite.create({
    dataDir,
    extensions: { pg_trgm, pgcrypto },
    parsers,
  });

  const base = clientFor(db as unknown as PGliteQueryable);

  return {
    instance: db,
    query: base.query,
    exec: base.exec,
    // PGlite is a single connection, so its own helper is what serialises
    // overlapping transactions rather than a pool handing out clients.
    transaction: <T>(fn: (client: DbClient) => Promise<T>): Promise<T> =>
      db.transaction(async (tx) => fn(clientFor(tx as unknown as PGliteQueryable))) as Promise<T>,
    close: () => db.close(),
  };
}
