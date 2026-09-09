import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DbClient, DbDriver } from './driver.js';
import { closeDb, query, transaction } from './pool.js';

export const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../migrations',
);

type Runner = Pick<DbDriver, 'query' | 'transaction'>;

/**
 * Applies every unapplied .sql file in order, each in its own transaction so a
 * failure leaves nothing behind. Exported so the desktop app can migrate a
 * local PGlite database with the identical files.
 */
export async function runMigrations(
  db: Runner,
  dir = migrationsDir,
  log: (message: string) => void = () => {},
): Promise<number> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const applied = new Set(
    (await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
  );
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

  let ran = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await fs.readFile(path.join(dir, file), 'utf8');
    log(`applying ${file}`);
    await db.transaction(async (client: DbClient) => {
      // A migration is a script, not a single statement.
      if (client.exec) await client.exec(sql);
      else await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
    ran++;
  }
  return ran;
}

async function main() {
  const ran = await runMigrations({ query, transaction }, migrationsDir, (m) => console.log(m));
  console.log(ran === 0 ? 'Database already up to date.' : `Applied ${ran} migration(s).`);
  await closeDb();
}

// Only run when invoked directly, so importing this module stays side-effect free.
if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
