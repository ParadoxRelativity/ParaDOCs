import { config } from '../config.js';
import type { DbClient, DbDriver, DbResult } from './driver.js';

export type { DbClient, DbDriver, DbResult } from './driver.js';

let driver: Promise<DbDriver> | null = null;

/**
 * Supplies the driver to use instead of connecting to Postgres. The desktop app
 * calls this with a PGlite-backed driver before building the app, so a local
 * workspace runs the same routes with no database server present.
 */
export function useDriver(next: DbDriver): void {
  driver = Promise.resolve(next);
}

/**
 * Postgres is imported lazily so the desktop bundle, which injects its own
 * driver, never has to carry `pg` or dial a socket that isn't there.
 */
function active(): Promise<DbDriver> {
  if (!driver) {
    driver = import('./pgDriver.js').then((m) => m.createPgDriver(config.databaseUrl));
  }
  return driver;
}

export async function query<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<DbResult<T>> {
  return (await active()).query<T>(text, params);
}

/** Runs `fn` inside a transaction, rolling back on any throw. */
export async function transaction<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
  return (await active()).transaction(fn);
}

export async function closeDb(): Promise<void> {
  if (!driver) return;
  const current = driver;
  driver = null;
  await (await current).close();
}
