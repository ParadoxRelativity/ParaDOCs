import type { Role } from '@paradocs/shared';
import { presentationAccess } from './access.js';

/**
 * Who may open a presentation, without a request, for the collaboration
 * handshake and for server-side reads. The same rules as a document: the
 * workspace role, then any lock on the presentation or the folders above it.
 */
export async function presentationAccessForUser(
  userId: string,
  presentationId: string,
): Promise<{ workspaceId: string; role: Role; canEdit: boolean } | null> {
  const access = await presentationAccess(userId, presentationId);
  return access ? { workspaceId: access.workspaceId, role: access.role, canEdit: access.level === 2 } : null;
}
