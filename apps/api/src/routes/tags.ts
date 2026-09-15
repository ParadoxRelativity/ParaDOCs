import type { FastifyPluginAsync } from 'fastify';
import { createTagSchema, updateTagSchema } from '@paradocs/shared';
import { query } from '../db/pool.js';
import { conflict, notFound, parse } from '../lib/http.js';
import { documentLevelSql } from '../lib/access.js';
import { assertWorkspaceAccess } from '../plugins/session.js';

const PALETTE = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#14b8a6'];

export const tagRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  app.get<{ Params: { id: string } }>('/workspaces/:id/tags', async (req) => {
    const role = await assertWorkspaceAccess(req, req.params.id);
    // Counts only what the reader may see, so a tag's number matches what
    // following it turns up.
    const { rows } = await query(
      `SELECT t.id, t.workspace_id AS "workspaceId", t.name, t.color,
              count(d.id) FILTER (WHERE ${documentLevelSql('$2', '$3')} > 0)::int AS "documentCount"
         FROM tags t
         LEFT JOIN document_tags dt ON dt.tag_id = t.id
         LEFT JOIN documents d ON d.id = dt.document_id AND d.archived_at IS NULL
        WHERE t.workspace_id = $1
        GROUP BY t.id
        ORDER BY t.name`,
      [req.params.id, req.user!.id, role],
    );
    return rows;
  });

  app.post<{ Params: { id: string } }>('/workspaces/:id/tags', async (req, reply) => {
    await assertWorkspaceAccess(req, req.params.id, 'editor');
    const input = parse(createTagSchema, req.body);
    const name = input.name.trim();

    const { rows: existing } = await query('SELECT 1 FROM tags WHERE workspace_id = $1 AND lower(name) = lower($2)', [
      req.params.id,
      name,
    ]);
    if (existing.length) throw conflict(`A tag named "${name}" already exists`);

    // Cycle the default palette so a workspace's tags stay visually distinct.
    const { rows: count } = await query<{ count: number }>(
      'SELECT count(*)::int AS count FROM tags WHERE workspace_id = $1',
      [req.params.id],
    );
    const color = input.color ?? PALETTE[count[0].count % PALETTE.length];

    const { rows } = await query(
      `INSERT INTO tags (workspace_id, name, color) VALUES ($1, $2, $3)
       RETURNING id, workspace_id AS "workspaceId", name, color, 0 AS "documentCount"`,
      [req.params.id, name, color],
    );
    reply.status(201);
    return rows[0];
  });

  app.patch<{ Params: { id: string } }>('/tags/:id', async (req) => {
    const { rows: found } = await query<{ workspace_id: string }>('SELECT workspace_id FROM tags WHERE id = $1', [
      req.params.id,
    ]);
    if (!found[0]) throw notFound('Tag not found');
    await assertWorkspaceAccess(req, found[0].workspace_id, 'editor');
    const input = parse(updateTagSchema, req.body);
    const { rows } = await query(
      `UPDATE tags SET name = COALESCE($2, name), color = COALESCE($3, color)
        WHERE id = $1
        RETURNING id, workspace_id AS "workspaceId", name, color`,
      [req.params.id, input.name?.trim() ?? null, input.color ?? null],
    );
    return rows[0];
  });

  app.delete<{ Params: { id: string } }>('/tags/:id', async (req, reply) => {
    const { rows } = await query<{ workspace_id: string }>('SELECT workspace_id FROM tags WHERE id = $1', [
      req.params.id,
    ]);
    if (!rows[0]) throw notFound('Tag not found');
    await assertWorkspaceAccess(req, rows[0].workspace_id, 'editor');
    await query('DELETE FROM tags WHERE id = $1', [req.params.id]);
    reply.status(204);
  });
};
