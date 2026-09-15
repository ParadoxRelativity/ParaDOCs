import { publishToWorkspace } from '../chat/hub.js';

/**
 * Word that who can see what in a workspace has changed: a lock, a team, or
 * someone's role.
 *
 * Clients hear it over the chat socket and refetch what they show. The parts of
 * the server holding something open on someone's behalf — a channel
 * subscription, a document being edited, a call — listen here and check again,
 * because access granted when a socket opened says nothing about access now.
 */

type Listener = (workspaceId: string) => void;

const listeners = new Set<Listener>();

export function onAccessChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function accessChanged(workspaceId: string): void {
  publishToWorkspace(workspaceId, { type: 'access.changed', workspaceId });
  for (const listener of listeners) {
    try {
      listener(workspaceId);
    } catch {
      // One listener failing must not keep the others from checking.
    }
  }
}
