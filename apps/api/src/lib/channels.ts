import type { ChannelKind, ChatEvent } from '@paradocs/shared';
import { query } from '../db/pool.js';
import type { Role } from '../plugins/session.js';
import { publishToChannel, publishToUser } from '../chat/hub.js';

export interface ChannelAccess {
  workspaceId: string;
  kind: ChannelKind;
  name: string;
  /** The person's role in the channel's workspace. */
  role: Role;
}

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

/**
 * What a person may do with a channel, or null when they may not see it at
 * all: it does not exist, they are not in its workspace, or it is a direct
 * conversation they are not part of. Those cases are deliberately
 * indistinguishable, so a conversation's id reveals nothing to an outsider.
 */
export async function channelAccessFor(userId: string, channelId: string): Promise<ChannelAccess | null> {
  if (!UUID.test(channelId)) return null;
  const { rows } = await query<{
    workspace_id: string;
    kind: ChannelKind;
    name: string;
    role: Role | null;
    participant: boolean;
  }>(
    `SELECT c.workspace_id, c.kind, c.name, m.role,
            (c.kind <> 'direct' OR EXISTS (
               SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = $2
            )) AS participant
       FROM channels c
       LEFT JOIN workspace_members m ON m.workspace_id = c.workspace_id AND m.user_id = $2
      WHERE c.id = $1`,
    [channelId, userId],
  );
  const row = rows[0];
  if (!row?.role || !row.participant) return null;
  return { workspaceId: row.workspace_id, kind: row.kind, name: row.name, role: row.role };
}

/** The people in a direct conversation. */
export async function channelParticipants(channelId: string): Promise<string[]> {
  const { rows } = await query<{ user_id: string }>('SELECT user_id FROM channel_members WHERE channel_id = $1', [
    channelId,
  ]);
  return rows.map((r) => r.user_id);
}

/**
 * Sends a message event to whoever should see it. A named channel goes to its
 * subscribers. A direct conversation goes to the people in it wherever they
 * are, since a conversation someone has never opened is one their socket
 * cannot have subscribed to — and the first message in it is the one that
 * most needs to arrive.
 */
export async function publishChannelEvent(channelId: string, kind: ChannelKind, event: ChatEvent): Promise<void> {
  if (kind !== 'direct') {
    publishToChannel(channelId, event);
    return;
  }
  for (const userId of await channelParticipants(channelId)) publishToUser(userId, event);
}
