import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  attachmentSummary,
  collectReferences,
  directName,
  isGroupDirect,
  memberRef,
  mentions,
  mentionsHere,
  messagePreview,
  type CallEvent,
  type Channel,
  type ChatEvent,
  type ChatMessageEvent,
  type MessageReferences,
  type PresenceStatus,
  type VoiceOccupant,
} from '@paradocs/shared';
import { api } from '../api/client';
import { keys, refetchAfterAccessChange, type MessagePage } from '../api/hooks';
import { useChatSocket, type SocketStatus } from './chatSocket';
import { setTyping } from './typing';

export type NotificationPermissionState = 'unsupported' | 'default' | 'granted' | 'denied';

function permissionState(): NotificationPermissionState {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission as NotificationPermissionState;
}

function mentionsByName(body: string, userId: string): boolean {
  return body.toLowerCase().includes(memberRef(userId).toLowerCase());
}

/** Shared with the chat view, which merges the references of an older page. */
export function mergeReferences(a: MessageReferences, b: MessageReferences): MessageReferences {
  const documents = new Map(a.documents.map((d) => [d.id, d]));
  const spreadsheets = new Map(a.spreadsheets.map((s) => [s.id, s]));
  const channels = new Map(a.channels.map((c) => [c.id, c]));
  const members = new Map(a.members.map((m) => [m.id, m]));
  const workItems = new Map((a.workItems ?? []).map((i) => [i.id, i]));
  const projects = new Map((a.projects ?? []).map((p) => [p.id, p]));
  for (const d of b.documents) documents.set(d.id, d);
  for (const s of b.spreadsheets) spreadsheets.set(s.id, s);
  for (const c of b.channels) channels.set(c.id, c);
  for (const m of b.members) members.set(m.id, m);
  for (const i of b.workItems ?? []) workItems.set(i.id, i);
  for (const p of b.projects ?? []) projects.set(p.id, p);
  return {
    documents: [...documents.values()],
    spreadsheets: [...spreadsheets.values()],
    channels: [...channels.values()],
    members: [...members.values()],
    workItems: [...workItems.values()],
    projects: [...projects.values()],
  };
}

/**
 * The session's chat plumbing: one socket for every channel, the message cache,
 * presence, typing, ringing, and notifications for mentions and direct
 * messages.
 *
 * This lives above the chat view rather than inside it, because the whole point
 * of a notification is that it reaches you when you are somewhere else —
 * reading a document, or in another channel.
 */
export function useChatEvents({
  workspaceId,
  channels,
  selfId,
  activeChannelId,
  idle,
  quiet,
  notify: notifyEnabled = true,
  onNotifyClick,
  onCallEvent,
}: {
  workspaceId: string;
  channels: Channel[];
  selfId: string;
  activeChannelId: string | null;
  /** Whether this window has gone idle, so the server can show you as away. */
  idle: boolean;
  /** Busy: messages still arrive, but nothing pops up. */
  quiet: boolean;
  /**
   * Whether this window is the one that raises notifications. A popped-out
   * channel runs a socket of its own for its messages, and would otherwise
   * announce every mention a second time.
   */
  notify?: boolean;
  onNotifyClick: (workspaceId: string, channelId: string) => void;
  onCallEvent: (event: CallEvent) => void;
}): {
  status: SocketStatus;
  permission: NotificationPermissionState;
  requestPermission: () => void;
  /** Tells everyone else in a channel that you are typing there, or have stopped. */
  sendTyping: (channelId: string, typing: boolean) => void;
} {
  const qc = useQueryClient();
  const [permission, setPermission] = useState<NotificationPermissionState>(permissionState);

  // Read inside the socket handler, which is not re-created per render.
  const active = useRef(activeChannelId);
  active.current = activeChannelId;
  const names = useRef<Map<string, string>>(new Map());
  names.current = new Map(channels.map((c) => [c.id, c.name]));
  const openChannel = useRef(onNotifyClick);
  openChannel.current = onNotifyClick;
  const callHandler = useRef(onCallEvent);
  callHandler.current = onCallEvent;
  const muted = useRef(quiet);
  muted.current = quiet;
  const announcing = useRef(notifyEnabled);
  announcing.current = notifyEnabled;

  const applyMessage = useCallback(
    (event: ChatMessageEvent) => {
      const channelId = event.message.channelId;
      const direct = event.channelKind === 'direct';

      // Update the channel's page only if it has been loaded; a message for a
      // channel never opened simply has nothing to merge into.
      qc.setQueryData<MessagePage>(keys.messages(channelId), (current) => {
        if (!current) return current;
        const references = mergeReferences(current.references, event.references);
        const index = current.messages.findIndex((m) => m.id === event.message.id);
        if (index === -1) {
          if (event.type !== 'message.created') return current;
          return { ...current, references, messages: [...current.messages, event.message] };
        }
        const messages = [...current.messages];
        messages[index] = event.message;
        return { ...current, references, messages };
      });

      // A message pushed to a whole channel names only what is open to all of
      // it. Anything else it links — a team's document in a team's channel —
      // is asked for as this reader, who may well be allowed to see it.
      if (qc.getQueryData(keys.messages(channelId))) {
        const linked = collectReferences([event.message.body]);
        const unnamed =
          linked.documentIds.some((id) => !event.references.documents.some((d) => d.id === id)) ||
          linked.spreadsheetIds.some((id) => !event.references.spreadsheets.some((s) => s.id === id)) ||
          linked.workItemIds.some((id) => !(event.references.workItems ?? []).some((i) => i.id === id)) ||
          linked.projectIds.some((id) => !(event.references.projects ?? []).some((p) => p.id === id)) ||
          linked.channelIds.some((id) => !event.references.channels.some((c) => c.id === id));
        if (unnamed) {
          void api
            .get<MessageReferences>(`/messages/${event.message.id}/references`)
            .then((resolved) =>
              qc.setQueryData<MessagePage>(keys.messages(channelId), (current) =>
                current ? { ...current, references: mergeReferences(current.references, resolved) } : current,
              ),
            )
            .catch(() => {});
        }
      }

      if (event.type !== 'message.created') return;
      const author = event.message.author;
      // What they were typing has arrived.
      if (author) setTyping(channelId, author, false);
      const fromSomeoneElse = author?.id !== selfId;

      // Direct conversations reorder with every message, your own included, and
      // the first message may be in one this window has never listed.
      if (direct) void qc.invalidateQueries({ queryKey: keys.directs(event.workspaceId) });
      // Unread and mention counts are computed server side, so the badges are
      // refreshed rather than guessed at here.
      if (fromSomeoneElse) {
        if (!direct) void qc.invalidateQueries({ queryKey: keys.channels(event.workspaceId) });
        void qc.invalidateQueries({ queryKey: keys.notifications });
      }

      if (!fromSomeoneElse || muted.current || !announcing.current) return;
      // Everything in a direct conversation is said to you; in a channel, only
      // a mention is.
      if (!direct && !mentions(event.message.body, selfId)) return;
      // Already looking at it is not worth interrupting.
      const watching = active.current === channelId && document.visibilityState === 'visible';
      if (watching) return;

      const authorName = author?.name ?? 'Someone';
      // Being named is the more personal of the two, so it wins when a message does both.
      const addressed =
        mentionsHere(event.message.body) && !mentionsByName(event.message.body, selfId)
          ? 'notified everyone'
          : 'mentioned you';
      // A group conversation is named, so it is clear which of several it was said in.
      const group = direct
        ? qc.getQueryData<Channel[]>(keys.directs(event.workspaceId))?.find((c) => c.id === channelId)
        : undefined;
      notify({
        title: direct
          ? group && isGroupDirect(group)
            ? `${authorName} in ${directName(group)}`
            : authorName
          : `${authorName} ${addressed} in #${names.current.get(channelId) ?? 'chat'}`,
        body:
          messagePreview(event.message.body, event.references) ||
          attachmentSummary(event.message.attachments?.length ?? 0),
        // One notification per conversation, replaced as messages arrive,
        // rather than a stack of them.
        tag: direct ? `paradocs-direct-${channelId}` : 'paradocs-mention',
        onClick: () => openChannel.current(event.workspaceId, channelId),
      });
    },
    [qc, selfId],
  );

  const apply = useCallback(
    (event: ChatEvent) => {
      switch (event.type) {
        case 'typing':
          // Your own typing comes back from your other windows; it is not news.
          if (event.user.id !== selfId) setTyping(event.channelId, event.user, event.typing);
          return;
        case 'presence.changed':
          qc.setQueryData<Record<string, PresenceStatus>>(keys.presence(event.workspaceId), (current) =>
            current ? { ...current, [event.userId]: event.status } : current,
          );
          return;
        case 'channels.changed':
          void qc.invalidateQueries({ queryKey: keys.channels(event.workspaceId) });
          return;
        case 'directs.changed':
          void qc.invalidateQueries({ queryKey: keys.directs(event.workspaceId) });
          return;
        case 'members.changed':
          void qc.invalidateQueries({ queryKey: ['members', event.workspaceId] });
          void qc.invalidateQueries({ queryKey: keys.presence(event.workspaceId) });
          void qc.invalidateQueries({ queryKey: keys.workspaces });
          return;
        case 'access.changed':
          void refetchAfterAccessChange(qc);
          return;
        case 'projects.changed':
          // Ids only: whatever is showing the project or item asks again, and
          // the server decides what this person may see of it.
          void qc.invalidateQueries({ queryKey: ['projects', event.workspaceId] });
          void qc.invalidateQueries({ queryKey: keys.project(event.projectId) });
          void qc.invalidateQueries({ queryKey: keys.workItems(event.projectId) });
          void qc.invalidateQueries({ queryKey: ['workItemListing', event.workspaceId] });
          // Any item may be linked to one that changed, and shows its status.
          void qc.invalidateQueries({ queryKey: ['workItemLinks'] });
          if (event.itemId) {
            void qc.invalidateQueries({ queryKey: keys.workItem(event.itemId) });
            void qc.invalidateQueries({ queryKey: keys.workItemTimeline(event.itemId) });
            void qc.invalidateQueries({ queryKey: keys.workItemBacklinks(event.itemId) });
            void qc.invalidateQueries({ queryKey: ['workItemRef', event.itemId] });
          } else {
            // A status renamed or recoloured changes every chip in the project.
            void qc.invalidateQueries({ queryKey: ['workItemRef'] });
          }
          void qc.invalidateQueries({ queryKey: keys.notifications });
          return;
        case 'voice.changed':
          qc.setQueryData<Record<string, VoiceOccupant[]>>(keys.voiceParticipants(event.workspaceId), (current) => {
            if (!current) return current;
            const next = { ...current };
            // The server leaves an empty room out, so the cache does too.
            if (event.occupants.length > 0) next[event.channelId] = event.occupants;
            else delete next[event.channelId];
            return next;
          });
          return;
        case 'call.ringing':
        case 'call.ended':
          callHandler.current(event);
          return;
        default:
          applyMessage(event);
      }
    },
    [qc, selfId, applyMessage],
  );

  const { status, send } = useChatSocket({
    channelIds: channels.map((c) => c.id),
    workspaceId,
    idle,
    onEvent: apply,
  });

  const sendTyping = useCallback(
    (channelId: string, typing: boolean) => send({ type: 'typing', channelId, typing }),
    [send],
  );

  // Whatever changed while the socket was down went unheard. Who is around, who
  // is in which voice channel and the direct conversation list are cheap to ask
  // for again.
  useEffect(() => {
    if (status !== 'connected' || !workspaceId) return;
    void qc.invalidateQueries({ queryKey: keys.presence(workspaceId) });
    void qc.invalidateQueries({ queryKey: keys.voiceParticipants(workspaceId) });
    void qc.invalidateQueries({ queryKey: keys.directs(workspaceId) });
  }, [status, workspaceId, qc]);

  // Another tab may have been the one to ask.
  useEffect(() => {
    const sync = () => setPermission(permissionState());
    window.addEventListener('focus', sync);
    return () => window.removeEventListener('focus', sync);
  }, []);

  const requestPermission = useCallback(() => {
    if (typeof Notification === 'undefined') return;
    void Notification.requestPermission().then((result) =>
      setPermission(result as NotificationPermissionState),
    );
  }, []);

  return { status, permission, requestPermission, sendTyping };
}

function notify({
  title,
  body,
  tag,
  onClick,
}: {
  title: string;
  body: string;
  tag: string;
  onClick: () => void;
}): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    const notification = new Notification(title, { body, tag });
    notification.onclick = () => {
      window.focus();
      onClick();
      notification.close();
    };
  } catch {
    // Some browsers refuse construction outside a service worker; a missing
    // notification must never break message delivery.
  }
}
