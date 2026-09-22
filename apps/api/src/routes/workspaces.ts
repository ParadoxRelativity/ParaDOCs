import type { FastifyPluginAsync } from 'fastify';
import { createFolderSchema, createWorkspaceSchema, updateFolderSchema, updateWorkspaceSchema } from '@paradocs/shared';
import {
  WORKSPACE_APPS,
  type AccessMode,
  type DocumentSummary,
  type FolderApp,
  type FolderNode,
  type SheetFolderNode,
  type SpreadsheetSummary,
} from '@paradocs/shared';
import { query, transaction } from '../db/pool.js';
import { badRequest, forbidden, parse } from '../lib/http.js';
import { slugify } from '../lib/auth.js';
import { documentSummaryColumns, spreadsheetSummaryColumns } from '../lib/documentColumns.js';
import {
  assertFolderAccess,
  assertMoveKeepsAccess,
  documentLevelSql,
  folderLevelSql,
  managesAccess,
  permissionOf,
  spreadsheetLevelSql,
} from '../lib/access.js';
import { accessChanged } from '../lib/accessEvents.js';
import { enabledAppsSql } from '../lib/apps.js';
import { replaceAvatar, storeAvatar } from '../lib/avatars.js';
import { removeStoredFile, removeStoredFiles, uploadUrlSql } from '../lib/storage.js';
import { assertWorkspaceAccess } from '../plugins/session.js';
import { addDefaultVoiceChannel } from './voice.js';

const WORKSPACE_COLUMNS = `id, name, slug, icon, ${uploadUrlSql('avatar_key')} AS "avatarUrl",
  ${enabledAppsSql('disabled_apps')} AS apps, created_at AS "createdAt"`;

const FOLDER_COLUMNS = `id, workspace_id AS "workspaceId", app, parent_id AS "parentId", name, icon, position,
  created_at AS "createdAt"`;

interface FolderRow {
  id: string;
  workspace_id: string;
  app: FolderApp;
  parent_id: string | null;
  name: string;
  icon: string | null;
  position: number;
  created_at: string;
  access: AccessMode;
  level: number;
}

/**
 * Builds a folder tree for the reader and files `items` into it.
 *
 * Only what the reader may see is included. The nearest setting wins, so an
 * item can be open to someone inside a folder that is not; its folders are
 * kept as the path to it, marked `none`, and a folder with nothing in it they
 * may see is left out altogether.
 */
function buildTree<Item extends { folderId: string | null }, Node extends { permission: string; children: Node[] }>(
  folders: FolderRow[],
  items: Item[],
  makeNode: (folder: FolderRow) => Node,
  contents: (node: Node) => Item[],
): Node[] {
  const nodes = new Map<string, Node>();
  for (const f of folders) nodes.set(f.id, makeNode(f));

  const roots: Node[] = [];
  for (const f of folders) {
    const node = nodes.get(f.id)!;
    const parent = f.parent_id ? nodes.get(f.parent_id) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  for (const item of items) {
    const node = item.folderId ? nodes.get(item.folderId) : undefined;
    if (node) contents(node).push(item);
  }

  const visible = (node: Node): boolean => {
    node.children = node.children.filter(visible);
    return node.permission !== 'none' || node.children.length > 0 || contents(node).length > 0;
  };
  return roots.filter(visible);
}

function folderNodeBase(f: FolderRow) {
  return {
    id: f.id,
    workspaceId: f.workspace_id,
    app: f.app,
    parentId: f.parent_id,
    name: f.name,
    icon: f.icon,
    position: f.position,
    createdAt: f.created_at,
    access: f.access,
    permission: permissionOf(f.level),
  };
}

/** What each app files in its folders, for deleting a folder and what is in it. */
const FOLDER_CONTENTS = {
  docs: { table: 'documents', alias: 'd', entryColumn: 'document_id', noun: 'documents', levelSql: documentLevelSql },
  sheets: {
    table: 'spreadsheets',
    alias: 's',
    entryColumn: 'spreadsheet_id',
    noun: 'spreadsheets',
    levelSql: spreadsheetLevelSql,
  },
} as const;

/** A folder and every folder beneath it, as a CTE named `sub`. Takes the folder id as $1. */
const SUBTREE = `WITH RECURSIVE sub AS (
  SELECT id FROM folders WHERE id = $1
  UNION ALL
  SELECT f.id FROM folders f JOIN sub ON f.parent_id = sub.id
)`;

export const workspaceRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  app.get('/workspaces', async (req) => {
    const { rows } = await query(
      `SELECT w.id, w.name, w.slug, w.icon, ${uploadUrlSql('w.avatar_key')} AS "avatarUrl",
              ${enabledAppsSql('w.disabled_apps')} AS apps,
              w.created_at AS "createdAt", m.role,
              (SELECT count(*) FROM documents d
                WHERE d.workspace_id = w.id AND d.archived_at IS NULL
                  AND ${documentLevelSql('$1', 'm.role')} > 0) AS "documentCount",
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
         RETURNING ${WORKSPACE_COLUMNS}`,
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
      await addDefaultVoiceChannel(client, rows[0].id as string, req.user!.id);
      return rows[0];
    });
    reply.status(201);
    return { ...created, role: 'owner', documentCount: 0, memberCount: 1 };
  });

  app.patch<{ Params: { id: string } }>('/workspaces/:id', async (req) => {
    await assertWorkspaceAccess(req, req.params.id, 'admin');
    const input = parse(updateWorkspaceSchema, req.body);
    // Stored as what is off, so an app added later starts out on.
    const disabled = input.apps ? WORKSPACE_APPS.filter((app) => !input.apps!.includes(app)) : null;
    // The icon is optional, so an explicit null must clear it. COALESCE would
    // read that as "no change" and make a set icon impossible to remove.
    const { rows } = await query<{ apps_changed: boolean }>(
      `WITH before AS (SELECT disabled_apps FROM workspaces WHERE id = $1)
       UPDATE workspaces
          SET name = COALESCE($2, name),
              icon = CASE WHEN $3::boolean THEN $4 ELSE icon END,
              disabled_apps = COALESCE($5::text[], disabled_apps)
        WHERE id = $1
        RETURNING ${WORKSPACE_COLUMNS},
                  disabled_apps IS DISTINCT FROM (SELECT disabled_apps FROM before) AS apps_changed`,
      [req.params.id, input.name ?? null, input.icon !== undefined, input.icon ?? null, disabled],
    );
    const { apps_changed: appsChanged, ...workspace } = rows[0];
    // An app going off takes away what it holds, and one coming on gives it
    // back, for everyone in the workspace: their sidebars, open documents,
    // spreadsheets and chat sockets all check again.
    if (appsChanged) accessChanged(req.params.id);
    return workspace;
  });

  /** Sets the workspace picture, which takes the place of its icon. */
  app.put<{ Params: { id: string } }>('/workspaces/:id/avatar', async (req) => {
    await assertWorkspaceAccess(req, req.params.id, 'admin');
    const key = await storeAvatar(req, 'workspaces');
    return replaceAvatar('workspaces', req.params.id, key, WORKSPACE_COLUMNS);
  });

  app.delete<{ Params: { id: string } }>('/workspaces/:id/avatar', async (req) => {
    await assertWorkspaceAccess(req, req.params.id, 'admin');
    return replaceAvatar('workspaces', req.params.id, null, WORKSPACE_COLUMNS);
  });

  app.delete<{ Params: { id: string } }>('/workspaces/:id', async (req, reply) => {
    await assertWorkspaceAccess(req, req.params.id, 'owner');
    const { rows } = await query<{ count: number }>(
      'SELECT count(*)::int AS count FROM workspace_members WHERE user_id = $1',
      [req.user!.id],
    );
    if (rows[0].count <= 1) throw badRequest('You cannot leave yourself without a workspace');
    // The rows for the workspace's files cascade away with it, so the files
    // themselves are collected first and removed once it is gone.
    const { rows: files } = await query<{ storage_key: string }>(
      `SELECT storage_key FROM attachments WHERE workspace_id = $1
       UNION ALL
       SELECT a.storage_key FROM message_attachments a
         JOIN channels c ON c.id = a.channel_id
        WHERE c.workspace_id = $1
       UNION ALL
       SELECT a.storage_key FROM work_item_attachments a
         JOIN work_items i ON i.id = a.work_item_id
         JOIN projects p ON p.id = i.project_id
        WHERE p.workspace_id = $1`,
      [req.params.id],
    );
    const { rows: deleted } = await query<{ avatar_key: string | null }>(
      'DELETE FROM workspaces WHERE id = $1 RETURNING avatar_key',
      [req.params.id],
    );
    if (deleted[0]?.avatar_key) await removeStoredFile(deleted[0].avatar_key);
    await removeStoredFiles(
      files.map((f) => f.storage_key),
      req.log,
    );
    reply.status(204);
  });

  /**
   * Folder tree plus the documents in each folder, for the left sidebar.
   * Unfiled documents are deliberately excluded: the sidebar shows organized
   * documents only, and everything else lives in the All Documents view.
   * Only what the reader may see is included; see buildTree.
   */
  app.get<{ Params: { id: string } }>('/workspaces/:id/tree', async (req) => {
    const role = await assertWorkspaceAccess(req, req.params.id, 'viewer', 'docs');

    const [{ rows: folders }, { rows: documents }] = await Promise.all([
      query<FolderRow>(
        `SELECT id, workspace_id, app, parent_id, name, icon, position, created_at, access,
                ${folderLevelSql('$2', '$3', 'id')} AS level
           FROM folders WHERE workspace_id = $1 AND app = 'docs' ORDER BY position, name`,
        [req.params.id, req.user!.id, role],
      ),
      query<DocumentSummary>(
        `SELECT ${documentSummaryColumns('$2', '$3')}
           FROM documents d
          WHERE d.workspace_id = $1 AND d.archived_at IS NULL AND d.folder_id IS NOT NULL
            AND ${documentLevelSql('$2', '$3')} > 0
          ORDER BY d.title`,
        [req.params.id, req.user!.id, role],
      ),
    ]);

    return {
      folders: buildTree(
        folders,
        documents,
        (f): FolderNode => ({ ...folderNodeBase(f), children: [], documents: [] }),
        (node) => node.documents,
      ),
    };
  });

  /**
   * The Sheets app's tree: its folders with the spreadsheets filed in each,
   * and beside them the spreadsheets in no folder. Unlike documents there is
   * no other view of a workspace's spreadsheets, so the unfiled ones are part
   * of the answer rather than left to a listing of their own.
   */
  app.get<{ Params: { id: string } }>('/workspaces/:id/sheet-tree', async (req) => {
    const role = await assertWorkspaceAccess(req, req.params.id, 'viewer', 'sheets');

    const [{ rows: folders }, { rows: spreadsheets }] = await Promise.all([
      query<FolderRow>(
        `SELECT id, workspace_id, app, parent_id, name, icon, position, created_at, access,
                ${folderLevelSql('$2', '$3', 'id')} AS level
           FROM folders WHERE workspace_id = $1 AND app = 'sheets' ORDER BY position, name`,
        [req.params.id, req.user!.id, role],
      ),
      query<SpreadsheetSummary>(
        `SELECT ${spreadsheetSummaryColumns('$2', '$3')}
           FROM spreadsheets s
          WHERE s.workspace_id = $1 AND s.archived_at IS NULL
            AND ${spreadsheetLevelSql('$2', '$3')} > 0
          ORDER BY s.folder_id IS NULL, lower(s.title), s.updated_at DESC`,
        [req.params.id, req.user!.id, role],
      ),
    ]);

    return {
      folders: buildTree(
        folders,
        spreadsheets,
        (f): SheetFolderNode => ({ ...folderNodeBase(f), children: [], spreadsheets: [] }),
        (node) => node.spreadsheets,
      ),
      // Unfiled, most recently touched first, as the flat list always showed them.
      unfiled: spreadsheets
        .filter((sheet) => sheet.folderId === null)
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)),
    };
  });

  app.post<{ Params: { id: string } }>('/workspaces/:id/folders', async (req, reply) => {
    const input = parse(createFolderSchema, req.body);
    await assertWorkspaceAccess(req, req.params.id, 'editor', input.app);
    // A subfolder is something put in its parent, which takes being allowed to
    // change what is in it. It must be in the same app's tree.
    if (input.parentId) await assertFolderAccess(req, input.parentId, 'edit', req.params.id, input.app);
    const { rows } = await query(
      `INSERT INTO folders (workspace_id, app, parent_id, name, icon, position)
       VALUES ($1, $6, $2, $3, $4, COALESCE($5, (
         SELECT COALESCE(max(position) + 1, 0) FROM folders
          WHERE workspace_id = $1 AND app = $6 AND parent_id IS NOT DISTINCT FROM $2)))
       RETURNING ${FOLDER_COLUMNS}`,
      [req.params.id, input.parentId ?? null, input.name, input.icon ?? null, input.position ?? null, input.app],
    );
    reply.status(201);
    return rows[0];
  });

  app.patch<{ Params: { id: string } }>('/folders/:id', async (req) => {
    const input = parse(updateFolderSchema, req.body);
    const { workspaceId, role, app: folderApp } = await assertFolderAccess(req, req.params.id, 'edit');

    if (input.parentId !== undefined) {
      if (input.parentId) {
        if (input.parentId === req.params.id) throw badRequest('A folder cannot be its own parent');
        await assertFolderAccess(req, input.parentId, 'edit', workspaceId, folderApp);
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
      const { rows: current } = await query<{ access: string; parent_id: string | null }>(
        'SELECT access, parent_id FROM folders WHERE id = $1',
        [req.params.id],
      );
      await assertMoveKeepsAccess(role, { access: current[0].access, folderId: current[0].parent_id }, input.parentId ?? null);
    }

    const { rows } = await query(
      `UPDATE folders
          SET name = COALESCE($2, name),
              parent_id = CASE WHEN $3::boolean THEN $4::uuid ELSE parent_id END,
              -- Explicit null clears the icon; omitting it leaves it alone.
              icon = CASE WHEN $5::boolean THEN $6 ELSE icon END,
              position = COALESCE($7, position)
        WHERE id = $1
        RETURNING ${FOLDER_COLUMNS}`,
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

  /**
   * Deletes a folder and its subfolders. What is filed inside — documents, or
   * spreadsheets in a Sheets folder — is kept and becomes unfiled, or, with
   * `?contents=delete`, is deleted along with it. `?documents=delete` is the
   * older spelling of the same thing.
   */
  app.delete<{ Params: { id: string }; Querystring: { documents?: string; contents?: string } }>(
    '/folders/:id',
    async (req, reply) => {
      const { role, app: folderApp } = await assertFolderAccess(req, req.params.id, 'edit');
      const deleteContents = req.query.contents === 'delete' || req.query.documents === 'delete';
      const items = FOLDER_CONTENTS[folderApp];
      if (!managesAccess(role)) {
        // Subfolders go with it, so someone who could not change one of them
        // cannot delete it by deleting its parent.
        const { rows: locked } = await query(
          `${SUBTREE} SELECT 1 FROM sub WHERE ${folderLevelSql('$2', '$3', 'sub.id')} < 2 LIMIT 1`,
          [req.params.id, req.user!.id, role],
        );
        if (locked.length) throw forbidden('This folder holds folders you cannot change, so you cannot delete it');
        // The same goes for what is filed in them, including things locked away
        // from them that they could not even see were there.
        if (deleteContents) {
          const { rows: protectedItems } = await query(
            `${SUBTREE}
             SELECT 1 FROM ${items.table} ${items.alias}
              WHERE ${items.alias}.folder_id IN (SELECT id FROM sub) AND ${items.levelSql('$2', '$3')} < 2
              LIMIT 1`,
            [req.params.id, req.user!.id, role],
          );
          if (protectedItems.length) {
            throw forbidden(`This folder holds ${items.noun} you cannot change, so they cannot be deleted with it`);
          }
        }
      }

      if (deleteContents) {
        await transaction(async (client) => {
          await client.query(`${SUBTREE} DELETE FROM ${items.table} WHERE folder_id IN (SELECT id FROM sub)`, [
            req.params.id,
          ]);
          await client.query('DELETE FROM folders WHERE id = $1', [req.params.id]);
        });
        reply.status(204);
        return;
      }

      await transaction(async (client) => {
        // Subfolders cascade; what is filed inside is kept and falls back to the
        // root. Anything that took its access from a folder takes that setting
        // along, written onto itself, so deleting a folder never opens what was
        // in it.
        const { rows: carried } = await client.query<{ id: string; governor: string }>(
          `${SUBTREE}
           SELECT i.id, access_folder_governor(i.folder_id) AS governor
             FROM ${items.table} i
            WHERE i.folder_id IN (SELECT id FROM sub)
              AND i.access = 'inherit'
              AND access_folder_governor(i.folder_id) IS NOT NULL`,
          [req.params.id],
        );
        const byGovernor = new Map<string, string[]>();
        for (const row of carried) byGovernor.set(row.governor, [...(byGovernor.get(row.governor) ?? []), row.id]);
        for (const [governor, ids] of byGovernor) {
          await client.query(
            `UPDATE ${items.table} SET access = (SELECT access FROM folders WHERE id = $1) WHERE id = ANY($2::uuid[])`,
            [governor, ids],
          );
          await client.query(
            `INSERT INTO access_entries (${items.entryColumn}, team_id, user_id, level)
             SELECT i.id, e.team_id, e.user_id, e.level
               FROM access_entries e CROSS JOIN unnest($2::uuid[]) AS i(id)
              WHERE e.folder_id = $1`,
            [governor, ids],
          );
        }
        await client.query('DELETE FROM folders WHERE id = $1', [req.params.id]);
      });
      reply.status(204);
    },
  );
};
