import crypto from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { AI_KEY_PREFIX, MCP_PATH } from '@paradocs/shared';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { forbidden } from './http.js';
import { uploadUrlSql } from './storage.js';

/**
 * The secrets AI connections call with. See migration 0038.
 *
 * A personal access key (`pdk_`) is the connection's own secret. A client that
 * signed in instead calls with short-lived access tokens (`pda_`) and renews
 * them with a refresh token (`pdr_`) that changes each time it is used. Only
 * hashes are stored, and each prefix says what the secret is, so one pasted in
 * the wrong place is recognisable.
 */

export const ACCESS_TOKEN_PREFIX = 'pda_';
export const REFRESH_TOKEN_PREFIX = 'pdr_';

/** How long an access token lasts. A client renews it with its refresh token. */
export const ACCESS_TOKEN_SECONDS = 60 * 60;
/** A signed-in client not heard from in this long has to sign in again. */
export const IDLE_DAYS = 90;

export function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

export function newSecret(prefix: string): string {
  return prefix + crypto.randomBytes(32).toString('base64url');
}

/** Whether a bearer token is one of these rather than a session. */
export function isAiToken(token: string): boolean {
  return token.startsWith(AI_KEY_PREFIX) || token.startsWith(ACCESS_TOKEN_PREFIX);
}

/** What a request made through an AI connection may do, beyond what its person may. */
export interface AiCaller {
  connectionId: string;
  /** Null: every workspace the person is in. */
  workspaceId: string | null;
  canWrite: boolean;
}

interface Resolved {
  user: { id: string; email: string; name: string; avatarUrl: string | null };
  ai: AiCaller;
}

const RESOLVED_COLUMNS = `u.id, u.email, u.name, ${uploadUrlSql('u.avatar_key')} AS "avatarUrl",
  c.id AS "connectionId", c.workspace_id AS "workspaceId", c.can_write AS "canWrite"`;

/** The person and connection behind a key or access token, or null when it is not a live one. */
export async function resolveAiToken(token: string): Promise<Resolved | null> {
  const hash = hashSecret(token);
  const { rows } = token.startsWith(AI_KEY_PREFIX)
    ? await query<Resolved['user'] & AiCaller>(
        `SELECT ${RESOLVED_COLUMNS}
           FROM ai_connections c JOIN users u ON u.id = c.user_id
          WHERE c.token_hash = $1 AND c.kind = 'key' AND u.disabled_at IS NULL`,
        [hash],
      )
    : await query<Resolved['user'] & AiCaller>(
        `SELECT ${RESOLVED_COLUMNS}
           FROM ai_access_tokens t
           JOIN ai_connections c ON c.id = t.connection_id
           JOIN users u ON u.id = c.user_id
          WHERE t.token_hash = $1 AND t.expires_at > now() AND u.disabled_at IS NULL`,
        [hash],
      );
  const row = rows[0];
  if (!row) return null;
  return {
    user: { id: row.id, email: row.email, name: row.name, avatarUrl: row.avatarUrl },
    ai: { connectionId: row.connectionId, workspaceId: row.workspaceId, canWrite: row.canWrite },
  };
}

/** Notes that a connection was used, at most once a minute so a busy one does not write on every call. */
export async function touchConnection(connectionId: string): Promise<void> {
  await query(
    `UPDATE ai_connections SET last_used_at = now()
      WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
    [connectionId],
  );
}

/**
 * The MCP server's tools do their work through the app's own routes, so an
 * assistant is checked exactly as its person would be. Those calls carry this
 * header with a secret that lives only in this process; nothing from outside
 * can send it.
 */
export const INTERNAL_CALL_HEADER = 'x-paradocs-mcp-call';
export const internalCallSecret = crypto.randomBytes(32).toString('hex');

function isInternalCall(req: FastifyRequest): boolean {
  const sent = req.headers[INTERNAL_CALL_HEADER];
  if (typeof sent !== 'string' || sent.length !== internalCallSecret.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(internalCallSecret));
}

/**
 * Where an AI connection's token may be used: the MCP server, and the routes
 * its tools call on its behalf. Anywhere else — changing a password, making
 * more keys, deleting a workspace — it is refused, whatever the person could
 * do there themselves. A read-only connection changes nothing even there.
 */
export function assertAiRoute(req: FastifyRequest, ai: AiCaller): void {
  const path = req.url.split('?')[0];
  if (path === MCP_PATH) return;
  if (!isInternalCall(req)) throw forbidden(`An AI connection can only be used with the MCP server at ${MCP_PATH}`);
  if (!ai.canWrite && req.method !== 'GET' && req.method !== 'HEAD') {
    throw forbidden('This AI connection can only read');
  }
}

/** The address people reach this server at, for links an outside client follows. */
export function publicOrigin(req: FastifyRequest): string {
  return config.publicUrl || `${req.protocol}://${req.host}`;
}
