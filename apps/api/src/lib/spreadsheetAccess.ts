import type { Role } from '@paradocs/shared';
import { spreadsheetAccess } from './access.js';

/**
 * Who may open a spreadsheet, without a request, for the collaboration
 * handshake and for resolving references. The same rules as a document: the
 * workspace role, then any lock on the spreadsheet or the folders above it.
 * Routes use `assertSpreadsheetAccess` in access.ts.
 */
export async function spreadsheetAccessForUser(
  userId: string,
  spreadsheetId: string,
): Promise<{ workspaceId: string; role: Role; canEdit: boolean } | null> {
  const access = await spreadsheetAccess(userId, spreadsheetId);
  return access ? { workspaceId: access.workspaceId, role: access.role, canEdit: access.level === 2 } : null;
}
