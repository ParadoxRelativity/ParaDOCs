import type { FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { transaction } from '../db/pool.js';
import { badRequest } from './http.js';
import { removeStoredFile } from './storage.js';

const MAX_BYTES = 5 * 1024 * 1024;

/**
 * The file extension for a picture, judged from its bytes. The filename and
 * the declared type are both whatever the client says, and the extension
 * decides the content type the file is later served with. Raster formats
 * only: an SVG served from this origin could carry script.
 */
function imageExtension(bytes: Buffer): string | null {
  const ascii = (start: number, end: number) => bytes.toString('ascii', start, end);
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.readUInt32BE(4) === 0x0d0a1a0a) {
    return '.png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return '.jpg';
  if (bytes.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return '.gif';
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return '.webp';
  return null;
}

/** Reads a picture from a multipart request and stores it, returning its storage key. */
export async function storeAvatar(req: FastifyRequest, owner: 'users' | 'workspaces'): Promise<string> {
  const file = await req.file({ limits: { fileSize: MAX_BYTES, files: 1 } });
  if (!file) throw badRequest('No picture was uploaded');

  let bytes: Buffer;
  try {
    bytes = await file.toBuffer();
  } catch (err) {
    if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
      throw badRequest('Pictures must be 5 MB or smaller');
    }
    throw err;
  }

  const ext = imageExtension(bytes);
  if (!ext) throw badRequest('Pictures must be PNG, JPEG, WebP or GIF images');

  // A fresh name per upload, so a replaced picture is never served from cache.
  const key = `avatars/${owner}/${randomUUID()}${ext}`;
  const target = path.join(config.uploadDir, key);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, bytes);
  return key;
}

/**
 * Points a user or workspace at a picture, or at none, and deletes the file it
 * replaces. The old key is read under a row lock so two uploads racing cannot
 * both believe they replaced the same file and leave the other behind.
 */
export async function replaceAvatar(
  table: 'users' | 'workspaces',
  id: string,
  key: string | null,
  returning: string,
): Promise<Record<string, unknown>> {
  let result: { previous: string | null; row: Record<string, unknown> };
  try {
    result = await transaction(async (client) => {
      const { rows: current } = await client.query<{ avatar_key: string | null }>(
        `SELECT avatar_key FROM ${table} WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const { rows } = await client.query<Record<string, unknown>>(
        `UPDATE ${table} SET avatar_key = $2 WHERE id = $1 RETURNING ${returning}`,
        [id, key],
      );
      return { previous: current[0]?.avatar_key ?? null, row: rows[0] };
    });
  } catch (err) {
    // The new file is already on disk, and nothing will ever point at it.
    if (key) await removeStoredFile(key);
    throw err;
  }
  if (result.previous && result.previous !== key) await removeStoredFile(result.previous);
  return result.row;
}
