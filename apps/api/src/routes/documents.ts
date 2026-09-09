import type { FastifyPluginAsync } from 'fastify';
import type { DbClient } from '../db/pool.js';
import { createDocumentSchema, isoDate, updateDocumentSchema } from '@paradocs/shared';
import { query, transaction } from '../db/pool.js';
import { badRequest, notFound, parse } from '../lib/http.js';
import { blocksToMarkdown, deriveTitle } from '../lib/blocksToMarkdown.js';
import { DOCUMENT_SUMMARY_COLUMNS } from '../lib/documentColumns.js';
import { assertDocumentAccess, assertWorkspaceAccess } from '../plugins/session.js';

/** The full document, adding the body and derived fields to the shared summary. */
const DOC_COLUMNS = `${DOCUMENT_SUMMARY_COLUMNS}, d.body, d.body_md AS "bodyMd", d.properties,
  (SELECT json_build_object('id', u.id, 'name', u.name, 'email', u.email)
     FROM users u WHERE u.id = d.created_by) AS owner`;

async function replaceTags(client: DbClient, documentId: string, workspaceId: string, tagIds: string[]) {
  // Reject tags from another workspace rather than silently dropping them.
  if (tagIds.length) {
    const { rows } = await client.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM tags WHERE id = ANY($1::uuid[]) AND workspace_id = $2',
      [tagIds, workspaceId],
    );
    if (rows[0].count !== new Set(tagIds).size) {
      throw badRequest('One or more tags do not belong to this workspace');
    }
  }
  await client.query('DELETE FROM document_tags WHERE document_id = $1', [documentId]);
  if (tagIds.length) {
    await client.query(
      'INSERT INTO document_tags (document_id, tag_id) SELECT $1, unnest($2::uuid[])',
      [documentId, tagIds],
    );
  }
}

async function fetchDocument(id: string) {
  const { rows } = await query(`SELECT ${DOC_COLUMNS} FROM documents d WHERE d.id = $1`, [id]);
  if (!rows[0]) throw notFound('Document not found');
  return rows[0];
}

export const documentRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  /**
   * Flat document listing that backs the All Documents view. Unlike the sidebar
   * tree this includes unfiled documents, which is where new documents land.
   */
  app.get<{
    Params: { id: string };
    Querystring: { limit?: string; offset?: string; sort?: string; archived?: string; unfiled?: string };
  }>('/workspaces/:id/documents', async (req) => {
    await assertWorkspaceAccess(req, req.params.id);
    const limit = Math.min(Math.max(Number(req.query.limit ?? 100) || 100, 1), 200);
    const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
    const archived = req.query.archived === 'true';

    // Whitelisted so the sort key can never be interpolated from user input.
    const orderBy =
      { updated: 'd.updated_at DESC', created: 'd.created_at DESC', title: 'lower(d.title) ASC' }[
        req.query.sort ?? 'updated'
      ] ?? 'd.updated_at DESC';

    const conditions = ['d.workspace_id = $1', '(d.archived_at IS NOT NULL) = $2'];
    if (req.query.unfiled === 'true') conditions.push('d.folder_id IS NULL');

    const { rows } = await query(
      `SELECT ${DOCUMENT_SUMMARY_COLUMNS}
         FROM documents d
        WHERE ${conditions.join(' AND ')}
        ORDER BY ${orderBy}
        LIMIT $3 OFFSET $4`,
      [req.params.id, archived, limit, offset],
    );
    // `hasMore` lets the client offer "load more" without a second count query.
    return { documents: rows, hasMore: rows.length === limit };
  });

  app.post<{ Params: { id: string } }>('/workspaces/:id/documents', async (req, reply) => {
    await assertWorkspaceAccess(req, req.params.id, 'editor');
    const input = parse(createDocumentSchema, req.body);
    const body = input.body ?? [];
    const bodyMd = blocksToMarkdown(body);

    const id = await transaction(async (client) => {
      if (input.folderId) {
        const { rowCount } = await client.query('SELECT 1 FROM folders WHERE id = $1 AND workspace_id = $2', [
          input.folderId,
          req.params.id,
        ]);
        if (!rowCount) throw notFound('Folder not found');
      }
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO documents (workspace_id, folder_id, title, icon, body, body_md, created_by, mode)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8) RETURNING id`,
        [
          req.params.id,
          input.folderId ?? null,
          input.title?.trim() || deriveTitle(bodyMd),
          input.icon ?? null,
          JSON.stringify(body),
          bodyMd,
          req.user!.id,
          input.mode ?? 'page',
        ],
      );
      if (input.tagIds?.length) await replaceTags(client, rows[0].id, req.params.id, input.tagIds);
      return rows[0].id;
    });

    reply.status(201);
    return fetchDocument(id);
  });

  app.get<{ Params: { id: string } }>('/documents/:id', async (req) => {
    await assertDocumentAccess(req, req.params.id);
    return fetchDocument(req.params.id);
  });

  app.patch<{ Params: { id: string } }>('/documents/:id', async (req) => {
    const { workspaceId } = await assertDocumentAccess(req, req.params.id, 'editor');
    const input = parse(updateDocumentSchema, req.body);

    // The client sends markdown it rendered with BlockNote's own exporter; fall
    // back to the server converter when only blocks arrive.
    const bodyMd =
      input.bodyMd ?? (input.body !== undefined ? blocksToMarkdown(input.body) : undefined);

    await transaction(async (client) => {
      if (input.folderId) {
        const { rowCount } = await client.query('SELECT 1 FROM folders WHERE id = $1 AND workspace_id = $2', [
          input.folderId,
          workspaceId,
        ]);
        if (!rowCount) throw notFound('Folder not found');
      }
      await client.query(
        `UPDATE documents
            SET title = COALESCE($2, title),
                folder_id = CASE WHEN $3::boolean THEN $4::uuid ELSE folder_id END,
                icon = CASE WHEN $5::boolean THEN $6 ELSE icon END,
                body = COALESCE($7::jsonb, body),
                body_md = COALESCE($8, body_md),
                -- Writing blocks over REST invalidates the collaborative state so
                -- the next editing session reseeds from these blocks.
                ydoc = CASE WHEN $7::jsonb IS NULL THEN ydoc ELSE NULL END,
                properties = COALESCE($9::jsonb, properties),
                mode = COALESCE($12, mode),
                last_edited_by = $11,
                archived_at = CASE
                  WHEN $10::boolean IS NULL THEN archived_at
                  WHEN $10::boolean THEN COALESCE(archived_at, now())
                  ELSE NULL END,
                updated_at = now()
          WHERE id = $1`,
        [
          req.params.id,
          input.title?.trim() || null,
          input.folderId !== undefined,
          input.folderId ?? null,
          input.icon !== undefined,
          input.icon ?? null,
          input.body !== undefined ? JSON.stringify(input.body) : null,
          bodyMd ?? null,
          input.properties !== undefined ? JSON.stringify(input.properties) : null,
          input.archived ?? null,
          req.user!.id,
          input.mode ?? null,
        ],
      );
      if (input.tagIds) await replaceTags(client, req.params.id, workspaceId, input.tagIds);
    });

    return fetchDocument(req.params.id);
  });

  app.delete<{ Params: { id: string } }>('/documents/:id', async (req, reply) => {
    await assertDocumentAccess(req, req.params.id, 'editor');
    await query('DELETE FROM documents WHERE id = $1', [req.params.id]);
    reply.status(204);
  });

  /** Markdown export, for backups and for moving a document out of ParaDOCs. */
  app.get<{ Params: { id: string } }>('/documents/:id/markdown', async (req, reply) => {
    await assertDocumentAccess(req, req.params.id);
    const doc = (await fetchDocument(req.params.id)) as {
      title: string;
      bodyMd: string;
      tags: { name: string }[];
      createdAt: string;
      updatedAt: string;
    };
    const frontmatter = [
      '---',
      `title: ${JSON.stringify(doc.title)}`,
      `tags: [${doc.tags.map((t) => t.name).join(', ')}]`,
      `created: ${doc.createdAt}`,
      `updated: ${doc.updatedAt}`,
      '---',
      '',
    ].join('\n');
    reply.header('content-type', 'text/markdown; charset=utf-8');
    return `${frontmatter}${doc.bodyMd}\n`;
  });

  /**
   * Daily journal: fetch the entry for a date, creating it on first visit so the
   * client never has to decide between GET and POST.
   */
  app.get<{ Params: { id: string; date: string } }>('/workspaces/:id/journal/:date', async (req) => {
    // Opening a journal creates it on first visit, so this needs write access.
    await assertWorkspaceAccess(req, req.params.id, 'editor');
    const date = parse(isoDate, req.params.date);

    const existing = await query(
      `SELECT ${DOC_COLUMNS} FROM documents d
        WHERE d.workspace_id = $1 AND d.is_journal AND d.journal_date = $2::date`,
      [req.params.id, date],
    );
    if (existing.rows[0]) return existing.rows[0];

    const id = await transaction(async (client) => {
      // Journal entries land in a "Journal" folder, created once per workspace.
      const { rows: folder } = await client.query<{ id: string }>(
        `WITH existing AS (
           SELECT id FROM folders WHERE workspace_id = $1 AND parent_id IS NULL AND name = 'Journal' LIMIT 1
         ), created AS (
           INSERT INTO folders (workspace_id, name, position)
           SELECT $1, 'Journal', 0 WHERE NOT EXISTS (SELECT 1 FROM existing)
           RETURNING id
         )
         SELECT id FROM existing UNION ALL SELECT id FROM created`,
        [req.params.id],
      );
      const title = new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        timeZone: 'UTC',
      });
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO documents (workspace_id, folder_id, title, icon, is_journal, journal_date, body, body_md, created_by)
         VALUES ($1, $2, $3, '📔', true, $4::date, '[]'::jsonb, '', $5)
         ON CONFLICT (workspace_id, journal_date) WHERE is_journal DO UPDATE SET updated_at = documents.updated_at
         RETURNING id`,
        [req.params.id, folder[0]?.id ?? null, title, date, req.user!.id],
      );
      return rows[0].id;
    });

    return fetchDocument(id);
  });

  /** Which days have journals or document activity, for the calendar dots. */
  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>(
    '/workspaces/:id/activity',
    async (req) => {
      await assertWorkspaceAccess(req, req.params.id);
      const from = parse(isoDate, req.query.from ?? new Date().toISOString().slice(0, 8) + '01');
      const to = parse(isoDate, req.query.to ?? from);
      const { rows } = await query(
        `SELECT to_char(day, 'YYYY-MM-DD') AS day,
                count(*) FILTER (WHERE kind = 'created')::int AS created,
                count(*) FILTER (WHERE kind = 'updated')::int AS updated,
                bool_or(is_journal) AS "hasJournal"
           FROM (
             SELECT date_trunc('day', created_at)::date AS day, 'created' AS kind, is_journal
               FROM documents WHERE workspace_id = $1
             UNION ALL
             SELECT date_trunc('day', updated_at)::date, 'updated', is_journal
               FROM documents WHERE workspace_id = $1
           ) activity
          WHERE day BETWEEN $2::date AND $3::date
          GROUP BY day ORDER BY day`,
        [req.params.id, from, to],
      );
      return rows;
    },
  );
};
