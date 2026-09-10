import type { FastifyPluginAsync } from 'fastify';
import { createFolderSchema, createWorkspaceSchema, updateFolderSchema, updateWorkspaceSchema } from '@paradocs/shared';
import type { FolderNode } from '@paradocs/shared';
import { query, transaction } from '../db/pool.js';
import { badRequest, notFound, parse } from '../lib/http.js';
import { slugify } from '../lib/auth.js';
import { DOCUMENT_SUMMARY_COLUMNS } from '../lib/documentColumns.js';
import { assertWorkspaceAccess } from '../plugins/session.js';

interface FolderRow {
  id: string;
  workspace_id: string;
  parent_id: string | null;
  name: string;
  icon: string | null;
  position: number;
  created_at: string;
}

export const workspaceRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  app.get('/workspaces', async (req) => {
    const { rows } = await query(
      `SELECT w.id, w.name, w.slug, w.icon, w.created_at AS "createdAt", m.role,
              (SELECT count(*) FROM documents d
                WHERE d.workspace_id = w.id AND d.archived_at IS NULL) AS "documentCount",
              (SELECT count(*) FROM workspace_members wm
                WHERE wm.workspace_id = w.id) AS "memberCount"
         FROM workspace_members m
         JOIN workspaces w ON w.id = m.workspace_id
        WHERE m.user_id = $1
        ORDER BY w.created_at`,
      [req.user!.id],
    );
    return rows;
  });

  app.post('/workspaces', async (req, reply) => {
    const input = parse(createWorkspaceSchema, req.body);
    // Slugs are unique per owner; suffix on collision instead of failing.
    const base = slugify(input.name);
    const { rows: taken } = await query<{ slug: string }>(
      'SELECT slug FROM workspaces WHERE owner_id = $1 AND slug LIKE $2',
      [req.user!.id, `${base}%`],
    );
    const used = new Set(taken.map((r) => r.slug));
    let slug = base;
    for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`;

    const created = await transaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO workspaces (owner_id, name, slug, icon)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, slug, icon, created_at AS "createdAt"`,
        [req.user!.id, input.name, slug, input.icon ?? null],
      );
      await client.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [rows[0].id, req.user!.id],
      );
      // Somewhere to talk, so the chat tab is never an empty room.
      await client.query(
        `INSERT INTO channels (workspace_id, name, topic, created_by) VALUES ($1, 'general', $2, $3)`,
        [rows[0].id, 'Everything else', req.user!.id],
      );
      return rows[0];
    });
    reply.status(201);
    return { ...created, role: 'owner', documentCount: 0, memberCount: 1 };
  });

  app.patch<{ Params: { id: string } }>('/workspaces/:id', async (req) => {
    await assertWorkspaceAccess(req, req.params.id, 'admin');
    const input = parse(updateWorkspaceSchema, req.body);
    // The icon is optional, so an explicit null must clear it. COALESCE would
    // read that as "no change" and make a set icon impossible to remove.
    const { rows } = await query(
      `UPDATE workspaces
          SET name = COALESCE($2, name),
              icon = CASE WHEN $3::boolean THEN $4 ELSE icon END
        WHERE id = $1
        RETURNING id, name, slug, icon, created_at AS "createdAt"`,
      [req.params.id, input.name ?? null, input.icon !== undefined, input.icon ?? null],
    );
    return rows[0];
  });

  app.delete<{ Params: { id: string } }>('/workspaces/:id', async (req, reply) => {
    await assertWorkspaceAccess(req, req.params.id, 'owner');
    const { rows } = await query<{ count: number }>(
      'SELECT count(*)::int AS count FROM workspace_members WHERE user_id = $1',
      [req.user!.id],
    );
    if (rows[0].count <= 1) throw badRequest('You cannot leave yourself without a workspace');
    await query('DELETE FROM workspaces WHERE id = $1', [req.params.id]);
    reply.status(204);
  });

  /**
   * Folder tree plus the documents in each folder, for the left sidebar.
   * Unfiled documents are deliberately excluded: the sidebar shows organized
   * documents only, and everything else lives in the All Documents view.
   */
  app.get<{ Params: { id: string } }>('/workspaces/:id/tree', async (req) => {
    await assertWorkspaceAccess(req, req.params.id);

    const [{ rows: folders }, { rows: documents }] = await Promise.all([
      query<FolderRow>(
        `SELECT id, workspace_id, parent_id, name, icon, position, created_at
           FROM folders WHERE workspace_id = $1 ORDER BY position, name`,
        [req.params.id],
      ),
      query(
        `SELECT ${DOCUMENT_SUMMARY_COLUMNS}
           FROM documents d
          WHERE d.workspace_id = $1 AND d.archived_at IS NULL AND d.folder_id IS NOT NULL
          ORDER BY d.title`,
        [req.params.id],
      ),
    ]);

    const nodes = new Map<string, FolderNode>();
    for (const f of folders) {
      nodes.set(f.id, {
        id: f.id,
        workspaceId: f.workspace_id,
        parentId: f.parent_id,
        name: f.name,
        icon: f.icon,
        position: f.position,
        createdAt: f.created_at,
        children: [],
        documents: [],
      });
    }

    const roots: FolderNode[] = [];
    for (const f of folders) {
      const node = nodes.get(f.id)!;
      const parent = f.parent_id ? nodes.get(f.parent_id) : undefined;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }

    for (const doc of documents) {
      nodes.get(doc.folderId as string)?.documents.push(doc as never);
    }

    return { folders: roots };
  });

  app.post<{ Params: { id: string } }>('/workspaces/:id/folders', async (req, reply) => {
    await assertWorkspaceAccess(req, req.params.id, 'editor');
    const input = parse(createFolderSchema, req.body);
    if (input.parentId) {
      const { rowCount } = await query('SELECT 1 FROM folders WHERE id = $1 AND workspace_id = $2', [
        input.parentId,
        req.params.id,
      ]);
      if (!rowCount) throw notFound('Parent folder not found');
    }
    const { rows } = await query(
      `INSERT INTO folders (workspace_id, parent_id, name, icon, position)
       VALUES ($1, $2, $3, $4, COALESCE($5, (
         SELECT COALESCE(max(position) + 1, 0) FROM folders
          WHERE workspace_id = $1 AND parent_id IS NOT DISTINCT FROM $2)))
       RETURNING id, workspace_id AS "workspaceId", parent_id AS "parentId", name, icon, position,
                 created_at AS "createdAt"`,
      [req.params.id, input.parentId ?? null, input.name, input.icon ?? null, input.position ?? null],
    );
    reply.status(201);
    return rows[0];
  });

  app.patch<{ Params: { id: string } }>('/folders/:id', async (req) => {
    const input = parse(updateFolderSchema, req.body);
    const { rows: found } = await query<{ workspace_id: string }>(
      'SELECT workspace_id FROM folders WHERE id = $1',
      [req.params.id],
    );
    if (!found[0]) throw notFound('Folder not found');
    await assertWorkspaceAccess(req, found[0].workspace_id, 'editor');

    if (input.parentId) {
      if (input.parentId === req.params.id) throw badRequest('A folder cannot be its own parent');
      // Walk up from the proposed parent; if we meet this folder, the move would cycle.
      const { rows: cycle } = await query<{ id: string }>(
        `WITH RECURSIVE up AS (
           SELECT id, parent_id FROM folders WHERE id = $1
           UNION ALL
           SELECT f.id, f.parent_id FROM folders f JOIN up ON f.id = up.parent_id
         ) SELECT id FROM up WHERE id = $2`,
        [input.parentId, req.params.id],
      );
      if (cycle.length) throw badRequest('That move would nest a folder inside itself');
    }

    const { rows } = await query(
      `UPDATE folders
          SET name = COALESCE($2, name),
              parent_id = CASE WHEN $3::boolean THEN $4::uuid ELSE parent_id END,
              -- Explicit null clears the icon; omitting it leaves it alone.
              icon = CASE WHEN $5::boolean THEN $6 ELSE icon END,
              position = COALESCE($7, position)
        WHERE id = $1
        RETURNING id, workspace_id AS "workspaceId", parent_id AS "parentId", name, icon, position,
                  created_at AS "createdAt"`,
      [
        req.params.id,
        input.name ?? null,
        input.parentId !== undefined,
        input.parentId ?? null,
        input.icon !== undefined,
        input.icon ?? null,
        input.position ?? null,
      ],
    );
    return rows[0];
  });

  app.delete<{ Params: { id: string } }>('/folders/:id', async (req, reply) => {
    const { rows } = await query<{ workspace_id: string }>('SELECT workspace_id FROM folders WHERE id = $1', [
      req.params.id,
    ]);
    if (!rows[0]) throw notFound('Folder not found');
    await assertWorkspaceAccess(req, rows[0].workspace_id, 'editor');
    // Subfolders cascade; documents inside are kept and fall back to the root.
    await query('DELETE FROM folders WHERE id = $1', [req.params.id]);
    reply.status(204);
  });
};
