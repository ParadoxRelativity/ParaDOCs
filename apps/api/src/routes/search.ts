import type { FastifyPluginAsync } from 'fastify';
import { searchQuerySchema } from '@paradocs/shared';
import { query } from '../db/pool.js';
import { parse } from '../lib/http.js';
import { documentLevelSql, projectLevelSql, spreadsheetLevelSql } from '../lib/access.js';
import { appEnabled } from '../lib/apps.js';
import { assertWorkspaceAccess } from '../plugins/session.js';

/**
 * Turns free text into a tsquery. Every term is prefix-matched so results appear
 * while the user is still typing, and websearch syntax is avoided because it
 * cannot express prefixes.
 */
function toTsQuery(input: string): string | null {
  const terms = input
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 0)
    .slice(0, 12);
  if (!terms.length) return null;
  return terms.map((t) => `${t.replace(/'/g, "''")}:*`).join(' & ');
}

/** How many spreadsheets a search returns beside its documents. */
const SHEET_LIMIT = 20;

/**
 * Spreadsheets that match, searched by title and by what is written in their
 * cells. They are their own application with their own table, so they are a
 * second query rather than a union: the document query is shaped around
 * folders and tags that a spreadsheet does not have.
 *
 * A search narrowed by tag or folder has already said it wants documents, and
 * no spreadsheet can satisfy either filter, so none are returned for it. As
 * with documents, nothing locked away from the reader turns up.
 */
async function searchSpreadsheets(
  workspaceId: string,
  reader: { userId: string; role: string },
  input: { q?: string; tags?: string[]; folderId?: string; from?: string; to?: string; includeArchived?: boolean },
  tsquery: string | null,
) {
  if (input.tags?.length || input.folderId) return [];

  const params: unknown[] = [workspaceId, reader.userId, reader.role];
  const where: string[] = ['s.workspace_id = $1', `${spreadsheetLevelSql('$2', '$3')} > 0`];
  if (!input.includeArchived) where.push('s.archived_at IS NULL');

  let rankExpr = '0';
  let snippetExpr = 'left(s.search_text, 180)';
  if (tsquery) {
    params.push(tsquery);
    const p = `$${params.length}`;
    params.push(input.q!);
    const rawQ = `$${params.length}`;
    where.push(`(s.search @@ to_tsquery('english', ${p}) OR s.title ILIKE '%' || ${rawQ} || '%')`);
    rankExpr = `ts_rank(s.search, to_tsquery('english', ${p}))`;
    snippetExpr = `ts_headline('english', s.search_text, to_tsquery('english', ${p}),
      'StartSel=<mark>, StopSel=</mark>, MaxWords=28, MinWords=10, ShortWord=2, MaxFragments=1')`;
  }
  if (input.from) {
    params.push(input.from);
    where.push(`s.updated_at >= $${params.length}::date`);
  }
  if (input.to) {
    params.push(input.to);
    where.push(`s.updated_at < ($${params.length}::date + interval '1 day')`);
  }

  const { rows } = await query(
    `SELECT s.id, s.title, s.icon, s.updated_at AS "updatedAt",
            ${rankExpr} AS rank,
            ${snippetExpr} AS snippet
       FROM spreadsheets s
      WHERE ${where.join(' AND ')}
      ORDER BY ${tsquery ? 'rank DESC, ' : ''}s.updated_at DESC
      LIMIT ${SHEET_LIMIT}`,
    params,
  );
  return rows;
}

/** How many work items a search returns beside its documents. */
const ITEM_LIMIT = 20;

/**
 * Work items that match, by title, by key (`ENG-12`) or by description, in
 * projects the reader may see. Like spreadsheets, they have no folders or
 * tags, so a search narrowed by either returns none.
 */
async function searchWorkItems(
  workspaceId: string,
  reader: { userId: string; role: string },
  input: { q?: string; tags?: string[]; folderId?: string; includeArchived?: boolean },
  tsquery: string | null,
) {
  if (input.tags?.length || input.folderId || !input.q) return [];
  const params: unknown[] = [workspaceId, reader.userId, reader.role, input.q, tsquery];
  const { rows } = await query(
    `SELECT i.id, i.project_id AS "projectId", p.key || '-' || i.number AS key, i.title,
            p.name AS "projectName", st.name AS "statusName", st.category AS "statusCategory", st.color AS "statusColor",
            i.updated_at AS "updatedAt",
            CASE WHEN $5::text IS NULL THEN 0 ELSE ts_rank(i.search, to_tsquery('english', $5)) END AS rank
       FROM work_items i
       JOIN projects p ON p.id = i.project_id
       JOIN project_statuses st ON st.id = i.status_id
      WHERE i.workspace_id = $1
        AND ${projectLevelSql('$2', '$3')} > 0
        ${input.includeArchived ? '' : 'AND p.archived_at IS NULL'}
        AND (i.title ILIKE '%' || $4 || '%'
             OR (p.key || '-' || i.number) ILIKE $4 || '%'
             OR ($5::text IS NOT NULL AND i.search @@ to_tsquery('english', $5)))
      ORDER BY (st.category = 'done'), rank DESC, i.updated_at DESC
      LIMIT ${ITEM_LIMIT}`,
    params,
  );
  return rows;
}

export const searchRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  app.get<{ Params: { id: string }; Querystring: Record<string, string | string[]> }>(
    '/workspaces/:id/search',
    async (req) => {
      const role = await assertWorkspaceAccess(req, req.params.id);
      // Each half answers only for an app the workspace has on.
      const [docsOn, sheetsOn, projectsOn] = await Promise.all([
        appEnabled(req.params.id, 'docs'),
        appEnabled(req.params.id, 'sheets'),
        appEnabled(req.params.id, 'projects'),
      ]);
      const raw = req.query;
      const input = parse(searchQuerySchema, {
        ...raw,
        // Fastify gives a string for one ?tags= and an array for several.
        tags: raw.tags === undefined ? undefined : Array.isArray(raw.tags) ? raw.tags : [raw.tags],
      });

      const tsquery = input.q ? toTsQuery(input.q) : null;
      const params: unknown[] = [req.params.id];
      const where: string[] = ['d.workspace_id = $1'];

      if (!input.includeArchived) where.push('d.archived_at IS NULL');

      if (tsquery) {
        params.push(tsquery);
        const p = `$${params.length}`;
        // Trigram fallback catches substrings that stemming misses ("para" in "ParaDOCs").
        params.push(input.q!);
        const rawQ = `$${params.length}`;
        where.push(`(d.search @@ to_tsquery('english', ${p}) OR d.title ILIKE '%' || ${rawQ} || '%')`);
      }
      if (input.tags?.length) {
        params.push(input.tags);
        // Require every selected tag, which is what a tag filter usually means.
        where.push(`(SELECT count(*) FROM document_tags dt
                      WHERE dt.document_id = d.id AND dt.tag_id = ANY($${params.length}::uuid[]))
                    = array_length($${params.length}::uuid[], 1)`);
      }
      if (input.folderId) {
        params.push(input.folderId);
        // Include documents in nested folders, not just direct children.
        where.push(`d.folder_id IN (
          WITH RECURSIVE down AS (
            SELECT id FROM folders WHERE id = $${params.length}
            UNION ALL SELECT f.id FROM folders f JOIN down ON f.parent_id = down.id
          ) SELECT id FROM down)`);
      }
      if (input.from) {
        params.push(input.from);
        where.push(`d.updated_at >= $${params.length}::date`);
      }
      if (input.to) {
        params.push(input.to);
        // Inclusive of the end day.
        where.push(`d.updated_at < ($${params.length}::date + interval '1 day')`);
      }

      // Nothing locked away from the reader turns up, however well it matches.
      params.push(req.user!.id, role);
      where.push(`${documentLevelSql(`$${params.length - 1}`, `$${params.length}`)} > 0`);

      const rankExpr = tsquery ? `ts_rank(d.search, to_tsquery('english', $2))` : '0';
      const snippetExpr = tsquery
        ? `ts_headline('english', regexp_replace(d.body_md, '\\[([^\\]]*)\\]\\(paradocs-sheet://[^)]*\\)?', '\\1', 'g'), to_tsquery('english', $2),
             'StartSel=<mark>, StopSel=</mark>, MaxWords=28, MinWords=10, ShortWord=2, MaxFragments=1')`
        : `left(regexp_replace(d.body_md, '\\[([^\\]]*)\\]\\(paradocs-sheet://[^)]*\\)?', '\\1', 'g'), 180)`;

      params.push(input.limit, input.offset);
      const limitParam = `$${params.length - 1}`;
      const offsetParam = `$${params.length}`;

      const { rows } = !docsOn ? { rows: [] } : await query(
        `SELECT d.id, d.title, d.icon, d.mode, d.folder_id AS "folderId",
                d.updated_at AS "updatedAt", d.is_journal AS "isJournal",
                ${rankExpr} AS rank,
                ${snippetExpr} AS snippet,
                COALESCE((
                  SELECT array_agg(name ORDER BY depth DESC)
                    FROM (
                      WITH RECURSIVE up AS (
                        SELECT id, parent_id, name, 0 AS depth FROM folders WHERE id = d.folder_id
                        UNION ALL
                        SELECT f.id, f.parent_id, f.name, up.depth + 1
                          FROM folders f JOIN up ON f.id = up.parent_id
                      ) SELECT name, depth FROM up
                    ) path
                ), ARRAY[]::text[]) AS "folderPath",
                COALESCE(
                  (SELECT json_agg(json_build_object('id', t.id, 'workspaceId', t.workspace_id,
                                                     'name', t.name, 'color', t.color) ORDER BY t.name)
                     FROM document_tags dt JOIN tags t ON t.id = dt.tag_id
                    WHERE dt.document_id = d.id),
                  '[]'::json) AS tags
           FROM documents d
          WHERE ${where.join(' AND ')}
          ORDER BY ${tsquery ? 'rank DESC, ' : ''}d.updated_at DESC
          LIMIT ${limitParam} OFFSET ${offsetParam}`,
        params,
      );

      const sheets = sheetsOn
        ? await searchSpreadsheets(req.params.id, { userId: req.user!.id, role }, input, tsquery)
        : [];
      const workItems = projectsOn
        ? await searchWorkItems(req.params.id, { userId: req.user!.id, role }, input, tsquery)
        : [];
      return { hits: rows, sheets, workItems, query: input.q ?? '' };
    },
  );
};
