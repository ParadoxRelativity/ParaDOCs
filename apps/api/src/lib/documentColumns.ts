import { documentLevelSql, permissionSql, spreadsheetLevelSql } from './access.js';

/**
 * The column list every document read shares, so the wire shape stays
 * consistent. It lives here rather than in one route because the sidebar tree
 * and the flat listing both need it, and a hand-copied second list silently
 * drifted once already — the tree stopped returning `mode`, which made every
 * canvas show a page icon.
 *
 * Queries using this must alias the documents table as `d`. `user` and `role`
 * are SQL for the reader and their role in the document's workspace, which
 * decide what `permission` says they may do.
 */
export function documentSummaryColumns(user: string, role: string): string {
  return `
  d.id, d.workspace_id AS "workspaceId", d.folder_id AS "folderId", d.title, d.icon, d.mode,
  d.archived_at AS "archivedAt", d.created_at AS "createdAt", d.updated_at AS "updatedAt",
  d.access, ${permissionSql(documentLevelSql(user, role))} AS permission,
  COALESCE(
    (SELECT json_agg(json_build_object('id', t.id, 'workspaceId', t.workspace_id,
                                       'name', t.name, 'color', t.color) ORDER BY t.name)
       FROM document_tags dt JOIN tags t ON t.id = dt.tag_id
      WHERE dt.document_id = d.id),
    '[]'::json) AS tags`;
}

/**
 * The same for a spreadsheet, whose table must be aliased `s`. Shared by the
 * spreadsheet routes and the Sheets tree.
 */
export function spreadsheetSummaryColumns(user: string, role: string): string {
  return `
  s.id, s.workspace_id AS "workspaceId", s.folder_id AS "folderId", s.title, s.icon,
  s.created_at AS "createdAt", s.updated_at AS "updatedAt", s.archived_at AS "archivedAt",
  s.access, ${permissionSql(spreadsheetLevelSql(user, role))} AS permission`;
}
