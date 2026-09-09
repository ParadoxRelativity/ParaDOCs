import type { FastifyPluginAsync } from 'fastify';
import { changePasswordSchema, loginSchema, registerSchema, updateProfileSchema } from '@paradocs/shared';
import { query, transaction } from '../db/pool.js';
import { hashPassword, newSessionToken, slugify, verifyPassword } from '../lib/auth.js';
import { badRequest, conflict, forbidden, parse, unauthorized } from '../lib/http.js';
import { SESSION_COOKIE, sessionCookieOptions } from '../plugins/session.js';
import { config } from '../config.js';
import { oidcStatus } from './oidc.js';

async function createSession(userId: string): Promise<string> {
  const token = newSessionToken();
  await query(
    `INSERT INTO sessions (token, user_id, expires_at)
     VALUES ($1, $2, now() + ($3 || ' days')::interval)`,
    [token, userId, String(config.sessionTtlDays)],
  );
  return token;
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.get('/auth/me', async (req) => ({
    user: req.user,
    allowRegistration: config.allowRegistration,
    oidc: oidcStatus(),
  }));

  app.post('/auth/register', async (req, reply) => {
    const input = parse(registerSchema, req.body);

    // Registration can be closed by env, but the very first account is always
    // allowed so a fresh install is never locked out of itself.
    const { rows: existing } = await query<{ count: number }>('SELECT count(*)::int AS count FROM users');
    if (!config.allowRegistration && existing[0].count > 0) {
      throw forbidden('Registration is closed on this server');
    }

    const passwordHash = await hashPassword(input.password);
    const user = await transaction(async (client) => {
      const dup = await client.query('SELECT 1 FROM users WHERE lower(email) = lower($1)', [input.email]);
      if (dup.rowCount) throw conflict('An account with that email already exists');

      const { rows } = await client.query<{ id: string; email: string; name: string }>(
        `INSERT INTO users (email, password_hash, name)
         VALUES ($1, $2, $3) RETURNING id, email, name`,
        [input.email, passwordHash, input.name],
      );
      const created = rows[0];

      // Every account starts with a usable workspace rather than an empty shell.
      const { rows: wsRows } = await client.query<{ id: string }>(
        `INSERT INTO workspaces (owner_id, name, slug, icon)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [created.id, 'Personal', slugify('Personal'), '🏠'],
      );
      // Access is membership, not ownership: without this row the new account
      // is not a member of the workspace it just got and every request for it
      // answers 404.
      await client.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [wsRows[0].id, created.id],
      );
      await client.query(
        `INSERT INTO folders (workspace_id, name, position) VALUES ($1, 'Journal', 0), ($1, 'Notes', 1)`,
        [wsRows[0].id],
      );
      return created;
    });

    const token = await createSession(user.id);
    reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions());
    return { user };
  });

  app.post('/auth/login', async (req, reply) => {
    const input = parse(loginSchema, req.body);
    const { rows } = await query<{ id: string; email: string; name: string; password_hash: string }>(
      'SELECT id, email, name, password_hash FROM users WHERE lower(email) = lower($1)',
      [input.email],
    );
    const row = rows[0];
    // Hash even when the user is missing, so timing does not reveal which emails exist.
    const ok = await verifyPassword(input.password, row?.password_hash ?? 'scrypt$00$00');
    if (!row || !ok) throw unauthorized('Incorrect email or password');

    const token = await createSession(row.id);
    reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions());
    return { user: { id: row.id, email: row.email, name: row.name } };
  });

  app.patch('/auth/me', async (req) => {
    if (!req.user) throw unauthorized();
    const input = parse(updateProfileSchema, req.body);

    if (input.email && input.email.toLowerCase() !== req.user.email.toLowerCase()) {
      const { rows } = await query('SELECT 1 FROM users WHERE lower(email) = lower($1) AND id <> $2', [
        input.email,
        req.user.id,
      ]);
      if (rows.length) throw conflict('Another account already uses that email');
    }

    const { rows } = await query<{ id: string; email: string; name: string }>(
      `UPDATE users SET name = COALESCE($2, name), email = COALESCE($3, email)
        WHERE id = $1 RETURNING id, email, name`,
      [req.user.id, input.name ?? null, input.email ?? null],
    );
    return { user: rows[0] };
  });

  app.post('/auth/password', async (req, reply) => {
    if (!req.user) throw unauthorized();
    const input = parse(changePasswordSchema, req.body);

    const { rows } = await query<{ password_hash: string | null }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [req.user.id],
    );
    const current = rows[0]?.password_hash ?? null;

    // Accounts created through a provider have no password yet, so there is
    // nothing to verify the first time they set one.
    if (current) {
      if (!input.currentPassword) throw badRequest('Enter your current password');
      if (!(await verifyPassword(input.currentPassword, current))) {
        throw forbidden('That is not your current password');
      }
    }

    const hash = await hashPassword(input.newPassword);
    const keep = req.cookies?.[SESSION_COOKIE] ?? '';
    await transaction(async (client) => {
      await client.query('UPDATE users SET password_hash = $2 WHERE id = $1', [req.user!.id, hash]);
      // Changing a password signs out everywhere else.
      await client.query('DELETE FROM sessions WHERE user_id = $1 AND token <> $2', [req.user!.id, keep]);
    });

    reply.status(204);
  });

  app.post('/auth/logout', async (req, reply) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) await query('DELETE FROM sessions WHERE token = $1', [token]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
};
