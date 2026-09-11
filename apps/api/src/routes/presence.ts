import type { FastifyPluginAsync } from 'fastify';
import { updatePresenceSchema, type PresenceSettings, type PresenceStatus } from '@paradocs/shared';
import { query } from '../db/pool.js';
import { parse } from '../lib/http.js';
import { assertWorkspaceAccess } from '../plugins/session.js';
import { choosePresence, presenceOf } from '../chat/presence.js';

const SETTINGS_COLUMNS = `presence AS status, away_after_minutes AS "awayAfterMinutes"`;

export const presenceRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  /**
   * The status the signed-in person chose and how long they may be idle. Kept
   * on the account, so it follows them to every device.
   */
  app.get('/presence/me', async (req): Promise<PresenceSettings> => {
    const { rows } = await query<PresenceSettings>(`SELECT ${SETTINGS_COLUMNS} FROM users WHERE id = $1`, [
      req.user!.id,
    ]);
    return rows[0];
  });

  app.patch('/presence/me', async (req): Promise<PresenceSettings> => {
    const input = parse(updatePresenceSchema, req.body);
    const { rows } = await query<PresenceSettings>(
      `UPDATE users
          SET presence = COALESCE($2, presence),
              away_after_minutes = COALESCE($3, away_after_minutes)
        WHERE id = $1
        RETURNING ${SETTINGS_COLUMNS}`,
      [req.user!.id, input.status ?? null, input.awayAfterMinutes ?? null],
    );
    if (input.status) await choosePresence(req.user!.id, input.status);
    return rows[0];
  });

  /** Everyone in a workspace and whether they are around, keyed by user id. */
  app.get<{ Params: { id: string } }>('/workspaces/:id/presence', async (req) => {
    await assertWorkspaceAccess(req, req.params.id);
    const { rows } = await query<{ user_id: string }>(
      'SELECT user_id FROM workspace_members WHERE workspace_id = $1',
      [req.params.id],
    );
    const presence: Record<string, PresenceStatus> = {};
    for (const { user_id: userId } of rows) presence[userId] = presenceOf(userId);
    return presence;
  });
};
