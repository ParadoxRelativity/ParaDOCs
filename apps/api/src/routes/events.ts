import type { FastifyPluginAsync } from 'fastify';
import { createEventSchema, updateEventSchema } from '@paradocs/shared';
import { query } from '../db/pool.js';
import { notFound, parse } from '../lib/http.js';
import { assertWorkspaceAccess } from '../plugins/session.js';
import { documentAccess } from '../lib/access.js';

/** An event can link a document in its workspace that the person linking it may see. */
async function assertLinkable(userId: string, documentId: string, workspaceId: string): Promise<void> {
  const access = await documentAccess(userId, documentId);
  if (!access || access.workspaceId !== workspaceId) throw notFound('Linked document not found in this workspace');
}

const EVENT_COLUMNS = `
  e.id, e.workspace_id AS "workspaceId", e.document_id AS "documentId", e.title, e.description,
  e.start_at AS "startAt", e.end_at AS "endAt", e.all_day AS "allDay", e.color,
  e.created_at AS "createdAt"`;

export const eventRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>(
    '/workspaces/:id/events',
    async (req) => {
      await assertWorkspaceAccess(req, req.params.id);
      const conditions = ['e.workspace_id = $1'];
      const params: unknown[] = [req.params.id];
      if (req.query.from) {
        params.push(req.query.from);
        // An event overlaps the window if it ends after the window starts.
        conditions.push(`COALESCE(e.end_at, e.start_at) >= $${params.length}::date`);
      }
      if (req.query.to) {
        params.push(req.query.to);
        conditions.push(`e.start_at < ($${params.length}::date + interval '1 day')`);
      }
      const { rows } = await query(
        `SELECT ${EVENT_COLUMNS} FROM events e
          WHERE ${conditions.join(' AND ')}
          ORDER BY e.start_at`,
        params,
      );
      return rows;
    },
  );

  app.post<{ Params: { id: string } }>('/workspaces/:id/events', async (req, reply) => {
    await assertWorkspaceAccess(req, req.params.id, 'editor');
    const input = parse(createEventSchema, req.body);
    if (input.documentId) await assertLinkable(req.user!.id, input.documentId, req.params.id);
    const { rows } = await query(
      `WITH inserted AS (
         INSERT INTO events (workspace_id, document_id, title, description, start_at, end_at, all_day, color)
         VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7, COALESCE($8, '#6366f1'))
         RETURNING *
       ) SELECT ${EVENT_COLUMNS} FROM inserted e`,
      [
        req.params.id,
        input.documentId ?? null,
        input.title,
        input.description ?? null,
        input.startAt,
        input.endAt ?? null,
        input.allDay ?? false,
        input.color ?? null,
      ],
    );
    reply.status(201);
    return rows[0];
  });

  app.patch<{ Params: { id: string } }>('/events/:id', async (req) => {
    const { rows: found } = await query<{ workspace_id: string }>('SELECT workspace_id FROM events WHERE id = $1', [
      req.params.id,
    ]);
    if (!found[0]) throw notFound('Event not found');
    await assertWorkspaceAccess(req, found[0].workspace_id, 'editor');
    const input = parse(updateEventSchema, req.body);
    if (input.documentId) await assertLinkable(req.user!.id, input.documentId, found[0].workspace_id);
    const { rows } = await query(
      `WITH updated AS (
         UPDATE events
            SET title = COALESCE($2, title),
                description = CASE WHEN $3::boolean THEN $4 ELSE description END,
                start_at = COALESCE($5::timestamptz, start_at),
                end_at = CASE WHEN $6::boolean THEN $7::timestamptz ELSE end_at END,
                all_day = COALESCE($8, all_day),
                color = COALESCE($9, color),
                document_id = CASE WHEN $10::boolean THEN $11::uuid ELSE document_id END
          WHERE id = $1 RETURNING *
       ) SELECT ${EVENT_COLUMNS} FROM updated e`,
      [
        req.params.id,
        input.title ?? null,
        input.description !== undefined,
        input.description ?? null,
        input.startAt ?? null,
        input.endAt !== undefined,
        input.endAt ?? null,
        input.allDay ?? null,
        input.color ?? null,
        input.documentId !== undefined,
        input.documentId ?? null,
      ],
    );
    return rows[0];
  });

  app.delete<{ Params: { id: string } }>('/events/:id', async (req, reply) => {
    const { rows } = await query<{ workspace_id: string }>('SELECT workspace_id FROM events WHERE id = $1', [
      req.params.id,
    ]);
    if (!rows[0]) throw notFound('Event not found');
    await assertWorkspaceAccess(req, rows[0].workspace_id, 'editor');
    await query('DELETE FROM events WHERE id = $1', [req.params.id]);
    reply.status(204);
  });
};
