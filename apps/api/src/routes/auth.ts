import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { changePasswordSchema, loginSchema, registerSchema, updateProfileSchema } from '@paradocs/shared';
import { query, transaction } from '../db/pool.js';
import { hashPassword, newSessionToken, verifyPassword } from '../lib/auth.js';
import { badRequest, conflict, forbidden, parse, unauthorized } from '../lib/http.js';
import { SESSION_COOKIE, sessionCookieOptions, sessionToken } from '../plugins/session.js';
import { config } from '../config.js';
import { oidcStatus } from './oidc.js';
import { replaceAvatar, storeAvatar } from '../lib/avatars.js';
import { uploadUrlSql } from '../lib/storage.js';
import { createAccount } from '../lib/accounts.js';
import { getServerSettings } from '../lib/serverSettings.js';

/** The account as the client sees it. */
const USER_COLUMNS = `id, email, name, ${uploadUrlSql('avatar_key')} AS "avatarUrl"`;

async function createSession(userId: string): Promise<string> {
  const token = newSessionToken();
  await query(
    `INSERT INTO sessions (token, user_id, expires_at)
     VALUES ($1, $2, now() + ($3 || ' days')::interval)`,
    [token, userId, String(config.sessionTtlDays)],
  );
  return token;
}

/**
 * Hands a new session to whoever signed in. A browser gets it as an HTTP-only
 * cookie, where page script cannot read it. The mobile app asks for it in the
 * body instead, with this header, because it cannot use a cookie from another
 * origin and has to send the token itself.
 */
const TOKEN_HEADER = 'x-paradocs-session';

function issueSession(req: FastifyRequest, reply: FastifyReply, token: string): { token?: string } {
  if (req.headers[TOKEN_HEADER] === 'token') return { token };
  reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions());
  return {};
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.get('/auth/me', async (req) => ({
    user: req.user,
    allowRegistration: (await getServerSettings()).allowRegistration,
    oidc: oidcStatus(),
  }));

  app.post('/auth/register', async (req, reply) => {
    const input = parse(registerSchema, req.body);

    // Registration can be closed from the admin page, but the very first account
    // is always allowed so a fresh install is never locked out of itself.
    const { rows: existing } = await query<{ count: number }>('SELECT count(*)::int AS count FROM users');
    if (!(await getServerSettings()).allowRegistration && existing[0].count > 0) {
      throw forbidden('Registration is closed on this server');
    }

    const passwordHash = await hashPassword(input.password);
    const user = await transaction((client) =>
      createAccount(client, { email: input.email, name: input.name, passwordHash }),
    );

    const token = await createSession(user.id);
    return { user: { ...user, avatarUrl: null }, ...issueSession(req, reply, token) };
  });

  app.post('/auth/login', async (req, reply) => {
    const input = parse(loginSchema, req.body);
    const { rows } = await query<{
      id: string;
      email: string;
      name: string;
      avatarUrl: string | null;
      password_hash: string;
      disabled: boolean;
    }>(
      `SELECT ${USER_COLUMNS}, password_hash, disabled_at IS NOT NULL AS disabled
         FROM users WHERE lower(email) = lower($1)`,
      [input.email],
    );
    const row = rows[0];
    // Hash even when the user is missing, so timing does not reveal which emails exist.
    const ok = await verifyPassword(input.password, row?.password_hash ?? 'scrypt$00$00');
    if (!row || !ok) throw unauthorized('Incorrect email or password');
    // Said only to someone who knows the password, so it reveals nothing to a guesser.
    if (row.disabled) throw forbidden('This account has been disabled. Contact the server administrator.');

    const token = await createSession(row.id);
    return {
      user: { id: row.id, email: row.email, name: row.name, avatarUrl: row.avatarUrl },
      ...issueSession(req, reply, token),
    };
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

    const { rows } = await query(
      `UPDATE users SET name = COALESCE($2, name), email = COALESCE($3, email)
        WHERE id = $1 RETURNING ${USER_COLUMNS}`,
      [req.user.id, input.name ?? null, input.email ?? null],
    );
    return { user: rows[0] };
  });

  /** Sets the profile picture. The picture it replaces is deleted. */
  app.put('/auth/me/avatar', async (req) => {
    if (!req.user) throw unauthorized();
    const key = await storeAvatar(req, 'users');
    return { user: await replaceAvatar('users', req.user.id, key, USER_COLUMNS) };
  });

  app.delete('/auth/me/avatar', async (req) => {
    if (!req.user) throw unauthorized();
    return { user: await replaceAvatar('users', req.user.id, null, USER_COLUMNS) };
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
    const keep = sessionToken(req) ?? '';
    await transaction(async (client) => {
      await client.query('UPDATE users SET password_hash = $2 WHERE id = $1', [req.user!.id, hash]);
      // Changing a password signs out everywhere else.
      await client.query('DELETE FROM sessions WHERE user_id = $1 AND token <> $2', [req.user!.id, keep]);
    });

    reply.status(204);
  });

  app.post('/auth/logout', async (req, reply) => {
    const token = sessionToken(req);
    if (token) await query('DELETE FROM sessions WHERE token = $1', [token]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
};
