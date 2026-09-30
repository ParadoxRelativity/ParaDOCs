import { useEffect, useRef } from 'react';
import type { Notifications, WorkItemNotification } from '@paradocs/shared';
import { useNotifications } from '../api/hooks';
import { notify } from './browserNotifications';
import { playSound } from './sounds';

interface BellAnnouncement {
  /** Changes whenever there is something new to say about the same thing. */
  key: string;
  title: string;
  body: string;
  path: string;
}

function workItemTitle(item: WorkItemNotification): string {
  const by = item.by?.name ?? 'Someone';
  switch (item.reason) {
    case 'role':
      return `${by} made you ${item.role ? item.role.toLowerCase() : 'a participant'} on ${item.key}`;
    case 'comment':
      return `${by} commented on ${item.key}`;
    case 'status':
      return item.status ? `${by} moved ${item.key} to ${item.status}` : `${by} changed the status of ${item.key}`;
    default:
      return `${by} mentioned you in ${item.key}`;
  }
}

/**
 * What in the bell is announced when it first appears. Messages are left out:
 * they arrive over the socket, and are announced as they do (chatEvents.ts).
 */
function announcements(notifications: Notifications): BellAnnouncement[] {
  return [
    ...notifications.invites.map((invite) => ({
      key: `invite:${invite.id}`,
      title: `Invitation to ${invite.workspace.name}`,
      body: invite.invitedBy
        ? `${invite.invitedBy} invited you to join as ${invite.role}.`
        : `You are invited to join as ${invite.role}.`,
      path: `/invite/${invite.token}`,
    })),
    ...(notifications.mentions ?? []).map((mention) => ({
      key: `mention:${mention.documentId}:${mention.createdAt}`,
      title: `${mention.taggedBy?.name ?? 'Someone'} tagged you`,
      body: `${mention.title} · ${mention.workspace.name}`,
      path: `/w/${mention.workspace.id}/d/${mention.documentId}`,
    })),
    ...(notifications.workItems ?? []).map((item) => ({
      key: `item:${item.workItemId}:${item.reason}:${item.createdAt}`,
      title: workItemTitle(item),
      body: item.title,
      path: `/w/${item.workspace.id}/p/${item.projectId}/${item.workItemId}`,
    })),
  ];
}

/**
 * Announces something new reaching the bell — a work item role, a comment or
 * status change on an item you hold a role on, being named in one, a document
 * tag, an invitation — with a soft chime and, in a browser, a notification.
 * The desktop app raises the notification itself, for every server at once.
 *
 * Whatever is there when the page opens was waiting already, so the first
 * answer from the server only sets what has been seen. Only the main window
 * calls this; a popped-out conversation has no bell.
 */
export function useBellAnnouncements({ quiet, onOpen }: { quiet: boolean; onOpen: (path: string) => void }): void {
  const { data, isFetchedAfterMount } = useNotifications();
  const seen = useRef<Set<string> | null>(null);
  const open = useRef(onOpen);
  open.current = onOpen;

  useEffect(() => {
    // A copy kept from the last visit is older than the page: wait for the server.
    if (!data || !isFetchedAfterMount) return;
    const current = announcements(data);
    const previous = seen.current;
    seen.current = new Set(current.map((a) => a.key));
    if (!previous || quiet) return;
    const fresh = current.filter((a) => !previous.has(a.key));
    if (fresh.length === 0) return;
    playSound('notification_generic');
    for (const announcement of fresh) {
      notify({
        title: announcement.title,
        body: announcement.body,
        // One per thing, replaced when there is news about it again.
        tag: `paradocs-${announcement.key.split(':').slice(0, 2).join(':')}`,
        onClick: () => open.current(announcement.path),
      });
    }
  }, [data, isFetchedAfterMount, quiet]);
}
