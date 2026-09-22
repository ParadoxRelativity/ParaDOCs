import type { FolderApp } from '@paradocs/shared';
import { publishToWorkspace } from '../chat/hub.js';

/**
 * Tells everyone with the workspace open that its Docs or Sheets tree changed —
 * something created, renamed, moved, archived or deleted — so their sidebars
 * and listings pick it up without a reload.
 */
export function treeChanged(workspaceId: string, app: FolderApp): void {
  publishToWorkspace(workspaceId, { type: 'tree.changed', workspaceId, app });
}
