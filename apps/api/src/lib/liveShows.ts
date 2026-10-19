import {
  normalizeLiveState,
  sameLiveState,
  type ChatEvent,
  type LiveShowInfo,
  type LiveShowRefusal,
  type ShowState,
} from '@paradocs/shared';
import { query } from '../db/pool.js';
import { publishToShow, publishToWorkspace, subscribeToShow } from '../chat/hub.js';
import { workspaceMembership } from '../plugins/session.js';
import { channelAccessFor } from './channels.js';
import { isUuid } from './cursor.js';
import { presentationAccessForUser } from './presentationAccess.js';

/**
 * Live slideshows: one presenter per presentation, and whoever follows.
 *
 * A session lives only in this process and only as long as the presenter's
 * socket does, so a show cannot outlive the person running it and nothing is
 * stored. The presenter's socket is the only one whose position is taken;
 * followers send nothing the server acts on but joining and leaving.
 *
 * Callers are identified by an `owner` token, one per socket, so a person with
 * two windows open is two parties and only the window that started the show
 * drives it.
 */

export type Owner = symbol;
type Reply = (event: ChatEvent) => void;

/** Followers a show takes before turning more away. */
export const MAX_FOLLOWERS = 500;
/** Position updates closer together than this are held back and merged, so a held-down key cannot flood the audience. */
export const MIN_PUBLISH_GAP_MS = 40;

interface Session {
  info: Omit<LiveShowInfo, 'viewers'>;
  owner: Owner;
  state: ShowState;
  seq: number;
  lastPublishedAt: number;
  pending: ReturnType<typeof setTimeout> | null;
  stopOwner: () => void;
  viewers: Map<Owner, () => void>;
}

const sessions = new Map<string, Session>();
/** Every show a socket is part of, so closing it can let go of them all. */
const memberships = new Map<Owner, Set<string>>();

const EMPTY_STATE: ShowState = { slideId: null, step: 0, blank: null, jump: '' };

function remember(owner: Owner, presentationId: string) {
  let set = memberships.get(owner);
  if (!set) memberships.set(owner, (set = new Set()));
  set.add(presentationId);
}

function forget(owner: Owner, presentationId: string) {
  const set = memberships.get(owner);
  set?.delete(presentationId);
  if (set?.size === 0) memberships.delete(owner);
}

function infoOf(session: Session): LiveShowInfo {
  return { ...session.info, viewers: session.viewers.size };
}

function refuse(presentationId: string, reason: LiveShowRefusal, message: string): ChatEvent {
  return { type: 'show.refused', presentationId, reason, message };
}

function changed(session: Session) {
  publishToWorkspace(session.info.workspaceId, {
    type: 'shows.changed',
    workspaceId: session.info.workspaceId,
    presentationId: session.info.presentationId,
  });
}

function publishState(session: Session) {
  if (session.pending) clearTimeout(session.pending);
  session.pending = null;
  session.lastPublishedAt = Date.now();
  session.seq += 1;
  publishToShow(session.info.presentationId, {
    type: 'show.state',
    presentationId: session.info.presentationId,
    state: session.state,
    seq: session.seq,
  });
}

function publishViewers(session: Session) {
  publishToShow(session.info.presentationId, {
    type: 'show.viewers',
    presentationId: session.info.presentationId,
    viewers: session.viewers.size,
  });
}

function close(session: Session) {
  if (sessions.get(session.info.presentationId) !== session) return;
  if (session.pending) clearTimeout(session.pending);
  publishToShow(session.info.presentationId, { type: 'show.ended', presentationId: session.info.presentationId });
  sessions.delete(session.info.presentationId);
  session.stopOwner();
  forget(session.owner, session.info.presentationId);
  for (const [viewer, stop] of session.viewers) {
    stop();
    forget(viewer, session.info.presentationId);
  }
  session.viewers.clear();
  changed(session);
}

/**
 * Starts a live show of a presentation for `user`, who needs `slides.present`
 * and to be able to see the deck. `channelId` is where it was announced, if
 * anywhere; it must be a channel they can read in the same workspace.
 */
export async function startShow(
  user: { id: string; name: string },
  owner: Owner,
  presentationId: string,
  channelId: string | null | undefined,
  reply: Reply,
): Promise<void> {
  const access = isUuid(presentationId) ? await presentationAccessForUser(user.id, presentationId) : null;
  if (!access) return reply(refuse(presentationId, 'forbidden', 'You cannot open that presentation'));
  const member = await workspaceMembership(user.id, access.workspaceId);
  if (!member?.permissions.has('slides.present')) {
    return reply(refuse(presentationId, 'forbidden', 'Your role does not let you present live'));
  }
  const { rows } = await query<{ title: string; archived: boolean }>(
    'SELECT title, archived_at IS NOT NULL AS archived FROM presentations WHERE id = $1',
    [presentationId],
  );
  if (!rows[0] || rows[0].archived) return reply(refuse(presentationId, 'unavailable', 'That presentation is archived'));
  if (channelId) {
    const channel = isUuid(channelId) ? await channelAccessFor(user.id, channelId) : null;
    if (!channel || channel.workspaceId !== access.workspaceId) {
      return reply(refuse(presentationId, 'forbidden', 'You cannot post in that channel'));
    }
  }

  // The awaits above let another start in; look again now that it is settled.
  const existing = sessions.get(presentationId);
  if (existing) {
    if (existing.info.presenter.id !== user.id) {
      return reply(refuse(presentationId, 'busy', `${existing.info.presenter.name} is already presenting this`));
    }
    // The same person starting again, from another window, takes over.
    close(existing);
  }

  const session: Session = {
    info: {
      presentationId,
      workspaceId: access.workspaceId,
      title: rows[0].title,
      presenter: { id: user.id, name: user.name },
      channelId: channelId ?? null,
      startedAt: new Date().toISOString(),
    },
    owner,
    state: EMPTY_STATE,
    seq: 0,
    lastPublishedAt: 0,
    pending: null,
    stopOwner: subscribeToShow(presentationId, reply),
    viewers: new Map(),
  };
  sessions.set(presentationId, session);
  remember(owner, presentationId);
  reply({ type: 'show.started', presentationId, show: infoOf(session) });
  changed(session);
}

/** The presenter moved. Anyone else's position is ignored, as is anything that is not a position. */
export function updateShow(owner: Owner, presentationId: string, rawState: unknown): void {
  const session = sessions.get(presentationId);
  const state = normalizeLiveState(rawState);
  if (!session || session.owner !== owner || !state || sameLiveState(session.state, state)) return;
  session.state = state;
  const wait = session.lastPublishedAt + MIN_PUBLISH_GAP_MS - Date.now();
  if (wait <= 0) return publishState(session);
  // Merged into one trailing update, so the audience always ends on where the presenter is.
  if (!session.pending) {
    session.pending = setTimeout(() => publishState(session), wait);
    session.pending.unref?.();
  }
}

/** The presenter ends the show. */
export function endShow(owner: Owner, presentationId: string): void {
  const session = sessions.get(presentationId);
  if (session && session.owner === owner) close(session);
}

/** Follows a show, if the person may see the deck. Replies with where it is now. */
export async function joinShow(
  user: { id: string },
  owner: Owner,
  presentationId: string,
  reply: Reply,
): Promise<void> {
  if (!sessions.has(presentationId)) return reply(refuse(presentationId, 'not-live', 'That presentation is not being presented'));
  const access = isUuid(presentationId) ? await presentationAccessForUser(user.id, presentationId) : null;
  if (!access) return reply(refuse(presentationId, 'forbidden', 'You do not have access to this presentation'));
  const session = sessions.get(presentationId);
  if (!session) return reply(refuse(presentationId, 'not-live', 'That presentation is not being presented'));
  if (session.owner !== owner && !session.viewers.has(owner)) {
    if (session.viewers.size >= MAX_FOLLOWERS) return reply(refuse(presentationId, 'busy', 'This show is full'));
    session.viewers.set(owner, subscribeToShow(presentationId, reply));
    remember(owner, presentationId);
    publishViewers(session);
  }
  reply({ type: 'show.joined', presentationId, show: infoOf(session), state: session.state, seq: session.seq });
}

/** Stops following. */
export function leaveShow(owner: Owner, presentationId: string): void {
  const session = sessions.get(presentationId);
  const stop = session?.viewers.get(owner);
  if (!session || !stop) return;
  stop();
  session.viewers.delete(owner);
  forget(owner, presentationId);
  publishViewers(session);
}

/** A socket has gone: its show ends, and it stops following any other. */
export function releaseOwner(owner: Owner): void {
  for (const presentationId of [...(memberships.get(owner) ?? [])]) {
    const session = sessions.get(presentationId);
    if (!session) continue;
    if (session.owner === owner) close(session);
    else leaveShow(owner, presentationId);
  }
  memberships.delete(owner);
}

/**
 * Who can see what has changed: followers who may no longer open the deck are
 * dropped, and a presenter who may no longer present or see it is stopped.
 */
export async function recheckOwner(user: { id: string }, owner: Owner): Promise<void> {
  for (const presentationId of [...(memberships.get(owner) ?? [])]) {
    const session = sessions.get(presentationId);
    if (!session) continue;
    const access = await presentationAccessForUser(user.id, presentationId);
    const presenting = session.owner === owner;
    const allowed =
      access !== null && (!presenting || (await workspaceMembership(user.id, access.workspaceId))?.permissions.has('slides.present') === true);
    if (allowed) continue;
    if (presenting) close(session);
    else leaveShow(owner, presentationId);
  }
}

/** The shows running in a workspace that `userId` could follow. */
export async function activeShows(userId: string, workspaceId: string): Promise<LiveShowInfo[]> {
  const running = [...sessions.values()].filter((s) => s.info.workspaceId === workspaceId);
  const visible: LiveShowInfo[] = [];
  for (const session of running) {
    if (await presentationAccessForUser(userId, session.info.presentationId)) visible.push(infoOf(session));
  }
  return visible.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/** Test helper: the position the server holds for a show. */
export function showState(presentationId: string): ShowState | null {
  return sessions.get(presentationId)?.state ?? null;
}
