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
 * A project can run its board in sprints. It is an option, off to begin with:
 * with it on, the board shows only the running sprint's work, and the backlog
 * becomes where the sprints after it are planned. See `ProjectSprint`.
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

/**
 * A named set of the moves a work item may make between statuses: for each
 * status, the ones an item sitting in it may go to next. It is what says how
 * work leaves the backlog, since a backlog status's moves are the board
 * statuses an item may enter at.
 *
 * Which workflow an item follows is decided by its type, so a bug can take a
 * different route through the board than a story. A type no workflow is set
 * for moves freely, which is how every project starts.
 */
export interface ProjectWorkflow {
  id: string;
  name: string;
  position: number;
  /** The statuses reachable from each status, keyed by the status moved from. */
  transitions: Record<string, string[]>;
}

/**
 * One column's worth of cards on the board. Usually a single status; several
 * means those statuses are merged and their work is shown as one list, for
 * stages a team tracks separately but reads as one — "In review" beside
 * "Awaiting QA" when what matters is that it has left development.
 */
export interface BoardCell {
  /** At least one. In the order a merged cell offers them to a card dropped in. */
  statusIds: string[];
  /** What a merged cell is called. Null: its statuses' names, joined. */
  name: string | null;
}

/**
 * A slot across the board: one cell, or several stacked over and under each
 * other, so two narrow stages take up one column's width between them.
 */
export interface BoardLane {
  cells: BoardCell[];
}

/**
 * How a project's board is laid out, over and above the order its statuses are
 * in. Everyone on the project sees the same arrangement; which lanes are folded
 * up is each viewer's own business and is not kept here.
 *
 * It is stored as a wish rather than a rule: statuses it does not mention get
 * lanes of their own, and ones it names that have since been deleted or moved
 * to the backlog are ignored. That way a layout never hides work, and a project
 * that has never been arranged needs no layout stored at all.
 */
export interface BoardLayout {
  lanes: BoardLane[];
}

export const EMPTY_BOARD_LAYOUT: BoardLayout = { lanes: [] };

export type SprintState = 'planned' | 'active' | 'completed';

/**
 * A stretch of time a project's team commits a set of work to. It is planned,
 * then running — only one at a time — then complete. Which items are in it is
 * each item's `sprintId`; a completed sprint keeps what was finished in it.
 */
export interface ProjectSprint {
  id: string;
  name: string;
  /** What the sprint is for, in a sentence. Empty when nobody said. */
  goal: string;
  state: SprintState;
  /** YYYY-MM-DD, planned. Either may be open until the sprint starts. */
  startDate: string | null;
  endDate: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface ProjectRole {
  id: string;
  name: string;
  /** Whether several people can hold it on one item, as reviewers can. */
  multiple: boolean;
  /**
   * Whether a name can be typed into it as well as a member chosen, for
   * whoever the item is about but has no account here — a queue's customer.
   */
  freeForm: boolean;
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
  /** What routes through the board the project offers. Empty until one is made. */
  workflows: ProjectWorkflow[];
  /** The workflow each item type follows, by workflow id. A type left out moves freely. */
  typeWorkflows: Partial<Record<WorkItemType, string>>;
  /** How the board's columns are arranged. Empty lanes: one per status, in order. */
  boardLayout: BoardLayout;
  /** Whether the board is run in sprints. Always false for a queue. */
  sprintsEnabled: boolean;
  /** Running first, then planned in the order they were made, then completed, newest first. */
  sprints: ProjectSprint[];
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
  /** The sprint it is in, if the project runs in sprints and it has been put in one. */
  sprintId: string | null;
  /** YYYY-MM-DD. */
  dueDate: string | null;
  /** In whatever unit the team estimates in: points, hours, days. */
  estimate: number | null;
  /** Who holds each role, keyed by role id. Roles nobody holds are left out. */
  roles: Record<string, string[]>;
  /**
   * The names typed into each free-form role, keyed by role id, alongside
   * whatever members `roles` gives it. Roles with none are left out.
   */
  roleNames: Record<string, string[]>;
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
  | { kind: 'title'; from: string; to: string }
  /** Sprint names as they were at the time; null is the backlog. */
  | { kind: 'sprint'; from: string | null; to: string | null };

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

// --- workflows ---------------------------------------------------------------

/** The workflow an item of this type follows here, or null when none is set. */
export function workflowForType(
  project: Pick<Project, 'workflows' | 'typeWorkflows'>,
  type: WorkItemType,
): ProjectWorkflow | null {
  const id = project.typeWorkflows[type];
  return (id && project.workflows.find((w) => w.id === id)) || null;
}

/**
 * The statuses an item of this type may move to from where it is, or null when
 * nothing constrains it — no workflow for its type. Null and an empty array
 * mean opposite things, so callers must tell them apart: nowhere to go is a
 * dead end, no workflow is anywhere.
 */
export function allowedMoves(
  project: Pick<Project, 'workflows' | 'typeWorkflows'>,
  type: WorkItemType,
  fromStatusId: string,
): string[] | null {
  const workflow = workflowForType(project, type);
  return workflow ? (workflow.transitions[fromStatusId] ?? []) : null;
}

/**
 * Whether a workflow lets an item of this type make this move. Staying put is
 * always allowed: reordering within a status is not a move.
 */
export function canMoveTo(
  project: Pick<Project, 'workflows' | 'typeWorkflows'>,
  type: WorkItemType,
  fromStatusId: string,
  toStatusId: string,
): boolean {
  if (fromStatusId === toStatusId) return true;
  const allowed = allowedMoves(project, type, fromStatusId);
  return allowed === null || allowed.includes(toStatusId);
}

// --- board layout ------------------------------------------------------------

/** A cell with its statuses looked up, and a name to put at the top of it. */
export interface BoardCellView {
  /** Identifies the cell across a redraw, and is what a collapsed cell is remembered by. */
  key: string;
  name: string;
  /** Whether the name was chosen for the merge, rather than derived from its statuses. */
  named: boolean;
  statuses: ProjectStatus[];
  /** Whether it holds more than one status, so cards need to say which they are in. */
  merged: boolean;
}

/** A lane with its cells looked up, in the order they are stacked. */
export interface BoardLaneView {
  /** Its first status: stable while the lane is merged, split or moved. */
  key: string;
  /** All the statuses in it, whatever cell they are in. */
  statuses: ProjectStatus[];
  cells: BoardCellView[];
}

/** What a merged cell is called when it has not been named: its statuses, joined. */
function joinedName(statuses: ProjectStatus[]): string {
  return statuses.map((s) => s.name).join(' · ');
}

/**
 * The board's columns as they should be drawn: the stored layout reconciled
 * with the statuses the project actually has now.
 *
 * Statuses the layout does not mention get a lane each, after the ones it does,
 * so a status added since it was arranged still turns up on the board. Ones it
 * names that are gone, or have been moved to the backlog, drop out, along with
 * any cell or lane left empty. A status named twice is kept where it is named
 * first, since it can only be in one place.
 */
export function boardLanes(project: Pick<Project, 'statuses' | 'boardLayout'>): BoardLaneView[] {
  const onBoard = project.statuses.filter((s) => s.category !== 'backlog');
  const byId = new Map(onBoard.map((s) => [s.id, s]));
  const placed = new Set<string>();

  const lanes: BoardLaneView[] = [];
  for (const lane of project.boardLayout?.lanes ?? []) {
    const cells: BoardCellView[] = [];
    for (const cell of lane.cells ?? []) {
      const statuses: ProjectStatus[] = [];
      for (const id of cell.statusIds ?? []) {
        const status = byId.get(id);
        if (status && !placed.has(id)) {
          placed.add(id);
          statuses.push(status);
        }
      }
      if (statuses.length === 0) continue;
      const named = statuses.length > 1 && !!cell.name;
      cells.push({
        key: statuses.map((s) => s.id).join('+'),
        name: named ? cell.name! : joinedName(statuses),
        named,
        statuses,
        merged: statuses.length > 1,
      });
    }
    if (cells.length > 0) lanes.push({ key: cells[0].statuses[0].id, statuses: cells.flatMap((c) => c.statuses), cells });
  }

  for (const status of onBoard) {
    if (placed.has(status.id)) continue;
    lanes.push({
      key: status.id,
      statuses: [status],
      cells: [{ key: status.id, name: status.name, named: false, statuses: [status], merged: false }],
    });
  }
  return lanes;
}

/** The lanes as they would be stored: what an edit is made against and saved back. */
export function layoutOf(lanes: BoardLaneView[]): BoardLayout {
  return {
    lanes: lanes.map((lane) => ({
      cells: lane.cells.map((cell) => ({
        statusIds: cell.statuses.map((s) => s.id),
        // A name is only worth keeping when someone chose it; a derived one
        // would go stale the moment a status in it is renamed.
        name: cell.named ? cell.name : null,
      })),
    })),
  };
}

/**
 * Every status in this cell that a card could be dropped into, in the cell's
 * own order. A merged column can offer several, since a workflow may allow the
 * card into more than one of the statuses behind it — and staying where it is
 * always counts, so a card already in the column offers that status too.
 *
 * More than one means the drop is ambiguous and the board has to ask rather
 * than choose: it draws a box per status over the column and the card takes
 * whichever it is dropped in. Empty means the column cannot take the card.
 */
export function cellTargets(
  project: Pick<Project, 'workflows' | 'typeWorkflows'>,
  cell: Pick<BoardCellView, 'statuses'>,
  item: Pick<WorkItemSummary, 'type' | 'statusId'>,
): ProjectStatus[] {
  return cell.statuses.filter((status) => canMoveTo(project, item.type, item.statusId, status.id));
}

/**
 * Where a card dropped on this cell lands when nothing has picked a status: the
 * first one the cell offers, or null when it offers none. Callers that can ask
 * — the board, which draws a box per status — should use `cellTargets` and let
 * the drop say which, since the first is only a guess when there are several.
 */
export function cellTarget(
  project: Pick<Project, 'workflows' | 'typeWorkflows'>,
  cell: Pick<BoardCellView, 'statuses'>,
  item: Pick<WorkItemSummary, 'type' | 'statusId'>,
): string | null {
  const offered = cellTargets(project, cell, item);
  // Staying put beats moving when the card is already here.
  if (offered.some((s) => s.id === item.statusId)) return item.statusId;
  return offered[0]?.id ?? null;
}

// --- sprints -----------------------------------------------------------------

/** The sprint running now, if any. */
export function activeSprint(project: Pick<Project, 'sprints'>): ProjectSprint | null {
  return project.sprints.find((s) => s.state === 'active') ?? null;
}

/** Whether this project's board is being run in sprints. */
export function usesSprints(project: Pick<Project, 'kind' | 'sprintsEnabled'>): boolean {
  return project.kind === 'project' && project.sprintsEnabled;
}

/**
 * Where an item goes on the board when it joins a running sprint from a
 * backlog status: the first board status its workflow allows, not-started
 * ones before any other, in board order. Null when its workflow allows none.
 * An item already on the board stays where it is, which is also null.
 */
export function sprintEntryStatus(
  project: Pick<Project, 'statuses' | 'workflows' | 'typeWorkflows'>,
  item: Pick<WorkItemSummary, 'type' | 'statusId'>,
): ProjectStatus | null {
  const current = project.statuses.find((s) => s.id === item.statusId);
  if (!current || current.category !== 'backlog') return null;
  const open = project.statuses.filter(
    (s) => s.category !== 'backlog' && canMoveTo(project, item.type, item.statusId, s.id),
  );
  return open.find((s) => s.category === 'todo') ?? open[0] ?? null;
}

/** Whole days from today to a YYYY-MM-DD date: negative once it has passed. */
export function daysUntil(date: string, today = new Date()): number {
  const [y, m, d] = date.split('-').map(Number);
  const end = Date.UTC(y, m - 1, d);
  const now = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((end - now) / 86_400_000);
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

/**
 * A board arrangement as it is sent. The bounds are there to keep a malformed
 * or hostile layout small; which statuses it names is not checked, since the
 * board reconciles that itself every time it is drawn.
 */
export const boardLayoutSchema = z.object({
  lanes: z
    .array(
      z.object({
        cells: z
          .array(
            z.object({
              statusIds: z.array(uuid).min(1).max(20),
              name: z
                .string()
                .trim()
                .max(40)
                .nullish()
                .transform((value) => value || null),
            }),
          )
          .min(1)
          .max(20),
      }),
    )
    .max(50),
});

export const updateProjectSchema = z.object({
  name: z.string().trim().min(1, 'Name it').max(80).optional(),
  key: projectKeySchema.optional(),
  description: z.string().max(4000).optional(),
  icon: z.string().trim().max(8).nullish(),
  archived: z.boolean().optional(),
  boardLayout: boardLayoutSchema.optional(),
  sprintsEnabled: z.boolean().optional(),
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
  freeForm: z.boolean().default(false),
});

export const updateRoleSchema = z.object({
  name: z.string().trim().min(1, 'Name the role').max(40).optional(),
  multiple: z.boolean().optional(),
  freeForm: z.boolean().optional(),
  position: z.number().finite().optional(),
});

/** A workflow can offer at most this many moves out of one status. */
export const MAX_TRANSITIONS = 50;

export const createWorkflowSchema = z.object({
  name: z.string().trim().min(1, 'Name the workflow').max(40),
});

export const updateWorkflowSchema = z.object({
  name: z.string().trim().min(1, 'Name the workflow').max(40).optional(),
  position: z.number().finite().optional(),
  /**
   * Replaces the whole set of moves at once, keyed by the status moved from.
   * A status left out allows nothing out of itself.
   */
  transitions: z.record(uuid, z.array(uuid).max(MAX_TRANSITIONS)).optional(),
});

/** Points one item type at a workflow, or at none with a null. */
export const setTypeWorkflowSchema = z.object({
  type: workItemTypeSchema,
  workflowId: uuid.nullable(),
});

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');

/** How long a sprint runs when nobody says otherwise. */
export const DEFAULT_SPRINT_DAYS = 14;

export const createSprintSchema = z.object({
  /** "Sprint 4", counting the project's sprints, when left out. */
  name: z.string().trim().max(60).optional(),
  goal: z.string().trim().max(500).default(''),
  startDate: isoDate.nullish(),
  endDate: isoDate.nullish(),
});

export const updateSprintSchema = z.object({
  name: z.string().trim().min(1, 'Name the sprint').max(60).optional(),
  goal: z.string().trim().max(500).optional(),
  /** Pass null to clear. */
  startDate: isoDate.nullish(),
  endDate: isoDate.nullish(),
});

export const startSprintSchema = z.object({
  startDate: isoDate,
  endDate: isoDate,
  /**
   * Also bring in the open work already on the board that is in no sprint —
   * what a project that is only now turning sprints on has in flight.
   */
  includeBoard: z.boolean().default(false),
});

export const completeSprintSchema = z.object({
  /** Where unfinished work goes: a planned sprint, or null for the backlog. */
  moveTo: uuid.nullable().default(null),
});

/** Putting many items into a sprint at once, or taking them out with null. */
export const setWorkItemsSprintSchema = z.object({
  itemIds: z.array(uuid).min(1).max(500),
  sprintId: uuid.nullable(),
});

export const MAX_ROLE_HOLDERS = 20;

/** A name typed into a free-form role: a person, a company, a ticket number. */
export const roleNameSchema = z.string().trim().min(1).max(80);
const roleNamesSchema = z.array(roleNameSchema).max(MAX_ROLE_HOLDERS);

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
  /** Names typed into free-form roles from the start, keyed by role id. */
  roleNames: z.record(uuid, roleNamesSchema).optional(),
  /** The sprint it starts in. A running sprint takes it onto the board. */
  sprintId: uuid.nullish(),
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
  /** Pass null to send it back to the backlog. */
  sprintId: uuid.nullish(),
});

/** Moving many items at once, such as from the backlog onto the board. */
export const moveWorkItemsSchema = z.object({
  itemIds: z.array(uuid).min(1).max(500),
  statusId: uuid,
});

/** Everyone and everything holding one role, replacing whoever held it before. */
export const setWorkItemRoleSchema = z.object({
  userIds: z.array(uuid).max(MAX_ROLE_HOLDERS),
  /** Only a free-form role takes these. */
  names: roleNamesSchema.default([]),
});

export const workItemCommentSchema = z.object({
  body: z.string().trim().min(1, 'Write something first').max(10_000),
});

export const resolveWorkItemsSchema = z.object({
  ids: z.array(uuid).max(300),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
export type CreateSprintInput = z.input<typeof createSprintSchema>;
export type UpdateSprintInput = z.infer<typeof updateSprintSchema>;
export type CreateWorkItemInput = z.input<typeof createWorkItemSchema>;
export type UpdateWorkItemInput = z.infer<typeof updateWorkItemSchema>;
