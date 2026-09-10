import { useEffect, useMemo, useState } from 'react';
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { COLLAB_FRAGMENT } from '@paradocs/shared';
import { colorFromString } from './util';

export type CollabStatus = 'connecting' | 'connected' | 'disconnected';

export interface Peer {
  clientId: number;
  name: string;
  color: string;
  avatarUrl: string | null;
}

export interface CollabSession {
  ydoc: Y.Doc;
  provider: HocuspocusProvider;
  fragment: Y.XmlFragment;
}

export const colorForUser = colorFromString;

function socketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  // Same origin, so the session cookie authenticates the socket.
  return `${protocol}://${window.location.host}/collab`;
}

function toStatus(raw: unknown): CollabStatus {
  return raw === 'connected' ? 'connected' : raw === 'connecting' ? 'connecting' : 'disconnected';
}

/**
 * Opens a collaborative session for one document. The Y.Doc is the live source
 * of truth; the server persists it and derives blocks and markdown from it.
 *
 * The provider is built inside an effect rather than a memo: StrictMode mounts,
 * tears down and remounts, and a memoized provider would be destroyed by the
 * first cleanup and then reused dead, so the socket never connected.
 */
export function useCollaboration(
  documentId: string,
  self: { id: string; name: string; avatarUrl?: string | null },
) {
  const [session, setSession] = useState<CollabSession | null>(null);
  const [status, setStatus] = useState<CollabStatus>('connecting');
  const [peers, setPeers] = useState<Peer[]>([]);

  useEffect(() => {
    const ydoc = new Y.Doc();
    const provider = new HocuspocusProvider({ url: socketUrl(), name: documentId, document: ydoc });
    setStatus(toStatus(provider.status));
    setSession({ ydoc, provider, fragment: ydoc.getXmlFragment(COLLAB_FRAGMENT) });

    return () => {
      provider.destroy();
      ydoc.destroy();
      setSession(null);
    };
  }, [documentId]);

  useEffect(() => {
    const provider = session?.provider;
    if (!provider) return;

    // Read the current value first: the socket often connects before this effect
    // runs, and the missed event would leave the badge stuck on "connecting".
    setStatus(toStatus(provider.status));
    const onStatus = ({ status }: { status: string }) => setStatus(toStatus(status));
    provider.on('status', onStatus);

    const awareness = provider.awareness;
    const onAwareness = () => {
      if (!awareness) return;
      const others: Peer[] = [];
      awareness.getStates().forEach((state, clientId) => {
        if (clientId === awareness.clientID) return;
        const user = (state as { user?: { name?: string; color?: string; avatarUrl?: unknown } }).user;
        if (!user?.name) return;
        // Another client wrote this, so only a path into our own uploads is drawn.
        const avatarUrl =
          typeof user.avatarUrl === 'string' && user.avatarUrl.startsWith('/uploads/') ? user.avatarUrl : null;
        others.push({ clientId, name: user.name, color: user.color ?? '#888', avatarUrl });
      });
      setPeers(others);
    };
    awareness?.on('change', onAwareness);
    onAwareness();

    return () => {
      provider.off('status', onStatus);
      awareness?.off('change', onAwareness);
    };
  }, [session]);

  const user = useMemo(
    () => ({ name: self.name, color: colorForUser(self.id), avatarUrl: self.avatarUrl ?? null }),
    [self.id, self.name, self.avatarUrl],
  );

  return { session, user, status, peers };
}
