import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import type { FastifyInstance } from 'fastify';
import type { DbClient, DbDriver, DbResult } from '../src/db/driver.js';

/**
 * The API as it runs, on an in-memory PGlite database migrated from scratch:
 * the same arrangement as a desktop workspace. Requests go through
 * `app.inject`, so every route, hook and check is exercised.
 */

// PGlite hands back Dates where node-postgres hands back strings; the routes
// expect strings, as the desktop driver arranges.
const iso = (value: string) => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
};
const parsers = {
  1082: (value: string) => value,
  20: (value: string) => Number(value),
  1114: (value: string) => iso(value.endsWith('Z') ? value : `${value}Z`),
  1184: (value: string) => iso(value),
};

type Queryable = {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[]; affectedRows?: number }>;
  exec(text: string): Promise<unknown>;
};

function clientFor(db: Queryable): DbClient {
  return {
    async query<T>(text: string, params: unknown[] = []): Promise<DbResult<T>> {
      const result = await db.query<T>(text, params);
      return { rows: result.rows, rowCount: result.rows.length || result.affectedRows || 0 };
    },
    exec: async (sql: string) => {
      await db.exec(sql);
    },
  };
}

export interface TestUser {
  id: string;
  name: string;
  token: string;
  /** The workspace their account started with. */
  workspaceId: string;
}

export interface Api {
  app: FastifyInstance;
  sql: <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<T[]>;
  register: (name: string) => Promise<TestUser>;
  /** Puts `user` in `workspaceId` with the role of that name. */
  join: (user: TestUser, workspaceId: string, roleName: string) => Promise<void>;
  call: <T = any>(
    user: TestUser | null,
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    body?: unknown,
  ) => Promise<{ status: number; body: T }>;
  close: () => Promise<void>;
}

let registered = 0;

export async function startApi(): Promise<Api> {
  process.env.DATABASE_URL = 'pglite://test';
  process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-0123456789';
  process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'paradocs-test-'));
  process.env.SECURE_COOKIES = 'false';
  process.env.LOG_LEVEL = 'silent';
  process.env.ALLOW_REGISTRATION = 'true';

  const db = await PGlite.create({ extensions: { pg_trgm, pgcrypto }, parsers });
  const base = clientFor(db as unknown as Queryable);
  const driver: DbDriver = {
    ...base,
    transaction: <T>(fn: (client: DbClient) => Promise<T>) =>
      db.transaction((tx) => fn(clientFor(tx as unknown as Queryable))) as Promise<T>,
    close: () => db.close(),
  } as DbDriver;

  const { useDriver } = await import('../src/db/pool.js');
  useDriver(driver);
  const { runMigrations } = await import('../src/db/migrate.js');
  await runMigrations(driver);
  const { buildApp } = await import('../src/app.js');
  const app = await buildApp();
  await app.ready();

  const sql = async <T>(text: string, params: unknown[] = []) => (await base.query<T>(text, params)).rows;

  const call: Api['call'] = async (user, method, url, body) => {
    const response = await app.inject({
      method,
      url: url.startsWith('/api') ? url : `/api${url}`,
      headers: user ? { authorization: `Bearer ${user.token}` } : {},
      ...(body === undefined ? {} : { payload: body as object }),
    });
    const text = response.body;
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON: an iCal feed, say.
    }
    return { status: response.statusCode, body: parsed as any };
  };

  return {
    app,
    sql,
    call,
    async register(name) {
      registered += 1;
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        remoteAddress: `10.0.${Math.floor(registered / 250)}.${registered % 250}`,
        headers: { 'x-paradocs-session': 'token' },
        payload: { email: `${name.toLowerCase()}${registered}@example.com`, name, password: 'correct horse battery' },
      });
      if (response.statusCode >= 300) throw new Error(`register ${name}: ${response.statusCode} ${response.body}`);
      const { user, token } = JSON.parse(response.body);
      const [workspace] = await sql<{ workspace_id: string }>(
        'SELECT workspace_id FROM workspace_members WHERE user_id = $1',
        [user.id],
      );
      return { id: user.id, name, token, workspaceId: workspace.workspace_id };
    },
    async join(user, workspaceId, roleName) {
      await sql(
        `INSERT INTO workspace_members (workspace_id, user_id, role, role_id)
         SELECT $1, $2, 'member', r.id FROM workspace_roles r WHERE r.workspace_id = $1 AND r.name = $3`,
        [workspaceId, user.id, roleName],
      );
    },
    async close() {
      await app.close();
      await db.close();
    },
  };
}
