/** Shared domain types. The API returns these shapes verbatim. */

import type { DocumentMode } from './canvas.js';
import type { ReleaseInfo } from './version.js';

export interface User {
  id: string;
  email: string;
  name: string;
  /** Served path of the profile picture. Null draws a lettered avatar. */
  avatarUrl: string | null;
  createdAt: string;
}

export type Role = 'owner' | 'admin' | 'editor' | 'viewer';

/**
 * Who can reach a folder, document or channel. `open` is everyone in the
 * workspace, `allow` only the teams and people listed, and `deny` everyone
 * except them. Folders and documents may `inherit` the setting of the nearest
 * folder above them that has one of its own; the nearest setting wins. Owners
 * and admins are never kept out.
 */
export type AccessMode = 'inherit' | 'open' | 'allow' | 'deny';

/** What someone may do with a folder, document or channel. */
export type Permission = 'none' | 'view' | 'edit';

/** A named group of members, so access can be given to several people at once. */
export interface Team {
  id: string;
  workspaceId: string;
  name: string;
  memberIds: string[];
  createdAt: string;
}

/** One line of an allow or deny list. */
export interface AccessEntry {
  subject:
    | { kind: 'team'; id: string; name: string }
    | { kind: 'user'; id: string; name: string; avatarUrl: string | null };
  /**
   * On an allow list, `view` or `edit`. On a deny list, `none` or `view`: a
   * deny list only ever takes access away.
   */
  permission: Permission;
}

/** Who can reach one folder, document or channel, as owners and admins manage it. */
export interface AccessSettings {
  access: AccessMode;
  entries: AccessEntry[];
  /**
   * For something that inherits, the folder whose setting applies to it. Null
   * when no folder above it has one, which means it is open.
   */
  inheritedFrom: { id: string; name: string; access: AccessMode } | null;
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  icon: string | null;
  /** Served path of the workspace picture, which takes the place of the icon. */
  avatarUrl: string | null;
  createdAt: string;
}

export interface WorkspaceMember {
  userId: string;
  name: string;
  email: string;
  avatarUrl: string | null;
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
  workspaceAvatarUrl: string | null;
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
  /** Its own setting; see AccessMode. */
  access: AccessMode;
  /**
   * What the signed-in person may do in it. `none` for a folder shown only
   * because something inside it is visible to them.
   */
  permission: Permission;
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
  /** Its own setting; see AccessMode. */
  access: AccessMode;
  /** What the signed-in person may do with it: `view` or `edit`. */
  permission: Permission;
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

/**
 * A spreadsheet that matched a search. Kept apart from SearchHit rather than
 * folded into it: a spreadsheet has no folder, tags or mode, and giving every
 * document hit an optional version of each would make both harder to read.
 */
export interface SheetSearchHit {
  id: string;
  title: string;
  icon: string | null;
  updatedAt: string;
  /** Highlighted snippet from the cells, with <mark> around matches. */
  snippet: string;
  rank: number;
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
  author: Pick<User, 'id' | 'name' | 'email' | 'avatarUrl'>;
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

/** A workspace as a notification names it. */
export interface NotificationWorkspace {
  id: string;
  name: string;
  icon: string | null;
  avatarUrl: string | null;
}

/** An invitation addressed to your email that you have not answered yet. */
export interface InviteNotification {
  id: string;
  token: string;
  role: Role;
  invitedBy: string | null;
  createdAt: string;
  expiresAt: string;
  workspace: NotificationWorkspace;
}

/** A channel with messages you have not read, summarised by the newest one. */
export interface MessageNotification {
  channelId: string;
  /** For a direct conversation, the other person's name. */
  channelName: string;
  /** A direct conversation: every message in it is addressed to you. */
  direct: boolean;
  workspace: NotificationWorkspace;
  unread: number;
  /** How many of the unread messages name you. */
  mentions: number;
  latest: {
    id: string;
    /** Plain text, with references resolved to names. */
    preview: string;
    createdAt: string;
    author: { id: string; name: string; avatarUrl: string | null } | null;
  };
}

/**
 * A document or canvas where someone tagged you by name. One per document,
 * however many times your name appears in it.
 */
export interface MentionNotification {
  documentId: string;
  title: string;
  mode: DocumentMode;
  workspace: NotificationWorkspace;
  /** Who was editing when the tag appeared. Null if that account is gone. */
  taggedBy: { id: string; name: string; avatarUrl: string | null } | null;
  createdAt: string;
}

/**
 * A newer release than the server is running. Only server administrators are
 * told, since only they can do anything about it.
 */
export interface ServerUpdateNotification {
  currentVersion: string;
  release: ReleaseInfo;
}

/** Everything on a server that wants the signed-in person's attention. */
export interface Notifications {
  invites: InviteNotification[];
  messages: MessageNotification[];
  mentions: MentionNotification[];
  /** Null when there is none, or for anyone but a server administrator. Absent from older servers. */
  serverUpdate?: ServerUpdateNotification | null;
}
