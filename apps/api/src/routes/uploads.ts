import type { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { config } from '../config.js';
import { query, transaction } from '../db/pool.js';
import { badRequest, notFound, parse } from '../lib/http.js';
import { blocksToMarkdown } from '../lib/blocksToMarkdown.js';
import { removeStoredFile } from '../lib/storage.js';
import { assertWorkspaceAccess } from '../plugins/session.js';

const MAX_BYTES = 25 * 1024 * 1024;

const attachSchema = z.object({
  title: z.string().max(300).optional(),
  folderId: z.string().uuid().nullish(),
});

/** The BlockNote block that best presents a file of this type. */
function blockForFile(mimeType: string, url: string, filename: string) {
  if (mimeType.startsWith('image/')) {
    return { type: 'image', props: { url, caption: '', name: filename }, children: [] };
  }
  if (mimeType.startsWith('video/')) {
    return { type: 'video', props: { url, caption: '', name: filename }, children: [] };
  }
  if (mimeType.startsWith('audio/')) {
    return { type: 'audio', props: { url, caption: '', name: filename }, children: [] };
  }
  return { type: 'file', props: { url, name: filename, caption: '' }, children: [] };
}

/** Attachments for images, audio, video and files used on canvases and pages. */
export const uploadRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  app.post<{ Params: { id: string } }>('/workspaces/:id/uploads', async (req, reply) => {
    await assertWorkspaceAccess(req, req.params.id, 'editor');
    const file = await req.file({ limits: { fileSize: MAX_BYTES } });
    if (!file) throw badRequest('No file was uploaded');

    const buffer = await file.toBuffer();
    if (buffer.byteLength > MAX_BYTES) throw badRequest('File exceeds the 25 MB limit');

    // Recording the owning document is what keeps the unattached list honest.
    const fields = file.fields as Record<string, { value?: unknown } | undefined>;
    const rawDocumentId = fields?.documentId?.value;
    const documentId =
      typeof rawDocumentId === 'string' && z.string().uuid().safeParse(rawDocumentId).success
        ? rawDocumentId
        : null;

    // Store under a generated name so a malicious filename cannot escape the directory.
    const ext = path.extname(file.filename).slice(0, 12).replace(/[^.\w]/g, '');
    const storageKey = `${req.params.id}/${randomUUID()}${ext}`;
    const target = path.join(config.uploadDir, storageKey);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, buffer);

    const { rows } = await query(
      `INSERT INTO attachments (workspace_id, document_id, filename, mime_type, byte_size, storage_key)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, filename, mime_type AS "mimeType", byte_size AS "byteSize"`,
      [req.params.id, documentId, file.filename, file.mimetype, buffer.byteLength, storageKey],
    );

    reply.status(201);
    return { ...rows[0], url: `/uploads/${storageKey}` };
  });

  /**
   * Uploads in a workspace. Files with no owning document are listed first;
   * that happens when a file was never attached, or when the document holding
   * it was deleted, which nulls the reference.
   */
  app.get<{ Params: { id: string }; Querystring: { unattached?: string } }>(
    '/workspaces/:id/uploads',
    async (req) => {
      await assertWorkspaceAccess(req, req.params.id, 'admin');
      const onlyUnattached = req.query.unattached === 'true';

      const { rows } = await query(
        `SELECT a.id, a.filename, a.mime_type AS "mimeType", a.byte_size AS "byteSize",
                a.created_at AS "createdAt", a.document_id AS "documentId",
                d.title AS "documentTitle",
                '/uploads/' || a.storage_key AS url
           FROM attachments a
           LEFT JOIN documents d ON d.id = a.document_id
          WHERE a.workspace_id = $1
            AND ($2::boolean IS NOT TRUE OR a.document_id IS NULL)
          ORDER BY a.created_at DESC`,
        [req.params.id, onlyUnattached],
      );

      const { rows: totals } = await query<{
        total: number;
        unattached: number;
        bytes: number;
        unattached_bytes: number;
      }>(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE document_id IS NULL)::int AS unattached,
                -- sum() over bigint yields numeric, which arrives as a string;
                -- cast back so the client gets numbers.
                COALESCE(sum(byte_size), 0)::bigint AS bytes,
                COALESCE(sum(byte_size) FILTER (WHERE document_id IS NULL), 0)::bigint AS unattached_bytes
           FROM attachments WHERE workspace_id = $1`,
        [req.params.id],
      );

      return { uploads: rows, totals: totals[0] };
    },
  );

  app.delete<{ Params: { id: string; uploadId: string } }>(
    '/workspaces/:id/uploads/:uploadId',
    async (req, reply) => {
      await assertWorkspaceAccess(req, req.params.id, 'admin');
      const { rows } = await query<{ storage_key: string }>(
        'SELECT storage_key FROM attachments WHERE id = $1 AND workspace_id = $2',
        [req.params.uploadId, req.params.id],
      );
      if (!rows[0]) throw notFound('Upload not found');

      await removeStoredFile(rows[0].storage_key);
      await query('DELETE FROM attachments WHERE id = $1', [req.params.uploadId]);
      reply.status(204);
    },
  );

  /** Puts an orphaned file into a new document, which also re-homes it. */
  app.post<{ Params: { id: string; uploadId: string } }>(
    '/workspaces/:id/uploads/:uploadId/attach',
    async (req, reply) => {
      await assertWorkspaceAccess(req, req.params.id, 'admin');
      const input = parse(attachSchema, req.body ?? {});

      const { rows } = await query<{
        id: string;
        filename: string;
        mime_type: string;
        storage_key: string;
        document_id: string | null;
      }>(
        `SELECT id, filename, mime_type, storage_key, document_id
           FROM attachments WHERE id = $1 AND workspace_id = $2`,
        [req.params.uploadId, req.params.id],
      );
      const attachment = rows[0];
      if (!attachment) throw notFound('Upload not found');
      if (attachment.document_id) throw badRequest('That file already belongs to a document');

      if (input.folderId) {
        const { rowCount } = await query('SELECT 1 FROM folders WHERE id = $1 AND workspace_id = $2', [
          input.folderId,
          req.params.id,
        ]);
        if (!rowCount) throw notFound('Folder not found');
      }

      const url = `/uploads/${attachment.storage_key}`;
      const blocks = [blockForFile(attachment.mime_type, url, attachment.filename)];

      const document = await transaction(async (client) => {
        const { rows: created } = await client.query<{ id: string; title: string }>(
          `INSERT INTO documents (workspace_id, folder_id, title, body, body_md, created_by)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6)
           RETURNING id, title`,
          [
            req.params.id,
            input.folderId ?? null,
            input.title?.trim() || attachment.filename,
            JSON.stringify(blocks),
            blocksToMarkdown(blocks),
            req.user!.id,
          ],
        );
        await client.query('UPDATE attachments SET document_id = $2 WHERE id = $1', [
          attachment.id,
          created[0].id,
        ]);
        return created[0];
      });

      reply.status(201);
      return { document };
    },
  );
};
