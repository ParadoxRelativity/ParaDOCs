import type { FastifyPluginAsync } from 'fastify';
import {
  linkTargetsQuerySchema,
  searchQuerySchema,
  slideElementText,
  type LinkTargets,
  type PresentationSearchHit,
} from '@paradocs/shared';
import { query } from '../db/pool.js';
import { parse } from '../lib/http.js';
import { documentLevelSql, presentationLevelSql, projectLevelSql, scheduleLevelSql, spreadsheetLevelSql } from '../lib/access.js';
import { loadDeck } from '../lib/deck.js';
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
  reader: { userId: string; roleId: string },
  input: { q?: string; tags?: string[]; folderId?: string; from?: string; to?: string; includeArchived?: boolean },
  tsquery: string | null,
) {
  if (input.tags?.length || input.folderId) return [];

  const params: unknown[] = [workspaceId, reader.userId, reader.roleId];
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

/** How many presentations a search returns beside its documents. */
const DECK_LIMIT = 20;

/** The terms of a search, as the patterns that find them at the start of a word. */
function termPatterns(input: string): RegExp[] {
  return input
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean)
    .slice(0, 12)
    .map((t) => new RegExp(`(?<![\\p{L}\\p{N}_])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\p{L}\\p{N}_]*`, 'giu'));
}

/** About 160 characters of `text` around the first term found in it, the terms marked; null when none is there. */
function markedExcerpt(text: string, patterns: RegExp[]): string | null {
  let first = -1;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    const found = pattern.exec(text);
    if (found && (first === -1 || found.index < first)) first = found.index;
  }
  if (first === -1) return null;
  const start = Math.max(0, first - 60);
  let excerpt = text.slice(start, start + 160).replace(/\s+/g, ' ');
  for (const pattern of patterns) excerpt = excerpt.replace(pattern, (m) => `<mark>${m}</mark>`);
  return `${start > 0 ? '…' : ''}${excerpt.trim()}${start + 160 < text.length ? '…' : ''}`;
}

/**
 * Where in a deck the typed words are: the first slide, counted from 1, whose
 * text or speaker notes has one of them, with a marked excerpt. Slide text is
 * looked for before notes on the same slide.
 */
function locateInDeck(
  slides: { id: string; elements: Parameters<typeof slideElementText>[0][]; notes: string }[],
  patterns: RegExp[],
) {
  for (const [index, slide] of slides.entries()) {
    for (const [text, inNotes] of [[slide.elements.map(slideElementText).filter(Boolean).join('\n'), false], [slide.notes, true]] as const) {
      const snippet = markedExcerpt(text, patterns);
      if (snippet) return { slide: index + 1, slideId: slide.id, inNotes, snippet };
    }
  }
  return null;
}

/** How many of a search's decks are opened to say which slide matched. */
const LOCATE_LIMIT = 5;

/**
 * Presentations that match, by title and by the text and speaker notes on
 * their slides, naming the slide the match is on. As with spreadsheets, a
 * search narrowed by tag or folder has asked for documents, and nothing locked
 * away from the reader turns up.
 *
 * The database finds and ranks the decks; the slide is found by reading the
 * best few hits' decks, so a phrase only in the speaker notes finds the deck and says
 * where. A match the typed words do not locate (stemming: "running" finds
 * "run") falls back to the database's own excerpt and no slide.
 */
async function searchPresentations(
  workspaceId: string,
  reader: { userId: string; roleId: string },
  input: { q?: string; tags?: string[]; folderId?: string; from?: string; to?: string; includeArchived?: boolean },
  tsquery: string | null,
): Promise<PresentationSearchHit[]> {
  if (input.tags?.length || input.folderId) return [];

  const params: unknown[] = [workspaceId, reader.userId, reader.roleId];
  const where: string[] = ['p.workspace_id = $1', `${presentationLevelSql('$2', '$3')} > 0`];
  if (!input.includeArchived) where.push('p.archived_at IS NULL');

  let rankExpr = '0';
  let snippetExpr = "left(p.search_text, 180)";
  if (tsquery) {
    params.push(tsquery);
    const q = `$${params.length}`;
    params.push(input.q!);
    const rawQ = `$${params.length}`;
    // Comments are found too. This search is already limited to decks the reader may open, so a comment is only ever found by someone who could read it.
    where.push(`(p.search @@ to_tsquery('english', ${q}) OR p.title ILIKE '%' || ${rawQ} || '%'
      OR EXISTS (SELECT 1 FROM slide_comments sc WHERE sc.presentation_id = p.id
                  AND to_tsvector('english'::regconfig, sc.body) @@ to_tsquery('english', ${q})))`);
    rankExpr = `ts_rank(p.search, to_tsquery('english', ${q}))`;
    snippetExpr = `ts_headline('english', p.search_text, to_tsquery('english', ${q}),
      'StartSel=<mark>, StopSel=</mark>, MaxWords=28, MinWords=10, ShortWord=2, MaxFragments=1')`;
  }
  if (input.from) {
    params.push(input.from);
    where.push(`p.updated_at >= $${params.length}::date`);
  }
  if (input.to) {
    params.push(input.to);
    where.push(`p.updated_at < ($${params.length}::date + interval '1 day')`);
  }

  const { rows } = await query<Omit<PresentationSearchHit, 'slide' | 'slideId' | 'inNotes'>>(
    `SELECT p.id, p.title, p.icon, p.updated_at AS "updatedAt",
            ${rankExpr} AS rank,
            ${snippetExpr} AS snippet
       FROM presentations p
      WHERE ${where.join(' AND ')}
      ORDER BY ${tsquery ? 'rank DESC, ' : ''}p.updated_at DESC
      LIMIT ${DECK_LIMIT}`,
    params,
  );
  const patterns = input.q ? termPatterns(input.q) : [];
  return Promise.all(
    rows.map(async (row, index) => {
      // Naming the slide means reading the whole deck, so only the best few hits get one.
      const deck = patterns.length && index < LOCATE_LIMIT ? await loadDeck(row.id) : null;
      const found = deck ? locateInDeck(deck.slides, patterns) : null;
      return found ? { ...row, ...found } : { ...row, slide: null, slideId: null, inNotes: false };
    }),
  );
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
  reader: { userId: string; roleId: string },
  input: { q?: string; tags?: string[]; folderId?: string; includeArchived?: boolean },
  tsquery: string | null,
) {
  if (input.tags?.length || input.folderId || !input.q) return [];
  const params: unknown[] = [workspaceId, reader.userId, reader.roleId, input.q, tsquery];
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

/**
 * Schedules that match, by name or description, among those the reader may
 * see. Like work items, they have no folders or tags.
 */
async function searchSchedules(
  workspaceId: string,
  reader: { userId: string; roleId: string },
  input: { q?: string; tags?: string[]; folderId?: string },
) {
  if (input.tags?.length || input.folderId || !input.q) return [];
  const { rows } = await query(
    `SELECT s.id, s.name, s.description, s.color, s.time_zone AS "timeZone"
       FROM schedules s
      WHERE s.workspace_id = $1
        AND ${scheduleLevelSql('$2', '$3')} > 0
        AND (s.name ILIKE '%' || $4 || '%' OR s.description ILIKE '%' || $4 || '%')
      ORDER BY (s.name ILIKE $4 || '%') DESC, lower(s.name)
      LIMIT ${ITEM_LIMIT}`,
    [workspaceId, reader.userId, reader.roleId, input.q],
  );
  return rows;
}

export const searchRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  /**
   * Documents and spreadsheets for a picker, by title: what starts with what
   * was typed first, then what contains it, most recently touched first within
   * each. Nothing typed gives the most recently touched. Kept to titles, and
   * to what the reader may open in apps the workspace has on, so it is quick
   * enough to ask on every pause in typing, whatever the workspace holds.
   */
  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>(
    '/workspaces/:id/link-targets',
    async (req): Promise<LinkTargets> => {
      const { roleId } = await assertWorkspaceAccess(req, req.params.id);
      const input = parse(linkTargetsQuerySchema, req.query ?? {});
      const kinds = new Set((input.kinds ?? '').split(','));
      const limit = input.limit ?? 20;
      const [docsOn, sheetsOn, slidesOn] = await Promise.all([
        appEnabled(req.params.id, 'docs'),
        appEnabled(req.params.id, 'sheets'),
        appEnabled(req.params.id, 'slides'),
      ]);
      // Typed text is matched literally, not as a pattern.
      const q = input.q ? input.q.replace(/[\\%_]/g, (c) => `\\${c}`) : null;
      const params = [req.params.id, req.user!.id, roleId, q, limit];
      const match = (title: string) => `($4::text IS NULL OR ${title} ILIKE '%' || $4 || '%')`;
      const order = (title: string, touched: string) =>
        `($4::text IS NOT NULL AND ${title} ILIKE $4 || '%') DESC, ${touched} DESC`;

      const [documents, spreadsheets, presentations] = await Promise.all([
        docsOn && kinds.has('documents')
          ? query<LinkTargets['documents'][number]>(
              `SELECT d.id, d.title, d.icon, d.mode FROM documents d
                WHERE d.workspace_id = $1 AND d.archived_at IS NULL AND ${match('d.title')}
                  AND ${documentLevelSql('$2', '$3')} > 0
                ORDER BY ${order('d.title', 'd.updated_at')}
                LIMIT $5`,
              params,
            )
          : { rows: [] },
        sheetsOn && kinds.has('spreadsheets')
          ? query<LinkTargets['spreadsheets'][number]>(
              `SELECT s.id, s.title, s.icon FROM spreadsheets s
                WHERE s.workspace_id = $1 AND s.archived_at IS NULL AND ${match('s.title')}
                  AND ${spreadsheetLevelSql('$2', '$3')} > 0
                ORDER BY ${order('s.title', 's.updated_at')}
                LIMIT $5`,
              params,
            )
          : { rows: [] },
        slidesOn && kinds.has('presentations')
          ? query<NonNullable<LinkTargets['presentations']>[number]>(
              `SELECT p.id, p.title, p.icon FROM presentations p
                WHERE p.workspace_id = $1 AND p.archived_at IS NULL AND ${match('p.title')}
                  AND ${presentationLevelSql('$2', '$3')} > 0
                ORDER BY ${order('p.title', 'p.updated_at')}
                LIMIT $5`,
              params,
            )
          : { rows: [] },
      ]);
      return { documents: documents.rows, spreadsheets: spreadsheets.rows, presentations: presentations.rows };
    },
  );

  app.get<{ Params: { id: string }; Querystring: Record<string, string | string[]> }>(
    '/workspaces/:id/search',
    async (req) => {
      const { roleId } = await assertWorkspaceAccess(req, req.params.id);
      // Each half answers only for an app the workspace has on.
      const [docsOn, sheetsOn, slidesOn, projectsOn, schedulesOn] = await Promise.all([
        appEnabled(req.params.id, 'docs'),
        appEnabled(req.params.id, 'sheets'),
        appEnabled(req.params.id, 'slides'),
        appEnabled(req.params.id, 'projects'),
        appEnabled(req.params.id, 'schedules'),
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
      params.push(req.user!.id, roleId);
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
                d.updated_at AS "updatedAt",
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
        ? await searchSpreadsheets(req.params.id, { userId: req.user!.id, roleId }, input, tsquery)
        : [];
      const presentations = slidesOn
        ? await searchPresentations(req.params.id, { userId: req.user!.id, roleId }, input, tsquery)
        : [];
      const workItems = projectsOn
        ? await searchWorkItems(req.params.id, { userId: req.user!.id, roleId }, input, tsquery)
        : [];
      const schedules = schedulesOn ? await searchSchedules(req.params.id, { userId: req.user!.id, roleId }, input) : [];
      return { hits: rows, sheets, presentations, workItems, schedules, query: input.q ?? '' };
    },
  );
};
