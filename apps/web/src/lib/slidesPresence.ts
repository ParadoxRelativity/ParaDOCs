import { useEffect, useRef, useState } from 'react';
import type { CollabSession } from './collaboration';

/**
 * Which slide each person is on and what they have selected there, shared
 * through awareness beside the pointer (lib/canvasPresence.ts). Like the
 * pointer it is live, per-connection state and never reaches the Y.Doc or
 * anyone's undo history.
 */
const FIELD = 'slide';

export interface SlideLocation {
  slideId: string | null;
  selected: string[];
}

export interface PeerSlideState extends SlideLocation {
  clientId: number;
  name: string;
  color: string;
}

/** Another client wrote this, so only well-formed strings are believed. */
function readLocation(state: unknown): SlideLocation | null {
  const raw = (state as { [FIELD]?: Partial<SlideLocation> } | undefined)?.[FIELD];
  if (!raw || (raw.slideId !== null && typeof raw.slideId !== 'string')) return null;
  const selected = Array.isArray(raw.selected) ? raw.selected.filter((id): id is string => typeof id === 'string').slice(0, 200) : [];
  return { slideId: raw.slideId ?? null, selected };
}

/** Everyone else's slide and selection. Kept apart from the editor's state so a collaborator clicking re-renders only what shows them. */
export function usePeerSlideStates(session: CollabSession): PeerSlideState[] {
  const [peers, setPeers] = useState<PeerSlideState[]>([]);
  const lastKey = useRef('');

  useEffect(() => {
    const awareness = session.provider.awareness;
    if (!awareness) return;
    const onChange = () => {
      const next: PeerSlideState[] = [];
      awareness.getStates().forEach((state, clientId) => {
        if (clientId === awareness.clientID) return;
        const location = readLocation(state);
        const user = (state as { user?: { name?: unknown; color?: unknown } }).user;
        if (!location || typeof user?.name !== 'string') return;
        next.push({ clientId, name: user.name, color: typeof user.color === 'string' ? user.color : '#888', ...location });
      });
      // Awareness also carries pointers, which change many times a second;
      // only a change to who is where is worth a render.
      const key = JSON.stringify(next);
      if (key === lastKey.current) return;
      lastKey.current = key;
      setPeers(next);
    };
    awareness.on('change', onChange);
    onChange();
    return () => awareness.off('change', onChange);
  }, [session]);

  return peers;
}

/** Publishes this person's slide and selection, and takes them off everyone else's view on leaving. */
export function usePublishSlideState(session: CollabSession, slideId: string | null, selected: Set<string>) {
  const key = [...selected].sort().join(',');
  useEffect(() => {
    session.provider.awareness?.setLocalStateField(FIELD, { slideId, selected: key ? key.split(',') : [] });
  }, [session, slideId, key]);
  useEffect(
    () => () => {
      session.provider.awareness?.setLocalStateField(FIELD, null);
    },
    [session],
  );
}
