import { Notification, nativeImage } from 'electron';
import type { Notifications } from '@paradocs/shared';
import { getConnection, listConnections, type Connection } from './connections.js';
import { notificationsFor, postTo } from './connectionApi.js';
import { activeConnectionId, getAppWindow, openConnection, sendToConnection } from './windows.js';
import { focusPopout, isPopoutFocused } from './popouts.js';

/**
 * What reaches the notifications bar also reaches the operating system, as a
 * notification of its own: a banner, a sound, a place in the notification
 * centre — whatever the person has the OS do for this app.
 *
 * It lives here rather than in the pages because it has to cover every
 * connection, loaded or not, and has to be raised once however many pages are
 * looking at the same server. Every connection is asked in turn on a timer,
 * and a page asks for its own to be looked at straight away when its bar
 * changes, which is how a direct message arrives in seconds rather than at the
 * next round.
 *
 * Only what is new since the last look is announced. What a connection already
 * had when the app first saw it is what the bar is for.
 */

const POLL_MS = 60_000;

/** What the page on a connection says about itself, so nothing is announced that is already on screen. */
export interface PageState {
  /** Busy: everything still reaches the bar, but nothing pops up. */
  quiet: boolean;
  /** The channel open in the main window, if chat is what it is showing. */
  openChannelId: string | null;
}

interface Seen {
  /** Everything ever announced, or already there when first seen, by key. */
  keys: Set<string>;
  /** How many unread messages in each channel name you, to notice another. */
  mentions: Map<string, number>;
}

interface Announcement {
  key: string;
  title: string;
  body: string;
  /** A data URL: the author's picture, where there is one. */
  picture: string | null;
  /** Where clicking it lands, within the connection. Null brings the app forward. */
  path: string | null;
  /** A conversation already open in a window of its own is focused there instead. */
  channelId?: string;
  /** Opening a tagged document is what answers the tag. */
  documentId?: string;
}

const seen = new Map<string, Seen>();
const pages = new Map<string, PageState>();
/** Checks in flight, and the one to follow each, so a burst of nudges asks each server twice at most. */
const checking = new Map<string, Promise<void>>();
const queued = new Map<string, Promise<void>>();
/** Held until clicked or closed; a notification that is collected can no longer be clicked. */
const showing = new Set<Notification>();
/** Keys stay small, but a long session should not grow them without end. */
const MAX_KEYS = 5000;

let timer: NodeJS.Timeout | null = null;

export function startNotifier(): void {
  if (timer || !Notification.isSupported()) return;
  timer = setInterval(() => {
    for (const connection of listConnections()) void check(connection.id);
  }, POLL_MS);
  for (const connection of listConnections()) void check(connection.id);
}

/** A page's bar changed, or what it is showing did: its connection is looked at now. */
export function pageChanged(connectionId: string, state: PageState): Promise<void> {
  pages.set(connectionId, state);
  return check(connectionId);
}

/** A connection removed from the app takes what was known about it along. */
export function forgetNotifications(connectionId: string): void {
  seen.delete(connectionId);
  pages.delete(connectionId);
}

/**
 * One look at a server at a time. Asked again while one is under way, it looks
 * once more afterwards — once, however many asked — since the first may have
 * fetched just before the change it was asked about.
 */
function check(connectionId: string): Promise<void> {
  const running = checking.get(connectionId);
  if (!running) {
    const next = look(connectionId).finally(() => checking.delete(connectionId));
    checking.set(connectionId, next);
    return next;
  }
  let again = queued.get(connectionId);
  if (!again) {
    again = running.then(() => {
      queued.delete(connectionId);
      return check(connectionId);
    });
    queued.set(connectionId, again);
  }
  return again;
}

async function look(connectionId: string): Promise<void> {
  const connection = getConnection(connectionId);
  if (!connection) return;
  const listing = await notificationsFor(connection).catch(() => null);
  // Signed out or out of reach says nothing about what has been read, so what
  // was known stands until the server can be asked again.
  if (listing?.status !== 'ok') return;

  const found = announcements(listing.notifications);
  const previous = seen.get(connectionId);
  const mentions = new Map(listing.notifications.messages.map((m) => [m.channelId, m.mentions]));

  if (!previous) {
    seen.set(connectionId, { keys: new Set(found.map((a) => a.key)), mentions });
    return;
  }

  const page = pages.get(connectionId);
  for (const announcement of found) {
    if (previous.keys.has(announcement.key)) continue;
    previous.keys.add(announcement.key);
    if (page?.quiet) continue;
    if (announcement.channelId) {
      const message = listing.notifications.messages.find((m) => m.channelId === announcement.channelId);
      // In a channel, only being named is news, and only when it is a new one.
      if (message && !message.direct && message.mentions <= (previous.mentions.get(message.channelId) ?? 0)) continue;
      if (watching(connectionId, announcement.channelId)) continue;
    }
    show(connection, announcement);
  }
  previous.mentions = mentions;
  if (previous.keys.size > MAX_KEYS) previous.keys = new Set(found.map((a) => a.key));
}

/** Already looking at the conversation is not worth interrupting. */
function watching(connectionId: string, channelId: string): boolean {
  if (isPopoutFocused(connectionId, channelId)) return true;
  return Boolean(
    getAppWindow()?.isFocused() &&
      activeConnectionId() === connectionId &&
      pages.get(connectionId)?.openChannelId === channelId,
  );
}

/** Everything in a listing that could be announced, each under a key that changes when there is something new. */
function announcements(notifications: Notifications): Announcement[] {
  const found: Announcement[] = [];

  for (const message of notifications.messages) {
    const author = message.latest.author?.name ?? 'Someone';
    const title = message.direct
      ? author === message.channelName
        ? author
        : `${author} in ${message.channelName}`
      : `${author} mentioned you in #${message.channelName}`;
    found.push({
      key: `message:${message.channelId}:${message.latest.id}`,
      title,
      body: message.latest.preview,
      picture: message.latest.author?.avatarUrl ?? null,
      path: `/w/${message.workspace.id}/c/${message.channelId}`,
      channelId: message.channelId,
    });
  }

  for (const mention of notifications.mentions ?? []) {
    found.push({
      key: `tag:${mention.documentId}:${mention.createdAt}`,
      title: `${mention.taggedBy?.name ?? 'Someone'} tagged you`,
      body: `${mention.title} · ${mention.workspace.name}`,
      picture: mention.taggedBy?.avatarUrl ?? null,
      path: `/w/${mention.workspace.id}/d/${mention.documentId}`,
      documentId: mention.documentId,
    });
  }

  for (const item of notifications.workItems ?? []) {
    const by = item.by?.name ?? 'Someone';
    found.push({
      key: `item:${item.workItemId}:${item.reason}:${item.createdAt}`,
      title:
        item.reason === 'role'
          ? `${by} made you ${item.role ? item.role.toLowerCase() : 'a participant'} on ${item.key}`
          : `${by} mentioned you in ${item.key}`,
      body: item.title,
      picture: item.by?.avatarUrl ?? null,
      path: `/w/${item.workspace.id}/p/${item.projectId}/${item.workItemId}`,
    });
  }

  for (const invite of notifications.invites) {
    found.push({
      key: `invite:${invite.id}`,
      title: `Invitation to ${invite.workspace.name}`,
      body: invite.invitedBy
        ? `${invite.invitedBy} invited you to join as ${invite.role}.`
        : `You are invited to join as ${invite.role}.`,
      picture: invite.workspace.avatarUrl,
      path: `/invite/${invite.token}`,
    });
  }

  const update = notifications.serverUpdate;
  if (update) {
    found.push({
      key: `server-update:${update.release.version}`,
      title: `ParaDOCs ${update.release.version} is available`,
      body: `This server is running ${update.currentVersion}.`,
      picture: null,
      path: null,
    });
  }

  return found;
}

function show(connection: Connection, announcement: Announcement): void {
  // With more than one server in the app, which one it came from is part of the news.
  const several = listConnections().length > 1;
  const notification = new Notification({
    title: announcement.title,
    subtitle: several ? connection.label : undefined,
    body: several && process.platform !== 'darwin' ? `${announcement.body}\n${connection.label}` : announcement.body,
    icon: announcement.picture ? nativeImage.createFromDataURL(announcement.picture) : undefined,
  });
  showing.add(notification);
  notification.on('click', () => {
    showing.delete(notification);
    void open(connection.id, announcement);
  });
  notification.on('close', () => showing.delete(notification));
  notification.show();
}

async function open(connectionId: string, announcement: Announcement): Promise<void> {
  const connection = getConnection(connectionId);
  if (!connection) return;
  if (announcement.channelId && focusPopout(connectionId, announcement.channelId)) return;
  if (announcement.documentId) void postTo(connection, '/api/notifications/mentions/read', { documentIds: [announcement.documentId] });
  const path = announcement.path ?? undefined;
  if (path && sendToConnection(connectionId, { type: 'navigate', path })) return;
  await openConnection(connection, path).catch(() => {});
}
