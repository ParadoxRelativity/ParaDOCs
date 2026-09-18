import pg from 'pg';
import type { DbClient, DbDriver } from './driver.js';

// node-postgres returns DATE as a local-midnight Date, which shifts calendar
// dates (a work item's due date) across timezones. Keep them as the plain YYYY-MM-DD string we stored.
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

/** The driver a self-hosted server uses: a real Postgres connection pool. */
export function createPgDriver(connectionString: string): DbDriver {
  const pool = new pg.Pool({ connectionString, max: 10 });

  const run = async <T>(client: pg.Pool | pg.PoolClient, text: string, params: unknown[] = []) => {
    const result = await client.query<pg.QueryResultRow>(text, params as never[]);
    return { rows: result.rows as T[], rowCount: result.rowCount };
  };

  return {
    query: (text, params) => run(pool, text, params),
    async transaction<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({ query: (text, params) => run(client, text, params) });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
