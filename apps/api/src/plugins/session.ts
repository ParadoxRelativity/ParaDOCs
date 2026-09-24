import type { IncomingMessage } from 'node:http';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { query } from '../db/pool.js';
import { config } from '../config.js';
import { forbidden, notFound, unauthorized } from '../lib/http.js';
import { newSessionToken } from '../lib/auth.js';
import { uploadUrlSql } from '../lib/storage.js';
import type { WorkspaceApp, WorkspacePermission } from '@paradocs/shared';
import { documentAccess, type ResourceAccess } from '../lib/access.js';
import { assertAppEnabled } from '../lib/apps.js';
import { MEMBERSHIP_COLUMNS, managesAccess, membershipFrom, missingPermission, type Membership } from '../lib/roles.js';

export const SESSION_COOKIE = 'paradocs_session';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}

export type { Role } from '@paradocs/shared';
export type { Membership } from '../lib/roles.js';

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
    const token = sessionToken(req);
    if (!token) return;
    req.user = await resolveSession(token);
  });

  app.decorate('requireAuth', async (req: FastifyRequest) => {
    if (!req.user) throw unauthorized();
  });
};

export const sessionPlugin = fp(plugin, { name: 'session' });

/**
 * The session token a request carries. A browser sends it as a cookie. The
 * mobile app is served from its own origin, and a cross-site cookie from a
 * webview is refused or dropped, so it sends the token as a bearer header
 * instead.
 */
export function sessionToken(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length).trim() || undefined;
  return req.cookies?.[SESSION_COOKIE];
}

/**
 * The subprotocol a websocket offers to authenticate with, followed by the
 * token itself: `new WebSocket(url, [BEARER_PROTOCOL, token])`. A browser
 * websocket cannot set headers, and a token in the address would end up in
 * access logs, so this is how the mobile app authenticates a socket.
 */
export const BEARER_PROTOCOL = 'paradocs.bearer';

/** The session token on a websocket handshake: the cookie, or the bearer subprotocol. */
export function upgradeToken(request: IncomingMessage): string | undefined {
  const offered = (request.headers['sec-websocket-protocol'] ?? '').split(',').map((p) => p.trim());
  const at = offered.indexOf(BEARER_PROTOCOL);
  if (at !== -1 && offered[at + 1]) return offered[at + 1];
  return readCookie(request.headers.cookie, SESSION_COOKIE);
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return undefined;
}

/**
 * Picks the subprotocol a websocket server answers with. One that offered the
 * bearer protocol has to have it echoed back, or the client drops the
 * connection; the token after it is never echoed.
 */
export function selectProtocol(protocols: Set<string>): string | false {
  if (protocols.has(BEARER_PROTOCOL)) return BEARER_PROTOCOL;
  const [first] = protocols;
  return first ?? false;
}

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

/**
 * The user behind a files-only token, for serving uploads to a client that
 * cannot send its session with a picture. See migration 0029.
 */
export async function resolveMediaToken(mediaToken: string): Promise<SessionUser | null> {
  const { rows } = await query<SessionUser>(
    `SELECT u.id, u.email, u.name, ${uploadUrlSql('u.avatar_key')} AS "avatarUrl"
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.media_token = $1 AND s.expires_at > now() AND u.disabled_at IS NULL`,
    [mediaToken],
  );
  return rows[0] ?? null;
}

/** The files-only token of a session, for handing to the client that holds it. */
export async function mediaTokenFor(sessionToken: string): Promise<string | null> {
  const { rows } = await query<{ media_token: string }>('SELECT media_token FROM sessions WHERE token = $1', [
    sessionToken,
  ]);
  return rows[0]?.media_token ?? null;
}

export interface NewSession {
  token: string;
  /** Reads uploaded files and nothing else; see migration 0029. */
  mediaToken: string;
}

export async function createSession(userId: string): Promise<NewSession> {
  const token = newSessionToken();
  const { rows } = await query<{ media_token: string }>(
    `INSERT INTO sessions (token, user_id, expires_at)
     VALUES ($1, $2, now() + ($3 || ' days')::interval)
     RETURNING media_token`,
    [token, userId, String(config.sessionTtlDays)],
  );
  return { token, mediaToken: rows[0].media_token };
}

/**
 * Hands a new session to whoever signed in. A browser gets it as an HTTP-only
 * cookie, where page script cannot read it. The mobile app asks for it in the
 * body instead, with this header, because it cannot use a cookie from another
 * origin and has to send the token itself.
 */
const TOKEN_HEADER = 'x-paradocs-session';

export function issueSession(req: FastifyRequest, reply: FastifyReply, session: NewSession): Partial<NewSession> {
  if (req.headers[TOKEN_HEADER] === 'token') return session;
  reply.setCookie(SESSION_COOKIE, session.token, sessionCookieOptions());
  return {};
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

/** The signed-in user's place in a workspace, or null if they are not a member. */
export async function workspaceMembership(userId: string, workspaceId: string): Promise<Membership | null> {
  const { rows } = await query<{ role: Membership['role']; role_id: string; permissions: string[] }>(
    `SELECT ${MEMBERSHIP_COLUMNS}
       FROM workspace_members m
       JOIN workspace_roles r ON r.id = m.role_id
      WHERE m.workspace_id = $1 AND m.user_id = $2`,
    [workspaceId, userId],
  );
  return rows[0] ? membershipFrom(rows[0]) : null;
}

/**
 * What a route asks of the caller: a permission their role must grant,
 * `manage` for owners and admins, or `owner`. Nothing asks only that they are
 * a member.
 */
export type Requirement = WorkspacePermission | 'manage' | 'owner';

/** Whether someone meets a requirement. */
export function meets(member: Membership, need: Requirement): boolean {
  if (need === 'owner') return member.role === 'owner';
  if (need === 'manage') return managesAccess(member.role);
  return member.permissions.has(need);
}

function refusal(need: Requirement): string {
  if (need === 'owner') return 'Only an owner can do this';
  if (need === 'manage') return 'Only an owner or admin can do this';
  return missingPermission(need);
}

/**
 * Confirms membership and, when given, a requirement and an app the workspace
 * must have turned on. Non-members get 404 rather than 403 so workspace ids
 * stay unguessable.
 */
export async function assertWorkspaceAccess(
  req: FastifyRequest,
  workspaceId: string,
  need?: Requirement,
  app?: WorkspaceApp,
): Promise<Membership> {
  if (!req.user) throw unauthorized();
  const member = await workspaceMembership(req.user.id, workspaceId);
  if (!member) throw notFound('Workspace not found');
  if (app) await assertAppEnabled(workspaceId, app);
  assertMeets(member, need);
  return member;
}

/** Refuses someone who does not meet a requirement. */
export function assertMeets(member: Membership, need: Requirement | undefined): void {
  if (need && !meets(member, need)) throw forbidden(refusal(need));
}

/**
 * Resolves a document and checks what the caller may do with it: their role in
 * its workspace, and any lock on the document or its folders. `comment` asks
 * only that their role lets them comment on what they can see; `edit` and
 * `delete` also that no lock holds them to viewing. Someone who may not see it
 * at all gets 404, as for a document that does not exist.
 */
export async function assertDocumentAccess(
  req: FastifyRequest,
  documentId: string,
  need: 'view' | 'comment' | 'edit' | 'delete' = 'view',
): Promise<ResourceAccess & { canEdit: boolean }> {
  if (!req.user) throw unauthorized();
  const access = await documentAccess(req.user.id, documentId);
  if (!access) throw notFound('Document not found');
  if (need !== 'view') assertMeets(access, `docs.${need}`);
  if (need === 'edit' || need === 'delete') {
    if (access.level < 2) {
      throw forbidden(
        access.permissions.has('docs.edit')
          ? 'You can view this document but not change it'
          : missingPermission('docs.edit'),
      );
    }
  }
  return { ...access, canEdit: access.level === 2 };
}

/** Same check without a request, for the websocket handshake. */
export async function documentAccessForUser(
  userId: string,
  documentId: string,
): Promise<{ workspaceId: string; canEdit: boolean } | null> {
  const access = await documentAccess(userId, documentId);
  return access ? { workspaceId: access.workspaceId, canEdit: access.level === 2 } : null;
}
