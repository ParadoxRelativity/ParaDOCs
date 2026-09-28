import type { Notifications } from '@paradocs/shared';

/** What is waiting in one workspace, as the workspace menu shows it. */
export interface WorkspaceNotificationCount {
  count: number;
  /** Something addressed to you: a mention, a direct message, or a work item. */
  urgent: boolean;
}

/**
 * Notifications grouped by the workspace they come from, counted the way the
 * bell counts them: one per channel with unread messages, one per document you
 * were tagged in, one per work item. Invitations are left out, since they are
 * to workspaces you are not in yet, and so is a server update, which belongs
 * to no workspace.
 */
export function countByWorkspace(notifications: Notifications | undefined): Map<string, WorkspaceNotificationCount> {
  const counts = new Map<string, WorkspaceNotificationCount>();
  if (!notifications) return counts;
  const add = (workspaceId: string, urgent: boolean) => {
    const entry = counts.get(workspaceId) ?? { count: 0, urgent: false };
    entry.count += 1;
    entry.urgent ||= urgent;
    counts.set(workspaceId, entry);
  };
  for (const message of notifications.messages) add(message.workspace.id, message.mentions > 0 || message.direct);
  // A server that predates tagging or work items sends neither.
  for (const mention of notifications.mentions ?? []) add(mention.workspace.id, true);
  for (const item of notifications.workItems ?? []) add(item.workspace.id, true);
  return counts;
}
