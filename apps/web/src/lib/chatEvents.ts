import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { mentions, parseMessage, type Channel, type ChatEvent, type MessageReferences } from '@paradocs/shared';
import { keys, type MessagePage } from '../api/hooks';
import { useChatSocket, type SocketStatus } from './chatSocket';

export type NotificationPermissionState = 'unsupported' | 'default' | 'granted' | 'denied';

function permissionState(): NotificationPermissionState {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission as NotificationPermissionState;
}

/** Shared with the chat view, which merges the references of an older page. */
export function mergeReferences(a: MessageReferences, b: MessageReferences): MessageReferences {
  const documents = new Map(a.documents.map((d) => [d.id, d]));
  const channels = new Map(a.channels.map((c) => [c.id, c]));
  const members = new Map(a.members.map((m) => [m.id, m]));
  for (const d of b.documents) documents.set(d.id, d);
  for (const c of b.channels) channels.set(c.id, c);
  for (const m of b.members) members.set(m.id, m);
  return {
    documents: [...documents.values()],
    channels: [...channels.values()],
    members: [...members.values()],
  };
}

/**
 * Renders a message body as plain text for a notification, where markup cannot
 * be shown: references become the names they resolve to rather than raw tokens.
 */
function preview(body: string, references: MessageReferences): string {
  const documents = new Map(references.documents.map((d) => [d.id, d]));
  const channels = new Map(references.channels.map((c) => [c.id, c]));
  const members = new Map(references.members.map((m) => [m.id, m]));

  return parseMessage(body)
    .map((segment) => {
      if (segment.type === 'text') return segment.value;
      if (segment.type === 'document') return documents.get(segment.id)?.title ?? 'a document';
      if (segment.type === 'channel') {
        const channel = channels.get(segment.id);
        return channel ? `#${channel.name}` : 'a channel';
      }
      const member = members.get(segment.id);
      return member ? `@${member.name}` : '@someone';
    })
    .join('')
    .trim();
}

/**
 * The session's chat plumbing: one socket for every channel, the message cache,
 * and notifications for mentions.
 *
 * This lives above the chat view rather than inside it, because the whole point
 * of a mention notification is that it reaches you when you are somewhere else
 * — reading a document, or in another channel.
 */
export function useChatEvents({
  workspaceId,
  channels,
  selfId,
  activeChannelId,
  onNotifyClick,
}: {
  workspaceId: string;
  channels: Channel[];
  selfId: string;
  activeChannelId: string | null;
  onNotifyClick: (channelId: string) => void;
}): { status: SocketStatus; permission: NotificationPermissionState; requestPermission: () => void } {
  const qc = useQueryClient();
  const [permission, setPermission] = useState<NotificationPermissionState>(permissionState);

  // Read inside the socket handler, which is not re-created per render.
  const active = useRef(activeChannelId);
  active.current = activeChannelId;
  const names = useRef<Map<string, string>>(new Map());
  names.current = new Map(channels.map((c) => [c.id, c.name]));
  const openChannel = useRef(onNotifyClick);
  openChannel.current = onNotifyClick;

  const apply = useCallback(
    (event: ChatEvent) => {
      const channelId = event.message.channelId;

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

      if (event.type !== 'message.created') return;
      const fromSomeoneElse = event.message.author?.id !== selfId;
      // Unread and mention counts are computed server side, so the badges are
      // refreshed rather than guessed at here.
      if (fromSomeoneElse) qc.invalidateQueries({ queryKey: keys.channels(workspaceId) });

      if (!fromSomeoneElse || !mentions(event.message.body, selfId)) return;
      // Already looking at it is not worth interrupting.
      const watching = active.current === channelId && document.visibilityState === 'visible';
      if (watching) return;
      notify({
        title: `${event.message.author?.name ?? 'Someone'} mentioned you in #${names.current.get(channelId) ?? 'chat'}`,
        body: preview(event.message.body, event.references),
        onClick: () => openChannel.current(channelId),
      });
    },
    [qc, selfId, workspaceId],
  );

  const status = useChatSocket(
    channels.map((c) => c.id),
    apply,
  );

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

  return { status, permission, requestPermission };
}

function notify({ title, body, onClick }: { title: string; body: string; onClick: () => void }): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    const notification = new Notification(title, { body, tag: 'paradocs-mention' });
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
