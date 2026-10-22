import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import * as Y from 'yjs';
import {
  applyPresentationTemplateSchema,
  readDeck,
  savePresentationTemplateSchema,
  slidesCollabName,
  templateAssetUrls,
  templateDeckFrom,
  templatePreview,
  templateStyleOf,
  updatePresentationTemplateSchema,
  type PresentationTemplateSummary,
  type TemplateStyle,
} from '@paradocs/shared';
import { query, type DbClient } from '../db/pool.js';
import { UUID, assertPresentationAccess } from '../lib/access.js';
import { HttpError, badRequest, forbidden, notFound, parse } from '../lib/http.js';
import { liveDocument } from '../lib/liveDocuments.js';
import { mayReadUpload } from '../lib/uploadAccess.js';
import { assertWorkspaceAccess } from '../plugins/session.js';

/**
 * Presentation templates (PARA-110): a deck's look saved in a workspace, for
 * anyone in it to start a presentation from or put on one.
 *
 * A template is saved from a deck here, or imported from a PowerPoint file in
 * the browser, which reads the file, makes the template (`POST`), uploads its
 * pictures to it and then stores the deck (`PUT …/content`). Until then it is
 * a draft nobody sees. Whoever saved one, an owner or an admin may rename or
 * delete it, as with project templates.
 */

/** The largest template deck, its pictures aside (they are uploaded on their own). */
const TEMPLATE_MAX_BYTES = 20 * 1024 * 1024;

/** A draft whose import never finished is cleared after this long. */
const DRAFT_LIFETIME = '1 day';

interface TemplateRow {
  id: string;
  name: string;
  description: string;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  preview: PresentationTemplateSummary['preview'];
}

const SUMMARY_COLUMNS = `t.id, t.name, t.description, t.created_by AS "createdBy", u.name AS "createdByName",
  t.created_at AS "createdAt", t.preview`;

function isManager(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

/** A template's deck as a Y.Doc, or null for a draft; the caller destroys it. */
function openDeck(ydoc: Buffer | null): Y.Doc | null {
  if (!ydoc) return null;
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(ydoc));
  return doc;
}

/**
 * Records pictures a template shows against it, so they are served to the
 * workspace and outlive the deck they came from. Only files the person saving
 * may read themselves are linked: a template must not become a way to see a
 * picture from somewhere locked to them.
 */
async function linkAssets(db: Pick<DbClient, 'query'>, userId: string, workspaceId: string, templateId: string, urls: string[]): Promise<void> {
  const keys: string[] = [];
  for (const url of urls) {
    const key = url.slice('/uploads/'.length);
    if (key.startsWith(`${workspaceId}/`) && (await mayReadUpload(userId, key))) keys.push(key);
  }
  if (keys.length === 0) return;
  await db.query(
    `INSERT INTO presentation_template_attachments (template_id, attachment_id)
     SELECT $1::uuid, a.id FROM attachments a WHERE a.workspace_id = $2 AND a.storage_key = ANY($3::text[])
     ON CONFLICT DO NOTHING`,
    [templateId, workspaceId, keys],
  );
}

/** Lets a presentation's readers see a template's pictures, once the deck shows them: after it is made from or styled with it. */
export async function linkTemplateAssetsToPresentation(db: Pick<DbClient, 'query'>, templateId: string, presentationId: string): Promise<void> {
  await db.query(
    `INSERT INTO presentation_attachments (presentation_id, attachment_id)
     SELECT $1::uuid, attachment_id FROM presentation_template_attachments WHERE template_id = $2::uuid
     ON CONFLICT DO NOTHING`,
    [presentationId, templateId],
  );
}

/** A finished template of this workspace, for making or styling a deck with. */
export async function usableTemplate(workspaceId: string, templateId: string): Promise<{ ydoc: Buffer }> {
  if (!UUID.test(templateId)) throw badRequest('That template does not exist');
  const { rows } = await query<{ ydoc: Buffer }>(
    'SELECT ydoc FROM presentation_templates WHERE id = $1 AND workspace_id = $2 AND ydoc IS NOT NULL',
    [templateId, workspaceId],
  );
  if (!rows[0]) throw badRequest('That template does not exist');
  return rows[0];
}

export const presentationTemplateRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  async function summary(id: string, userId: string, role: string): Promise<PresentationTemplateSummary> {
    const { rows } = await query<TemplateRow>(
      `SELECT ${SUMMARY_COLUMNS} FROM presentation_templates t LEFT JOIN users u ON u.id = t.created_by WHERE t.id = $1`,
      [id],
    );
    if (!rows[0]) throw notFound('Template not found');
    return { ...rows[0], canManage: isManager(role) || rows[0].createdBy === userId };
  }

  /** A template, checked to be one the reader may change: theirs, or any for an owner or admin. */
  async function manageableTemplate(req: FastifyRequest, templateId: string) {
    if (!UUID.test(templateId)) throw notFound('Template not found');
    const { rows } = await query<{ workspace_id: string; created_by: string | null; ydoc: Buffer | null }>(
      'SELECT workspace_id, created_by, ydoc FROM presentation_templates WHERE id = $1',
      [templateId],
    );
    if (!rows[0]) throw notFound('Template not found');
    const member = await assertWorkspaceAccess(req, rows[0].workspace_id, 'slides.view', 'slides');
    if (rows[0].created_by !== req.user!.id && !isManager(member.role)) {
      throw forbidden('Only whoever saved a template, an owner or an admin can change it');
    }
    return { workspaceId: rows[0].workspace_id, draft: rows[0].ydoc === null, role: member.role };
  }

  /** The workspace's templates, by name: everyone who can see Slides sees them all. */
  app.get<{ Params: { id: string } }>('/workspaces/:id/presentation-templates', async (req): Promise<PresentationTemplateSummary[]> => {
    const member = await assertWorkspaceAccess(req, req.params.id, 'slides.view', 'slides');
    await query(`DELETE FROM presentation_templates WHERE workspace_id = $1 AND ydoc IS NULL AND created_at < now() - interval '${DRAFT_LIFETIME}'`, [
      req.params.id,
    ]);
    const { rows } = await query<TemplateRow>(
      `SELECT ${SUMMARY_COLUMNS}
         FROM presentation_templates t LEFT JOIN users u ON u.id = t.created_by
        WHERE t.workspace_id = $1 AND t.ydoc IS NOT NULL
        ORDER BY lower(t.name), t.created_at`,
      [req.params.id],
    );
    const manager = isManager(member.role);
    return rows.map((t) => ({ ...t, canManage: manager || t.createdBy === req.user!.id }));
  });

  /** Starts an imported template: a draft, to upload its pictures to before its deck is stored. */
  app.post<{ Params: { id: string } }>('/workspaces/:id/presentation-templates', async (req, reply) => {
    await assertWorkspaceAccess(req, req.params.id, 'slides.create', 'slides');
    const input = parse(savePresentationTemplateSchema, req.body ?? {});
    const { rows } = await query<{ id: string }>(
      `INSERT INTO presentation_templates (workspace_id, name, description, created_by)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [req.params.id, input.name, input.description ?? '', req.user!.id],
    );
    reply.status(201);
    return { id: rows[0].id };
  });

  /**
   * An imported template's deck, built in the browser. It is rebuilt here from
   * its look, so whatever was sent, the template holds its theme, master and
   * layouts and one Title slide. Only a draft takes one.
   */
  app.put<{ Params: { id: string } }>('/presentation-templates/:id/content', async (req) => {
    const { draft, role } = await manageableTemplate(req, req.params.id);
    if (!draft) throw new HttpError(409, 'This template is already saved', 'template_saved');
    const file = await req.file({ limits: { fileSize: TEMPLATE_MAX_BYTES, files: 1 } });
    if (!file) throw badRequest('No template was uploaded');
    let data: Buffer;
    try {
      data = await file.toBuffer();
    } catch (err) {
      if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') throw badRequest('That template is too large');
      throw err;
    }
    if (file.file.truncated) throw badRequest('That template is too large');

    const sent = new Y.Doc();
    const stored = new Y.Doc();
    try {
      try {
        Y.applyUpdate(sent, new Uint8Array(data));
      } catch {
        throw badRequest('That is not a template');
      }
      const update = templateDeckFrom(sent);
      Y.applyUpdate(stored, update);
      // Its pictures were linked as they were uploaded to it; nothing it names besides is.
      const { rowCount } = await query('UPDATE presentation_templates SET ydoc = $2, preview = $3 WHERE id = $1 AND ydoc IS NULL', [
        req.params.id,
        Buffer.from(update),
        JSON.stringify(templatePreview(stored)),
      ]);
      if (!rowCount) throw new HttpError(409, 'This template is already saved', 'template_saved');
    } finally {
      sent.destroy();
      stored.destroy();
    }
    return summary(req.params.id, req.user!.id, role);
  });

  /** Saves a deck's look as a template: its theme, master and layouts, and none of its slides. */
  app.post<{ Params: { id: string } }>('/presentations/:id/template', async (req, reply) => {
    const { workspaceId } = await assertPresentationAccess(req, req.params.id);
    const member = await assertWorkspaceAccess(req, workspaceId, 'slides.create', 'slides');
    const input = parse(savePresentationTemplateSchema, req.body ?? {});
    const { rows: source } = await query<{ ydoc: Buffer | null }>('SELECT ydoc FROM presentations WHERE id = $1', [req.params.id]);
    if (!source[0]) throw notFound('Presentation not found');

    // The open deck is newer than the saved copy by up to the save debounce.
    const live = liveDocument(slidesCollabName(req.params.id));
    const deck = live ?? openDeck(source[0].ydoc) ?? new Y.Doc();
    const stored = new Y.Doc();
    try {
      const update = templateDeckFrom(deck);
      Y.applyUpdate(stored, update);
      const { rows } = await query<{ id: string }>(
        `INSERT INTO presentation_templates (workspace_id, name, description, ydoc, preview, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [workspaceId, input.name, input.description ?? '', Buffer.from(update), JSON.stringify(templatePreview(stored)), req.user!.id],
      );
      await linkAssets({ query }, req.user!.id, workspaceId, rows[0].id, templateAssetUrls(templateStyleOf(readDeck(stored))));
      reply.status(201);
      return summary(rows[0].id, req.user!.id, member.role);
    } finally {
      if (!live) deck.destroy();
      stored.destroy();
    }
  });

  app.patch<{ Params: { id: string } }>('/presentation-templates/:id', async (req) => {
    const { role } = await manageableTemplate(req, req.params.id);
    const input = parse(updatePresentationTemplateSchema, req.body ?? {});
    await query('UPDATE presentation_templates SET name = COALESCE($2, name), description = COALESCE($3, description) WHERE id = $1', [
      req.params.id,
      input.name ?? null,
      input.description ?? null,
    ]);
    return summary(req.params.id, req.user!.id, role);
  });

  /** Deletes a template. Decks made from it keep their look, and their pictures, which they hold links to of their own. */
  app.delete<{ Params: { id: string } }>('/presentation-templates/:id', async (req, reply) => {
    await manageableTemplate(req, req.params.id);
    await query('DELETE FROM presentation_templates WHERE id = $1', [req.params.id]);
    reply.status(204);
  });

  /**
   * Getting ready to put a template's look on a deck: its pictures become
   * readable to whoever can open the deck, and its look comes back for the
   * editor to apply, in its own undoable edit, to the deck people are editing.
   */
  app.post<{ Params: { id: string } }>('/presentations/:id/apply-template', async (req): Promise<TemplateStyle> => {
    const { workspaceId } = await assertPresentationAccess(req, req.params.id, 'edit');
    const input = parse(applyPresentationTemplateSchema, req.body ?? {});
    const template = await usableTemplate(workspaceId, input.templateId);
    const doc = openDeck(template.ydoc)!;
    try {
      await linkTemplateAssetsToPresentation({ query }, input.templateId, req.params.id);
      return templateStyleOf(readDeck(doc));
    } finally {
      doc.destroy();
    }
  });
};
