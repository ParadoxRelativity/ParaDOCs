import { useEffect, useRef, useState } from 'react';
import type { ChatEvent } from '@paradocs/shared';

export type SocketStatus = 'connecting' | 'connected' | 'disconnected';

function socketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  // Same origin, so the session cookie authenticates the handshake.
  return `${protocol}://${window.location.host}/chat`;
}

/**
 * One socket for the session, subscribed to every channel in the workspace.
 *
 * Subscribing to all of them rather than only the open one is what makes
 * mentions and unread counts arrive without a refetch: you have to be told
 * about a message in a channel you are not looking at, which is exactly the
 * case that matters for a notification.
 *
 * The handler is kept in a ref so changing it — which happens on every render,
 * since it closes over the message cache — does not tear the socket down.
 */
export function useChatSocket(channelIds: string[], onEvent: (event: ChatEvent) => void): SocketStatus {
  const [status, setStatus] = useState<SocketStatus>('connecting');
  const socketRef = useRef<WebSocket | null>(null);
  const handler = useRef(onEvent);
  handler.current = onEvent;

  // What the socket is currently subscribed to, so a reconnect can restore it
  // and a channel list change only sends the difference.
  const subscribed = useRef<Set<string>>(new Set());
  const wanted = useRef<string[]>(channelIds);
  wanted.current = channelIds;

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    function connect() {
      const socket = new WebSocket(socketUrl());
      socketRef.current = socket;
      setStatus('connecting');

      socket.onopen = () => {
        attempt = 0;
        setStatus('connected');
        // A new socket knows nothing, so everything is (re)subscribed here.
        subscribed.current = new Set();
        for (const id of wanted.current) {
          socket.send(JSON.stringify({ type: 'subscribe', channelId: id }));
          subscribed.current.add(id);
        }
      };
      socket.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data as string) as ChatEvent | { type: 'subscribed' };
          if (parsed.type === 'subscribed') return;
          handler.current(parsed as ChatEvent);
        } catch {
          // A malformed frame is not worth tearing the socket down for.
        }
      };
      socket.onclose = () => {
        setStatus('disconnected');
        subscribed.current = new Set();
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

  return status;
}
