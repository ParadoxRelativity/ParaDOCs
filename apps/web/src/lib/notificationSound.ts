import { useEffect, useRef } from 'react';
import type { Notifications } from '@paradocs/shared';
import { useNotifications } from '../api/hooks';
import { playSound } from './sounds';

/**
 * What in the bell is worth a sound when it first appears. Messages are left
 * out: they arrive over the socket, and are heard as they do (chatEvents.ts).
 */
function soundedKeys(notifications: Notifications): string[] {
  return [
    ...notifications.invites.map((invite) => `invite:${invite.id}`),
    ...(notifications.mentions ?? []).map((mention) => `mention:${mention.documentId}:${mention.createdAt}`),
    ...(notifications.workItems ?? []).map((item) => `item:${item.workItemId}:${item.createdAt}`),
  ];
}

/**
 * A soft chime when something new reaches the bell: a work item you were
 * given or named in, a document you were tagged in, an invitation.
 *
 * Whatever is there when the page opens was waiting already, so the first
 * answer from the server only sets what has been seen. Only the main window
 * calls this; a popped-out conversation has no bell.
 */
export function useNotificationSound({ quiet }: { quiet: boolean }): void {
  const { data, isFetchedAfterMount } = useNotifications();
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    // A copy kept from the last visit is older than the page: wait for the server.
    if (!data || !isFetchedAfterMount) return;
    const current = soundedKeys(data);
    const previous = seen.current;
    seen.current = new Set(current);
    if (!previous || quiet) return;
    if (current.some((key) => !previous.has(key))) playSound('notification_generic');
  }, [data, isFetchedAfterMount, quiet]);
}
