/**
 * Projects: tracking work.
 *
 * A workspace has any number of projects and queues. Both hold work items and
 * both are set up the same way — each has statuses of its own, and roles of its
 * own that people take on an item (assignee, reviewer, reporter, or whatever
 * the project calls them). What differs is how the work arrives and is shown:
 * a project is planned and laid out on a board, a queue is taken in and worked
 * through in order, oldest first.
 *
 * Every status belongs to one of four categories. The names are the
 * project's to choose; the category is what the app itself understands, so
 * "Shipped" and "Resolved" both count as finished without anyone telling it so.
 *
 * The backlog is work nobody has queued to start. It is kept off the board and
 * out of workload, in a ranked list of its own, so a project with hundreds of
 * ideas and requests still has a board showing only what is actually planned.
 *
 * Work items are referenced from elsewhere by id, the way documents and
 * spreadsheets are: `<item:uuid>` in chat, in canvas text and in other work
 * items, and an inline `workItem` node in a document. What a reference shows —
 * key, title, status — is looked up when it is drawn, so it never goes stale.
 */

import { z } from 'zod';
import { parseMessage, type MessageAuthor, type MessageReferences } from './chat.js';
import type { CanvasElement } from './canvas.js';
import { canvasTextOf, walkInlineNodes } from './mentions.js';
import type { AccessMode, NotificationWorkspace, Permission } from './types.js';

export type ProjectKind = 'project' | 'queue';

/** What a status means, whatever it is called. */
export type StatusCategory = 'backlog' | 'todo' | 'active' | 'done';

export const STATUS_CATEGORIES: StatusCategory[] = ['backlog', 'todo', 'active', 'done'];

export const STATUS_CATEGORY_LABELS: Record<StatusCategory, string> = {
  backlog: 'Backlog',
  todo: 'Not started',
  active: 'In progress',
  done: 'Done',
};

export type WorkItemType = 'task' | 'bug' | 'story' | 'epic' | 'request';
export const WORK_ITEM_TYPES: WorkItemType[] = ['task', 'bug', 'story', 'epic', 'request'];

export type WorkItemPriority = 'none' | 'low' | 'medium' | 'high' | 'urgent';
/** Highest first, the order a list sorted by priority reads in. */
export const WORK_ITEM_PRIORITIES: WorkItemPriority[] = ['urgent', 'high', 'medium', 'low', 'none'];

/** Colours offered for a status. */
export const STATUS_COLORS = ['#8f8f9c', '#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6'];

export interface ProjectStatus {
  id: string;
  name: string;
  category: StatusCategory;
  color: string;
  /** Fractional, so a status can be dropped between two others. */
  position: number;
}

export interface ProjectRole {
  id: string;
  name: string;
  /** Whether several people can hold it on one item, as reviewers can. */
  multiple: boolean;
  position: number;
}

/** A project as a list shows it. */
export interface ProjectSummary {
  id: string;
  workspaceId: string;
  kind: ProjectKind;
  /** Short and uppercase; every item's key starts with it. */
  key: string;
  name: string;
  description: string;
  icon: string | null;
  /** A project has no folder, so like a channel it never inherits. */
  access: Exclude<AccessMode, 'inherit'>;
  /** What the signed-in person may do with it: `view` or `edit`. */
  permission: Permission;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  /** Items not in a done status. */
  openCount: number;
  itemCount: number;
}

/** A project with how it is set up. */
export interface Project extends ProjectSummary {
  /** In board order. */
  statuses: ProjectStatus[];
  /** In the order an item lists them. */
  roles: ProjectRole[];
  /** Deleting is for owners, admins, and whoever made the project. */
  canDelete: boolean;
}

export interface WorkItemSummary {
  id: string;
  projectId: string;
  number: number;
  /** `ENG-12`. Follows the project's key if that changes. */
  key: string;
  title: string;
  type: WorkItemType;
  priority: WorkItemPriority;
  statusId: string;
  /** Order within its status, fractional like a status's. */
  position: number;
  /** YYYY-MM-DD. */
  dueDate: string | null;
  /** In whatever unit the team estimates in: points, hours, days. */
  estimate: number | null;
  /** Who holds each role, keyed by role id. Roles nobody holds are left out. */
  roles: Record<string, string[]>;
  commentCount: number;
  createdAt: string;
  updatedAt: string;
  /** When it last moved into a done status. Null while it is open. */
  completedAt: string | null;
}

/** One work item, opened. */
export interface WorkItem extends WorkItemSummary {
  /** Plain text with reference tokens, as a chat message is written. */
  description: string;
  createdBy: MessageAuthor | null;
  /** What the description points at. */
  references: MessageReferences;
}

/** A work item listed outside its project, such as under "My work". */
export interface WorkItemListing extends WorkItemSummary {
  project: Pick<ProjectSummary, 'id' | 'key' | 'name' | 'icon' | 'kind'>;
  status: ProjectStatus;
  /** The roles the signed-in person holds on it, by name. */
  myRoles: string[];
}

export interface WorkItemComment {
  id: string;
  body: string;
  author: MessageAuthor | null;
  createdAt: string;
  editedAt: string | null;
}

/** Something that happened to a work item, told in its history beside the comments. */
export type WorkItemActivityData =
  | { kind: 'created' }
  | { kind: 'status'; from: string; to: string }
  | { kind: 'role'; role: string; added: string[]; removed: string[] }
  | { kind: 'priority'; from: WorkItemPriority; to: WorkItemPriority }
  | { kind: 'title'; from: string; to: string };

export type WorkItemActivity = {
  id: string;
  actor: MessageAuthor | null;
  createdAt: string;
} & WorkItemActivityData;

export interface WorkItemTimeline {
  comments: WorkItemComment[];
  activity: WorkItemActivity[];
  /** What the comments point at, and the people named in the history. */
  references: MessageReferences;
}

/** Where a work item is mentioned, for those the reader may see. */
export interface WorkItemBacklinks {
  documents: { id: string; title: string; icon: string | null; mode: 'page' | 'canvas' }[];
  /** A direct conversation has no name; it is listed only to the people in it. */
  channels: { id: string; name: string; kind: 'text' | 'direct'; mentions: number; latestAt: string }[];
  workItems: { id: string; projectId: string; key: string; title: string }[];
}

/** A work item that wants the signed-in person's attention. */
export interface WorkItemNotification {
  workItemId: string;
  projectId: string;
  key: string;
  title: string;
  /** Given a role on it, or named in its description or a comment. */
  reason: 'role' | 'mention';
  /** For a role, which one. */
  role: string | null;
  workspace: NotificationWorkspace;
  by: { id: string; name: string; avatarUrl: string | null } | null;
  createdAt: string;
}

/** Where a work item opens in the app. */
export function workItemPath(workspaceId: string, projectId: string, itemId: string): string {
  return `/w/${workspaceId}/p/${projectId}/${itemId}`;
}

// --- references in documents and canvases ------------------------------------

/**
 * A work item in the middle of a sentence. `label` is what it was called when
 * it was inserted, shown where the item cannot be looked up and written into
 * the markdown a document derives for search.
 */
export const WORK_ITEM_INLINE = {
  type: 'workItem',
  propSchema: {
    itemId: { default: '' },
    label: { default: '' },
  },
  content: 'none',
} as const;

/** Every work item a document body points at. */
export function blockWorkItems(blocks: unknown): string[] {
  const found = new Set<string>();
  walkInlineNodes(blocks, (node) => {
    const id = node.type === WORK_ITEM_INLINE.type ? node.props?.itemId : undefined;
    if (typeof id === 'string' && id) found.add(id.toLowerCase());
  });
  return [...found];
}

/** Every work item on a canvas: its cards, and tokens in its text. */
export function canvasWorkItems(elements: CanvasElement[]): string[] {
  const found = new Set<string>();
  for (const element of elements) {
    if (element.type === 'workItem' && element.itemId) found.add(element.itemId.toLowerCase());
    for (const text of canvasTextOf(element)) {
      if (!text.includes('<item:')) continue;
      for (const segment of parseMessage(text)) if (segment.type === 'workItem') found.add(segment.id);
    }
  }
  return [...found];
}

/** Every work item a batch of message-style bodies points at. */
export function textWorkItems(bodies: string[]): string[] {
  const found = new Set<string>();
  for (const body of bodies) {
    if (!body.includes('<item:')) continue;
    for (const segment of parseMessage(body)) if (segment.type === 'workItem') found.add(segment.id);
  }
  return [...found];
}

/** Everyone named in a batch of message-style bodies. */
export function textMembers(bodies: string[]): string[] {
  const found = new Set<string>();
  for (const body of bodies) {
    if (!body.includes('<@')) continue;
    for (const segment of parseMessage(body)) if (segment.type === 'member') found.add(segment.id);
  }
  return [...found];
}

// --- input ---------------------------------------------------------------------

const uuid = z.string().uuid();
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a #rrggbb hex color');

/** Letters and digits, starting with a letter: what goes before the number in `ENG-12`. */
export const projectKeySchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .refine((value) => /^[A-Z][A-Z0-9]{1,9}$/.test(value), 'A key is 2 to 10 letters or digits, starting with a letter');

/** A key suggested from a name: its initials, or the start of a one-word name. */
export function suggestProjectKey(name: string): string {
  const words = name
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const letters = words.length > 1 ? words.map((word) => word[0]).join('') : (words[0] ?? '').slice(0, 4);
  const key = letters.replace(/^[0-9]+/, '').slice(0, 10);
  return key.length >= 2 ? key : `${key}PRJ`.slice(0, 3);
}

export const statusCategorySchema = z.enum(['backlog', 'todo', 'active', 'done']);
export const workItemTypeSchema = z.enum(['task', 'bug', 'story', 'epic', 'request']);
export const workItemPrioritySchema = z.enum(['none', 'low', 'medium', 'high', 'urgent']);

export const createProjectSchema = z.object({
  name: z.string().trim().min(1, 'Name it').max(80),
  key: projectKeySchema,
  kind: z.enum(['project', 'queue']).default('project'),
  description: z.string().max(4000).default(''),
  icon: z.string().trim().max(8).nullish(),
});

export const updateProjectSchema = z.object({
  name: z.string().trim().min(1, 'Name it').max(80).optional(),
  key: projectKeySchema.optional(),
  description: z.string().max(4000).optional(),
  icon: z.string().trim().max(8).nullish(),
  archived: z.boolean().optional(),
});

export const createStatusSchema = z.object({
  name: z.string().trim().min(1, 'Name the status').max(40),
  category: statusCategorySchema.default('todo'),
  color: hexColor.optional(),
});

export const updateStatusSchema = z.object({
  name: z.string().trim().min(1, 'Name the status').max(40).optional(),
  category: statusCategorySchema.optional(),
  color: hexColor.optional(),
  position: z.number().finite().optional(),
});

export const deleteStatusSchema = z.object({
  /** Where the items in it go. Required when it has any. */
  moveTo: uuid.optional(),
});

export const createRoleSchema = z.object({
  name: z.string().trim().min(1, 'Name the role').max(40),
  multiple: z.boolean().default(false),
});

export const updateRoleSchema = z.object({
  name: z.string().trim().min(1, 'Name the role').max(40).optional(),
  multiple: z.boolean().optional(),
  position: z.number().finite().optional(),
});

export const MAX_ROLE_HOLDERS = 20;

const estimateSchema = z.number().finite().min(0).max(100_000);

export const createWorkItemSchema = z.object({
  title: z.string().trim().min(1, 'Give it a title').max(300),
  description: z.string().max(20_000).default(''),
  type: workItemTypeSchema.default('task'),
  priority: workItemPrioritySchema.default('none'),
  /** The project's first status when left out. */
  statusId: uuid.optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD').nullish(),
  estimate: estimateSchema.nullish(),
  /** Who holds which role from the start, keyed by role id. */
  roles: z.record(uuid, z.array(uuid).max(MAX_ROLE_HOLDERS)).optional(),
});

export const updateWorkItemSchema = z.object({
  title: z.string().trim().min(1, 'Give it a title').max(300).optional(),
  description: z.string().max(20_000).optional(),
  type: workItemTypeSchema.optional(),
  priority: workItemPrioritySchema.optional(),
  statusId: uuid.optional(),
  /** Pass null to clear. */
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD').nullish(),
  estimate: estimateSchema.nullish(),
  position: z.number().finite().optional(),
});

/** Moving many items at once, such as from the backlog onto the board. */
export const moveWorkItemsSchema = z.object({
  itemIds: z.array(uuid).min(1).max(500),
  statusId: uuid,
});

export const setWorkItemRoleSchema = z.object({
  userIds: z.array(uuid).max(MAX_ROLE_HOLDERS),
});

export const workItemCommentSchema = z.object({
  body: z.string().trim().min(1, 'Write something first').max(10_000),
});

export const resolveWorkItemsSchema = z.object({
  ids: z.array(uuid).max(300),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
export type CreateWorkItemInput = z.input<typeof createWorkItemSchema>;
export type UpdateWorkItemInput = z.infer<typeof updateWorkItemSchema>;
