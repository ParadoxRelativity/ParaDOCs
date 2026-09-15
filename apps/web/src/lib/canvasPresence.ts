import { useCallback, useEffect, useRef, useState } from 'react';
import type { CollabSession } from './collaboration';

/**
 * Where each person is on a canvas, shared through the document's awareness
 * rather than the Y.Doc: a pointer position is live, per-connection state that
 * must never be persisted or land in anyone's undo history.
 */
const FIELD = 'canvas';

/** At most one update per interval, so a moving pointer is not a flood of messages. */
const SEND_EVERY_MS = 50;

export interface CanvasPointer {
  x: number;
  y: number;
  /** False once the pointer has left the board; the last position is kept so others can still jump to it. */
  active: boolean;
}

export interface PeerPointer extends CanvasPointer {
  clientId: number;
  name: string;
  color: string;
}

/** Another client wrote this, so only well-formed numbers are believed. */
function readPointer(state: unknown): CanvasPointer | null {
  const raw = (state as { [FIELD]?: Partial<CanvasPointer> } | undefined)?.[FIELD];
  if (!raw || !Number.isFinite(raw.x) || !Number.isFinite(raw.y)) return null;
  return { x: raw.x!, y: raw.y!, active: raw.active === true };
}

/** A collaborator's last known position on the board, read on demand. */
export function peerPointer(session: CollabSession, clientId: number): CanvasPointer | null {
  return readPointer(session.provider.awareness?.getStates().get(clientId));
}

/**
 * Everyone else's pointer. Kept out of the editor's own state so a collaborator
 * moving their mouse re-renders the cursor layer, not the whole board.
 */
export function usePeerPointers(session: CollabSession): PeerPointer[] {
  const [pointers, setPointers] = useState<PeerPointer[]>([]);

  useEffect(() => {
    const awareness = session.provider.awareness;
    if (!awareness) return;
    const onChange = () => {
      const next: PeerPointer[] = [];
      awareness.getStates().forEach((state, clientId) => {
        if (clientId === awareness.clientID) return;
        const pointer = readPointer(state);
        const user = (state as { user?: { name?: unknown; color?: unknown } }).user;
        if (!pointer || typeof user?.name !== 'string') return;
        const color = typeof user.color === 'string' ? user.color : '#888';
        next.push({ clientId, name: user.name, color, ...pointer });
      });
      setPointers(next);
    };
    awareness.on('change', onChange);
    onChange();
    return () => awareness.off('change', onChange);
  }, [session]);

  return pointers;
}

/**
 * Publishes this person's pointer, in canvas units. Pass null when the pointer
 * leaves the board. Updates are throttled with a trailing send, so the last
 * position always arrives.
 */
export function usePublishPointer(session: CollabSession) {
  const last = useRef<CanvasPointer | null>(null);
  const sentAt = useRef(0);
  const timer = useRef<number | null>(null);

  const flush = useCallback(() => {
    timer.current = null;
    sentAt.current = Date.now();
    session.provider.awareness?.setLocalStateField(FIELD, last.current);
  }, [session]);

  const publish = useCallback(
    (point: { x: number; y: number } | null) => {
      if (point) {
        last.current = { x: point.x, y: point.y, active: true };
      } else if (last.current?.active) {
        last.current = { ...last.current, active: false };
      } else {
        return;
      }
      if (timer.current !== null) return;
      const wait = SEND_EVERY_MS - (Date.now() - sentAt.current);
      // Leaving the board is sent at once, so a cursor does not linger where nobody is.
      if (wait <= 0 || !point) flush();
      else timer.current = window.setTimeout(flush, wait);
    },
    [flush],
  );

  useEffect(() => {
    // Switching to another window or tab leaves the pointer wherever it was.
    const hide = () => publish(null);
    const onVisibility = () => document.hidden && hide();
    window.addEventListener('blur', hide);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('blur', hide);
      document.removeEventListener('visibilitychange', onVisibility);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
      // Leaving the canvas takes this person off everyone else's board.
      session.provider.awareness?.setLocalStateField(FIELD, null);
    };
  }, [session, publish]);

  return publish;
}
