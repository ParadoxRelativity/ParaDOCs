import type { FastifyPluginAsync } from 'fastify';
import {
  createSlideCommentSchema,
  updateSlideCommentSchema,
  type SlideComment,
  type SlideCommentThreads,
} from '@paradocs/shared';
import { query } from '../db/pool.js';
import { badRequest, forbidden, notFound, parse } from '../lib/http.js';
import { uploadUrlSql } from '../lib/storage.js';
import { UUID, assertPresentationAccess } from '../lib/access.js';
import { resolveReferences } from '../lib/chatReferences.js';
import { recordSlideMentions } from '../lib/slideMentions.js';
import { assertMeets } from '../plugins/session.js';

const COMMENT_COLUMNS = `
  c.id, c.presentation_id AS "presentationId", c.slide_id AS "slideId", c.element_id AS "elementId",
  c.parent_id AS "parentId", c.body, c.resolved, c.created_at AS "createdAt", c.updated_at AS "updatedAt",
  json_build_object('id', u.id, 'name', u.name, 'email', u.email,
                    'avatarUrl', ${uploadUrlSql('u.avatar_key')}) AS author`;

/**
 * Comment threads on a presentation's slides, after the document comments in
 * routes/comments.ts. Anyone who can see the presentation reads them; writing
 * one takes the Slides comment permission, which viewers have by default. A
 * comment outlives its slide: nothing here looks at the deck.
 */
export const slideCommentRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  app.get<{ Params: { id: string } }>('/presentations/:id/comments', async (req): Promise<SlideCommentThreads> => {
    const access = await assertPresentationAccess(req, req.params.id);
    const { rows } = await query<SlideComment>(
      `SELECT ${COMMENT_COLUMNS}
         FROM slide_comments c JOIN users u ON u.id = c.author_id
        WHERE c.presentation_id = $1
        ORDER BY c.created_at`,
      [req.params.id],
    );
    // Replies nest one level; deeper ones are flattened onto their root.
    const roots: SlideComment[] = [];
    const byId = new Map(rows.map((c) => [c.id, { ...c, replies: [] as SlideComment[] }]));
    for (const comment of byId.values()) {
      if (comment.parentId && byId.has(comment.parentId)) byId.get(comment.parentId)!.replies!.push(comment);
      else roots.push(comment);
    }
    return {
      comments: roots,
      references: await resolveReferences(
        rows.map((c) => c.body),
        access.workspaceId,
        req.user!.id,
      ),
    };
  });

  app.post<{ Params: { id: string } }>('/presentations/:id/comments', async (req, reply) => {
    const access = await assertPresentationAccess(req, req.params.id);
    assertMeets(access, 'slides.comment');
    const input = parse(createSlideCommentSchema, req.body);
    let slideId = input.slideId;
    let elementId = input.elementId ?? null;
    if (input.parentId) {
      // A reply stays on its thread's slide and element whatever the request says.
      const { rows: parent } = await query<{ slide_id: string; element_id: string | null }>(
        'SELECT slide_id, element_id FROM slide_comments WHERE id = $1 AND presentation_id = $2',
        [input.parentId, req.params.id],
      );
      if (!parent[0]) throw badRequest('Parent comment is not on this presentation');
      slideId = parent[0].slide_id;
      elementId = parent[0].element_id;
    }
    const { rows } = await query<SlideComment>(
      `WITH inserted AS (
         INSERT INTO slide_comments (presentation_id, slide_id, element_id, parent_id, author_id, body)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
       )
       SELECT ${COMMENT_COLUMNS} FROM inserted c JOIN users u ON u.id = c.author_id`,
      [req.params.id, slideId, elementId, input.parentId ?? null, req.user!.id, input.body],
    );
    await recordSlideMentions(rows[0], req.user!.id);
    reply.status(201);
    return rows[0];
  });

  app.patch<{ Params: { id: string } }>('/slide-comments/:id', async (req) => {
    const found = await findComment(req.params.id);
    const access = await assertPresentationAccess(req, found.presentation_id);
    assertMeets(access, 'slides.comment');
    const input = parse(updateSlideCommentSchema, req.body);
    // Anyone who may comment may resolve a thread; only the author may edit the text.
    if (input.body !== undefined && found.author_id !== req.user!.id) {
      throw forbidden('You can only edit your own comments');
    }
    const { rows } = await query<SlideComment>(
      `WITH updated AS (
         UPDATE slide_comments
            SET body = COALESCE($2, body), resolved = COALESCE($3, resolved), updated_at = now()
          WHERE id = $1 RETURNING *
       )
       SELECT ${COMMENT_COLUMNS} FROM updated c JOIN users u ON u.id = c.author_id`,
      [req.params.id, input.body ?? null, input.resolved ?? null],
    );
    // Naming someone while editing tells them too, once.
    if (input.body !== undefined) await recordSlideMentions(rows[0], req.user!.id);
    return rows[0];
  });

  app.delete<{ Params: { id: string } }>('/slide-comments/:id', async (req, reply) => {
    const found = await findComment(req.params.id);
    const access = await assertPresentationAccess(req, found.presentation_id);
    assertMeets(access, 'slides.comment');
    if (found.author_id !== req.user!.id) throw forbidden('You can only delete your own comments');
    await query('DELETE FROM slide_comments WHERE id = $1', [req.params.id]);
    reply.status(204);
  });
};

async function findComment(id: string): Promise<{ presentation_id: string; author_id: string }> {
  if (!UUID.test(id)) throw notFound('Comment not found');
  const { rows } = await query<{ presentation_id: string; author_id: string }>(
    'SELECT presentation_id, author_id FROM slide_comments WHERE id = $1',
    [id],
  );
  if (!rows[0]) throw notFound('Comment not found');
  return rows[0];
}
