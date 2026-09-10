import type { ChatEvent } from '@paradocs/shared';

/**
 * In-process fan-out from the REST routes to the connected sockets.
 *
 * Deliberately a plain registry rather than anything the routes have to know
 * about: a route publishes an event and does not import the websocket layer,
 * which keeps the HTTP path testable and free of transport concerns.
 *
 * This is per-process. A deployment running several API instances behind a
 * load balancer would need Postgres LISTEN/NOTIFY here to reach sockets on the
 * other instances; a single self-hosted process, which is what the Docker image
 * runs, needs nothing more.
 */

type Listener = (event: ChatEvent) => void;

const listeners = new Map<string, Set<Listener>>();

export function subscribeToChannel(channelId: string, listener: Listener): () => void {
  let set = listeners.get(channelId);
  if (!set) {
    set = new Set();
    listeners.set(channelId, set);
  }
  set.add(listener);

  return () => {
    const current = listeners.get(channelId);
    if (!current) return;
    current.delete(listener);
    // Drop the empty set so a workspace with thousands of dead channels does
    // not keep an entry each.
    if (current.size === 0) listeners.delete(channelId);
  };
}

export function publishToChannel(channelId: string, event: ChatEvent): void {
  const set = listeners.get(channelId);
  if (!set) return;
  for (const listener of set) {
    try {
      listener(event);
    } catch {
      // One broken socket must not stop delivery to the others.
    }
  }
}

/** Test/diagnostic helper: how many sockets are listening to a channel. */
export function listenerCount(channelId: string): number {
  return listeners.get(channelId)?.size ?? 0;
}
