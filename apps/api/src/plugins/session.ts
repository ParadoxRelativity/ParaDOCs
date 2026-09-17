import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { query } from '../db/pool.js';
import { config } from '../config.js';
import { forbidden, notFound, unauthorized } from '../lib/http.js';
import { uploadUrlSql } from '../lib/storage.js';
import type { WorkspaceApp } from '@paradocs/shared';
import { documentAccess } from '../lib/access.js';
import { assertAppEnabled } from '../lib/apps.js';

export const SESSION_COOKIE = 'paradocs_session';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
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
    `SELECT u.id, u.email, u.name, ${uploadUrlSql('u.avatar_key')} AS "avatarUrl"
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token = $1 AND s.expires_at > now() AND u.disabled_at IS NULL`,
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
 * Confirms membership and, when given, a minimum role and an app the workspace
 * must have turned on. Non-members get 404 rather than 403 so workspace ids
 * stay unguessable.
 */
export async function assertWorkspaceAccess(
  req: FastifyRequest,
  workspaceId: string,
  minimum: Role = 'viewer',
  app?: WorkspaceApp,
): Promise<Role> {
  if (!req.user) throw unauthorized();
  const role = await workspaceRole(req.user.id, workspaceId);
  if (!role) throw notFound('Workspace not found');
  if (app) await assertAppEnabled(workspaceId, app);
  if (!roleAtLeast(role, minimum)) {
    throw forbidden(`This action requires the ${minimum} role or higher`);
  }
  return role;
}

/**
 * Resolves a document and checks what the caller may do with it: their role in
 * its workspace, and any lock on the document or its folders. `editor` asks
 * whether they may change it; `admin` and `owner` are about the workspace role
 * alone. Someone who may not see it at all gets 404, as for a document that
 * does not exist.
 */
export async function assertDocumentAccess(
  req: FastifyRequest,
  documentId: string,
  minimum: Role = 'viewer',
): Promise<{ workspaceId: string; role: Role; canEdit: boolean }> {
  if (!req.user) throw unauthorized();
  const access = await documentAccess(req.user.id, documentId);
  if (!access) throw notFound('Document not found');
  if (roleAtLeast(minimum, 'admin')) {
    if (!roleAtLeast(access.role, minimum)) throw forbidden(`This action requires the ${minimum} role or higher`);
  } else if (minimum === 'editor' && access.level < 2) {
    throw forbidden(
      access.role === 'viewer'
        ? 'This action requires the editor role or higher'
        : 'You can view this document but not change it',
    );
  }
  return { workspaceId: access.workspaceId, role: access.role, canEdit: access.level === 2 };
}

/** Same check without a request, for the websocket handshake. */
export async function documentAccessForUser(
  userId: string,
  documentId: string,
): Promise<{ workspaceId: string; role: Role; canEdit: boolean } | null> {
  const access = await documentAccess(userId, documentId);
  return access ? { workspaceId: access.workspaceId, role: access.role, canEdit: access.level === 2 } : null;
}
