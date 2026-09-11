import { session as electronSession } from 'electron';
import http from 'node:http';
import https from 'node:https';
import type { InviteNotification, MessageNotification, Notifications, Role } from '@paradocs/shared';
import { partitionFor, type Connection } from './connections.js';
import { paths } from './paths.js';
import { readJson, writeJson } from './store.js';
import { loadedOrigin } from './windows.js';

/**
 * Talking to a connection's API on behalf of a page that belongs to a
 * different one: the workspace menu's other workspaces, and notifications from
 * other servers.
 *
 * A loaded connection is asked through its own proxy, with its own session. A
 * server that is not loaded is asked directly, with the session cookie its page
 * last signed in with. A local workspace that is not running cannot be asked
 * without starting its database.
 */

export interface WorkspaceEntry {
  id: string;
  name: string;
  icon: string | null;
  /**
   * A data URL. The picture's own path is relative to that connection's server,
   * which is not the one serving the page on screen.
   */
  picture: string | null;
}

export type WorkspaceListing =
  | { status: 'ok'; workspaces: WorkspaceEntry[] }
  | { status: 'signed-out' }
  | { status: 'unavailable'; workspaces: WorkspaceEntry[] };

export type NotificationsListing =
  | { status: 'ok'; notifications: Notifications }
  | { status: 'signed-out' }
  | { status: 'unavailable' };

export type Outcome = { ok: true } | { ok: false; error: string };

const SESSION_COOKIE = 'paradocs_session';
const TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_PICTURE_BYTES = 512 * 1024;
const ROLES = new Set<Role>(['owner', 'admin', 'editor', 'viewer']);

interface Reply {
  status: number;
  type: string;
  body: Buffer;
}

type Fetcher = (path: string, init?: { method: 'POST'; body: unknown }) => Promise<Reply>;

// --- the last known workspace lists ------------------------------------------

function readCache(): Record<string, WorkspaceEntry[]> {
  return readJson<Record<string, WorkspaceEntry[]>>(paths.workspaceCacheFile, {});
}

function remember(id: string, workspaces: WorkspaceEntry[]): void {
  writeJson(paths.workspaceCacheFile, { ...readCache(), [id]: workspaces });
}

function cached(id: string): WorkspaceEntry[] {
  return readCache()[id] ?? [];
}

export function forgetWorkspaces(id: string): void {
  const cache = readCache();
  delete cache[id];
  writeJson(paths.workspaceCacheFile, cache);
}

// --- reaching a connection ---------------------------------------------------

/** Through a loaded connection's proxy, carrying that page's own cookies. */
function viaSession(connection: Connection, origin: string): Fetcher {
  const session = electronSession.fromPartition(partitionFor(connection));
  return async (path, init) => {
    const response = await session.fetch(`${origin}${path}`, {
      method: init?.method ?? 'GET',
      credentials: 'include',
      ...(init ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return {
      status: response.status,
      type: response.headers.get('content-type') ?? '',
      body: Buffer.from(await response.arrayBuffer()),
    };
  };
}

/** Straight to a server that is not loaded, with the cookie its page signed in with. */
function direct(origin: string, token: string): Fetcher {
  return (path, init) =>
    new Promise((resolve, reject) => {
      const url = new URL(path, origin);
      const agent = url.protocol === 'https:' ? https : http;
      const payload = init ? JSON.stringify(init.body) : undefined;
      const request = agent.request(
        url,
        {
          method: init?.method ?? 'GET',
          timeout: TIMEOUT_MS,
          headers: {
            cookie: `${SESSION_COOKIE}=${token}`,
            ...(payload
              ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
              : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) request.destroy(new Error('The response was too large.'));
            else chunks.push(chunk);
          });
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              type: String(res.headers['content-type'] ?? ''),
              body: Buffer.concat(chunks),
            }),
          );
          res.on('error', reject);
        },
      );
      request.on('timeout', () => request.destroy(new Error('The server did not answer in time.')));
      request.on('error', reject);
      if (payload) request.write(payload);
      request.end();
    });
}

/** How to reach a connection: a fetcher, 'signed-out', or null when it cannot be asked. */
async function fetcherFor(connection: Connection): Promise<Fetcher | 'signed-out' | null> {
  const origin = loadedOrigin(connection.id);
  if (origin) return viaSession(connection, origin);
  if (connection.kind === 'remote' && connection.url) {
    const [cookie] = await electronSession
      .fromPartition(partitionFor(connection))
      .cookies.get({ name: SESSION_COOKIE });
    return cookie ? direct(connection.url, cookie.value) : 'signed-out';
  }
  return null;
}

/** Pictures never change under the same path, so each is fetched once per run. */
const pictures = new Map<string, string>();

async function picture(fetcher: Fetcher, path: unknown): Promise<string | null> {
  if (typeof path !== 'string' || !path.startsWith('/uploads/')) return null;
  const known = pictures.get(path);
  if (known) return known;
  try {
    const reply = await fetcher(path);
    const type = reply.type.split(';')[0].trim();
    if (reply.status !== 200 || !/^image\/(png|jpeg|webp|gif)$/.test(type)) return null;
    if (reply.body.length > MAX_PICTURE_BYTES) return null;
    const url = `data:${type};base64,${reply.body.toString('base64')}`;
    pictures.set(path, url);
    return url;
  } catch {
    return null;
  }
}

async function getJson(fetcher: Fetcher, path: string): Promise<unknown | 'signed-out'> {
  const reply = await fetcher(path);
  if (reply.status === 401) return 'signed-out';
  if (reply.status !== 200) throw new Error(`The server answered ${reply.status}.`);
  return JSON.parse(reply.body.toString('utf8'));
}

// --- what the pages ask for --------------------------------------------------

const text = (value: unknown, fallback = '') => (typeof value === 'string' ? value : fallback);
const nullable = (value: unknown) => (typeof value === 'string' ? value : null);
const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
const records = (value: unknown, limit: number) => (Array.isArray(value) ? value.slice(0, limit).map(record) : []);

export async function workspacesFor(connection: Connection): Promise<WorkspaceListing> {
  const fetcher = await fetcherFor(connection);
  if (fetcher === 'signed-out') return { status: 'signed-out' };
  if (!fetcher) return { status: 'unavailable', workspaces: cached(connection.id) };

  try {
    const rows = await getJson(fetcher, '/api/workspaces');
    if (rows === 'signed-out') return { status: 'signed-out' };
    if (!Array.isArray(rows)) throw new Error('The server sent something other than a list.');
    const workspaces = await Promise.all(
      records(rows, 200).map(async (row) => ({
        id: text(row.id),
        name: text(row.name),
        icon: nullable(row.icon),
        picture: await picture(fetcher, row.avatarUrl),
      })),
    );
    remember(connection.id, workspaces);
    return { status: 'ok', workspaces };
  } catch {
    return { status: 'unavailable', workspaces: cached(connection.id) };
  }
}

/**
 * Another server's notifications, rebuilt field by field: the page that shows
 * them belongs to a different server, so nothing from this one is passed along
 * unchecked, and pictures become data URLs it can display.
 */
export async function notificationsFor(connection: Connection): Promise<NotificationsListing> {
  const fetcher = await fetcherFor(connection);
  if (fetcher === 'signed-out') return { status: 'signed-out' };
  if (!fetcher) return { status: 'unavailable' };

  try {
    const raw = await getJson(fetcher, '/api/notifications');
    if (raw === 'signed-out') return { status: 'signed-out' };
    const body = record(raw);

    const workspace = async (value: unknown) => {
      const w = record(value);
      return { id: text(w.id), name: text(w.name), icon: nullable(w.icon), avatarUrl: await picture(fetcher, w.avatarUrl) };
    };

    const invites: InviteNotification[] = await Promise.all(
      records(body.invites, 100).map(async (invite) => ({
        id: text(invite.id),
        token: text(invite.token),
        role: ROLES.has(invite.role as Role) ? (invite.role as Role) : 'viewer',
        invitedBy: nullable(invite.invitedBy),
        createdAt: text(invite.createdAt),
        expiresAt: text(invite.expiresAt),
        workspace: await workspace(invite.workspace),
      })),
    );

    const messages: MessageNotification[] = await Promise.all(
      records(body.messages, 100).map(async (message) => {
        const latest = record(message.latest);
        const author = latest.author ? record(latest.author) : null;
        return {
          channelId: text(message.channelId),
          channelName: text(message.channelName),
          direct: message.direct === true,
          workspace: await workspace(message.workspace),
          unread: count(message.unread),
          mentions: count(message.mentions),
          latest: {
            id: text(latest.id),
            preview: text(latest.preview).slice(0, 300),
            createdAt: text(latest.createdAt),
            author: author
              ? { id: text(author.id), name: text(author.name, 'Someone'), avatarUrl: await picture(fetcher, author.avatarUrl) }
              : null,
          },
        };
      }),
    );

    return { status: 'ok', notifications: { invites, messages } };
  } catch {
    return { status: 'unavailable' };
  }
}

/** Sends a change to a connection's API on a page's behalf. */
export async function postTo(connection: Connection, path: string, body: unknown = {}): Promise<Outcome> {
  const fetcher = await fetcherFor(connection);
  if (fetcher === 'signed-out') return { ok: false, error: `Sign in to ${connection.label} first.` };
  if (!fetcher) return { ok: false, error: `${connection.label} is not open.` };

  try {
    const reply = await fetcher(path, { method: 'POST', body });
    if (reply.status >= 200 && reply.status < 300) return { ok: true };
    let detail = '';
    try {
      detail = text(record(JSON.parse(reply.body.toString('utf8'))).error);
    } catch {
      // Not JSON; the status says enough.
    }
    return { ok: false, error: detail || `${connection.label} answered ${reply.status}.` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
