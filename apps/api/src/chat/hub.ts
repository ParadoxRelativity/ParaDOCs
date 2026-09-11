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

function audience() {
  const listeners = new Map<string, Set<Listener>>();

  return {
    subscribe(key: string, listener: Listener): () => void {
      let set = listeners.get(key);
      if (!set) {
        set = new Set();
        listeners.set(key, set);
      }
      set.add(listener);

      return () => {
        const current = listeners.get(key);
        if (!current) return;
        current.delete(listener);
        // Drop the empty set so a workspace with thousands of dead channels does
        // not keep an entry each.
        if (current.size === 0) listeners.delete(key);
      };
    },

    publish(key: string, event: ChatEvent): void {
      const set = listeners.get(key);
      if (!set) return;
      for (const listener of set) {
        try {
          listener(event);
        } catch {
          // One broken socket must not stop delivery to the others.
        }
      }
    },

    count(key: string): number {
      return listeners.get(key)?.size ?? 0;
    },
  };
}

/** Messages in a named channel, to everyone with it open. */
const channels = audience();
/** Who is around, and changes to a workspace's channels and members. */
const workspaces = audience();
/**
 * What is addressed to one person — their direct messages and calls — to
 * every window they have open, without their having to ask for it.
 */
const users = audience();

export function subscribeToChannel(channelId: string, listener: Listener): () => void {
  return channels.subscribe(channelId, listener);
}

export function publishToChannel(channelId: string, event: ChatEvent): void {
  channels.publish(channelId, event);
}

export function subscribeToWorkspace(workspaceId: string, listener: Listener): () => void {
  return workspaces.subscribe(workspaceId, listener);
}

export function publishToWorkspace(workspaceId: string, event: ChatEvent): void {
  workspaces.publish(workspaceId, event);
}

export function subscribeToUser(userId: string, listener: Listener): () => void {
  return users.subscribe(userId, listener);
}

export function publishToUser(userId: string, event: ChatEvent): void {
  users.publish(userId, event);
}

/** Test/diagnostic helper: how many sockets are listening to a channel. */
export function listenerCount(channelId: string): number {
  return channels.count(channelId);
}
