import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { TYPING_INTERVAL_MS, TYPING_TIMEOUT_MS } from '@paradocs/shared';

/**
 * Who is typing where, as heard over the chat socket.
 *
 * Kept in memory only. An entry lives until it is repeated, its message
 * arrives, it is called off, or it times out — the last of which also covers
 * someone closing their laptop mid-sentence.
 */

export interface Typist {
  id: string;
  name: string;
}

const typing = new Map<string, Map<string, Typist & { timer: ReturnType<typeof setTimeout> }>>();
const listeners = new Set<() => void>();
/** A stable list per channel, replaced only when it changes, as React needs. */
const snapshots = new Map<string, readonly Typist[]>();
const NOBODY: readonly Typist[] = [];

function changed(channelId: string) {
  snapshots.delete(channelId);
  for (const listener of listeners) listener();
}

/** Records that someone is typing in a channel, or has stopped. */
export function setTyping(channelId: string, user: Typist, active: boolean): void {
  let people = typing.get(channelId);
  const existing = people?.get(user.id);
  if (existing) clearTimeout(existing.timer);

  if (!active) {
    if (!people || !existing) return;
    people.delete(user.id);
    if (people.size === 0) typing.delete(channelId);
    changed(channelId);
    return;
  }

  if (!people) {
    people = new Map();
    typing.set(channelId, people);
  }
  const timer = setTimeout(() => setTyping(channelId, user, false), TYPING_TIMEOUT_MS);
  // Setting an existing key keeps its place, so names stay in the order people started.
  people.set(user.id, { id: user.id, name: user.name, timer });
  if (!existing || existing.name !== user.name) changed(channelId);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(channelId: string): readonly Typist[] {
  let list = snapshots.get(channelId);
  if (!list) {
    const people = typing.get(channelId);
    list = people ? [...people.values()].map(({ id, name }) => ({ id, name })) : NOBODY;
    snapshots.set(channelId, list);
  }
  return list;
}

/** Everyone else typing in a channel, in the order they started. */
export function useTypists(channelId: string): readonly Typist[] {
  return useSyncExternalStore(subscribe, () => snapshot(channelId));
}

/**
 * Reports your own typing from one message box: at the first keystroke, again
 * every few seconds while you keep going, and a stop when the box is emptied
 * or closed. Nothing is sent between keystrokes, so pausing with a draft in
 * the box lets the indicator lapse for everyone else on its own.
 */
export function useTypingReporter(onTyping: ((typing: boolean) => void) | undefined) {
  const sentAt = useRef(0);
  const report = useRef(onTyping);
  report.current = onTyping;

  // Leaving the channel, or the page, with a half-written message.
  useEffect(
    () => () => {
      if (sentAt.current) report.current?.(false);
      sentAt.current = 0;
    },
    [],
  );

  return useMemo(
    () => ({
      /** The draft changed under the person's hands. */
      changed(draft: string) {
        const send = report.current;
        if (!send) return;
        if (!draft.trim()) {
          if (sentAt.current) {
            sentAt.current = 0;
            send(false);
          }
          return;
        }
        const now = Date.now();
        if (now - sentAt.current < TYPING_INTERVAL_MS) return;
        sentAt.current = now;
        send(true);
      },
      /** The message went out; its arrival clears the indicator for everyone else. */
      sent() {
        sentAt.current = 0;
      },
    }),
    [],
  );
}
