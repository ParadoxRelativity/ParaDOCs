import type { FastifyRequest } from 'fastify';
import type { Role } from '@paradocs/shared';
import { query } from '../db/pool.js';
import { notFound, unauthorized } from './http.js';
import { assertWorkspaceAccess, workspaceRole } from '../plugins/session.js';

/**
 * Who may open a spreadsheet: the same question documents answer, asked of a
 * different table. Permissions belong to the workspace, so a spreadsheet has no
 * sharing model of its own to get out of step with the rest of the app.
 */
export async function assertSpreadsheetAccess(
  req: FastifyRequest,
  spreadsheetId: string,
  minimum: Role = 'viewer',
): Promise<{ workspaceId: string; role: Role }> {
  if (!req.user) throw unauthorized();
  const workspaceId = await workspaceOf(spreadsheetId);
  if (!workspaceId) throw notFound('Spreadsheet not found');
  const role = await assertWorkspaceAccess(req, workspaceId, minimum);
  return { workspaceId, role };
}

/** The same check without a request, for the collaboration handshake. */
export async function spreadsheetAccessForUser(
  userId: string,
  spreadsheetId: string,
): Promise<{ workspaceId: string; role: Role } | null> {
  const workspaceId = await workspaceOf(spreadsheetId);
  if (!workspaceId) return null;
  const role = await workspaceRole(userId, workspaceId);
  return role ? { workspaceId, role } : null;
}

async function workspaceOf(spreadsheetId: string): Promise<string | null> {
  // A malformed id would make Postgres raise on the uuid cast rather than
  // simply not match, which would surface as a 500 instead of a 404.
  if (!/^[0-9a-fA-F-]{36}$/.test(spreadsheetId)) return null;
  const { rows } = await query<{ workspace_id: string }>(
    'SELECT workspace_id FROM spreadsheets WHERE id = $1',
    [spreadsheetId],
  );
  return rows[0]?.workspace_id ?? null;
}
