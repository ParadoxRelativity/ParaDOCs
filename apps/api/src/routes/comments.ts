import type { FastifyPluginAsync } from 'fastify';
import type { Comment } from '@paradocs/shared';
import { createCommentSchema, updateCommentSchema } from '@paradocs/shared';
import { query } from '../db/pool.js';
import { badRequest, forbidden, notFound, parse } from '../lib/http.js';
import { assertDocumentAccess } from '../plugins/session.js';

const COMMENT_COLUMNS = `
  c.id, c.document_id AS "documentId", c.parent_id AS "parentId", c.block_id AS "blockId",
  c.body, c.resolved, c.created_at AS "createdAt", c.updated_at AS "updatedAt",
  json_build_object('id', u.id, 'name', u.name, 'email', u.email) AS author`;

export const commentRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  app.get<{ Params: { id: string } }>('/documents/:id/comments', async (req) => {
    await assertDocumentAccess(req, req.params.id);
    const { rows } = await query<Comment>(
      `SELECT ${COMMENT_COLUMNS}
         FROM comments c JOIN users u ON u.id = c.author_id
        WHERE c.document_id = $1
        ORDER BY c.created_at`,
      [req.params.id],
    );

    // Nest replies one level; deeper threads are flattened onto their root.
    const roots: Comment[] = [];
    const byId = new Map(rows.map((c) => [c.id, { ...c, replies: [] as Comment[] }]));
    for (const comment of byId.values()) {
      if (comment.parentId && byId.has(comment.parentId)) byId.get(comment.parentId)!.replies!.push(comment);
      else roots.push(comment);
    }
    return roots;
  });

  app.post<{ Params: { id: string } }>('/documents/:id/comments', async (req, reply) => {
    await assertDocumentAccess(req, req.params.id);
    const input = parse(createCommentSchema, req.body);
    if (input.parentId) {
      const { rowCount } = await query('SELECT 1 FROM comments WHERE id = $1 AND document_id = $2', [
        input.parentId,
        req.params.id,
      ]);
      if (!rowCount) throw badRequest('Parent comment is not on this document');
    }
    const { rows } = await query(
      `WITH inserted AS (
         INSERT INTO comments (document_id, author_id, parent_id, block_id, body)
         VALUES ($1, $2, $3, $4, $5) RETURNING *
       )
       SELECT ${COMMENT_COLUMNS} FROM inserted c JOIN users u ON u.id = c.author_id`,
      [req.params.id, req.user!.id, input.parentId ?? null, input.blockId ?? null, input.body],
    );
    reply.status(201);
    return rows[0];
  });

  app.patch<{ Params: { id: string } }>('/comments/:id', async (req) => {
    const { rows: found } = await query<{ document_id: string; author_id: string }>(
      'SELECT document_id, author_id FROM comments WHERE id = $1',
      [req.params.id],
    );
    if (!found[0]) throw notFound('Comment not found');
    // Any member may resolve a thread; only the author may edit the text.
    await assertDocumentAccess(req, found[0].document_id);

    const input = parse(updateCommentSchema, req.body);
    // Anyone with document access may resolve a thread, but only the author may edit the text.
    if (input.body !== undefined && found[0].author_id !== req.user!.id) {
      throw forbidden('You can only edit your own comments');
    }
    const { rows } = await query(
      `WITH updated AS (
         UPDATE comments
            SET body = COALESCE($2, body), resolved = COALESCE($3, resolved), updated_at = now()
          WHERE id = $1 RETURNING *
       )
       SELECT ${COMMENT_COLUMNS} FROM updated c JOIN users u ON u.id = c.author_id`,
      [req.params.id, input.body ?? null, input.resolved ?? null],
    );
    return rows[0];
  });

  app.delete<{ Params: { id: string } }>('/comments/:id', async (req, reply) => {
    const { rows } = await query<{ document_id: string; author_id: string }>(
      'SELECT document_id, author_id FROM comments WHERE id = $1',
      [req.params.id],
    );
    if (!rows[0]) throw notFound('Comment not found');
    await assertDocumentAccess(req, rows[0].document_id);
    if (rows[0].author_id !== req.user!.id) throw forbidden('You can only delete your own comments');
    await query('DELETE FROM comments WHERE id = $1', [req.params.id]);
    reply.status(204);
  });
};
