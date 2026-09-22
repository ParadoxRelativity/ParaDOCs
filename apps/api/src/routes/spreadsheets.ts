import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { createSpreadsheetSchema, updateSpreadsheetSchema } from '@paradocs/shared';
import { query } from '../db/pool.js';
import { notFound, parse } from '../lib/http.js';
import { assertWorkspaceAccess } from '../plugins/session.js';
import { spreadsheetAccessForUser } from '../lib/spreadsheetAccess.js';
import { assertFolderAccess, assertMoveKeepsAccess, assertSpreadsheetAccess, roleSql, spreadsheetLevelSql } from '../lib/access.js';
import { spreadsheetSummaryColumns } from '../lib/documentColumns.js';
import { treeChanged } from '../lib/treeEvents.js';
import { loadWorkbook, resolveInWorkbook, type Workbook } from '../lib/workbook.js';
import { isValidSheetRef, sheetRefKey, type ResolvedSheetRef, type SheetRef } from '@paradocs/shared';

const refSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cell'), spreadsheetId: z.string(), sheetId: z.string(), cell: z.string() }),
  z.object({ kind: z.literal('chart'), spreadsheetId: z.string(), sheetId: z.string(), chartId: z.string() }),
]);

const resolveSchema = z.object({ refs: z.array(refSchema).max(300) });

/**
 * Resolves references for one person, loading each spreadsheet once however
 * many references point into it. A spreadsheet they cannot open answers
 * "unavailable" exactly as one that does not exist does, so a reference pasted
 * from someone else's document reveals nothing about what it pointed at.
 */
export async function resolveSheetRefs(userId: string, refs: SheetRef[]): Promise<Map<string, ResolvedSheetRef>> {
  const results = new Map<string, ResolvedSheetRef>();
  const workbooks = new Map<string, Promise<Workbook | null>>();

  for (const ref of refs) {
    const key = sheetRefKey(ref);
    if (results.has(key)) continue;
    if (!isValidSheetRef(ref)) {
      results.set(key, { kind: ref.kind, status: 'missing', problem: 'unavailable' });
      continue;
    }
    let pending = workbooks.get(ref.spreadsheetId);
    if (!pending) {
      pending = spreadsheetAccessForUser(userId, ref.spreadsheetId).then((access) =>
        access ? loadWorkbook(ref.spreadsheetId) : null,
      );
      workbooks.set(ref.spreadsheetId, pending);
    }
    const workbook = await pending;
    results.set(key, workbook ? resolveInWorkbook(workbook, ref) : { kind: ref.kind, status: 'missing', problem: 'unavailable' });
  }
  return results;
}

/**
 * Spreadsheets, as their own application.
 *
 * A smaller surface than documents: no tags and no comments. A spreadsheet is a
 * grid with a name, filed in the Sheets app's own folders and locked the way a
 * document is. The content lives in the Y.Doc that the collaboration server
 * owns — so there is no body to PATCH here and nothing that writes cells over
 * REST.
 */

/** A spreadsheet as `user` sees it. */
async function fetchSheet(id: string, userId: string) {
  const { rows } = await query(
    `SELECT ${spreadsheetSummaryColumns('$2', roleSql('$2', 's.workspace_id'))} FROM spreadsheets s WHERE s.id = $1`,
    [id, userId],
  );
  if (!rows[0]) throw notFound('Spreadsheet not found');
  return rows[0];
}

export const spreadsheetRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  app.get<{ Params: { id: string }; Querystring: { archived?: string } }>(
    '/workspaces/:id/spreadsheets',
    async (req) => {
      const role = await assertWorkspaceAccess(req, req.params.id, 'viewer', 'sheets');
      const archived = req.query.archived === 'true';
      // Only what the reader may see is listed.
      const { rows } = await query(
        `SELECT ${spreadsheetSummaryColumns('$3', '$4')}
           FROM spreadsheets s
          WHERE s.workspace_id = $1
            AND (s.archived_at IS NOT NULL) = $2
            AND ${spreadsheetLevelSql('$3', '$4')} > 0
          ORDER BY s.updated_at DESC
          LIMIT 500`,
        [req.params.id, archived, req.user!.id, role],
      );
      return rows;
    },
  );

  app.post<{ Params: { id: string } }>('/workspaces/:id/spreadsheets', async (req, reply) => {
    await assertWorkspaceAccess(req, req.params.id, 'editor', 'sheets');
    const input = parse(createSpreadsheetSchema, req.body ?? {});
    // Filing into a folder takes being allowed to change what is in it.
    if (input.folderId) await assertFolderAccess(req, input.folderId, 'edit', req.params.id, 'sheets');
    const { rows } = await query<{ id: string }>(
      `INSERT INTO spreadsheets (workspace_id, folder_id, title, icon, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [req.params.id, input.folderId ?? null, input.title || 'Untitled', input.icon ?? null, req.user!.id],
    );
    treeChanged(req.params.id, 'sheets');
    reply.status(201);
    return fetchSheet(rows[0].id, req.user!.id);
  });

  app.get<{ Params: { id: string } }>('/spreadsheets/:id', async (req) => {
    await assertSpreadsheetAccess(req, req.params.id);
    return fetchSheet(req.params.id, req.user!.id);
  });

  app.patch<{ Params: { id: string } }>('/spreadsheets/:id', async (req) => {
    const { workspaceId, role } = await assertSpreadsheetAccess(req, req.params.id, 'edit');
    const input = parse(updateSpreadsheetSchema, req.body ?? {});

    if (input.folderId !== undefined) {
      if (input.folderId) await assertFolderAccess(req, input.folderId, 'edit', workspaceId, 'sheets');
      const { rows: current } = await query<{ access: string; folder_id: string | null }>(
        'SELECT access, folder_id FROM spreadsheets WHERE id = $1',
        [req.params.id],
      );
      await assertMoveKeepsAccess(role, { access: current[0].access, folderId: current[0].folder_id }, input.folderId ?? null);
    }

    await query(
      `UPDATE spreadsheets
          SET title = COALESCE($2, title),
              icon = CASE WHEN $3::boolean THEN $4 ELSE icon END,
              archived_at = CASE
                WHEN $5::boolean IS NULL THEN archived_at
                WHEN $5::boolean THEN COALESCE(archived_at, now())
                ELSE NULL
              END,
              folder_id = CASE WHEN $6::boolean THEN $7::uuid ELSE folder_id END,
              -- Filing it somewhere is not an edit to the grid.
              updated_at = CASE WHEN $2::text IS NULL AND NOT $3::boolean AND $5::boolean IS NULL
                                THEN updated_at ELSE now() END
        WHERE id = $1`,
      [
        req.params.id,
        input.title ?? null,
        input.icon !== undefined,
        input.icon ?? null,
        input.archived ?? null,
        input.folderId !== undefined,
        input.folderId ?? null,
      ],
    );
    treeChanged(workspaceId, 'sheets');
    return fetchSheet(req.params.id, req.user!.id);
  });

  app.delete<{ Params: { id: string } }>('/spreadsheets/:id', async (req, reply) => {
    const { workspaceId } = await assertSpreadsheetAccess(req, req.params.id, 'edit');
    await query('DELETE FROM spreadsheets WHERE id = $1', [req.params.id]);
    treeChanged(workspaceId, 'sheets');
    reply.status(204);
  });

  /**
   * What a spreadsheet holds that can be pointed at from elsewhere: its sheets,
   * and the charts on each. For the picker that inserts a reference.
   */
  app.get<{ Params: { id: string } }>('/spreadsheets/:id/outline', async (req) => {
    await assertSpreadsheetAccess(req, req.params.id);
    const workbook = await loadWorkbook(req.params.id);
    if (!workbook) throw notFound('Spreadsheet not found');
    return {
      id: workbook.id,
      title: workbook.title,
      sheets: workbook.sheets.map((sheet) => ({
        id: sheet.id,
        name: sheet.name,
        charts: sheet.charts.map((chart) => ({ id: chart.id, title: chart.title, kind: chart.kind, range: chart.range })),
      })),
    };
  });

  /** The current value of each reference asked about, keyed as `sheetRefKey` keys them. */
  app.post('/sheet-refs/resolve', async (req) => {
    const input = parse(resolveSchema, req.body ?? {});
    const results = await resolveSheetRefs(req.user!.id, input.refs as SheetRef[]);
    return { results: Object.fromEntries(results) };
  });

  /**
   * The cells as text. The grid itself is served over the collaboration socket;
   * this is for anything that wants a snapshot without opening one — an export,
   * or a preview of a spreadsheet referenced from a document.
   */
  app.get<{ Params: { id: string } }>('/spreadsheets/:id/text', async (req, reply) => {
    if (!z.string().uuid().safeParse(req.params.id).success) throw notFound('Spreadsheet not found');
    await assertSpreadsheetAccess(req, req.params.id);
    const { rows } = await query<{ search_text: string }>(
      'SELECT search_text FROM spreadsheets WHERE id = $1',
      [req.params.id],
    );
    if (!rows[0]) throw notFound('Spreadsheet not found');
    reply.type('text/plain; charset=utf-8');
    return rows[0].search_text;
  });
};
