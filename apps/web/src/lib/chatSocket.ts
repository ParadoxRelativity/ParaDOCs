import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatEvent } from '@paradocs/shared';
import { fromServer, openSocket, socketUrl } from './server';

export type SocketStatus = 'connecting' | 'connected' | 'disconnected';

/**
 * One socket for the session, subscribed to every channel in the workspace and
 * to the workspace itself.
 *
 * Subscribing to all channels rather than only the open one is what makes
 * mentions and unread counts arrive without a refetch: you have to be told
 * about a message in a channel you are not looking at, which is exactly the
 * case that matters for a notification. Direct messages and calls need no
 * subscription; the server sends them to the person.
 *
 * The socket also reports whether this window has gone idle, which is how the
 * server knows to show someone as away, and carries typing, which is only
 * worth sending while connected and is simply dropped otherwise.
 *
 * The handler is kept in a ref so changing it — which happens on every render,
 * since it closes over the message cache — does not tear the socket down.
 */
export function useChatSocket({
  channelIds,
  workspaceId,
  idle,
  onEvent,
}: {
  channelIds: string[];
  /** For who is around in it, and changes to its channels and members. */
  workspaceId: string;
  idle: boolean;
  onEvent: (event: ChatEvent) => void;
}): { status: SocketStatus; send: (message: object) => void } {
  const [status, setStatus] = useState<SocketStatus>('connecting');
  const socketRef = useRef<WebSocket | null>(null);
  const handler = useRef(onEvent);
  handler.current = onEvent;

  // What the socket should be told, so a reconnect can restore it, and what it
  // has been told, so a change only sends the difference. The latter is reset
  // whenever the socket is, since a new socket knows nothing.
  const wanted = useRef<string[]>(channelIds);
  wanted.current = channelIds;
  const wantedWorkspace = useRef(workspaceId);
  wantedWorkspace.current = workspaceId;
  const wantedIdle = useRef(idle);
  wantedIdle.current = idle;
  const subscribed = useRef<Set<string>>(new Set());
  const subscribedWorkspace = useRef<string | null>(null);
  const reportedIdle = useRef<boolean | null>(null);

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    function connect() {
      // Same origin in a browser, so the session cookie authenticates the
      // handshake; the mobile app offers its token instead.
      const socket = openSocket(socketUrl('/chat'));
      socketRef.current = socket;
      setStatus('connecting');
      const send = (message: object) => socket.send(JSON.stringify(message));

      socket.onopen = () => {
        attempt = 0;
        subscribed.current = new Set();
        for (const id of wanted.current) {
          send({ type: 'subscribe', channelId: id });
          subscribed.current.add(id);
        }
        subscribedWorkspace.current = wantedWorkspace.current || null;
        if (subscribedWorkspace.current) send({ type: 'subscribe', workspaceId: subscribedWorkspace.current });
        reportedIdle.current = wantedIdle.current;
        send({ type: 'activity', idle: wantedIdle.current });
        setStatus('connected');
      };
      socket.onmessage = (event) => {
        try {
          const parsed = fromServer(JSON.parse(event.data as string)) as ChatEvent | { type: 'subscribed' };
          if (parsed.type === 'subscribed') return;
          handler.current(parsed as ChatEvent);
        } catch {
          // A malformed frame is not worth tearing the socket down for.
        }
      };
      socket.onclose = () => {
        setStatus('disconnected');
        subscribed.current = new Set();
        subscribedWorkspace.current = null;
        reportedIdle.current = null;
        if (closed) return;
        // Back off so a server restart does not become a reconnect storm.
        attempt += 1;
        retry = setTimeout(connect, Math.min(1000 * 2 ** (attempt - 1), 15_000));
      };
      socket.onerror = () => socket.close();
    }

    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, []);

  // Channels appearing or disappearing sends only the difference. Keyed on the
  // joined ids so a new array with the same contents is not a change.
  const key = channelIds.join(',');
  useEffect(() => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const next = new Set(channelIds);

    for (const id of next) {
      if (subscribed.current.has(id)) continue;
      socket.send(JSON.stringify({ type: 'subscribe', channelId: id }));
      subscribed.current.add(id);
    }
    for (const id of [...subscribed.current]) {
      if (next.has(id)) continue;
      socket.send(JSON.stringify({ type: 'unsubscribe', channelId: id }));
      subscribed.current.delete(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, status]);

  useEffect(() => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const next = workspaceId || null;
    if (subscribedWorkspace.current === next) return;
    if (subscribedWorkspace.current) {
      socket.send(JSON.stringify({ type: 'unsubscribe', workspaceId: subscribedWorkspace.current }));
    }
    subscribedWorkspace.current = next;
    if (next) socket.send(JSON.stringify({ type: 'subscribe', workspaceId: next }));
  }, [workspaceId, status]);

  useEffect(() => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || reportedIdle.current === idle) return;
    reportedIdle.current = idle;
    socket.send(JSON.stringify({ type: 'activity', idle }));
  }, [idle, status]);

  /** Sends something momentary, such as typing. Dropped while disconnected. */
  const send = useCallback((message: object) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }, []);

  return { status, send };
}
