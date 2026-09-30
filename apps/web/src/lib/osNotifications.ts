import { useEffect } from 'react';
import { useNotifications } from '../api/hooks';
import { desktop } from './desktop';

/**
 * In the desktop app, whatever reaches the notifications bar is announced by
 * the operating system too. The app does the announcing, for every connection
 * at once; this page's part is to say when its own bar has changed, so a
 * direct message is announced as it arrives rather than at the app's next
 * round, and what it has open, so a conversation already on screen stays
 * quiet.
 *
 * Those notifications are silent: this page plays the app's own sounds for
 * what it hears, and the app plays them for the rest. Saying which workspace
 * is open is how the app knows which mentions this page has heard.
 *
 * Only the main window's page says anything. A popped-out channel is one of
 * its conversations, and the app knows when it is the window in front.
 */
export function useOsNotifications({
  quiet,
  openChannelId,
  workspaceId,
}: {
  quiet: boolean;
  openChannelId: string | null;
  workspaceId: string | null;
}): void {
  const { data } = useNotifications();

  useEffect(() => {
    if (!desktop || !data) return;
    void desktop.notifications.changed({ quiet, openChannelId, workspaceId }).catch(() => {});
  }, [data, quiet, openChannelId, workspaceId]);
}
