import { query } from '../db/pool.js';
import { publishToUser } from '../chat/hub.js';

/**
 * Tells every enabled server administrator's open clients that their
 * notifications have changed, so a bell showing account deletion requests
 * catches up now rather than on its next poll. Runs after the change commits.
 */
export async function notifyServerAdmins(): Promise<void> {
  const { rows } = await query<{ id: string }>(
    'SELECT id FROM users WHERE is_server_admin AND disabled_at IS NULL',
  );
  for (const { id } of rows) publishToUser(id, { type: 'notifications.changed' });
}
