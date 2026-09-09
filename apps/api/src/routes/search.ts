import type { FastifyPluginAsync } from 'fastify';
import { searchQuerySchema } from '@paradocs/shared';
import { query } from '../db/pool.js';
import { parse } from '../lib/http.js';
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

export const searchRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  app.get<{ Params: { id: string }; Querystring: Record<string, string | string[]> }>(
    '/workspaces/:id/search',
    async (req) => {
      await assertWorkspaceAccess(req, req.params.id);
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

      const rankExpr = tsquery ? `ts_rank(d.search, to_tsquery('english', $2))` : '0';
      const snippetExpr = tsquery
        ? `ts_headline('english', d.body_md, to_tsquery('english', $2),
             'StartSel=<mark>, StopSel=</mark>, MaxWords=28, MinWords=10, ShortWord=2, MaxFragments=1')`
        : `left(d.body_md, 180)`;

      params.push(input.limit, input.offset);
      const limitParam = `$${params.length - 1}`;
      const offsetParam = `$${params.length}`;

      const { rows } = await query(
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

      return { hits: rows, query: input.q ?? '' };
    },
  );
};
