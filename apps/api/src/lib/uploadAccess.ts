import { query } from '../db/pool.js';
import { UUID, documentAccess, workItemAccess } from './access.js';
import { channelAccessFor } from './channels.js';

/**
 * Whether someone may read an uploaded file, judged from where it is stored.
 *
 * A file's address is unguessable, but an address gets copied, forwarded and
 * kept long after whoever had it lost access to what it belongs to. So a file
 * is served only to those who may see what it was shared in:
 *
 * - `avatars/…` — profile and workspace pictures. Anyone, signed in or not:
 *   the invitation page shows a workspace's picture before its reader has an
 *   account, and nothing about a picture is private to a workspace.
 * - `chat/<channel>/…` — whoever can read the channel or conversation.
 * - `work-items/<item>/…` — whoever can see the work item.
 * - `<workspace>/…` — a document's or canvas's file, for whoever can see that
 *   document; one belonging to no document, for anyone in the workspace.
 *
 * Anything else, or anything malformed, is refused.
 */
export async function mayReadUpload(userId: string | null, storageKey: string): Promise<boolean> {
  const parts = storageKey.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..' || part.includes('\\'))) return false;

  if (parts[0] === 'avatars') return true;
  if (!userId) return false;

  if (parts[0] === 'chat') {
    return parts.length === 3 && (await channelAccessFor(userId, parts[1])) !== null;
  }

  if (parts[0] === 'work-items') {
    return parts.length === 3 && (await workItemAccess(userId, parts[1])) !== null;
  }

  const [workspaceId] = parts;
  if (parts.length !== 2 || !UUID.test(workspaceId)) return false;
  const { rows } = await query<{ document_id: string | null }>(
    'SELECT document_id FROM attachments WHERE storage_key = $1 AND workspace_id = $2',
    [storageKey, workspaceId],
  );
  const documentId = rows[0]?.document_id;
  if (documentId) return (await documentAccess(userId, documentId)) !== null;
  const { rows: member } = await query('SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [
    workspaceId,
    userId,
  ]);
  return member.length > 0;
}
