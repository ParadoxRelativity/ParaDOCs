import type { FastifyBaseLogger } from 'fastify';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ChatEvent, PresenceStatus } from '@paradocs/shared';
import { SESSION_COOKIE, resolveSession, workspaceRole, type SessionUser } from '../plugins/session.js';
import { query } from '../db/pool.js';
import { channelAccessFor, publishChannelEvent, type ChannelAccess } from '../lib/channels.js';
import { subscribeToChannel, subscribeToUser, subscribeToWorkspace } from './hub.js';
import { appearsOffline, connectPresence } from './presence.js';

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
  /**
   * A subscription names a channel, for its messages, or a workspace, for who
   * is around and changes to its channels and members. Activity reports
   * whether this window has gone idle. Typing says the person is writing in a
   * channel, or has stopped.
   */
  type: 'subscribe' | 'unsubscribe' | 'activity' | 'typing';
  channelId?: string;
  workspaceId?: string;
  idle?: boolean;
  typing?: boolean;
}

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

/**
 * Typing arrives every few seconds per person, so where a socket may type is
 * checked once and remembered for a while rather than asked of the database
 * each time. A minute is short enough that losing access soon stops it.
 */
const TYPING_ACCESS_TTL_MS = 60_000;
/** Faster than any honest client repeats itself; anything quicker is dropped. */
const TYPING_MIN_GAP_MS = 1_000;
/** Remembered channels per socket, past which the memory starts over. */
const TYPING_ACCESS_LIMIT = 200;

/**
 * Pushes new messages to everyone with a channel open, presence to everyone
 * with a workspace open, and typing to whoever can read the channel.
 *
 * A socket subscribes to channels and workspaces one at a time, and every
 * subscription is checked against membership at the moment it is made — the
 * socket being authenticated says who you are, not what you may read.
 */
export function createChatServer(log: FastifyBaseLogger) {
  const wss = new WebSocketServer({ noServer: true });
  // Sockets that have stopped answering pings, so a dropped laptop lid does not
  // leave a subscriber attached to a channel forever.
  const alive = new WeakMap<WebSocket, boolean>();

  function handleConnection(socket: WebSocket, user: SessionUser, chosen: PresenceStatus) {
    const subscriptions = new Map<string, () => void>();
    const typingAccess = new Map<string, { access: ChannelAccess | null; checkedAt: number; sentAt: number }>();
    let closed = false;
    alive.set(socket, true);

    socket.on('pong', () => alive.set(socket, true));

    const send = (event: ChatEvent) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
    };

    // Direct messages and calls are addressed to a person rather than a
    // channel, so every socket they have open hears them without asking.
    const stopPersonal = subscribeToUser(user.id, send);
    // Having a socket open is what makes someone present; closing the last one
    // is what takes them away again.
    const presence = connectPresence(user.id, chosen, (err) => log.warn({ err }, 'could not announce presence'));

    /**
     * Passes on that this person is typing, or has stopped, to everyone who can
     * read the channel — the same audience its messages reach. Nothing is
     * stored; listeners let the indicator lapse when the updates stop.
     */
    async function relayTyping(channelId: string, typing: boolean) {
      const now = Date.now();
      let entry = typingAccess.get(channelId);
      if (!entry || now - entry.checkedAt > TYPING_ACCESS_TTL_MS) {
        if (typingAccess.size >= TYPING_ACCESS_LIMIT) typingAccess.clear();
        entry = { access: await channelAccessFor(user.id, channelId), checkedAt: now, sentAt: entry?.sentAt ?? 0 };
        typingAccess.set(channelId, entry);
      }
      const { access } = entry;
      if (closed || !access || (access.kind !== 'text' && access.kind !== 'direct')) return;
      // Someone typing is plainly around, so appearing offline hides it too —
      // stopping included, which would give them away just the same.
      if (appearsOffline(user.id)) return;
      // Stopping always gets through, so an indicator is never left behind.
      if (typing && now - entry.sentAt < TYPING_MIN_GAP_MS) return;
      entry.sentAt = typing ? now : 0;

      await publishChannelEvent(channelId, access.kind, {
        type: 'typing',
        workspaceId: access.workspaceId,
        channelId,
        user: { id: user.id, name: user.name },
        typing,
      });
    }

    socket.on('message', (raw) => {
      void (async () => {
        let parsed: ClientMessage;
        try {
          parsed = JSON.parse(raw.toString()) as ClientMessage;
        } catch {
          return;
        }
        if (!parsed || typeof parsed !== 'object') return;

        if (parsed.type === 'activity') {
          presence.setIdle(parsed.idle === true);
          return;
        }

        if (parsed.type === 'typing') {
          if (typeof parsed.channelId !== 'string' || !UUID.test(parsed.channelId)) return;
          await relayTyping(parsed.channelId, parsed.typing !== false);
          return;
        }

        const target =
          typeof parsed.channelId === 'string'
            ? { kind: 'channel' as const, id: parsed.channelId }
            : typeof parsed.workspaceId === 'string'
              ? { kind: 'workspace' as const, id: parsed.workspaceId }
              : null;
        if (!target || !UUID.test(target.id)) return;
        const key = `${target.kind}:${target.id}`;

        if (parsed.type === 'unsubscribe') {
          subscriptions.get(key)?.();
          subscriptions.delete(key);
          return;
        }
        if (parsed.type !== 'subscribe' || subscriptions.has(key)) return;

        // Access is re-checked here rather than trusted from the handshake.
        const allowed =
          target.kind === 'channel'
            ? (await channelAccessFor(user.id, target.id)) !== null
            : (await workspaceRole(user.id, target.id)) !== null;
        // The socket may have closed, or the same subscription landed twice,
        // while that was being checked.
        if (!allowed || closed || subscriptions.has(key)) return;

        if (target.kind === 'channel') {
          subscriptions.set(key, subscribeToChannel(target.id, send));
          socket.send(JSON.stringify({ type: 'subscribed', channelId: target.id }));
        } else {
          subscriptions.set(key, subscribeToWorkspace(target.id, send));
          socket.send(JSON.stringify({ type: 'subscribed', workspaceId: target.id }));
        }
      })().catch((err) => log.error({ err }, 'chat socket message failed'));
    });

    // Close and error can both arrive for one socket.
    const release = () => {
      if (closed) return;
      closed = true;
      for (const unsubscribe of subscriptions.values()) unsubscribe();
      subscriptions.clear();
      typingAccess.clear();
      stopPersonal();
      presence.close();
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
    // Presence starts from the status they chose; the rest is worked out from
    // their sockets.
    const { rows } = await query<{ presence: PresenceStatus }>('SELECT presence FROM users WHERE id = $1', [user.id]);
    const chosen = rows[0]?.presence ?? 'online';
    wss.handleUpgrade(request, socket, head, (ws) => handleConnection(ws, user, chosen));
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
