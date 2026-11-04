import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startApi, type Api, type TestUser } from './harness.js';

/**
 * The admin page's account list says which accounts single sign-on made, and
 * through which provider: Ann registered, Bea came in through Okta, and Cal
 * through a provider that has since been removed.
 */
describe('accounts made by single sign-on', () => {
  let api: Api;
  let admin: FastifyInstance;
  let cookie: string;
  let ann: TestUser;
  let bea: TestUser;
  let cal: TestUser;

  beforeAll(async () => {
    api = await startApi();
    const { buildAdminApp } = await import('../src/admin/app.js');
    admin = await buildAdminApp();
    await admin.ready();

    ann = await api.register('Ann');
    bea = await api.register('Bea');
    cal = await api.register('Cal');
    await api.sql('UPDATE users SET is_server_admin = true WHERE id = $1', [ann.id]);
    await api.sql(
      `INSERT INTO oidc_providers (slug, name, issuer, client_id) VALUES ('okta', 'Okta', 'https://okta.example.com/', 'id')`,
    );
    // As the provider reports it, without the slash the admin typed.
    await api.sql(`UPDATE users SET created_by_issuer = 'https://okta.example.com' WHERE id = $1`, [bea.id]);
    await api.sql(`UPDATE users SET created_by_issuer = 'https://gone.example.com' WHERE id = $1`, [cal.id]);

    const [{ email }] = await api.sql<{ email: string }>('SELECT email FROM users WHERE id = $1', [ann.id]);
    const login = await admin.inject({
      method: 'POST',
      url: '/api/admin/login',
      headers: { 'x-paradocs-admin': '1' },
      payload: { email, password: 'correct horse battery' },
    });
    expect(login.statusCode).toBe(200);
    cookie = String(login.headers['set-cookie']).split(';')[0];
  });

  afterAll(async () => {
    await admin?.close();
    await api?.close();
  });

  it('names the provider, or its issuer once it is gone', async () => {
    const res = await admin.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const byId = new Map(res.json().users.map((u: { id: string; createdBySso: string | null }) => [u.id, u.createdBySso]));
    expect(byId.get(ann.id)).toBeNull();
    expect(byId.get(bea.id)).toBe('Okta');
    expect(byId.get(cal.id)).toBe('https://gone.example.com');
  });

  it('marks accounts single sign-on made before the column existed', async () => {
    const [{ created_at }] = await api.sql<{ created_at: string }>('SELECT created_at FROM users WHERE id = $1', [
      ann.id,
    ]);
    await api.sql('UPDATE users SET created_by_issuer = NULL WHERE id IN ($1, $2)', [bea.id, cal.id]);
    // Bea's identity was made with her account; Ann's was linked later.
    await api.sql(
      `INSERT INTO auth_identities (user_id, provider, subject, created_at)
       SELECT id, 'https://okta.example.com', 'bea', created_at FROM users WHERE id = $1`,
      [bea.id],
    );
    await api.sql(
      `INSERT INTO auth_identities (user_id, provider, subject, created_at)
       VALUES ($1, 'https://okta.example.com', 'ann', $2::timestamptz + interval '1 day')`,
      [ann.id, created_at],
    );
    const migration = fs.readFileSync(new URL('../migrations/0059_account_created_by_sso.sql', import.meta.url), 'utf8');
    await api.sql(migration.slice(migration.indexOf('UPDATE users')));

    const rows = await api.sql<{ id: string; created_by_issuer: string | null }>(
      'SELECT id, created_by_issuer FROM users WHERE id IN ($1, $2, $3)',
      [ann.id, bea.id, cal.id],
    );
    const byId = new Map(rows.map((r) => [r.id, r.created_by_issuer]));
    expect(byId.get(ann.id)).toBeNull();
    expect(byId.get(bea.id)).toBe('https://okta.example.com');
    expect(byId.get(cal.id)).toBeNull();
  });
});
