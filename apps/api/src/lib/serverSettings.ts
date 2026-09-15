import type { ServerSettings } from '@paradocs/shared';
import { query } from '../db/pool.js';
import { config } from '../config.js';

/**
 * Settings for the whole server, changed from the admin page.
 *
 * A setting nobody has changed has no row and takes its default. Registration's
 * default still comes from ALLOW_REGISTRATION, so an existing deployment keeps
 * behaving as configured until an administrator decides otherwise.
 *
 * Read from the database each time rather than cached: they are read rarely,
 * and a cache would go stale in every process but the one that wrote it.
 */
function defaults(): ServerSettings {
  return {
    allowRegistration: config.allowRegistration,
    messageRetentionMaxDays: null,
  };
}

const KEYS = Object.keys(defaults()) as (keyof ServerSettings)[];

export async function getServerSettings(): Promise<ServerSettings> {
  const settings = defaults();
  const { rows } = await query<{ key: string; value: unknown }>('SELECT key, value FROM server_settings');
  for (const row of rows) {
    if ((KEYS as string[]).includes(row.key)) Object.assign(settings, { [row.key]: row.value });
  }
  return settings;
}

export async function updateServerSettings(
  patch: Partial<ServerSettings>,
  updatedBy: string,
): Promise<ServerSettings> {
  for (const key of KEYS) {
    if (patch[key] === undefined) continue;
    await query(
      `INSERT INTO server_settings (key, value, updated_by, updated_at)
       VALUES ($1, $2::jsonb, $3, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [key, JSON.stringify(patch[key]), updatedBy],
    );
  }
  return getServerSettings();
}
