import type { FastifyReply, FastifyRequest } from 'fastify';
import { query } from '../db/pool.js';
import { newSessionToken } from '../lib/auth.js';
import { config } from '../config.js';

export const ADMIN_COOKIE = 'paradocs_admin_session';

/**
 * Where the admin API lives, and the path the admin cookie is scoped to.
 * Cookies are not kept apart by port, so the scope is what stops the browser
 * sending it to the app, which has nothing under this path.
 */
export const ADMIN_API_PREFIX = '/api/admin';

/**
 * Every change on the admin API must carry this header. A page on another
 * origin cannot add it without a CORS preflight, which the admin server never
 * grants, so a form or script elsewhere — the app on its own port included —
 * cannot act on an administrator's behalf.
 */
export const ADMIN_HEADER = 'x-paradocs-admin';

/** Short, since an admin session can change everything on the server. */
const ADMIN_SESSION_HOURS = 12;

export interface AdminIdentity {
  id: string;
  email: string;
  name: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** The server administrator signed in on the admin port. Only set there. */
    admin: AdminIdentity | null;
  }
}

/**
 * The administrator behind an admin session token. Checked on every request,
 * so removing someone's administrator access, or disabling them, ends their
 * admin session at once.
 */
export async function resolveAdminSession(token: string): Promise<AdminIdentity | null> {
  const { rows } = await query<AdminIdentity>(
    `SELECT u.id, u.email, u.name
       FROM admin_sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token = $1 AND s.expires_at > now() AND u.is_server_admin AND u.disabled_at IS NULL`,
    [token],
  );
  return rows[0] ?? null;
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'strict' as const,
    // The admin port is usually plain HTTP on loopback or through a tunnel, so
    // this follows its own setting rather than the app's.
    secure: config.admin.secureCookies,
    path: ADMIN_API_PREFIX,
    maxAge: ADMIN_SESSION_HOURS * 60 * 60,
  };
}

export async function startAdminSession(reply: FastifyReply, userId: string): Promise<void> {
  const token = newSessionToken();
  await query(
    `INSERT INTO admin_sessions (token, user_id, expires_at)
     VALUES ($1, $2, now() + make_interval(hours => $3::int))`,
    [token, userId, ADMIN_SESSION_HOURS],
  );
  reply.setCookie(ADMIN_COOKIE, token, cookieOptions());
}

export async function endAdminSession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = req.cookies?.[ADMIN_COOKIE];
  if (token) await query('DELETE FROM admin_sessions WHERE token = $1', [token]);
  reply.clearCookie(ADMIN_COOKIE, { path: ADMIN_API_PREFIX });
}
