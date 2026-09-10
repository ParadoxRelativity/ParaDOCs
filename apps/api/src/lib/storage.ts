import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

/** Removes a stored file, tolerating one that is already gone. */
export async function removeStoredFile(storageKey: string) {
  try {
    await fs.unlink(path.join(config.uploadDir, storageKey));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/** SQL for the served URL of a storage key column, null when the column is. */
export function uploadUrlSql(column: string): string {
  return `CASE WHEN ${column} IS NULL THEN NULL ELSE '/uploads/' || ${column} END`;
}
