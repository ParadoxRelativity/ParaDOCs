/** Shared domain types. The API returns these shapes verbatim. */

import type { DocumentMode } from './canvas.js';

export interface User {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

export type Role = 'owner' | 'admin' | 'editor' | 'viewer';

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  icon: string | null;
  createdAt: string;
}

export interface WorkspaceMember {
  userId: string;
  name: string;
  email: string;
  role: Role;
  joinedAt: string;
  /** True for the account making the request. */
  isSelf: boolean;
}

export interface WorkspaceInvite {
  id: string;
  workspaceId: string;
  email: string | null;
  role: Role;
  token: string;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
  invitedBy: string | null;
}

/** What an invitee sees before signing in to accept. */
export interface InvitePreview {
  workspaceName: string;
  workspaceIcon: string | null;
  role: Role;
  email: string | null;
  invitedBy: string | null;
  expiresAt: string;
  alreadyMember: boolean;
}

export interface Folder {
  id: string;
  workspaceId: string;
  parentId: string | null;
  name: string;
  /** Optional. Folders without one render no icon at all. */
  icon: string | null;
  position: number;
  createdAt: string;
}

/** A folder plus its children and the documents filed in it. */
export interface FolderNode extends Folder {
  children: FolderNode[];
  documents: DocumentSummary[];
}

export interface Tag {
  id: string;
  workspaceId: string;
  name: string;
  color: string;
  documentCount?: number;
}

export interface DocumentSummary {
  id: string;
  mode: DocumentMode;
  workspaceId: string;
  folderId: string | null;
  title: string;
  icon: string | null;
  isJournal: boolean;
  journalDate: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  tags: Tag[];
}

/**
 * `body` is the canonical BlockNote document (an array of blocks).
 * `bodyMd` is derived from it on every save and is what search and export read.
 */
export interface Doc extends DocumentSummary {
  body: unknown[];
  bodyMd: string;
  properties: Record<string, DocumentPropertyValue>;
  /** Who created the document. Null if that account has since been deleted. */
  owner: Pick<User, 'id' | 'name' | 'email'> | null;
}

export type DocumentPropertyValue = string | number | boolean | null;

export interface SearchHit {
  id: string;
  title: string;
  mode: DocumentMode;
  icon: string | null;
  folderId: string | null;
  folderPath: string[];
  updatedAt: string;
  isJournal: boolean;
  /** Highlighted snippet from the document body, with <mark> around matches. */
  snippet: string;
  rank: number;
  tags: Tag[];
}

export interface Comment {
  id: string;
  documentId: string;
  parentId: string | null;
  blockId: string | null;
  body: string;
  resolved: boolean;
  createdAt: string;
  updatedAt: string;
  author: Pick<User, 'id' | 'name' | 'email'>;
  replies?: Comment[];
}

export interface CalendarEvent {
  id: string;
  workspaceId: string;
  documentId: string | null;
  title: string;
  description: string | null;
  startAt: string;
  endAt: string | null;
  allDay: boolean;
  color: string;
  createdAt: string;
}

/** Documents created or updated on a given day, used to dot the calendar. */
export interface ActivityDay {
  day: string;
  created: number;
  updated: number;
  hasJournal: boolean;
}
