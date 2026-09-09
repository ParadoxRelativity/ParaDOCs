import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { query } from '../db/pool.js';
import { config } from '../config.js';
import { forbidden, notFound, unauthorized } from '../lib/http.js';

export const SESSION_COOKIE = 'paradocs_session';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

/** Ordered least to most privileged, so comparisons are a simple index check. */
export const ROLES = ['viewer', 'editor', 'admin', 'owner'] as const;
export type Role = (typeof ROLES)[number];

export function roleAtLeast(role: Role, minimum: Role): boolean {
  return ROLES.indexOf(role) >= ROLES.indexOf(minimum);
}

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
  }
  interface FastifyInstance {
    /** preHandler that rejects unauthenticated requests. */
    requireAuth: (req: FastifyRequest) => Promise<void>;
  }
}

const plugin: FastifyPluginAsync = async (app) => {
  app.decorateRequest('user', null);

  app.addHook('onRequest', async (req) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) return;
    req.user = await resolveSession(token);
  });

  app.decorate('requireAuth', async (req: FastifyRequest) => {
    if (!req.user) throw unauthorized();
  });
};

export const sessionPlugin = fp(plugin, { name: 'session' });

/** Looks up the user behind a session token. Shared with the websocket handshake. */
export async function resolveSession(token: string): Promise<SessionUser | null> {
  const { rows } = await query<SessionUser>(
    `SELECT u.id, u.email, u.name
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token = $1 AND s.expires_at > now()`,
    [token],
  );
  return rows[0] ?? null;
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: config.secureCookies,
    path: '/',
    maxAge: config.sessionTtlDays * 24 * 60 * 60,
  };
}

/** The signed-in user's role in a workspace, or null if they are not a member. */
export async function workspaceRole(userId: string, workspaceId: string): Promise<Role | null> {
  const { rows } = await query<{ role: Role }>(
    'SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
    [workspaceId, userId],
  );
  return rows[0]?.role ?? null;
}

/**
 * Confirms membership and, when given, a minimum role. Non-members get 404
 * rather than 403 so workspace ids stay unguessable.
 */
export async function assertWorkspaceAccess(
  req: FastifyRequest,
  workspaceId: string,
  minimum: Role = 'viewer',
): Promise<Role> {
  if (!req.user) throw unauthorized();
  const role = await workspaceRole(req.user.id, workspaceId);
  if (!role) throw notFound('Workspace not found');
  if (!roleAtLeast(role, minimum)) {
    throw forbidden(`This action requires the ${minimum} role or higher`);
  }
  return role;
}

/** Resolves a document and checks the caller's role in its workspace. */
export async function assertDocumentAccess(
  req: FastifyRequest,
  documentId: string,
  minimum: Role = 'viewer',
): Promise<{ workspaceId: string; role: Role }> {
  if (!req.user) throw unauthorized();
  const { rows } = await query<{ workspace_id: string }>(
    'SELECT workspace_id FROM documents WHERE id = $1',
    [documentId],
  );
  if (!rows[0]) throw notFound('Document not found');
  const workspaceId = rows[0].workspace_id;
  const role = await assertWorkspaceAccess(req, workspaceId, minimum);
  return { workspaceId, role };
}

/** Same check without a request, for the websocket handshake. */
export async function documentAccessForUser(
  userId: string,
  documentId: string,
): Promise<{ workspaceId: string; role: Role } | null> {
  const { rows } = await query<{ workspace_id: string }>(
    'SELECT workspace_id FROM documents WHERE id = $1',
    [documentId],
  );
  if (!rows[0]) return null;
  const role = await workspaceRole(userId, rows[0].workspace_id);
  return role ? { workspaceId: rows[0].workspace_id, role } : null;
}
