import type { DbClient } from '../db/driver.js';
import { slugify } from './auth.js';
import { conflict } from './http.js';
import { addDefaultVoiceChannel } from '../routes/voice.js';

/**
 * Creates an account with a usable Personal workspace, inside the caller's
 * transaction. Shared by registration and by accounts made on the admin page,
 * so both start people off in the same place.
 */
export async function createAccount(
  client: DbClient,
  input: { email: string; name: string; passwordHash: string; isServerAdmin?: boolean },
): Promise<{ id: string; email: string; name: string }> {
  const dup = await client.query('SELECT 1 FROM users WHERE lower(email) = lower($1)', [input.email]);
  if (dup.rowCount) throw conflict('An account with that email already exists');

  const { rows } = await client.query<{ id: string; email: string; name: string }>(
    `INSERT INTO users (email, password_hash, name, is_server_admin)
     VALUES ($1, $2, $3, $4) RETURNING id, email, name`,
    [input.email, input.passwordHash, input.name, input.isServerAdmin ?? false],
  );
  const created = rows[0];

  // Every account starts with a usable workspace rather than an empty shell.
  const { rows: wsRows } = await client.query<{ id: string }>(
    `INSERT INTO workspaces (owner_id, name, slug, icon)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [created.id, 'Personal', slugify('Personal'), '🏠'],
  );
  // Access is membership, not ownership: without this row the new account
  // is not a member of the workspace it just got and every request for it
  // answers 404.
  await client.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [wsRows[0].id, created.id],
  );
  await client.query(
    `INSERT INTO folders (workspace_id, name, position) VALUES ($1, 'Journal', 0), ($1, 'Notes', 1)`,
    [wsRows[0].id],
  );
  // Somewhere to talk, so the chat tab is never an empty room.
  await client.query(
    `INSERT INTO channels (workspace_id, name, topic, created_by) VALUES ($1, 'general', $2, $3)`,
    [wsRows[0].id, 'Everything else', created.id],
  );
  await addDefaultVoiceChannel(client, wsRows[0].id, created.id);
  return created;
}
