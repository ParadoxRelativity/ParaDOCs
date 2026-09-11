import type { PresenceStatus } from '@paradocs/shared';
import { query } from '../db/pool.js';
import { publishToWorkspace } from './hub.js';

/**
 * Who is around, worked out from the chat sockets each person has open.
 *
 * Every window holds one socket and reports whether it has gone idle. Someone
 * set to online is online while any of their windows is in use and away once
 * all of them are quiet; any other choice is shown as chosen. With no socket
 * at all they are offline.
 *
 * Per-process, like the hub it publishes through.
 */

/**
 * Reloading a page drops its socket for a moment. Announcing "offline" for
 * that blink would flicker the dot for everyone watching.
 */
const OFFLINE_GRACE_MS = 5_000;

interface Session {
  idle: boolean;
}

interface Person {
  sessions: Set<Session>;
  chosen: PresenceStatus;
  /** What everyone was last told. */
  shown: PresenceStatus;
  /** Set while the last socket has closed but the grace period has not run out. */
  leaving: ReturnType<typeof setTimeout> | null;
}

const people = new Map<string, Person>();

function statusOf(person: Person): PresenceStatus {
  if (person.sessions.size === 0) return person.leaving ? person.shown : 'offline';
  if (person.chosen !== 'online') return person.chosen;
  for (const session of person.sessions) if (!session.idle) return 'online';
  return 'away';
}

export function presenceOf(userId: string): PresenceStatus {
  const person = people.get(userId);
  return person ? statusOf(person) : 'offline';
}

/**
 * Whether someone connected has chosen to appear offline. Everything that
 * would give them away — typing, most obviously — checks this.
 */
export function appearsOffline(userId: string): boolean {
  return people.get(userId)?.chosen === 'offline';
}

/** Tells every workspace the person is in, if what they would see has changed. */
async function settle(userId: string): Promise<void> {
  const person = people.get(userId);
  if (!person) return;
  const status = statusOf(person);
  if (person.sessions.size === 0 && !person.leaving) people.delete(userId);
  if (status === person.shown) return;
  person.shown = status;

  const { rows } = await query<{ workspace_id: string }>(
    'SELECT workspace_id FROM workspace_members WHERE user_id = $1',
    [userId],
  );
  // A later change may have settled while this one waited on the database;
  // the older answer must not land on top of it.
  if (person.shown !== status) return;
  for (const { workspace_id: workspaceId } of rows) {
    publishToWorkspace(workspaceId, { type: 'presence.changed', workspaceId, userId, status });
  }
}

/**
 * Registers one open socket. `chosen` is read from the database as the socket
 * connects, which also picks up a choice made from a window since closed.
 */
export function connectPresence(
  userId: string,
  chosen: PresenceStatus,
  onError: (err: unknown) => void,
): { setIdle: (idle: boolean) => void; close: () => void } {
  let person = people.get(userId);
  if (!person) {
    person = { sessions: new Set(), chosen, shown: 'offline', leaving: null };
    people.set(userId, person);
  }
  person.chosen = chosen;
  if (person.leaving) {
    clearTimeout(person.leaving);
    person.leaving = null;
  }

  const session: Session = { idle: false };
  person.sessions.add(session);
  const announce = () => void settle(userId).catch(onError);
  announce();

  let closed = false;
  return {
    setIdle(idle) {
      if (closed || session.idle === idle) return;
      session.idle = idle;
      announce();
    },
    close() {
      if (closed) return;
      closed = true;
      // The entry cannot have been dropped while this session was in it.
      const current = people.get(userId);
      if (!current) return;
      current.sessions.delete(session);
      if (current.sessions.size > 0) {
        announce();
        return;
      }
      if (current.leaving) clearTimeout(current.leaving);
      current.leaving = setTimeout(() => {
        current.leaving = null;
        announce();
      }, OFFLINE_GRACE_MS);
      current.leaving.unref();
    },
  };
}

/** Applies a newly chosen status to someone who is connected. */
export async function choosePresence(userId: string, status: PresenceStatus): Promise<void> {
  const person = people.get(userId);
  if (!person) return;
  person.chosen = status;
  await settle(userId);
}
