import pg from 'pg';
import { config } from '../config.js';

// node-postgres returns DATE as a local-midnight Date, which shifts journal
// dates across timezones. Keep them as the plain YYYY-MM-DD string we stored.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);
// Return bigint counts as JS numbers; our counts never approach 2^53.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));
// Hand timestamps to the app as ISO strings rather than Date objects. JSON
// responses looked right either way, but anything that string-interpolates a
// timestamp (markdown export frontmatter) would otherwise emit a locale string.
for (const oid of [pg.types.builtins.TIMESTAMPTZ, pg.types.builtins.TIMESTAMP]) {
  const base = pg.types.getTypeParser(oid);
  pg.types.setTypeParser(oid, (value: string) => {
    const parsed = (base as (v: string) => unknown)(value);
    return parsed instanceof Date ? parsed.toISOString() : parsed;
  });
}

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as never[]);
}

/** Runs `fn` inside a transaction, rolling back on any throw. */
export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
