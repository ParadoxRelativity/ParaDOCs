import type { FastifyBaseLogger } from 'fastify';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { SESSION_COOKIE, resolveSession, workspaceRole, type SessionUser } from '../plugins/session.js';
import { query } from '../db/pool.js';
import { subscribeToChannel } from './hub.js';

export const CHAT_PATH = '/chat';

/** Same cookie handshake as the collaboration socket. */
function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

interface ClientMessage {
  type: 'subscribe' | 'unsubscribe';
  channelId?: string;
}

/**
 * Pushes new messages to everyone with a channel open.
 *
 * A socket subscribes to channels one at a time, and every subscription is
 * checked against workspace membership at the moment it is made — the socket
 * being authenticated says who you are, not what you may read.
 */
export function createChatServer(log: FastifyBaseLogger) {
  const wss = new WebSocketServer({ noServer: true });
  // Sockets that have stopped answering pings, so a dropped laptop lid does not
  // leave a subscriber attached to a channel forever.
  const alive = new WeakMap<WebSocket, boolean>();

  function handleConnection(socket: WebSocket, user: SessionUser) {
    const subscriptions = new Map<string, () => void>();
    alive.set(socket, true);

    socket.on('pong', () => alive.set(socket, true));

    socket.on('message', (raw) => {
      void (async () => {
        let parsed: ClientMessage;
        try {
          parsed = JSON.parse(raw.toString()) as ClientMessage;
        } catch {
          return;
        }
        const channelId = parsed.channelId;
        if (!channelId || typeof channelId !== 'string') return;

        if (parsed.type === 'unsubscribe') {
          subscriptions.get(channelId)?.();
          subscriptions.delete(channelId);
          return;
        }
        if (parsed.type !== 'subscribe' || subscriptions.has(channelId)) return;

        const { rows } = await query<{ workspace_id: string }>(
          'SELECT workspace_id FROM channels WHERE id = $1',
          [channelId],
        );
        const workspaceId = rows[0]?.workspace_id;
        if (!workspaceId) return;
        // Membership is re-checked here rather than trusted from the handshake.
        if (!(await workspaceRole(user.id, workspaceId))) return;

        subscriptions.set(
          channelId,
          subscribeToChannel(channelId, (event) => {
            if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
          }),
        );
        socket.send(JSON.stringify({ type: 'subscribed', channelId }));
      })().catch((err) => log.error({ err }, 'chat subscribe failed'));
    });

    const release = () => {
      for (const unsubscribe of subscriptions.values()) unsubscribe();
      subscriptions.clear();
    };
    socket.on('close', release);
    socket.on('error', release);
  }

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (alive.get(socket) === false) {
        socket.terminate();
        continue;
      }
      alive.set(socket, false);
      socket.ping();
    }
  }, 30_000);
  heartbeat.unref();

  async function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const token = readCookie(request.headers.cookie, SESSION_COOKIE);
    const user = token ? await resolveSession(token) : null;
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => handleConnection(ws, user));
  }

  function attach(server: Server) {
    server.on('upgrade', (request, socket, head) => {
      const path = (request.url ?? '').split('?')[0];
      // Other upgrade listeners — collaboration, Vite HMR in dev — must still
      // see sockets that are not ours.
      if (path !== CHAT_PATH) return;
      handleUpgrade(request, socket as Duplex, head).catch((err) => {
        log.error({ err }, 'chat upgrade failed');
        socket.destroy();
      });
    });
  }

  async function close() {
    clearInterval(heartbeat);
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }

  return { attach, close };
}
