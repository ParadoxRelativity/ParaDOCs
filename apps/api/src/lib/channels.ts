import { HERE_REF, type ChannelKind, type ChatEvent } from '@paradocs/shared';
import { query } from '../db/pool.js';
import type { Role } from '../plugins/session.js';
import { publishToChannel, publishToUser } from '../chat/hub.js';
import { UUID, channelLevelSql, type Level } from './access.js';
import { appEnabledSql } from './apps.js';

export { UUID };

/**
 * A condition on `m.body`: the message mentions this user, by their own token
 * or with `@here`. Matched on the stored tokens rather than names, so someone
 * renaming themselves cannot change what counts. Whoever can read the channel
 * is who `@here` reaches, so the caller's access check already scopes it.
 */
export function mentionsUserSql(userParam: string): string {
  return `(position('<@' || ${userParam}::text || '>' in lower(m.body)) > 0 OR position('${HERE_REF}' in m.body) > 0)`;
}

export interface ChannelAccess {
  workspaceId: string;
  kind: ChannelKind;
  name: string;
  /** The person's role in the channel's workspace. */
  role: Role;
  /** 1 reads a text channel or listens in a voice one; 2 also posts or speaks. */
  level: Level;
}

/**
 * What a person may do with a channel, or null when they may not see it at
 * all: it does not exist, they are not in its workspace, it is locked away from
 * them, it is a direct conversation they are not part of, or the workspace has
 * Chat turned off. Those cases are
 * deliberately indistinguishable, so a conversation's id reveals nothing to an
 * outsider.
 */
export async function channelAccessFor(userId: string, channelId: string): Promise<ChannelAccess | null> {
  if (!UUID.test(channelId)) return null;
  const { rows } = await query<{
    workspace_id: string;
    kind: ChannelKind;
    name: string;
    role: Role | null;
    level: number | null;
  }>(
    `SELECT c.workspace_id, c.kind, c.name, m.role,
            CASE WHEN c.kind = 'direct'
                 THEN CASE WHEN EXISTS (
                        SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = $2
                      ) THEN 2 ELSE 0 END
                 ELSE ${channelLevelSql('$2', 'm.role')}
            END AS level
       FROM channels c
       LEFT JOIN workspace_members m ON m.workspace_id = c.workspace_id AND m.user_id = $2
      WHERE c.id = $1 AND ${appEnabledSql('c.workspace_id', 'chat')}`,
    [channelId, userId],
  );
  const row = rows[0];
  if (!row?.role || !row.level) return null;
  return { workspaceId: row.workspace_id, kind: row.kind, name: row.name, role: row.role, level: row.level as Level };
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
