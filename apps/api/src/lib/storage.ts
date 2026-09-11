import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyBaseLogger } from 'fastify';
import type { MultipartFile } from '@fastify/multipart';
import { attachmentKind } from '@paradocs/shared';
import { config } from '../config.js';
import { HttpError } from './http.js';

/** Removes a stored file, tolerating one that is already gone. */
export async function removeStoredFile(storageKey: string) {
  try {
    await fs.unlink(path.join(config.uploadDir, storageKey));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * Removes files whose rows are already gone. A failure is logged rather than
 * thrown: the request has done what it was asked, and a stray file on disk is
 * better than reporting an error for it.
 */
export async function removeStoredFiles(storageKeys: string[], log: FastifyBaseLogger): Promise<void> {
  await Promise.all(
    storageKeys.map((key) =>
      removeStoredFile(key).catch((err) => log.warn({ err, key }, 'could not remove stored file')),
    ),
  );
}

/** SQL for the served URL of a storage key column, null when the column is. */
export function uploadUrlSql(column: string): string {
  return `CASE WHEN ${column} IS NULL THEN NULL ELSE '/uploads/' || ${column} END`;
}

/** "25 MB", for messages about the upload limit. */
export function formatMegabytes(bytes: number): string {
  const megabytes = bytes / (1024 * 1024);
  return `${Number.isInteger(megabytes) ? megabytes : Number(megabytes.toFixed(1))} MB`;
}

function fileTooLarge(): HttpError {
  return new HttpError(413, `Files must be ${formatMegabytes(config.maxUploadBytes)} or smaller`, 'too_large');
}

/** Options for `req.file()`: one file, no larger than the server allows. */
export function uploadLimits() {
  return { limits: { fileSize: config.maxUploadBytes, files: 1 } };
}

/**
 * Writes an uploaded file under `directory`, streamed to disk so a large file
 * is never held in memory.
 *
 * The stored name is generated, so a malicious filename cannot escape the
 * directory. Only a short, sanitised extension is kept from the original,
 * because that is what decides the content type the file is served with.
 */
export async function storeUpload(
  file: MultipartFile,
  directory: string,
): Promise<{ storageKey: string; byteSize: number }> {
  const ext = path.extname(file.filename).slice(0, 12).replace(/[^.\w]/g, '').toLowerCase();
  const storageKey = `${directory}/${randomUUID()}${ext}`;
  const target = path.join(config.uploadDir, storageKey);
  await fs.mkdir(path.dirname(target), { recursive: true });

  try {
    await pipeline(file.file, createWriteStream(target));
  } catch (err) {
    await removeStoredFile(storageKey);
    if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') throw fileTooLarge();
    throw err;
  }
  // Past the limit the stream simply ends early and is marked truncated.
  if (file.file.truncated) {
    await removeStoredFile(storageKey);
    throw fileTooLarge();
  }

  const { size } = await fs.stat(target);
  return { storageKey, byteSize: size };
}

/**
 * Whether the browser may show a stored file in place. Pictures, audio, video
 * and PDFs can be; anything else is served as a download in a sandbox, since it
 * could be HTML or SVG that would otherwise run script on this origin.
 */
export function servesInline(filePath: string): boolean {
  return attachmentKind(filePath) !== 'file' || /\.pdf$/i.test(filePath);
}
