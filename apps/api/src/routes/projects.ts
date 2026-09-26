import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  DEFAULT_ARCHIVE_DAYS,
  STANDARD_ITEM_TYPES,
  WORK_ITEM_LINK_LABELS,
  canMoveTo,
  completeSprintSchema,
  createProjectSchema,
  createSprintSchema,
  createRoleSchema,
  createStatusSchema,
  createItemTypeSchema,
  createWorkItemLinkSchema,
  createWorkItemSchema,
  createWorkflowSchema,
  isEpicType,
  isSymmetricLink,
  ARCHIVE_PAGE_SIZE,
  archivePageQuerySchema,
  MAX_LISTED_ITEMS,
  itemTypeOf,
  deleteItemTypeSchema,
  deleteStatusSchema,
  MAX_ROLE_HOLDERS,
  memberRef,
  moveWorkItemsSchema,
  resolveWorkItemsSchema,
  setWorkItemRoleSchema,
  setWorkItemsSprintSchema,
  sprintEntryStatus,
  startSprintSchema,
  textMembers,
  textWorkItems,
  updateItemTypeSchema,
  updateProjectSchema,
  updateRoleSchema,
  updateSprintSchema,
  updateStatusSchema,
  updateWorkItemSchema,
  updateWorkflowSchema,
  workItemCommentSchema,
  workflowForType,
  type Project,
  type ProjectItemType,
  type ProjectKind,
  type ProjectRole,
  type ProjectSprint,
  type ProjectStatus,
  type ProjectWorkflow,
  type SprintState,
  type StatusCategory,
  type ArchivePage,
  type WorkItem,
  type WorkItemActivity,
  type WorkItemActivityData,
  type WorkItemAttachment,
  type WorkItemBacklinks,
  type WorkItemComment,
  type WorkItemLink,
  type WorkItemLinkDirection,
  type WorkItemLinkType,
  type WorkItemListing,
  type WorkItemResponses,
  type WorkItemSort,
  type WorkItemSummary,
  type WorkItemTimeline,
  projectPermission,
} from '@paradocs/shared';
import { query, transaction, type DbClient } from '../db/pool.js';
import { badRequest, conflict, forbidden, notFound, parse } from '../lib/http.js';
import {
  UUID,
  assertProjectAccess,
  assertWorkItemAccess,
  channelLevelSql,
  workItemAccess,
  documentLevelSql,
  managesAccess,
  permissionSql,
  projectLevelSql,
  roleIdSql,
} from '../lib/access.js';
import { appEnabledSql } from '../lib/apps.js';
import { resolveReferences, resolveWorkItems } from '../lib/chatReferences.js';
import {
  dimension,
  displayName,
  removeStoredFile,
  removeStoredFiles,
  storeUpload,
  uploadLimits,
  uploadUrlSql,
} from '../lib/storage.js';
import { notifyAboutWorkItem, projectChanged, syncWorkItemMentions } from '../lib/workItems.js';
import { archiveDormantWorkItems } from '../lib/workItemArchive.js';
import { CURSOR_TEXT, decodeCursor, encodeCursor, isInteger } from '../lib/cursor.js';
import { assertWorkspaceAccess } from '../plugins/session.js';
import { grants } from '../lib/roles.js';

/**
 * Projects and queues, and the work items in them.
 *
 * A project is locked the way a channel is — open, or an allow or deny list —
 * and everything in it follows the project: whoever may view the project may
 * view its items, and whoever may edit it may file, move and comment on them
 * and change how the project is set up. Deleting a whole project is kept for
 * owners, admins and whoever made it.
 *
 * Descriptions and comments are written the way chat messages are, with
 * `<doc:…>`, `<sheet:…>`, `<item:…>`, `<#…>` and `<@…>` tokens, and resolved
 * the same way when read.
 */

type Queryable = Pick<DbClient, 'query'>;

const DEFAULTS: Record<
  ProjectKind,
  {
    statuses: { name: string; category: StatusCategory; color: string }[];
    roles: { name: string; multiple: boolean; freeForm?: boolean }[];
  }
> = {
  // New work lands in the backlog, and goes on the board once someone plans it.
  project: {
    statuses: [
      { name: 'Backlog', category: 'backlog', color: '#8f8f9c' },
      { name: 'To do', category: 'todo', color: '#6366f1' },
      { name: 'In progress', category: 'active', color: '#0ea5e9' },
      { name: 'In review', category: 'active', color: '#8b5cf6' },
      { name: 'Done', category: 'done', color: '#10b981' },
    ],
    roles: [
      { name: 'Assignee', multiple: false },
      { name: 'Reviewer', multiple: true },
      { name: 'Reporter', multiple: false },
    ],
  },
  queue: {
    statuses: [
      { name: 'Open', category: 'todo', color: '#f59e0b' },
      { name: 'In progress', category: 'active', color: '#0ea5e9' },
      { name: 'Waiting', category: 'active', color: '#8f8f9c' },
      { name: 'Resolved', category: 'done', color: '#10b981' },
    ],
    roles: [
      { name: 'Assignee', multiple: false },
      // Whoever asked is often a customer rather than a colleague, so the name
      // can be typed in when there is no account to point at.
      { name: 'Requester', multiple: false, freeForm: true },
      { name: 'Watcher', multiple: true },
    ],
  },
};

/** A project as `user`, with `role`, sees it. The table must be aliased `p`. */
function projectColumns(user: string, role: string): string {
  return `
  p.id, p.workspace_id AS "workspaceId", p.kind, p.key, p.name, p.description, p.icon, p.access,
  ${permissionSql(projectLevelSql(user, role))} AS permission,
  p.created_by AS "createdBy", p.created_at AS "createdAt", p.updated_at AS "updatedAt", p.archived_at AS "archivedAt",
  (SELECT count(*)::int FROM work_items i JOIN project_statuses st ON st.id = i.status_id
    WHERE i.project_id = p.id AND st.category <> 'done') AS "openCount",
  (SELECT count(*)::int FROM work_items i WHERE i.project_id = p.id) AS "itemCount"`;
}

/** A work item's summary. Items aliased `i`, their project `p`. */
const ITEM_COLUMNS = `
  i.id, i.project_id AS "projectId", i.number, p.key || '-' || i.number AS key, i.title, i.type_id AS "typeId", i.priority,
  i.status_id AS "statusId", i.position, i.sprint_id AS "sprintId", i.epic_id AS "epicId", to_char(i.due_date, 'YYYY-MM-DD') AS "dueDate",
  i.estimate::float8 AS estimate,
  COALESCE((
    SELECT json_object_agg(g.role_id, g.users)
      FROM (SELECT wr.role_id, json_agg(wr.user_id ORDER BY wr.created_at) AS users
              FROM work_item_roles wr
             WHERE wr.work_item_id = i.id AND wr.user_id IS NOT NULL
             GROUP BY wr.role_id) g
  ), '{}'::json) AS roles,
  COALESCE((
    SELECT json_object_agg(g.role_id, g.names)
      FROM (SELECT wr.role_id, json_agg(wr.name ORDER BY wr.created_at) AS names
              FROM work_item_roles wr
             WHERE wr.work_item_id = i.id AND wr.name IS NOT NULL
             GROUP BY wr.role_id) g
  ), '{}'::json) AS "roleNames",
  (SELECT count(*)::int FROM work_item_comments c WHERE c.work_item_id = i.id) AS "commentCount",
  (SELECT count(*)::int FROM work_item_links l
     JOIN work_items b ON b.id = l.source_id
     JOIN project_statuses bs ON bs.id = b.status_id
    WHERE l.target_id = i.id AND l.type = 'blocks' AND bs.category <> 'done') AS "blockedBy",
  i.created_at AS "createdAt", i.updated_at AS "updatedAt", i.completed_at AS "completedAt",
  i.archived_at AS "archivedAt"`;

/**
 * Archived work in the project aliased `p`, totalled by `column` — epic or
 * sprint — as JSON keyed by its id.
 */
function archivedBy(column: 'epic_id' | 'sprint_id'): string {
  return `COALESCE((
    SELECT json_object_agg(g.id, json_build_object('items', g.items, 'estimate', g.estimate))
      FROM (SELECT a.${column} AS id, count(*)::int AS items, COALESCE(sum(a.estimate), 0)::float8 AS estimate
              FROM work_items a
             WHERE a.project_id = p.id AND a.archived_at IS NOT NULL AND a.${column} IS NOT NULL
             GROUP BY a.${column}) g
  ), '{}'::json)`;
}

function authorJson(alias: string): string {
  return `CASE WHEN ${alias}.id IS NULL THEN NULL
    ELSE json_build_object('id', ${alias}.id, 'name', ${alias}.name, 'email', ${alias}.email,
                           'avatarUrl', ${uploadUrlSql(`${alias}.avatar_key`)}) END`;
}

/** A work item attachment aliased `a`, with its uploader aliased `u`, as a WorkItemAttachment. */
const ATTACHMENT_COLUMNS = `a.id, a.filename, a.mime_type AS "mimeType", a.byte_size::float8 AS "byteSize",
  '/uploads/' || a.storage_key AS url, a.width, a.height, ${authorJson('u')} AS uploader,
  a.created_at AS "createdAt"`;

/** How the type of the item aliased `i` looks, as JSON, for showing it outside its project. */
const ITEM_TYPE_LOOK = `(SELECT json_build_object('name', t.name, 'icon', t.icon, 'color', t.color, 'epic', t.epic)
                          FROM project_item_types t WHERE t.id = i.type_id)`;

/** Whether the item aliased `i` is of an epic-kind type. */
const IS_EPIC = `EXISTS (SELECT 1 FROM project_item_types t WHERE t.id = i.type_id AND t.epic)`;

/** An item type as the client wants it. The table must be aliased `t`. */
const ITEM_TYPE_JSON = `json_build_object('id', t.id, 'name', t.name, 'icon', t.icon, 'color', t.color, 'epic', t.epic,
  'workflowId', t.workflow_id, 'position', t.position,
  'roleIds', COALESCE((SELECT json_agg(tr.role_id) FROM project_item_type_roles tr WHERE tr.type_id = t.id), '[]'::json))`;

/** A sprint as the client wants it. The table must be aliased `sp`. */
const SPRINT_COLUMNS = `
  sp.id, sp.name, sp.goal, sp.state,
  to_char(sp.start_date, 'YYYY-MM-DD') AS "startDate", to_char(sp.end_date, 'YYYY-MM-DD') AS "endDate",
  sp.started_at AS "startedAt", sp.completed_at AS "completedAt", sp.created_at AS "createdAt"`;

/** Running first, then planned in the order they were made, then completed, newest first. */
const SPRINT_ORDER = `CASE sp.state WHEN 'active' THEN 0 WHEN 'planned' THEN 1 ELSE 2 END,
  CASE WHEN sp.state = 'completed' THEN NULL ELSE sp.created_at END,
  sp.completed_at DESC`;

/**
 * How the archive can be ordered: the expression each sort reads, aliased as
 * a page query aliases its tables (`i` the item, `st` its status), with what
 * type a cursor's value is cast back to and how to tell one is well formed.
 * Empty due dates and estimates are given a value past every real one, so
 * they sort last going up, as the list sorts them, and a cursor never holds
 * a null.
 */
const ARCHIVE_ORDER: Record<WorkItemSort, { expr: string; type: string; check: (value: string) => boolean }> = {
  key: { expr: 'i.number', type: 'int', check: (v) => CURSOR_TEXT.integer.test(v) },
  title: { expr: 'i.title', type: 'text', check: () => true },
  status: { expr: 'st.position', type: 'float8', check: (v) => CURSOR_TEXT.number.test(v) },
  priority: {
    expr: `CASE i.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`,
    type: 'int',
    check: (v) => /^\d$/.test(v),
  },
  due: { expr: `COALESCE(i.due_date, '9999-12-31'::date)`, type: 'date', check: (v) => CURSOR_TEXT.date.test(v) },
  estimate: { expr: 'COALESCE(i.estimate, -1)', type: 'numeric', check: (v) => CURSOR_TEXT.number.test(v) },
  updated: { expr: 'i.updated_at', type: 'timestamptz', check: (v) => CURSOR_TEXT.timestamp.test(v) },
  created: { expr: 'i.created_at', type: 'timestamptz', check: (v) => CURSOR_TEXT.timestamp.test(v) },
};

const responsesQuerySchema = z.object({ createdSince: z.string().datetime({ offset: true }) });

/** A workflow's moves as the client wants them: to-statuses keyed by from-status. */
const TRANSITIONS_JSON = `COALESCE((
  SELECT json_object_agg(g.from_status, g.tos)
    FROM (SELECT t.from_status, json_agg(t.to_status) AS tos
            FROM project_workflow_transitions t
           WHERE t.workflow_id = w.id
           GROUP BY t.from_status) g
), '{}'::json)`;

export async function fetchProject(id: string, userId: string): Promise<Project> {
  const { rows } = await query<Project>(
    `SELECT ${projectColumns('$2', roleIdSql('$2', 'p.workspace_id'))},
            COALESCE((SELECT json_agg(json_build_object('id', st.id, 'name', st.name, 'category', st.category,
                                                        'color', st.color, 'position', st.position)
                                      ORDER BY st.position, st.created_at)
                        FROM project_statuses st WHERE st.project_id = p.id), '[]'::json) AS statuses,
            COALESCE((SELECT json_agg(json_build_object('id', r.id, 'name', r.name, 'multiple', r.multiple,
                                                        'freeForm', r.free_form, 'position', r.position)
                                      ORDER BY r.position, r.created_at)
                        FROM project_roles r WHERE r.project_id = p.id), '[]'::json) AS roles,
            COALESCE((SELECT json_agg(json_build_object('id', w.id, 'name', w.name, 'position', w.position,
                                                        'transitions', ${TRANSITIONS_JSON})
                                      ORDER BY w.position, w.created_at)
                        FROM project_workflows w WHERE w.project_id = p.id), '[]'::json) AS workflows,
            COALESCE((SELECT json_agg(${ITEM_TYPE_JSON} ORDER BY t.position, t.created_at)
                        FROM project_item_types t WHERE t.project_id = p.id), '[]'::json) AS "itemTypes",
            p.board_layout AS "boardLayout",
            p.kind = 'project' AND p.sprints_enabled AS "sprintsEnabled",
            p.archive_after_days AS "archiveAfterDays",
            json_build_object(
              'count', (SELECT count(*)::int FROM work_items a WHERE a.project_id = p.id AND a.archived_at IS NOT NULL),
              'epics', ${archivedBy('epic_id')},
              'sprints', ${archivedBy('sprint_id')}
            ) AS archive,
            COALESCE(p.default_type_id,
                     (SELECT t.id FROM project_item_types t WHERE t.project_id = p.id AND NOT t.epic
                       ORDER BY t.position, t.created_at LIMIT 1)) AS "defaultTypeId",
            COALESCE((SELECT json_agg(to_jsonb(s) - 'ord' ORDER BY s.ord)
                        FROM (SELECT ${SPRINT_COLUMNS}, row_number() OVER (ORDER BY ${SPRINT_ORDER}) AS ord
                                FROM project_sprints sp WHERE sp.project_id = p.id) s), '[]'::json) AS sprints,
            (${projectLevelSql('$2', roleIdSql('$2', 'p.workspace_id'))} = 2
              AND (role_grants(${roleIdSql('$2', 'p.workspace_id')}, p.kind || 's.delete')
                OR (p.created_by = $2 AND role_grants(${roleIdSql('$2', 'p.workspace_id')}, p.kind || 's.create')))) AS "canDelete"
       FROM projects p WHERE p.id = $1`,
    [id, userId],
  );
  if (!rows[0]) throw notFound('Project not found');
  return rows[0];
}

async function fetchItem(id: string, workspaceId: string, userId: string): Promise<WorkItem> {
  const { rows } = await query<WorkItem>(
    `SELECT ${ITEM_COLUMNS}, i.description, ${authorJson('u')} AS "createdBy"
       FROM work_items i
       JOIN projects p ON p.id = i.project_id
       LEFT JOIN users u ON u.id = i.created_by
      WHERE i.id = $1`,
    [id],
  );
  if (!rows[0]) throw notFound('Work item not found');
  return { ...rows[0], references: await resolveReferences([rows[0].description], workspaceId, userId) };
}

async function projectOfStatus(statusId: string): Promise<string> {
  if (!UUID.test(statusId)) throw notFound('Status not found');
  const { rows } = await query<{ project_id: string }>('SELECT project_id FROM project_statuses WHERE id = $1', [statusId]);
  if (!rows[0]) throw notFound('Status not found');
  return rows[0].project_id;
}

async function projectOfWorkflow(workflowId: string): Promise<string> {
  if (!UUID.test(workflowId)) throw notFound('Workflow not found');
  const { rows } = await query<{ project_id: string }>('SELECT project_id FROM project_workflows WHERE id = $1', [workflowId]);
  if (!rows[0]) throw notFound('Workflow not found');
  return rows[0].project_id;
}

async function assertWorkflowNameFree(projectId: string, name: string, exceptId?: string): Promise<void> {
  const { rows } = await query(
    'SELECT 1 FROM project_workflows WHERE project_id = $1 AND lower(name) = lower($2) AND id IS DISTINCT FROM $3',
    [projectId, name, exceptId ?? null],
  );
  if (rows.length) throw conflict(`This project already has a workflow called ${name}`);
}

/**
 * Refuses a move no workflow allows. Owners and admins are let through: a
 * workflow is how a team means to work, not a cage, and someone has to be able
 * to unstick an item when the rules themselves turn out to be wrong.
 */
function assertMoveAllowed(
  project: Project,
  role: string | null,
  moves: { key: string; typeId: string; from: string; to: string }[],
): void {
  if (role === 'owner' || role === 'admin') return;
  const name = (id: string) => project.statuses.find((s) => s.id === id)?.name ?? 'that status';
  for (const move of moves) {
    if (canMoveTo(project, move.typeId, move.from, move.to)) continue;
    const workflow = workflowForType(project, move.typeId)!;
    throw badRequest(
      `${move.key} cannot go from ${name(move.from)} to ${name(move.to)}: the ${workflow.name} workflow does not allow it`,
    );
  }
}

type ItemTypeRow = { id: string; projectId: string; name: string; epic: boolean };

async function itemTypeRow(typeId: string): Promise<ItemTypeRow> {
  if (!UUID.test(typeId)) throw notFound('Type not found');
  const { rows } = await query<ItemTypeRow>(
    'SELECT id, project_id AS "projectId", name, epic FROM project_item_types WHERE id = $1',
    [typeId],
  );
  if (!rows[0]) throw notFound('Type not found');
  return rows[0];
}

async function assertItemTypeNameFree(projectId: string, name: string, exceptId?: string): Promise<void> {
  const { rows } = await query(
    'SELECT 1 FROM project_item_types WHERE project_id = $1 AND lower(name) = lower($2) AND id IS DISTINCT FROM $3',
    [projectId, name, exceptId ?? null],
  );
  if (rows.length) throw conflict(`This project already has a type called ${name}`);
}

/**
 * Takes people off roles that no longer apply to the type of the items `where`
 * picks out (items aliased `i`), and notes it in each item's history. It is what
 * keeps an item's roles to those its type offers, after the type changes or
 * the roles the type offers do.
 */
async function pruneRoles(db: Queryable, where: string, params: unknown[], actorId: string): Promise<void> {
  const { rows } = await db.query<{ work_item_id: string; role_id: string; role_name: string; holders: string[] }>(
    `DELETE FROM work_item_roles wr
      USING work_items i, project_roles r
      WHERE wr.work_item_id = i.id AND r.id = wr.role_id AND ${where}
        AND NOT EXISTS (SELECT 1 FROM project_item_type_roles tr WHERE tr.type_id = i.type_id AND tr.role_id = wr.role_id)
      RETURNING wr.work_item_id, wr.role_id, r.name AS role_name, ARRAY[COALESCE(wr.user_id::text, wr.name)] AS holders`,
    params,
  );
  const grouped = new Map<string, { itemId: string; role: string; removed: string[] }>();
  for (const row of rows) {
    const key = `${row.work_item_id}:${row.role_id}`;
    const entry = grouped.get(key) ?? { itemId: row.work_item_id, role: row.role_name, removed: [] };
    entry.removed.push(...row.holders);
    grouped.set(key, entry);
  }
  for (const entry of grouped.values()) {
    await logActivity(db, entry.itemId, actorId, { kind: 'role', role: entry.role, added: [], removed: entry.removed });
  }
}

async function projectOfRole(roleId: string): Promise<string> {
  if (!UUID.test(roleId)) throw notFound('Role not found');
  const { rows } = await query<{ project_id: string }>('SELECT project_id FROM project_roles WHERE id = $1', [roleId]);
  if (!rows[0]) throw notFound('Role not found');
  return rows[0].project_id;
}

/**
 * Refuses a change that would leave a project with nothing but backlog: the
 * board has to have somewhere for planned work to go.
 */
async function assertKeepsBoardStatus(projectId: string, changingStatusId: string): Promise<void> {
  const { rows } = await query<{ count: number }>(
    `SELECT count(*)::int AS count FROM project_statuses
      WHERE project_id = $1 AND category <> 'backlog' AND id <> $2`,
    [projectId, changingStatusId],
  );
  if (rows[0].count === 0) throw badRequest('A project needs at least one status that is not backlog, to make up its board');
}

async function assertKeyFree(workspaceId: string, key: string, exceptId?: string): Promise<void> {
  const { rows } = await query('SELECT 1 FROM projects WHERE workspace_id = $1 AND key = $2 AND id IS DISTINCT FROM $3', [
    workspaceId,
    key,
    exceptId ?? null,
  ]);
  if (rows.length) throw conflict(`Another project already uses the key ${key}`);
}

async function assertRoleNameFree(projectId: string, name: string, exceptId?: string): Promise<void> {
  const { rows } = await query(
    'SELECT 1 FROM project_roles WHERE project_id = $1 AND lower(name) = lower($2) AND id IS DISTINCT FROM $3',
    [projectId, name, exceptId ?? null],
  );
  if (rows.length) throw conflict(`This project already has a role called ${name}`);
}

/** Only members of the workspace can hold a role on its items. */
async function assertMembers(workspaceId: string, userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  const { rows } = await query<{ count: number }>(
    'SELECT count(*)::int AS count FROM workspace_members WHERE workspace_id = $1 AND user_id = ANY($2::uuid[])',
    [workspaceId, userIds],
  );
  if (rows[0].count !== userIds.length) throw badRequest('Everyone given a role must be a member of this workspace');
}

/**
 * What a free-form role is being given, tidied: blanks dropped, and the same
 * name twice — however it was capitalised the second time — kept once.
 */
function uniqueNames(names: string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names ?? []) {
    const name = raw.trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * Checks what one role is being given against how it is set up: a name only
 * where names are allowed, and one holder where only one may hold it.
 */
function assertRoleFits(
  role: { name: string; multiple: boolean; freeForm: boolean },
  userIds: string[],
  names: string[],
): void {
  if (names.length > 0 && !role.freeForm) {
    throw badRequest(`${role.name} is for people with an account here. Make it free-form to type a name in.`);
  }
  if (!role.multiple && userIds.length + names.length > 1) {
    throw badRequest(role.freeForm ? `Only one can be ${role.name}` : `Only one person can be ${role.name}`);
  }
}

/**
 * Gives a role its holders on a new item. Members go in first and names after,
 * a microsecond apart each, so every list reads back in the order it was given.
 */
export async function insertRoleHolders(
  db: Queryable,
  itemId: string,
  roleId: string,
  userIds: string[],
  names: string[],
): Promise<void> {
  if (userIds.length > 0) {
    await db.query(
      `INSERT INTO work_item_roles (work_item_id, role_id, user_id, created_at)
       SELECT $1, $2, u.id, now() + (u.n * interval '1 microsecond')
         FROM unnest($3::uuid[]) WITH ORDINALITY AS u(id, n)
       ON CONFLICT DO NOTHING`,
      [itemId, roleId, userIds],
    );
  }
  if (names.length > 0) {
    await db.query(
      `INSERT INTO work_item_roles (work_item_id, role_id, name, created_at)
       SELECT $1, $2, n.name, now() + ((n.i + ${MAX_ROLE_HOLDERS}) * interval '1 microsecond')
         FROM unnest($3::text[]) WITH ORDINALITY AS n(name, i)
       ON CONFLICT DO NOTHING`,
      [itemId, roleId, names],
    );
  }
}

export async function logActivity(db: Queryable, itemId: string, actorId: string | null, data: WorkItemActivityData): Promise<void> {
  await db.query('INSERT INTO work_item_activity (work_item_id, actor_id, data) VALUES ($1, $2, $3)', [
    itemId,
    actorId,
    JSON.stringify(data),
  ]);
}

/** Notes a link made or removed in the history of both its items, each reading it its own way. */
async function logLinkBothWays(
  db: Queryable,
  link: { id: string; target: string },
  type: WorkItemLinkType,
  items: { id: string; key: string; title: string }[],
  actorId: string,
  added: boolean,
): Promise<void> {
  const source = items.find((i) => i.id === link.id)!;
  const target = items.find((i) => i.id === link.target)!;
  const labels = WORK_ITEM_LINK_LABELS[type];
  await logActivity(db, source.id, actorId, { kind: 'link', label: labels.outward, key: target.key, title: target.title, added });
  await logActivity(db, target.id, actorId, { kind: 'link', label: labels.inward, key: source.key, title: source.title, added });
}

/**
 * Tells whoever is looking at the projects of the items linked to this one
 * that it changed, since each shows it — and whether it still blocks them.
 */
async function linkedChanged(itemId: string, workspaceId: string): Promise<void> {
  const { rows } = await query<{ id: string; project_id: string }>(
    `SELECT i.id, i.project_id FROM work_item_links l
       JOIN work_items i ON i.id = CASE WHEN l.source_id = $1 THEN l.target_id ELSE l.source_id END
      WHERE l.source_id = $1 OR l.target_id = $1`,
    [itemId],
  );
  for (const row of rows) projectChanged(workspaceId, row.project_id, row.id);
}

/**
 * Records the items an item's description and comments mention, so each of
 * those lists this one. Losing a backlink is not worth failing the request.
 */
async function recordItemMentions(req: FastifyRequest, itemId: string, workspaceId: string): Promise<void> {
  try {
    const { rows } = await query<{ body: string }>(
      `SELECT description AS body FROM work_items WHERE id = $1
       UNION ALL SELECT body FROM work_item_comments WHERE work_item_id = $1`,
      [itemId],
    );
    await syncWorkItemMentions({ kind: 'workItem', id: itemId }, workspaceId, textWorkItems(rows.map((r) => r.body)));
  } catch (err) {
    req.log.warn({ err, itemId }, 'could not record work item mentions');
  }
}

/** Tells people about an item, logging rather than failing when that goes wrong. */
async function tell(
  req: FastifyRequest,
  itemId: string,
  userIds: string[],
  reason: 'role' | 'mention',
  detail: string | null = null,
): Promise<void> {
  try {
    await notifyAboutWorkItem(itemId, userIds, reason, detail, req.user!.id);
  } catch (err) {
    req.log.warn({ err, itemId }, 'could not record work item notifications');
  }
}

/** Where an item lands in a status: after everything already there. */
export async function endOfStatus(db: Queryable, statusId: string): Promise<number> {
  const { rows } = await db.query<{ next: number }>(
    'SELECT COALESCE(max(position), 0)::float8 + 1 AS next FROM work_items WHERE status_id = $1',
    [statusId],
  );
  return rows[0].next;
}

// --- sprints -------------------------------------------------------------------

type SprintRow = { id: string; projectId: string; name: string; state: SprintState };

async function sprintRow(sprintId: string): Promise<SprintRow> {
  if (!UUID.test(sprintId)) throw notFound('Sprint not found');
  const { rows } = await query<SprintRow>(
    'SELECT id, project_id AS "projectId", name, state FROM project_sprints WHERE id = $1',
    [sprintId],
  );
  if (!rows[0]) throw notFound('Sprint not found');
  return rows[0];
}

/** A sprint of this project that work can still be put in: one not yet complete. */
async function openSprintOf(projectId: string, sprintId: string): Promise<SprintRow> {
  const sprint = await sprintRow(sprintId).catch(() => {
    throw badRequest('That sprint is not in this project');
  });
  if (sprint.projectId !== projectId) throw badRequest('That sprint is not in this project');
  if (sprint.state === 'completed') throw badRequest(`${sprint.name} is complete. Put the work in a sprint still to come.`);
  return sprint;
}

// --- epics ---------------------------------------------------------------------

type EpicRow = { id: string; title: string };

/** An epic of this project that work can be put under. */
async function epicOf(projectId: string, epicId: string): Promise<EpicRow> {
  const { rows } = await query<EpicRow & { epic: boolean }>(
    `SELECT i.id, i.title, t.epic FROM work_items i JOIN project_item_types t ON t.id = i.type_id
      WHERE i.id = $1 AND i.project_id = $2`,
    [epicId, projectId],
  );
  if (!rows[0]) throw badRequest('That epic is not in this project');
  if (!rows[0].epic) throw badRequest(`"${rows[0].title}" is not an epic`);
  return { id: rows[0].id, title: rows[0].title };
}

/** One item as putting it in a sprint needs it. */
type Placing = { id: string; key: string; typeId: string; epic: boolean; statusId: string; sprintId: string | null };

async function placingItems(db: Queryable, projectId: string, itemIds: string[]): Promise<Placing[]> {
  const { rows } = await db.query<Placing>(
    `SELECT i.id, p.key || '-' || i.number AS key, i.type_id AS "typeId", ${IS_EPIC} AS epic,
            i.status_id AS "statusId", i.sprint_id AS "sprintId"
       FROM unnest($1::uuid[]) WITH ORDINALITY AS picked(id, n)
       JOIN work_items i ON i.id = picked.id AND i.project_id = $2
       JOIN projects p ON p.id = i.project_id
      ORDER BY picked.n`,
    [itemIds, projectId],
  );
  return rows;
}

/**
 * Where each of these items goes when a running sprint takes it: from a
 * backlog status onto the board, at the first status its workflow allows.
 * Checked before anything is written, so a refusal changes nothing.
 *
 * An item whose workflow lets it nowhere on the board cannot join, which is
 * said by name. Owners and admins are let through to the first board status,
 * as they are past any other workflow rule.
 */
function boardEntries(project: Project, role: string | null, items: Placing[]): Map<string, ProjectStatus> {
  const entries = new Map<string, ProjectStatus>();
  for (const item of items) {
    const status = project.statuses.find((s) => s.id === item.statusId);
    if (status?.category !== 'backlog') continue;
    let entry = sprintEntryStatus(project, item);
    if (!entry && (role === 'owner' || role === 'admin')) {
      const board = project.statuses.filter((s) => s.category !== 'backlog');
      entry = board.find((s) => s.category === 'todo') ?? board[0] ?? null;
    }
    if (!entry) {
      throw badRequest(`${item.key} cannot join a running sprint: its workflow does not let it onto the board from ${status.name}`);
    }
    entries.set(item.id, entry);
  }
  return entries;
}

/** Moves items onto the board where `boardEntries` said, at the end of each status, in order. */
async function moveOntoBoard(
  db: Queryable,
  items: Placing[],
  entries: Map<string, ProjectStatus>,
  fromName: (statusId: string) => string,
  actorId: string,
): Promise<void> {
  for (const item of items) {
    const entry = entries.get(item.id);
    if (!entry) continue;
    await db.query(
      `UPDATE work_items
          SET status_id = $2, position = $3,
              completed_at = CASE WHEN $4 = 'done' THEN COALESCE(completed_at, now()) ELSE NULL END,
              archived_at = CASE WHEN $4 = 'done' THEN archived_at ELSE NULL END,
              updated_at = now()
        WHERE id = $1`,
      [item.id, entry.id, await endOfStatus(db, entry.id), entry.category],
    );
    await logActivity(db, item.id, actorId, { kind: 'status', from: fromName(item.statusId), to: entry.name });
  }
}

/**
 * Puts items in a sprint, or back in the backlog with null, and notes it in
 * each one's history. Joining a running sprint also takes an item waiting in a
 * backlog status onto the board, since the board is all a running sprint shows.
 * Leaving one moves nothing: work that has started is still started.
 */
async function placeInSprint(
  db: Queryable,
  project: Project,
  role: string | null,
  items: Placing[],
  sprint: Pick<SprintRow, 'id' | 'name' | 'state'> | null,
  actorId: string,
): Promise<number> {
  const moving = items.filter((item) => item.sprintId !== (sprint?.id ?? null));
  if (moving.length === 0) return 0;
  const epic = sprint && moving.find((item) => item.epic);
  if (epic) throw badRequest(`${epic.key} is an epic. Epics are not planned in sprints; put the work under it in one instead.`);
  const entries = sprint?.state === 'active' ? boardEntries(project, role, moving) : new Map<string, ProjectStatus>();

  await db.query('UPDATE work_items SET sprint_id = $2, updated_at = now() WHERE id = ANY($1::uuid[])', [
    moving.map((item) => item.id),
    sprint?.id ?? null,
  ]);
  const sprintName = (id: string | null) => (id ? (project.sprints.find((s) => s.id === id)?.name ?? null) : null);
  for (const item of moving) {
    await logActivity(db, item.id, actorId, { kind: 'sprint', from: sprintName(item.sprintId), to: sprint?.name ?? null });
  }
  const statusName = (id: string) => project.statuses.find((s) => s.id === id)?.name ?? 'Backlog';
  await moveOntoBoard(db, moving, entries, statusName, actorId);
  return moving.length;
}

const listQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  mine: z.enum(['true', 'false']).optional(),
  open: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const projectRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  // --- projects --------------------------------------------------------------

  app.get<{ Params: { id: string }; Querystring: { archived?: string } }>('/workspaces/:id/projects', async (req) => {
    const { roleId } = await assertWorkspaceAccess(req, req.params.id, undefined, 'projects');
    const { rows } = await query(
      `SELECT ${projectColumns('$3', '$4')}
         FROM projects p
        WHERE p.workspace_id = $1
          AND (p.archived_at IS NOT NULL) = $2
          AND ${projectLevelSql('$3', '$4')} > 0
        ORDER BY p.kind, lower(p.name)`,
      [req.params.id, req.query.archived === 'true', req.user!.id, roleId],
    );
    return rows;
  });

  app.post<{ Params: { id: string } }>('/workspaces/:id/projects', async (req, reply) => {
    const input = parse(createProjectSchema, req.body ?? {});
    const kind = input.kind ?? 'project';
    await assertWorkspaceAccess(req, req.params.id, projectPermission(kind, 'create'), 'projects');
    await assertKeyFree(req.params.id, input.key);
    const defaults = DEFAULTS[kind];

    const id = await transaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO projects (workspace_id, kind, key, name, description, icon, created_by, archive_after_days)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [
          req.params.id,
          kind,
          input.key,
          input.name,
          input.description ?? '',
          input.icon ?? null,
          req.user!.id,
          DEFAULT_ARCHIVE_DAYS[kind],
        ],
      );
      const projectId = rows[0].id;
      await client.query(
        `INSERT INTO project_statuses (project_id, name, category, color, position)
         SELECT $1, s.name, s.category, s.color, s.position
           FROM unnest($2::text[], $3::text[], $4::text[]) WITH ORDINALITY AS s(name, category, color, position)`,
        [
          projectId,
          defaults.statuses.map((s) => s.name),
          defaults.statuses.map((s) => s.category),
          defaults.statuses.map((s) => s.color),
        ],
      );
      await client.query(
        `INSERT INTO project_roles (project_id, name, multiple, free_form, position)
         SELECT $1, r.name, r.multiple, r.free_form, r.position
           FROM unnest($2::text[], $3::boolean[], $4::boolean[])
                WITH ORDINALITY AS r(name, multiple, free_form, position)`,
        [
          projectId,
          defaults.roles.map((r) => r.name),
          defaults.roles.map((r) => r.multiple),
          defaults.roles.map((r) => r.freeForm ?? false),
        ],
      );
      // The five standard types, each taking every role.
      const { rows: types } = await client.query<{ id: string; name: string }>(
        `INSERT INTO project_item_types (project_id, name, icon, color, epic, position)
         SELECT $1, t.name, t.icon, t.color, t.epic, t.position
           FROM unnest($2::text[], $3::text[], $4::text[], $5::boolean[]) WITH ORDINALITY AS t(name, icon, color, epic, position)
         RETURNING id, name`,
        [
          projectId,
          STANDARD_ITEM_TYPES.map((t) => t.name),
          STANDARD_ITEM_TYPES.map((t) => t.icon),
          STANDARD_ITEM_TYPES.map((t) => t.color),
          STANDARD_ITEM_TYPES.map((t) => t.epic),
        ],
      );
      await client.query(
        `INSERT INTO project_item_type_roles (type_id, role_id)
         SELECT t.id, r.id FROM project_item_types t JOIN project_roles r ON r.project_id = t.project_id
          WHERE t.project_id = $1`,
        [projectId],
      );
      const defaultName = kind === 'queue' ? 'Request' : 'Task';
      await client.query('UPDATE projects SET default_type_id = $2 WHERE id = $1', [
        projectId,
        types.find((t) => t.name === defaultName)!.id,
      ]);
      return projectId;
    });

    projectChanged(req.params.id, id);
    reply.status(201);
    return fetchProject(id, req.user!.id);
  });

  app.get<{ Params: { id: string } }>('/projects/:id', async (req) => {
    await assertProjectAccess(req, req.params.id);
    return fetchProject(req.params.id, req.user!.id);
  });

  app.patch<{ Params: { id: string } }>('/projects/:id', async (req) => {
    const { workspaceId } = await assertProjectAccess(req, req.params.id, 'configure');
    const input = parse(updateProjectSchema, req.body ?? {});
    if (input.key) await assertKeyFree(workspaceId, input.key, req.params.id);
    if (input.defaultTypeId) {
      const type = await itemTypeRow(input.defaultTypeId);
      if (type.projectId !== req.params.id) throw badRequest('That type is not in this project');
      if (type.epic) throw badRequest(`New work cannot start as ${type.name}: it holds other work, as epics do`);
    }
    if (input.sprintsEnabled) {
      const { rows } = await query<{ kind: ProjectKind }>('SELECT kind FROM projects WHERE id = $1', [req.params.id]);
      if (rows[0]?.kind === 'queue') throw badRequest('A queue is worked through in order, not in sprints');
    }

    await query(
      `UPDATE projects
          SET name = COALESCE($2, name),
              key = COALESCE($3, key),
              description = COALESCE($4, description),
              icon = CASE WHEN $5::boolean THEN $6 ELSE icon END,
              archived_at = CASE
                WHEN $7::boolean IS NULL THEN archived_at
                WHEN $7::boolean THEN COALESCE(archived_at, now())
                ELSE NULL
              END,
              board_layout = COALESCE($8::jsonb, board_layout),
              sprints_enabled = COALESCE($9, sprints_enabled),
              default_type_id = COALESCE($10, default_type_id),
              archive_after_days = CASE WHEN $11::boolean THEN $12::int ELSE archive_after_days END,
              updated_at = now()
        WHERE id = $1`,
      [
        req.params.id,
        input.name ?? null,
        input.key ?? null,
        input.description ?? null,
        input.icon !== undefined,
        input.icon ?? null,
        input.archived ?? null,
        input.boardLayout ? JSON.stringify(input.boardLayout) : null,
        input.sprintsEnabled ?? null,
        input.defaultTypeId ?? null,
        input.archiveAfterDays !== undefined,
        input.archiveAfterDays ?? null,
      ],
    );
    // A shorter wait archives what has already sat long enough now, not at the next hourly sweep.
    if (input.archiveAfterDays) await archiveDormantWorkItems(req.params.id);
    projectChanged(workspaceId, req.params.id);
    return fetchProject(req.params.id, req.user!.id);
  });

  app.delete<{ Params: { id: string } }>('/projects/:id', async (req, reply) => {
    const access = await assertProjectAccess(req, req.params.id, 'configure');
    const { workspaceId, kind } = access;
    const { rows } = await query<{ created_by: string | null }>('SELECT created_by FROM projects WHERE id = $1', [
      req.params.id,
    ]);
    const own = rows[0]?.created_by === req.user!.id && grants(access, projectPermission(kind, 'create'));
    if (!own && !grants(access, projectPermission(kind, 'delete'))) {
      throw forbidden(`Your role does not let you delete a ${kind} someone else started. You can archive it instead.`);
    }
    // The rows for its items' files cascade away with it, so the files are collected first.
    const { rows: files } = await query<{ storage_key: string }>(
      `SELECT a.storage_key FROM work_item_attachments a
         JOIN work_items i ON i.id = a.work_item_id WHERE i.project_id = $1`,
      [req.params.id],
    );
    await query('DELETE FROM projects WHERE id = $1', [req.params.id]);
    await removeStoredFiles(
      files.map((f) => f.storage_key),
      req.log,
    );
    projectChanged(workspaceId, req.params.id);
    reply.status(204);
  });

  // --- statuses --------------------------------------------------------------

  app.post<{ Params: { id: string } }>('/projects/:id/statuses', async (req, reply) => {
    const { workspaceId } = await assertProjectAccess(req, req.params.id, 'configure');
    const input = parse(createStatusSchema, req.body ?? {});
    const { rows } = await query<ProjectStatus>(
      `INSERT INTO project_statuses (project_id, name, category, color, position)
       VALUES ($1, $2, $3, $4, (SELECT COALESCE(max(position), 0) + 1 FROM project_statuses WHERE project_id = $1))
       RETURNING id, name, category, color, position`,
      [req.params.id, input.name, input.category, input.color ?? '#8f8f9c'],
    );
    projectChanged(workspaceId, req.params.id);
    reply.status(201);
    return rows[0];
  });

  app.patch<{ Params: { id: string } }>('/project-statuses/:id', async (req) => {
    const projectId = await projectOfStatus(req.params.id);
    const { workspaceId } = await assertProjectAccess(req, projectId, 'configure');
    const input = parse(updateStatusSchema, req.body ?? {});
    if (input.category === 'backlog') await assertKeepsBoardStatus(projectId, req.params.id);

    const { rows } = await transaction(async (client) => {
      const result = await client.query<ProjectStatus>(
        `UPDATE project_statuses
            SET name = COALESCE($2, name), category = COALESCE($3, category),
                color = COALESCE($4, color), position = COALESCE($5, position)
          WHERE id = $1
          RETURNING id, name, category, color, position`,
        [req.params.id, input.name ?? null, input.category ?? null, input.color ?? null, input.position ?? null],
      );
      // A status that now means finished, or no longer does, takes its items with it.
      if (input.category) {
        await client.query(
          `UPDATE work_items
              SET completed_at = CASE WHEN $2 = 'done' THEN COALESCE(completed_at, now()) ELSE NULL END,
                  archived_at = CASE WHEN $2 = 'done' THEN archived_at ELSE NULL END
            WHERE status_id = $1`,
          [req.params.id, input.category],
        );
      }
      return result;
    });
    projectChanged(workspaceId, projectId);
    return rows[0];
  });

  app.delete<{ Params: { id: string }; Querystring: { moveTo?: string } }>('/project-statuses/:id', async (req, reply) => {
    const projectId = await projectOfStatus(req.params.id);
    const { workspaceId } = await assertProjectAccess(req, projectId, 'configure');
    const input = parse(deleteStatusSchema, req.query ?? {});

    const { rows } = await query<{ statuses: number; items: number }>(
      `SELECT (SELECT count(*)::int FROM project_statuses WHERE project_id = $1) AS statuses,
              (SELECT count(*)::int FROM work_items WHERE status_id = $2) AS items`,
      [projectId, req.params.id],
    );
    if (rows[0].statuses <= 1) throw badRequest('A project needs at least one status');
    await assertKeepsBoardStatus(projectId, req.params.id);
    if (rows[0].items > 0) {
      if (!input.moveTo || input.moveTo === req.params.id) {
        throw badRequest('Choose where the items in this status should go');
      }
      if ((await projectOfStatus(input.moveTo)) !== projectId) throw badRequest('That status is in another project');
    }

    await transaction(async (client) => {
      if (input.moveTo && rows[0].items > 0) {
        await client.query(
          `UPDATE work_items i
              SET status_id = t.id,
                  position = i.position + (SELECT COALESCE(max(position), 0) FROM work_items WHERE status_id = t.id),
                  completed_at = CASE WHEN t.category = 'done' THEN COALESCE(i.completed_at, now()) ELSE NULL END,
                  archived_at = CASE WHEN t.category = 'done' THEN i.archived_at ELSE NULL END,
                  updated_at = now()
             FROM project_statuses t
            WHERE t.id = $2 AND i.status_id = $1`,
          [req.params.id, input.moveTo],
        );
      }
      await client.query('DELETE FROM project_statuses WHERE id = $1', [req.params.id]);
    });
    projectChanged(workspaceId, projectId);
    reply.status(204);
  });

  // --- roles -----------------------------------------------------------------

  app.post<{ Params: { id: string } }>('/projects/:id/roles', async (req, reply) => {
    const { workspaceId } = await assertProjectAccess(req, req.params.id, 'configure');
    const input = parse(createRoleSchema, req.body ?? {});
    await assertRoleNameFree(req.params.id, input.name);
    const { rows } = await query<ProjectRole>(
      `INSERT INTO project_roles (project_id, name, multiple, free_form, position)
       VALUES ($1, $2, $3, $4, (SELECT COALESCE(max(position), 0) + 1 FROM project_roles WHERE project_id = $1))
       RETURNING id, name, multiple, free_form AS "freeForm", position`,
      [req.params.id, input.name, input.multiple, input.freeForm],
    );
    // A new role applies to every type until someone says otherwise.
    await query(
      `INSERT INTO project_item_type_roles (type_id, role_id)
       SELECT t.id, $2 FROM project_item_types t WHERE t.project_id = $1`,
      [req.params.id, rows[0].id],
    );
    projectChanged(workspaceId, req.params.id);
    reply.status(201);
    return rows[0];
  });

  app.patch<{ Params: { id: string } }>('/project-roles/:id', async (req) => {
    const projectId = await projectOfRole(req.params.id);
    const { workspaceId } = await assertProjectAccess(req, projectId, 'configure');
    const input = parse(updateRoleSchema, req.body ?? {});
    if (input.name) await assertRoleNameFree(projectId, input.name, req.params.id);

    const { rows } = await transaction(async (client) => {
      const result = await client.query<ProjectRole>(
        `UPDATE project_roles
            SET name = COALESCE($2, name), multiple = COALESCE($3, multiple),
                free_form = COALESCE($5, free_form), position = COALESCE($4, position)
          WHERE id = $1
          RETURNING id, name, multiple, free_form AS "freeForm", position`,
        [req.params.id, input.name ?? null, input.multiple ?? null, input.position ?? null, input.freeForm ?? null],
      );
      // A role that no longer takes typed names lets go of the ones it has;
      // there is nowhere left in the app to read or clear them from.
      if (input.freeForm === false) {
        await client.query('DELETE FROM work_item_roles WHERE role_id = $1 AND name IS NOT NULL', [req.params.id]);
      }
      // A role narrowed to one holder keeps whoever was given it first.
      if (input.multiple === false) {
        await client.query(
          `DELETE FROM work_item_roles wr
            WHERE wr.role_id = $1
              AND EXISTS (SELECT 1 FROM work_item_roles earlier
                           WHERE earlier.role_id = wr.role_id AND earlier.work_item_id = wr.work_item_id
                             AND (earlier.created_at, COALESCE(earlier.user_id::text, earlier.name))
                               < (wr.created_at, COALESCE(wr.user_id::text, wr.name)))`,
          [req.params.id],
        );
      }
      return result;
    });
    projectChanged(workspaceId, projectId);
    return rows[0];
  });

  app.delete<{ Params: { id: string } }>('/project-roles/:id', async (req, reply) => {
    const projectId = await projectOfRole(req.params.id);
    const { workspaceId } = await assertProjectAccess(req, projectId, 'configure');
    await query('DELETE FROM project_roles WHERE id = $1', [req.params.id]);
    projectChanged(workspaceId, projectId);
    reply.status(204);
  });

  // --- workflows -------------------------------------------------------------

  /** One workflow, read back the way `fetchProject` builds them. */
  async function fetchWorkflow(id: string): Promise<ProjectWorkflow> {
    const { rows } = await query<ProjectWorkflow>(
      `SELECT w.id, w.name, w.position, ${TRANSITIONS_JSON} AS transitions
         FROM project_workflows w WHERE w.id = $1`,
      [id],
    );
    if (!rows[0]) throw notFound('Workflow not found');
    return rows[0];
  }

  app.post<{ Params: { id: string } }>('/projects/:id/workflows', async (req, reply) => {
    const { workspaceId } = await assertProjectAccess(req, req.params.id, 'configure');
    const input = parse(createWorkflowSchema, req.body ?? {});
    await assertWorkflowNameFree(req.params.id, input.name);
    const { rows } = await query<{ id: string }>(
      `INSERT INTO project_workflows (project_id, name, position)
       VALUES ($1, $2, (SELECT COALESCE(max(position), 0) + 1 FROM project_workflows WHERE project_id = $1))
       RETURNING id`,
      [req.params.id, input.name],
    );
    projectChanged(workspaceId, req.params.id);
    reply.status(201);
    return fetchWorkflow(rows[0].id);
  });

  app.patch<{ Params: { id: string } }>('/project-workflows/:id', async (req) => {
    const projectId = await projectOfWorkflow(req.params.id);
    const { workspaceId } = await assertProjectAccess(req, projectId, 'configure');
    const input = parse(updateWorkflowSchema, req.body ?? {});
    if (input.name) await assertWorkflowNameFree(projectId, input.name, req.params.id);

    // Both ends of every move have to be statuses of this project.
    const moves = Object.entries(input.transitions ?? {}).flatMap(([from, tos]) =>
      [...new Set(tos)].filter((to) => to !== from).map((to) => ({ from, to })),
    );
    if (moves.length > 0) {
      const { rows } = await query<{ count: number }>(
        `SELECT count(*)::int AS count FROM project_statuses
          WHERE project_id = $1 AND id = ANY($2::uuid[])`,
        [projectId, [...new Set(moves.flatMap((m) => [m.from, m.to]))]],
      );
      if (rows[0].count !== new Set(moves.flatMap((m) => [m.from, m.to])).size) {
        throw badRequest('A workflow can only move work between this project\'s own statuses');
      }
    }

    await transaction(async (client) => {
      await client.query(
        'UPDATE project_workflows SET name = COALESCE($2, name), position = COALESCE($3, position) WHERE id = $1',
        [req.params.id, input.name ?? null, input.position ?? null],
      );
      // The moves are replaced wholesale, so what is not sent is no longer allowed.
      if (input.transitions) {
        await client.query('DELETE FROM project_workflow_transitions WHERE workflow_id = $1', [req.params.id]);
        if (moves.length > 0) {
          await client.query(
            `INSERT INTO project_workflow_transitions (workflow_id, from_status, to_status)
             SELECT $1, m.from_status, m.to_status
               FROM unnest($2::uuid[], $3::uuid[]) AS m(from_status, to_status)`,
            [req.params.id, moves.map((m) => m.from), moves.map((m) => m.to)],
          );
        }
      }
    });
    projectChanged(workspaceId, projectId);
    return fetchWorkflow(req.params.id);
  });

  app.delete<{ Params: { id: string } }>('/project-workflows/:id', async (req, reply) => {
    const projectId = await projectOfWorkflow(req.params.id);
    const { workspaceId } = await assertProjectAccess(req, projectId, 'configure');
    // The types that followed it lose their row too, and move freely again.
    await query('DELETE FROM project_workflows WHERE id = $1', [req.params.id]);
    projectChanged(workspaceId, projectId);
    reply.status(204);
  });

  // --- item types --------------------------------------------------------------

  async function fetchItemType(id: string): Promise<ProjectItemType> {
    const { rows } = await query<{ type: ProjectItemType }>(
      `SELECT ${ITEM_TYPE_JSON} AS type FROM project_item_types t WHERE t.id = $1`,
      [id],
    );
    if (!rows[0]) throw notFound('Type not found');
    return rows[0].type;
  }

  /** The role ids given, checked to be this project's; every role when none are given. */
  async function projectRoleIds(projectId: string, roleIds: string[] | undefined): Promise<string[]> {
    const { rows } = await query<{ id: string }>('SELECT id FROM project_roles WHERE project_id = $1', [projectId]);
    const all = rows.map((r) => r.id);
    if (roleIds === undefined) return all;
    const wanted = [...new Set(roleIds)];
    if (wanted.some((id) => !all.includes(id))) throw badRequest('That role is not in this project');
    return wanted;
  }

  app.post<{ Params: { id: string } }>('/projects/:id/item-types', async (req, reply) => {
    const { workspaceId } = await assertProjectAccess(req, req.params.id, 'configure');
    const input = parse(createItemTypeSchema, req.body ?? {});
    await assertItemTypeNameFree(req.params.id, input.name);
    const roleIds = await projectRoleIds(req.params.id, input.roleIds);
    const id = await transaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO project_item_types (project_id, name, icon, color, epic, position)
         VALUES ($1, $2, $3, $4, $5, (SELECT COALESCE(max(position), 0) + 1 FROM project_item_types WHERE project_id = $1))
         RETURNING id`,
        [req.params.id, input.name, input.icon ?? 'check2-square', input.color ?? '#0ea5e9', input.epic ?? false],
      );
      await client.query(
        'INSERT INTO project_item_type_roles (type_id, role_id) SELECT $1, unnest($2::uuid[])',
        [rows[0].id, roleIds],
      );
      return rows[0].id;
    });
    projectChanged(workspaceId, req.params.id);
    reply.status(201);
    return fetchItemType(id);
  });

  /**
   * Changes a type: how it looks, where it sits, the workflow its items follow,
   * and which roles apply to them. A role taken away is taken off every item of
   * the type that had someone in it, and each item's history says so.
   */
  app.patch<{ Params: { id: string } }>('/project-item-types/:id', async (req) => {
    const type = await itemTypeRow(req.params.id);
    const { workspaceId } = await assertProjectAccess(req, type.projectId, 'configure');
    const input = parse(updateItemTypeSchema, req.body ?? {});
    if (input.name) await assertItemTypeNameFree(type.projectId, input.name, req.params.id);
    if (input.workflowId && (await projectOfWorkflow(input.workflowId)) !== type.projectId) {
      throw badRequest('That workflow is in another project');
    }
    const roleIds = input.roleIds ? await projectRoleIds(type.projectId, input.roleIds) : null;

    await transaction(async (client) => {
      await client.query(
        `UPDATE project_item_types
            SET name = COALESCE($2, name), icon = COALESCE($3, icon), color = COALESCE($4, color),
                position = COALESCE($5, position),
                workflow_id = CASE WHEN $6::boolean THEN $7::uuid ELSE workflow_id END
          WHERE id = $1`,
        [
          req.params.id,
          input.name ?? null,
          input.icon ?? null,
          input.color ?? null,
          input.position ?? null,
          input.workflowId !== undefined,
          input.workflowId ?? null,
        ],
      );
      if (roleIds) {
        await client.query('DELETE FROM project_item_type_roles WHERE type_id = $1', [req.params.id]);
        await client.query('INSERT INTO project_item_type_roles (type_id, role_id) SELECT $1, unnest($2::uuid[])', [
          req.params.id,
          roleIds,
        ]);
        await pruneRoles(client, `i.type_id = $1`, [req.params.id], req.user!.id);
      }
    });
    projectChanged(workspaceId, type.projectId);
    return fetchItemType(req.params.id);
  });

  /**
   * Deletes a type. Its items become another type, which must be given when
   * there are any; becoming or ceasing to be epic-kind takes them out of
   * sprints and epics, or lets go of what was under them, as changing one
   * item's type would. A project keeps at least one type new work can start as.
   */
  app.delete<{ Params: { id: string }; Querystring: { moveTo?: string } }>('/project-item-types/:id', async (req, reply) => {
    const type = await itemTypeRow(req.params.id);
    const { workspaceId } = await assertProjectAccess(req, type.projectId, 'configure');
    const input = parse(deleteItemTypeSchema, req.query ?? {});
    const project = await fetchProject(type.projectId, req.user!.id);
    const others = project.itemTypes.filter((t) => t.id !== type.id);
    if (!type.epic && !others.some((t) => !t.epic)) {
      throw badRequest('A project needs at least one type that is not an epic, for new work to start as');
    }

    const { rows } = await query<{ count: number }>('SELECT count(*)::int AS count FROM work_items WHERE type_id = $1', [
      req.params.id,
    ]);
    const target = input.moveTo ? others.find((t) => t.id === input.moveTo) : null;
    if (input.moveTo && !target) throw badRequest('Move its work to another type in this project');
    if (rows[0].count > 0 && !target) throw badRequest(`Choose a type for the ${rows[0].count} work items that are ${type.name}`);

    await transaction(async (client) => {
      if (target && rows[0].count > 0) {
        if (type.epic && !target.epic) {
          await client.query(
            `UPDATE work_items SET epic_id = NULL, updated_at = now()
              WHERE epic_id IN (SELECT id FROM work_items WHERE type_id = $1)`,
            [req.params.id],
          );
        }
        await client.query(
          `UPDATE work_items
              SET type_id = $2,
                  sprint_id = CASE WHEN $3 THEN NULL ELSE sprint_id END,
                  epic_id = CASE WHEN $3 THEN NULL ELSE epic_id END,
                  updated_at = now()
            WHERE type_id = $1`,
          [req.params.id, target.id, target.epic && !type.epic],
        );
        await pruneRoles(client, 'i.type_id = $1', [target.id], req.user!.id);
      }
      // The default moves on with the work, or to the first type that can be one.
      const fallback = target && !target.epic ? target : others.find((t) => !t.epic)!;
      await client.query('UPDATE projects SET default_type_id = $2 WHERE id = $1 AND default_type_id = $3', [
        type.projectId,
        fallback.id,
        req.params.id,
      ]);
      await client.query('DELETE FROM project_item_types WHERE id = $1', [req.params.id]);
    });
    projectChanged(workspaceId, type.projectId);
    reply.status(204);
  });

  // --- sprints -----------------------------------------------------------------

  async function fetchSprint(id: string): Promise<ProjectSprint> {
    const { rows } = await query<ProjectSprint>(`SELECT ${SPRINT_COLUMNS} FROM project_sprints sp WHERE sp.id = $1`, [id]);
    if (!rows[0]) throw notFound('Sprint not found');
    return rows[0];
  }

  function assertDates(start: string | null | undefined, end: string | null | undefined): void {
    if (start && end && end < start) throw badRequest('A sprint cannot end before it starts');
  }

  app.post<{ Params: { id: string } }>('/projects/:id/sprints', async (req, reply) => {
    const { workspaceId } = await assertProjectAccess(req, req.params.id, 'sprints');
    const input = parse(createSprintSchema, req.body ?? {});
    assertDates(input.startDate, input.endDate);
    const { rows } = await query<{ id: string }>(
      `INSERT INTO project_sprints (project_id, name, goal, start_date, end_date)
       VALUES ($1, COALESCE(NULLIF($2, ''), 'Sprint ' || ((SELECT count(*) FROM project_sprints WHERE project_id = $1) + 1)),
               $3, $4, $5)
       RETURNING id`,
      [req.params.id, input.name ?? null, input.goal ?? '', input.startDate ?? null, input.endDate ?? null],
    );
    projectChanged(workspaceId, req.params.id);
    reply.status(201);
    return fetchSprint(rows[0].id);
  });

  app.patch<{ Params: { id: string } }>('/project-sprints/:id', async (req) => {
    const sprint = await sprintRow(req.params.id);
    const { workspaceId } = await assertProjectAccess(req, sprint.projectId, 'sprints');
    const input = parse(updateSprintSchema, req.body ?? {});
    const { rows } = await query<{ start: string | null; end: string | null }>(
      `SELECT to_char(start_date, 'YYYY-MM-DD') AS start, to_char(end_date, 'YYYY-MM-DD') AS "end"
         FROM project_sprints WHERE id = $1`,
      [req.params.id],
    );
    assertDates(
      input.startDate !== undefined ? input.startDate : rows[0].start,
      input.endDate !== undefined ? input.endDate : rows[0].end,
    );
    await query(
      `UPDATE project_sprints
          SET name = COALESCE($2, name), goal = COALESCE($3, goal),
              start_date = CASE WHEN $4::boolean THEN $5::date ELSE start_date END,
              end_date = CASE WHEN $6::boolean THEN $7::date ELSE end_date END
        WHERE id = $1`,
      [
        req.params.id,
        input.name ?? null,
        input.goal ?? null,
        input.startDate !== undefined,
        input.startDate ?? null,
        input.endDate !== undefined,
        input.endDate ?? null,
      ],
    );
    projectChanged(workspaceId, sprint.projectId);
    return fetchSprint(req.params.id);
  });

  /**
   * Starts a planned sprint. Its work waiting in backlog statuses goes onto the
   * board, since the board is what a running sprint is worked from.
   */
  app.post<{ Params: { id: string } }>('/project-sprints/:id/start', async (req) => {
    const sprint = await sprintRow(req.params.id);
    const { workspaceId, role } = await assertProjectAccess(req, sprint.projectId, 'sprints');
    const input = parse(startSprintSchema, req.body ?? {});
    assertDates(input.startDate, input.endDate);
    if (sprint.state !== 'planned') throw badRequest(`${sprint.name} has already been started`);
    const project = await fetchProject(sprint.projectId, req.user!.id);
    const running = project.sprints.find((s) => s.state === 'active');
    if (running) throw conflict(`${running.name} is still running. Complete it before starting another.`);

    await transaction(async (client) => {
      await client.query(
        `UPDATE project_sprints
            SET state = 'active', start_date = $2, end_date = $3, started_at = now()
          WHERE id = $1`,
        [req.params.id, input.startDate, input.endDate],
      );
      if (input.includeBoard) {
        const { rows } = await client.query<{ id: string }>(
          `SELECT i.id FROM work_items i JOIN project_statuses st ON st.id = i.status_id
            WHERE i.project_id = $1 AND i.sprint_id IS NULL AND NOT ${IS_EPIC} AND st.category IN ('todo', 'active')
            ORDER BY i.position, i.number`,
          [sprint.projectId],
        );
        const joining = await placingItems(client, sprint.projectId, rows.map((r) => r.id));
        // Already on the board, so nothing moves; the sprint only takes them in.
        await placeInSprint(client, project, role, joining, { ...sprint, state: 'planned' }, req.user!.id);
      }
      const { rows: waiting } = await client.query<{ id: string }>(
        `SELECT i.id FROM work_items i JOIN project_statuses st ON st.id = i.status_id
          WHERE i.sprint_id = $1 AND st.category = 'backlog'
          ORDER BY i.position, i.number`,
        [req.params.id],
      );
      const items = await placingItems(client, sprint.projectId, waiting.map((r) => r.id));
      const statusName = (id: string) => project.statuses.find((s) => s.id === id)?.name ?? 'Backlog';
      await moveOntoBoard(client, items, boardEntries(project, role, items), statusName, req.user!.id);
    });

    projectChanged(workspaceId, sprint.projectId);
    return fetchProject(sprint.projectId, req.user!.id);
  });

  /**
   * Completes the running sprint. What was finished stays in it, as the record
   * of what it got done; what was not goes on to a planned sprint, or back to
   * the backlog. Nothing changes status: unfinished work is where it was left.
   */
  app.post<{ Params: { id: string } }>('/project-sprints/:id/complete', async (req) => {
    const sprint = await sprintRow(req.params.id);
    const { workspaceId, role } = await assertProjectAccess(req, sprint.projectId, 'sprints');
    const input = parse(completeSprintSchema, req.body ?? {});
    if (sprint.state !== 'active') throw badRequest(`${sprint.name} is not running`);
    const next = input.moveTo ? await openSprintOf(sprint.projectId, input.moveTo) : null;
    if (next?.id === sprint.id) throw badRequest('Choose another sprint for the unfinished work');
    const project = await fetchProject(sprint.projectId, req.user!.id);

    await transaction(async (client) => {
      await client.query(`UPDATE project_sprints SET state = 'completed', completed_at = now() WHERE id = $1`, [
        req.params.id,
      ]);
      const { rows } = await client.query<{ id: string }>(
        `SELECT i.id FROM work_items i JOIN project_statuses st ON st.id = i.status_id
          WHERE i.sprint_id = $1 AND st.category <> 'done'
          ORDER BY i.position, i.number`,
        [req.params.id],
      );
      const unfinished = await placingItems(client, sprint.projectId, rows.map((r) => r.id));
      await placeInSprint(client, project, role, unfinished, next, req.user!.id);
    });

    projectChanged(workspaceId, sprint.projectId);
    return fetchProject(sprint.projectId, req.user!.id);
  });

  /** Deletes a sprint that is not running. Its work goes back to the backlog. */
  app.delete<{ Params: { id: string } }>('/project-sprints/:id', async (req, reply) => {
    const sprint = await sprintRow(req.params.id);
    const { workspaceId } = await assertProjectAccess(req, sprint.projectId, 'sprints');
    if (sprint.state === 'active') throw badRequest(`${sprint.name} is running. Complete it before deleting it.`);
    await query('DELETE FROM project_sprints WHERE id = $1', [req.params.id]);
    projectChanged(workspaceId, sprint.projectId);
    reply.status(204);
  });

  /** Puts many items in one sprint, or back in the backlog with null. */
  app.post<{ Params: { id: string } }>('/projects/:id/items/sprint', async (req) => {
    const { workspaceId, role } = await assertProjectAccess(req, req.params.id, 'sprints');
    const input = parse(setWorkItemsSprintSchema, req.body ?? {});
    const sprint = input.sprintId ? await openSprintOf(req.params.id, input.sprintId) : null;
    const project = await fetchProject(req.params.id, req.user!.id);
    const moved = await transaction(async (client) => {
      const items = await placingItems(client, req.params.id, [...new Set(input.itemIds)]);
      return placeInSprint(client, project, role, items, sprint, req.user!.id);
    });
    projectChanged(workspaceId, req.params.id);
    return { moved };
  });

  // --- work items --------------------------------------------------------------

  /**
   * A project's current work: everything but the archive, which is what the
   * board, the list and the rest show. The archive is read a page at a time
   * from `/projects/:id/archive`.
   */
  app.get<{ Params: { id: string } }>('/projects/:id/items', async (req) => {
    await assertProjectAccess(req, req.params.id);
    const { rows } = await query<WorkItemSummary>(
      `SELECT ${ITEM_COLUMNS}
         FROM work_items i JOIN projects p ON p.id = i.project_id
        WHERE i.project_id = $1 AND i.archived_at IS NULL
        ORDER BY i.position, i.number
        LIMIT ${MAX_LISTED_ITEMS}`,
      [req.params.id],
    );
    return rows;
  });

  /**
   * A page of a project's archive, filtered and ordered here since no reader
   * holds all of it. Pages are keyed rather than counted: the cursor is where
   * the last page ended, so items archived while someone scrolls neither
   * repeat nor go missing from what they have not reached yet.
   */
  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>(
    '/projects/:id/archive',
    async (req): Promise<ArchivePage> => {
      await assertProjectAccess(req, req.params.id);
      const input = parse(archivePageQuerySchema, req.query ?? {});
      // `parse` types what it returns as what was sent, so the defaults are applied again here.
      const order = ARCHIVE_ORDER[input.sort ?? 'updated'];
      const descending = input.descending !== 'false';
      const limit = input.limit ?? ARCHIVE_PAGE_SIZE;

      const params: unknown[] = [req.params.id];
      const where = ['i.project_id = $1', 'i.archived_at IS NOT NULL'];
      if (input.q) {
        // Taken literally, as the filter box takes it.
        params.push(input.q.replace(/[\\%_]/g, (c) => `\\${c}`));
        const q = `$${params.length}`;
        where.push(`(i.title ILIKE '%' || ${q} || '%' OR (p.key || '-' || i.number) ILIKE '%' || ${q} || '%')`);
      }
      if (input.person) {
        params.push(input.person);
        where.push(`EXISTS (SELECT 1 FROM work_item_roles wr WHERE wr.work_item_id = i.id AND wr.user_id = $${params.length})`);
      }
      if (input.completedSince) {
        params.push(input.completedSince);
        where.push(`i.completed_at >= $${params.length}`);
      }
      const filtered = [...where];
      const filterParams = [...params];

      if (input.cursor) {
        const [value, number] = decodeCursor(input.cursor, order.check, isInteger);
        params.push(value, number);
        where.push(`(${order.expr}, i.number) ${descending ? '<' : '>'} ($${params.length - 1}::${order.type}, $${params.length}::int)`);
      }
      const direction = descending ? 'DESC' : 'ASC';
      params.push(limit + 1);

      const [{ rows }, { rows: counted }] = await Promise.all([
        query<WorkItemSummary & { sortValue: string }>(
          `SELECT ${ITEM_COLUMNS}, (${order.expr})::text AS "sortValue"
             FROM work_items i
             JOIN projects p ON p.id = i.project_id
             JOIN project_statuses st ON st.id = i.status_id
            WHERE ${where.join(' AND ')}
            ORDER BY ${order.expr} ${direction}, i.number ${direction}
            LIMIT $${params.length}`,
          params,
        ),
        query<{ total: number }>(
          `SELECT count(*)::int AS total
             FROM work_items i JOIN projects p ON p.id = i.project_id
            WHERE ${filtered.join(' AND ')}`,
          filterParams,
        ),
      ]);

      // One more than a page was asked for, to know whether there is another.
      const more = rows.length > limit;
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        items: page.map(({ sortValue: _, ...item }) => item),
        nextCursor: more && last ? encodeCursor(last.sortValue, last.number) : null,
        total: counted[0].total,
      };
    },
  );

  /**
   * When each item first had a response, for a queue's insights: the first
   * comment from anyone but whoever filed it, the first move to another status,
   * or its being finished, whichever came first. Filing an item is not a status
   * move, so a status change always means someone picked it up.
   *
   * Only what insights can use: current work, which is where anything still
   * awaiting a response is, and whatever was filed since `createdSince`.
   */
  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>(
    '/projects/:id/responses',
    async (req): Promise<WorkItemResponses> => {
      await assertProjectAccess(req, req.params.id);
      const input = parse(responsesQuerySchema, req.query ?? {});
      const { rows } = await query<{ id: string; respondedAt: string | null }>(
        `SELECT i.id, LEAST(
                  (SELECT min(c.created_at) FROM work_item_comments c
                    WHERE c.work_item_id = i.id AND c.author_id IS DISTINCT FROM i.created_by),
                  (SELECT min(a.created_at) FROM work_item_activity a
                    WHERE a.work_item_id = i.id AND a.data->>'kind' = 'status'),
                  i.completed_at) AS "respondedAt"
           FROM work_items i
          WHERE i.project_id = $1 AND (i.archived_at IS NULL OR i.created_at >= $2)`,
        [req.params.id, input.createdSince],
      );
      return Object.fromEntries(rows.filter((r) => r.respondedAt).map((r) => [r.id, r.respondedAt!]));
    },
  );

  app.post<{ Params: { id: string } }>('/projects/:id/items', async (req, reply) => {
    const { workspaceId } = await assertProjectAccess(req, req.params.id, 'items');
    const parsed = parse(createWorkItemSchema, req.body ?? {});
    const input = { ...parsed, description: parsed.description ?? '' };
    const project = await fetchProject(req.params.id, req.user!.id);
    if (project.archivedAt) throw badRequest('This project is archived. Restore it to add work to it.');

    const type = itemTypeOf(project, input.typeId ?? project.defaultTypeId);
    if (!type) throw badRequest('That type is not in this project');
    let status = input.statusId ? project.statuses.find((s) => s.id === input.statusId) : project.statuses[0];
    if (!status) throw badRequest('That status is not in this project');
    if (type.epic && input.sprintId) throw badRequest(`${type.name} items are not planned in sprints; put the work under one in a sprint instead.`);
    if (type.epic && input.epicId) throw badRequest(`${type.name} items cannot be put under an epic`);
    const sprint = input.sprintId ? await openSprintOf(req.params.id, input.sprintId) : null;
    const epic = input.epicId ? await epicOf(req.params.id, input.epicId) : null;
    // New work in a running sprint starts on the board, where the sprint is worked.
    if (sprint?.state === 'active' && status.category === 'backlog') {
      const entry = project.statuses.find((s) => s.category === 'todo') ?? project.statuses.find((s) => s.category !== 'backlog');
      if (entry) status = entry;
    }

    const roleIds = new Set([...Object.keys(input.roles ?? {}), ...Object.keys(input.roleNames ?? {})]);
    const roles = [...roleIds].map((roleId) => {
      const role = project.roles.find((r) => r.id === roleId);
      if (!role) throw badRequest('That role is not in this project');
      if (!type.roleIds.includes(role.id)) throw badRequest(`${role.name} is not a role on ${type.name} items`);
      const userIds = [...new Set(input.roles?.[roleId] ?? [])];
      const names = uniqueNames(input.roleNames?.[roleId]);
      assertRoleFits(role, userIds, names);
      return { role, userIds, names };
    });
    await assertMembers(workspaceId, [...new Set(roles.flatMap((r) => r.userIds))]);

    const id = await transaction(async (client) => {
      const { rows: numbered } = await client.query<{ number: number }>(
        'UPDATE projects SET next_number = next_number + 1, updated_at = now() WHERE id = $1 RETURNING next_number - 1 AS number',
        [req.params.id],
      );
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO work_items (project_id, workspace_id, number, title, description, type_id, priority, status_id,
                                 position, due_date, estimate, created_by, completed_at, sprint_id, epic_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CASE WHEN $13 THEN now() END, $14, $15)
         RETURNING id`,
        [
          req.params.id,
          workspaceId,
          numbered[0].number,
          input.title,
          input.description,
          type.id,
          input.priority,
          status.id,
          await endOfStatus(client, status.id),
          input.dueDate ?? null,
          input.estimate ?? null,
          req.user!.id,
          status.category === 'done',
          sprint?.id ?? null,
          epic?.id ?? null,
        ],
      );
      const itemId = rows[0].id;
      for (const { role, userIds, names } of roles) {
        await insertRoleHolders(client, itemId, role.id, userIds, names);
      }
      await logActivity(client, itemId, req.user!.id, { kind: 'created' });
      return itemId;
    });

    await recordItemMentions(req, id, workspaceId);
    for (const { role, userIds } of roles) await tell(req, id, userIds, 'role', role.name);
    await tell(req, id, textMembers([input.description]), 'mention');
    projectChanged(workspaceId, req.params.id, id);
    reply.status(201);
    return fetchItem(id, workspaceId, req.user!.id);
  });

  /**
   * Moves several items into one status at once, in the order given, after
   * whatever is already there. It is how planned work leaves the backlog: a
   * hundred items picked and put on the board is one request and one change.
   */
  app.post<{ Params: { id: string } }>('/projects/:id/items/move', async (req) => {
    const { workspaceId, role } = await assertProjectAccess(req, req.params.id, 'items');
    const input = parse(moveWorkItemsSchema, req.body ?? {});
    const project = await fetchProject(req.params.id, req.user!.id);
    const target = project.statuses.find((s) => s.id === input.statusId);
    if (!target) throw badRequest('That status is not in this project');
    const itemIds = [...new Set(input.itemIds)];

    const { rows: moving } = await query<{ key: string; type_id: string; status_id: string }>(
      `SELECT p.key || '-' || i.number AS key, i.type_id, i.status_id
         FROM work_items i JOIN projects p ON p.id = i.project_id
        WHERE i.id = ANY($1::uuid[]) AND i.project_id = $2`,
      [itemIds, req.params.id],
    );
    assertMoveAllowed(
      project,
      role,
      moving.map((item) => ({ key: item.key, typeId: item.type_id, from: item.status_id, to: target.id })),
    );

    const moved = await transaction(async (client) => {
      const { rows } = await client.query<{ id: string; from_name: string }>(
        `SELECT i.id, st.name AS from_name
           FROM unnest($1::uuid[]) WITH ORDINALITY AS picked(id, n)
           JOIN work_items i ON i.id = picked.id AND i.project_id = $2
           JOIN project_statuses st ON st.id = i.status_id
          WHERE i.status_id <> $3
          ORDER BY picked.n`,
        [itemIds, req.params.id, target.id],
      );
      if (rows.length === 0) return 0;
      const start = await endOfStatus(client, target.id);
      await client.query(
        `UPDATE work_items i
            SET status_id = $2,
                position = $3 + picked.n - 1,
                completed_at = CASE WHEN $4 = 'done' THEN COALESCE(i.completed_at, now()) ELSE NULL END,
                archived_at = CASE WHEN $4 = 'done' THEN i.archived_at ELSE NULL END,
                updated_at = now()
           FROM unnest($1::uuid[]) WITH ORDINALITY AS picked(id, n)
          WHERE i.id = picked.id`,
        [rows.map((r) => r.id), target.id, start, target.category],
      );
      await client.query(
        `INSERT INTO work_item_activity (work_item_id, actor_id, data)
         SELECT m.id, $3, jsonb_build_object('kind', 'status', 'from', m.from_name, 'to', $4::text)
           FROM unnest($1::uuid[], $2::text[]) AS m(id, from_name)`,
        [rows.map((r) => r.id), rows.map((r) => r.from_name), req.user!.id, target.name],
      );
      return rows.length;
    });

    projectChanged(workspaceId, req.params.id);
    return { moved };
  });

  app.get<{ Params: { id: string } }>('/work-items/:id', async (req) => {
    const { workspaceId } = await assertWorkItemAccess(req, req.params.id);
    return fetchItem(req.params.id, workspaceId, req.user!.id);
  });

  app.patch<{ Params: { id: string } }>('/work-items/:id', async (req) => {
    const { workspaceId, projectId, role } = await assertWorkItemAccess(req, req.params.id, 'items');
    const input = parse(updateWorkItemSchema, req.body ?? {});

    const { rows: before } = await query<{
      key: string;
      title: string;
      description: string;
      type_id: string;
      priority: WorkItem['priority'];
      status_id: string;
      status_name: string;
      status_category: StatusCategory;
      sprint_id: string | null;
      epic_id: string | null;
      epic_title: string | null;
      archived: boolean;
    }>(
      `SELECT p.key || '-' || i.number AS key, i.title, i.description, i.type_id, i.priority, i.status_id,
              st.name AS status_name, st.category AS status_category, i.sprint_id, i.epic_id, e.title AS epic_title,
              i.archived_at IS NOT NULL AS archived
         FROM work_items i
         JOIN projects p ON p.id = i.project_id
         JOIN project_statuses st ON st.id = i.status_id
         LEFT JOIN work_items e ON e.id = i.epic_id
        WHERE i.id = $1`,
      [req.params.id],
    );
    const current = before[0];
    const project = await fetchProject(projectId, req.user!.id);
    const type = itemTypeOf(project, input.typeId ?? current.type_id);
    if (!type) throw badRequest('That type is not in this project');
    const changingType = type.id !== current.type_id;

    let target: { id: string; name: string; category: StatusCategory } | null = null;
    if (input.statusId && input.statusId !== current.status_id) {
      const status = project.statuses.find((s) => s.id === input.statusId);
      if (!status) throw badRequest('That status is not in this project');
      // The type it is being given, if it is being given one, is the type it moves as.
      assertMoveAllowed(project, role, [{ key: current.key, typeId: type.id, from: current.status_id, to: status.id }]);
      target = status;
    }

    // Only finished work is archived, so it has to be done once this change is made.
    const archiving = input.archived === true && !current.archived;
    const restoring = input.archived === false && current.archived;
    if (archiving && (target?.category ?? current.status_category) !== 'done') {
      throw badRequest('Only finished work can be archived');
    }
    // Moving it out of done takes it out of the archive, with no need to say so.
    const reopening = current.archived && target !== null && target.category !== 'done';

    // An epic sits above sprints and other epics: becoming one leaves both.
    const wasEpic = isEpicType(project, current.type_id);
    const becomingEpic = type.epic && !wasEpic;
    const leavingEpic = wasEpic && !type.epic;
    if (type.epic && input.sprintId) throw badRequest(`${type.name} items are not planned in sprints; put the work under one in a sprint instead.`);
    if (type.epic && input.epicId) throw badRequest(`${type.name} items cannot be put under an epic`);
    if (input.epicId === req.params.id) throw badRequest('A work item cannot be put under itself');
    const changingEpic =
      (input.epicId !== undefined && (input.epicId ?? null) !== current.epic_id) || (becomingEpic && current.epic_id !== null);
    const epic = changingEpic && input.epicId ? await epicOf(projectId, input.epicId) : null;

    // Changing sprint is done after everything else, from wherever that left it.
    const changingSprint =
      (input.sprintId !== undefined && (input.sprintId ?? null) !== current.sprint_id) ||
      (becomingEpic && current.sprint_id !== null);
    const sprint = changingSprint && input.sprintId ? await openSprintOf(projectId, input.sprintId) : null;
    const sprintProject = changingSprint ? project : null;

    await transaction(async (client) => {
      // Moved into another status with nowhere in particular to go: the end of it.
      const position = input.position ?? (target ? await endOfStatus(client, target.id) : null);
      await client.query(
        `UPDATE work_items
            SET title = COALESCE($2, title),
                description = COALESCE($3, description),
                type_id = COALESCE($4, type_id),
                priority = COALESCE($5, priority),
                status_id = COALESCE($6, status_id),
                position = COALESCE($7, position),
                due_date = CASE WHEN $8::boolean THEN $9::date ELSE due_date END,
                estimate = CASE WHEN $10::boolean THEN $11::numeric ELSE estimate END,
                completed_at = CASE
                  WHEN $12::text IS NULL THEN completed_at
                  WHEN $12 = 'done' THEN COALESCE(completed_at, now())
                  ELSE NULL
                END,
                archived_at = CASE
                  WHEN $13::boolean THEN now()
                  WHEN $14::boolean OR ($12::text IS NOT NULL AND $12 <> 'done') THEN NULL
                  ELSE archived_at
                END,
                updated_at = now()
          WHERE id = $1`,
        [
          req.params.id,
          input.title ?? null,
          input.description ?? null,
          changingType ? type.id : null,
          input.priority ?? null,
          target?.id ?? null,
          position,
          input.dueDate !== undefined,
          input.dueDate ?? null,
          input.estimate !== undefined,
          input.estimate ?? null,
          target?.category ?? null,
          archiving,
          restoring,
        ],
      );
      const actor = req.user!.id;
      if (target) await logActivity(client, req.params.id, actor, { kind: 'status', from: current.status_name, to: target.name });
      if (archiving) await logActivity(client, req.params.id, actor, { kind: 'archived' });
      if (restoring && !reopening) await logActivity(client, req.params.id, actor, { kind: 'restored' });
      if (input.priority && input.priority !== current.priority) {
        await logActivity(client, req.params.id, actor, { kind: 'priority', from: current.priority, to: input.priority });
      }
      if (input.title && input.title !== current.title) {
        await logActivity(client, req.params.id, actor, { kind: 'title', from: current.title, to: input.title });
      }
      // Roles its new type does not offer are taken off it.
      if (changingType) await pruneRoles(client, 'i.id = $1', [req.params.id], actor);
      if (changingEpic) {
        await client.query('UPDATE work_items SET epic_id = $2 WHERE id = $1', [req.params.id, epic?.id ?? null]);
        await logActivity(client, req.params.id, actor, { kind: 'epic', from: current.epic_title, to: epic?.title ?? null });
      }
      // No longer an epic: what was under it is under nothing now, and each says so.
      if (leavingEpic) {
        const { rows: freed } = await client.query<{ id: string }>(
          'UPDATE work_items SET epic_id = NULL, updated_at = now() WHERE epic_id = $1 RETURNING id',
          [req.params.id],
        );
        for (const child of freed) {
          await logActivity(client, child.id, actor, { kind: 'epic', from: input.title ?? current.title, to: null });
        }
      }
      if (sprintProject) {
        // The type was written above, so an item becoming an epic leaves its sprint as one.
        const items = await placingItems(client, projectId, [req.params.id]);
        await placeInSprint(client, sprintProject, role, items, sprint, actor);
      }
    });

    if (input.description !== undefined && input.description !== current.description) {
      await recordItemMentions(req, req.params.id, workspaceId);
      // Only people newly named are told; editing a typo elsewhere is not news to them.
      const already = new Set(textMembers([current.description]));
      await tell(req, req.params.id, textMembers([input.description]).filter((id) => !already.has(id)), 'mention');
    }
    projectChanged(workspaceId, projectId, req.params.id);
    // Its status and title are shown on every item linked to it.
    if (target || (input.title && input.title !== current.title)) await linkedChanged(req.params.id, workspaceId);
    return fetchItem(req.params.id, workspaceId, req.user!.id);
  });

  // --- links -------------------------------------------------------------------

  /** The items this one is linked to, those the reader may see, grouped the way the panel lists them. */
  app.get<{ Params: { id: string } }>('/work-items/:id/links', async (req): Promise<WorkItemLink[]> => {
    const { workspaceId } = await assertWorkItemAccess(req, req.params.id);
    const role = roleIdSql('$2', '$3');
    const { rows } = await query<WorkItemLink>(
      `SELECT l.id, l.type,
              CASE WHEN l.source_id = $1 THEN 'outward' ELSE 'inward' END AS direction,
              json_build_object('id', i.id, 'projectId', i.project_id, 'key', p.key || '-' || i.number,
                                'title', i.title, 'itemType', ${ITEM_TYPE_LOOK},
                                'status', json_build_object('name', st.name, 'color', st.color, 'category', st.category)) AS item,
              l.created_at AS "createdAt"
         FROM work_item_links l
         JOIN work_items i ON i.id = CASE WHEN l.source_id = $1 THEN l.target_id ELSE l.source_id END
         JOIN projects p ON p.id = i.project_id
         JOIN project_statuses st ON st.id = i.status_id
        WHERE (l.source_id = $1 OR l.target_id = $1) AND p.workspace_id = $3 AND ${projectLevelSql('$2', role)} > 0
        ORDER BY l.created_at`,
      [req.params.id, req.user!.id, workspaceId],
    );
    return rows;
  });

  /**
   * Links this item to another. Changing this item takes edit; the other only
   * has to be one the reader can see, in the same workspace, since the link is
   * as much a note on this item as a change to that one.
   */
  app.post<{ Params: { id: string } }>('/work-items/:id/links', async (req, reply) => {
    const { workspaceId, projectId } = await assertWorkItemAccess(req, req.params.id, 'items');
    const input = parse(createWorkItemLinkSchema, req.body ?? {});
    const type: WorkItemLinkType = input.type;
    if (input.targetId === req.params.id) throw badRequest('A work item cannot be linked to itself');
    const other = await workItemAccess(req.user!.id, input.targetId);
    if (!other || other.workspaceId !== workspaceId) throw badRequest('That work item is not in this workspace');

    // Stored pointing the way it reads outward; related-to either way, so from the lesser id.
    let direction: WorkItemLinkDirection = input.direction ?? 'outward';
    if (isSymmetricLink(type)) direction = req.params.id < input.targetId ? 'outward' : 'inward';
    const [source, target] = direction === 'outward' ? [req.params.id, input.targetId] : [input.targetId, req.params.id];

    const { rows: items } = await query<{ id: string; key: string; title: string }>(
      `SELECT i.id, p.key || '-' || i.number AS key, i.title
         FROM work_items i JOIN projects p ON p.id = i.project_id WHERE i.id = ANY($1::uuid[])`,
      [[req.params.id, input.targetId]],
    );
    const self = items.find((i) => i.id === req.params.id)!;
    const that = items.find((i) => i.id === input.targetId)!;

    const { rows: existing } = await query<{ type: WorkItemLinkType; source_id: string }>(
      `SELECT type, source_id FROM work_item_links
        WHERE LEAST(source_id, target_id) = LEAST($1::uuid, $2::uuid)
          AND GREATEST(source_id, target_id) = GREATEST($1::uuid, $2::uuid) AND type = $3`,
      [source, target, type],
    );
    if (existing[0]) {
      const reads = WORK_ITEM_LINK_LABELS[type][existing[0].source_id === req.params.id ? 'outward' : 'inward'];
      throw conflict(`${self.key} already ${reads} ${that.key}`);
    }

    const id = await transaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        'INSERT INTO work_item_links (source_id, target_id, type, created_by) VALUES ($1, $2, $3, $4) RETURNING id',
        [source, target, type, req.user!.id],
      );
      await logLinkBothWays(client, { id: source, target }, type, items, req.user!.id, true);
      await client.query('UPDATE work_items SET updated_at = now() WHERE id = ANY($1::uuid[])', [[source, target]]);
      return rows[0].id;
    });

    projectChanged(workspaceId, projectId, req.params.id);
    projectChanged(workspaceId, other.projectId, input.targetId);
    reply.status(201);
    return { id };
  });

  app.delete<{ Params: { id: string } }>('/work-item-links/:id', async (req, reply) => {
    if (!UUID.test(req.params.id)) throw notFound('Link not found');
    const { rows } = await query<{ source_id: string; target_id: string; type: WorkItemLinkType }>(
      'SELECT source_id, target_id, type FROM work_item_links WHERE id = $1',
      [req.params.id],
    );
    const link = rows[0];
    if (!link) throw notFound('Link not found');
    // Either end's editors may take a link off; the other end only has to be visible.
    const [a, b] = await Promise.all([
      workItemAccess(req.user!.id, link.source_id),
      workItemAccess(req.user!.id, link.target_id),
    ]);
    if (!a || !b) throw notFound('Link not found');
    if (a.level < 2 && b.level < 2) throw forbidden('You can view these work items but not change them');

    const { rows: items } = await query<{ id: string; key: string; title: string }>(
      `SELECT i.id, p.key || '-' || i.number AS key, i.title
         FROM work_items i JOIN projects p ON p.id = i.project_id WHERE i.id = ANY($1::uuid[])`,
      [[link.source_id, link.target_id]],
    );
    await transaction(async (client) => {
      await client.query('DELETE FROM work_item_links WHERE id = $1', [req.params.id]);
      await logLinkBothWays(client, { id: link.source_id, target: link.target_id }, link.type, items, req.user!.id, false);
      await client.query('UPDATE work_items SET updated_at = now() WHERE id = ANY($1::uuid[])', [
        [link.source_id, link.target_id],
      ]);
    });
    projectChanged(a.workspaceId, a.projectId, link.source_id);
    projectChanged(b.workspaceId, b.projectId, link.target_id);
    reply.status(204);
  });

  // --- attachments -------------------------------------------------------------

  app.get<{ Params: { id: string } }>('/work-items/:id/attachments', async (req): Promise<WorkItemAttachment[]> => {
    await assertWorkItemAccess(req, req.params.id);
    const { rows } = await query<WorkItemAttachment>(
      `SELECT ${ATTACHMENT_COLUMNS} FROM work_item_attachments a LEFT JOIN users u ON u.id = a.uploader_id
        WHERE a.work_item_id = $1 ORDER BY a.created_at`,
      [req.params.id],
    );
    return rows;
  });

  /** Attaches one file. Anyone who can change the item can add to it. */
  app.post<{ Params: { id: string } }>('/work-items/:id/attachments', async (req, reply) => {
    const { workspaceId, projectId } = await assertWorkItemAccess(req, req.params.id, 'items');
    const file = await req.file(uploadLimits());
    if (!file) throw badRequest('No file was uploaded');

    // Sent ahead of the file by the client, which measures images and videos
    // so they hold their shape before they load. Only a matching pair is kept.
    const fields = file.fields as Record<string, { value?: unknown } | undefined>;
    const width = dimension(fields?.width?.value);
    const height = dimension(fields?.height?.value);
    const measured = width !== null && height !== null;
    const filename = displayName(file.filename);

    const { storageKey, byteSize } = await storeUpload(file, `work-items/${req.params.id}`);
    let id: string;
    try {
      id = await transaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO work_item_attachments
             (work_item_id, uploader_id, filename, mime_type, byte_size, storage_key, width, height)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [
            req.params.id,
            req.user!.id,
            filename,
            (file.mimetype || 'application/octet-stream').slice(0, 100),
            byteSize,
            storageKey,
            measured ? width : null,
            measured ? height : null,
          ],
        );
        await logActivity(client, req.params.id, req.user!.id, { kind: 'attachment', filename, added: true });
        await client.query('UPDATE work_items SET updated_at = now() WHERE id = $1', [req.params.id]);
        return rows[0].id;
      });
    } catch (err) {
      // The item went away while the file was arriving.
      await removeStoredFile(storageKey);
      throw err;
    }

    projectChanged(workspaceId, projectId, req.params.id);
    const { rows } = await query<WorkItemAttachment>(
      `SELECT ${ATTACHMENT_COLUMNS} FROM work_item_attachments a LEFT JOIN users u ON u.id = a.uploader_id
        WHERE a.id = $1`,
      [id],
    );
    reply.status(201);
    return rows[0];
  });

  app.delete<{ Params: { id: string } }>('/work-item-attachments/:id', async (req, reply) => {
    if (!UUID.test(req.params.id)) throw notFound('File not found');
    const { rows } = await query<{ work_item_id: string }>(
      'SELECT work_item_id FROM work_item_attachments WHERE id = $1',
      [req.params.id],
    );
    if (!rows[0]) throw notFound('File not found');
    const itemId = rows[0].work_item_id;
    const { workspaceId, projectId } = await assertWorkItemAccess(req, itemId, 'items');

    const removed = await transaction(async (client) => {
      const { rows: gone } = await client.query<{ storage_key: string; filename: string }>(
        'DELETE FROM work_item_attachments WHERE id = $1 RETURNING storage_key, filename',
        [req.params.id],
      );
      if (!gone[0]) return null;
      await logActivity(client, itemId, req.user!.id, { kind: 'attachment', filename: gone[0].filename, added: false });
      await client.query('UPDATE work_items SET updated_at = now() WHERE id = $1', [itemId]);
      return gone[0];
    });
    if (!removed) throw notFound('File not found');

    await removeStoredFile(removed.storage_key);
    projectChanged(workspaceId, projectId, itemId);
    reply.status(204);
  });

  app.put<{ Params: { id: string; roleId: string } }>('/work-items/:id/roles/:roleId', async (req) => {
    const { workspaceId, projectId } = await assertWorkItemAccess(req, req.params.id, 'items');
    const input = parse(setWorkItemRoleSchema, req.body ?? {});
    if (!UUID.test(req.params.roleId)) throw notFound('Role not found');
    const { rows: roles } = await query<{ name: string; multiple: boolean; freeForm: boolean; applies: boolean }>(
      `SELECT r.name, r.multiple, r.free_form AS "freeForm",
              EXISTS (SELECT 1 FROM project_item_type_roles tr JOIN work_items i ON i.type_id = tr.type_id
                       WHERE i.id = $3 AND tr.role_id = r.id) AS applies
         FROM project_roles r WHERE r.id = $1 AND r.project_id = $2`,
      [req.params.roleId, projectId, req.params.id],
    );
    const role = roles[0];
    if (!role) throw notFound('Role not found');
    if (!role.applies && (input.userIds.length > 0 || (input.names ?? []).length > 0)) {
      throw badRequest(`${role.name} is not a role on this type of work item`);
    }
    const userIds = [...new Set(input.userIds)];
    const names = uniqueNames(input.names);
    assertRoleFits(role, userIds, names);
    await assertMembers(workspaceId, userIds);

    const added = await transaction(async (client) => {
      const { rows: existing } = await client.query<{ user_id: string | null; name: string | null }>(
        'SELECT user_id, name FROM work_item_roles WHERE work_item_id = $1 AND role_id = $2',
        [req.params.id, req.params.roleId],
      );
      const hadUsers = existing.flatMap((r) => (r.user_id === null ? [] : [r.user_id]));
      const hadNames = existing.flatMap((r) => (r.name === null ? [] : [r.name]));
      const keptNames = new Set(names.map((n) => n.toLowerCase()));
      const adding = userIds.filter((id) => !hadUsers.includes(id));
      const removing = hadUsers.filter((id) => !userIds.includes(id));
      const addingNames = names.filter((n) => !hadNames.some((had) => had.toLowerCase() === n.toLowerCase()));
      const removingNames = hadNames.filter((had) => !keptNames.has(had.toLowerCase()));
      if (adding.length + removing.length + addingNames.length + removingNames.length === 0) return [];

      await client.query(
        `DELETE FROM work_item_roles
          WHERE work_item_id = $1 AND role_id = $2
            AND CASE WHEN user_id IS NOT NULL THEN NOT (user_id = ANY($3::uuid[]))
                     ELSE NOT (lower(name) = ANY($4::text[])) END`,
        [req.params.id, req.params.roleId, userIds, [...keptNames]],
      );
      await insertRoleHolders(client, req.params.id, req.params.roleId, adding, addingNames);
      await client.query('UPDATE work_items SET updated_at = now() WHERE id = $1', [req.params.id]);
      // Typed names sit in the history beside the people, written as they were
      // given: nothing else records what a customer was called at the time.
      await logActivity(client, req.params.id, req.user!.id, {
        kind: 'role',
        role: role.name,
        added: [...adding, ...addingNames],
        removed: [...removing, ...removingNames],
      });
      return adding;
    });

    await tell(req, req.params.id, added, 'role', role.name);
    projectChanged(workspaceId, projectId, req.params.id);
    return fetchItem(req.params.id, workspaceId, req.user!.id);
  });

  app.delete<{ Params: { id: string } }>('/work-items/:id', async (req, reply) => {
    const { workspaceId, projectId } = await assertWorkItemAccess(req, req.params.id, 'items');
    // The rows for its files cascade away with it, so the files are collected first.
    const { rows: files } = await query<{ storage_key: string }>(
      'SELECT storage_key FROM work_item_attachments WHERE work_item_id = $1',
      [req.params.id],
    );
    await query('DELETE FROM work_items WHERE id = $1', [req.params.id]);
    await removeStoredFiles(
      files.map((f) => f.storage_key),
      req.log,
    );
    projectChanged(workspaceId, projectId, req.params.id);
    reply.status(204);
  });

  // --- comments and history ---------------------------------------------------

  app.get<{ Params: { id: string } }>('/work-items/:id/timeline', async (req): Promise<WorkItemTimeline> => {
    const { workspaceId } = await assertWorkItemAccess(req, req.params.id);
    const [{ rows: comments }, { rows: activity }] = await Promise.all([
      query<WorkItemComment>(
        `SELECT c.id, c.body, ${authorJson('u')} AS author, c.created_at AS "createdAt", c.edited_at AS "editedAt"
           FROM work_item_comments c LEFT JOIN users u ON u.id = c.author_id
          WHERE c.work_item_id = $1
          ORDER BY c.created_at`,
        [req.params.id],
      ),
      query<{ id: string; actor: WorkItemActivity['actor']; createdAt: string; data: WorkItemActivityData }>(
        `SELECT a.id, ${authorJson('u')} AS actor, a.created_at AS "createdAt", a.data
           FROM work_item_activity a LEFT JOIN users u ON u.id = a.actor_id
          WHERE a.work_item_id = $1
          ORDER BY a.created_at`,
        [req.params.id],
      ),
    ]);
    // The people a role change names are resolved alongside the comments' references.
    const named = activity.flatMap((a) => (a.data.kind === 'role' ? [...a.data.added, ...a.data.removed] : []));
    const references = await resolveReferences(
      [...comments.map((c) => c.body), named.map(memberRef).join(' ')],
      workspaceId,
      req.user!.id,
    );
    return {
      comments,
      activity: activity.map(({ data, ...rest }) => ({ ...rest, ...data })),
      references,
    };
  });

  app.post<{ Params: { id: string } }>('/work-items/:id/comments', async (req, reply) => {
    const { workspaceId, projectId } = await assertWorkItemAccess(req, req.params.id, 'comment');
    const input = parse(workItemCommentSchema, req.body ?? {});
    const id = await transaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        'INSERT INTO work_item_comments (work_item_id, author_id, body) VALUES ($1, $2, $3) RETURNING id',
        [req.params.id, req.user!.id, input.body],
      );
      // Someone still talking about finished work wants it back in view: a
      // requester following up on a resolved request, say.
      const { rows: restored } = await client.query(
        `UPDATE work_items i SET updated_at = now(), archived_at = NULL
           FROM (SELECT archived_at FROM work_items WHERE id = $1) was
          WHERE i.id = $1 AND was.archived_at IS NOT NULL
          RETURNING i.id`,
        [req.params.id],
      );
      if (restored.length > 0) await logActivity(client, req.params.id, req.user!.id, { kind: 'restored' });
      else await client.query('UPDATE work_items SET updated_at = now() WHERE id = $1', [req.params.id]);
      return rows[0].id;
    });
    await recordItemMentions(req, req.params.id, workspaceId);
    await tell(req, req.params.id, textMembers([input.body]), 'mention');
    projectChanged(workspaceId, projectId, req.params.id);
    reply.status(201);
    return { id };
  });

  async function commentRow(id: string) {
    if (!UUID.test(id)) throw notFound('Comment not found');
    const { rows } = await query<{ work_item_id: string; author_id: string | null; body: string }>(
      'SELECT work_item_id, author_id, body FROM work_item_comments WHERE id = $1',
      [id],
    );
    if (!rows[0]) throw notFound('Comment not found');
    return rows[0];
  }

  app.patch<{ Params: { id: string } }>('/work-item-comments/:id', async (req) => {
    const found = await commentRow(req.params.id);
    const { workspaceId, projectId } = await assertWorkItemAccess(req, found.work_item_id, 'comment');
    if (found.author_id !== req.user!.id) throw forbidden('You can only edit your own comments');
    const input = parse(workItemCommentSchema, req.body ?? {});
    await query('UPDATE work_item_comments SET body = $2, edited_at = now() WHERE id = $1', [req.params.id, input.body]);
    await recordItemMentions(req, found.work_item_id, workspaceId);
    const already = new Set(textMembers([found.body]));
    await tell(req, found.work_item_id, textMembers([input.body]).filter((id) => !already.has(id)), 'mention');
    projectChanged(workspaceId, projectId, found.work_item_id);
    return { id: req.params.id };
  });

  app.delete<{ Params: { id: string } }>('/work-item-comments/:id', async (req, reply) => {
    const found = await commentRow(req.params.id);
    const { workspaceId, projectId, role } = await assertWorkItemAccess(req, found.work_item_id);
    if (found.author_id !== req.user!.id && !managesAccess(role)) {
      throw forbidden('You can only delete your own comments');
    }
    await query('DELETE FROM work_item_comments WHERE id = $1', [req.params.id]);
    await recordItemMentions(req, found.work_item_id, workspaceId);
    projectChanged(workspaceId, projectId, found.work_item_id);
    reply.status(204);
  });

  // --- references --------------------------------------------------------------

  /**
   * Where an item is mentioned: documents and canvases, conversations and other
   * items. Each is held to what the reader may open, so a backlink never names
   * a document or channel that is locked away from them.
   */
  app.get<{ Params: { id: string } }>('/work-items/:id/backlinks', async (req): Promise<WorkItemBacklinks> => {
    const { workspaceId } = await assertWorkItemAccess(req, req.params.id);
    const user = req.user!.id;
    const role = roleIdSql('$2', '$3');
    const [documents, channels, workItems] = await Promise.all([
      query<WorkItemBacklinks['documents'][number]>(
        `SELECT d.id, d.title, d.icon, d.mode
           FROM work_item_mentions wm JOIN documents d ON d.id = wm.document_id
          WHERE wm.work_item_id = $1 AND d.workspace_id = $3 AND d.archived_at IS NULL
            AND ${appEnabledSql('$3', 'docs')} AND ${documentLevelSql('$2', role)} > 0
          ORDER BY d.updated_at DESC`,
        [req.params.id, user, workspaceId],
      ),
      query<WorkItemBacklinks['channels'][number]>(
        `SELECT c.id, c.name, c.kind, count(*)::int AS mentions, max(msg.created_at) AS "latestAt"
           FROM work_item_mentions wm
           JOIN messages msg ON msg.id = wm.message_id AND msg.deleted_at IS NULL
           JOIN channels c ON c.id = msg.channel_id
          WHERE wm.work_item_id = $1 AND c.workspace_id = $3 AND ${appEnabledSql('$3', 'chat')}
            AND ((c.kind = 'text' AND ${channelLevelSql('$2', role)} > 0)
              OR (c.kind = 'direct' AND EXISTS (SELECT 1 FROM channel_members cm
                                                 WHERE cm.channel_id = c.id AND cm.user_id = $2)))
          GROUP BY c.id
          ORDER BY max(msg.created_at) DESC`,
        [req.params.id, user, workspaceId],
      ),
      query<WorkItemBacklinks['workItems'][number]>(
        `SELECT i.id, i.project_id AS "projectId", p.key || '-' || i.number AS key, i.title
           FROM work_item_mentions wm
           JOIN work_items i ON i.id = wm.source_item_id
           JOIN projects p ON p.id = i.project_id
          WHERE wm.work_item_id = $1 AND i.workspace_id = $3 AND ${projectLevelSql('$2', role)} > 0
          ORDER BY i.updated_at DESC`,
        [req.params.id, user, workspaceId],
      ),
    ]);
    return { documents: documents.rows, channels: channels.rows, workItems: workItems.rows };
  });

  /** What each work item asked about is called and where it stands, for chips in documents and on canvases. */
  app.post('/work-item-refs/resolve', async (req) => {
    const input = parse(resolveWorkItemsSchema, req.body ?? {});
    return { items: await resolveWorkItems([...new Set(input.ids)], null, req.user!.id) };
  });

  /**
   * Work items across a workspace's projects: the reader's own with `mine`,
   * or those matching `q` — by title, by key such as ENG-12, or by what their
   * description says. Archived projects are left out.
   */
  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>(
    '/workspaces/:id/work-items',
    async (req): Promise<WorkItemListing[]> => {
      const { roleId } = await assertWorkspaceAccess(req, req.params.id, undefined, 'projects');
      const input = parse(listQuerySchema, req.query ?? {});
      const params: unknown[] = [req.params.id, req.user!.id, roleId];
      const where = ['i.workspace_id = $1', 'p.archived_at IS NULL', `${projectLevelSql('$2', '$3')} > 0`];
      if (input.mine === 'true') {
        where.push('EXISTS (SELECT 1 FROM work_item_roles wr WHERE wr.work_item_id = i.id AND wr.user_id = $2)');
      }
      if (input.open === 'true') where.push(`st.category <> 'done'`);
      if (input.q) {
        params.push(input.q);
        const q = `$${params.length}`;
        const terms = input.q
          .toLowerCase()
          .split(/[^\p{L}\p{N}_]+/u)
          .filter(Boolean)
          .slice(0, 8)
          .map((t) => `${t.replace(/'/g, "''")}:*`)
          .join(' & ');
        params.push(terms || null);
        const ts = `$${params.length}`;
        where.push(`(i.title ILIKE '%' || ${q} || '%'
                     OR (p.key || '-' || i.number) ILIKE ${q} || '%'
                     OR (${ts}::text IS NOT NULL AND i.search @@ to_tsquery('english', ${ts})))`);
      }
      params.push(input.limit);
      const { rows } = await query<WorkItemListing>(
        `SELECT ${ITEM_COLUMNS},
                json_build_object('id', p.id, 'key', p.key, 'name', p.name, 'icon', p.icon, 'kind', p.kind) AS project,
                json_build_object('id', st.id, 'name', st.name, 'category', st.category, 'color', st.color,
                                  'position', st.position) AS status,
                ${ITEM_TYPE_LOOK} AS "itemType",
                COALESCE((SELECT json_agg(r.name ORDER BY r.position)
                            FROM project_roles r
                           WHERE EXISTS (SELECT 1 FROM work_item_roles wr
                                          WHERE wr.role_id = r.id AND wr.work_item_id = i.id AND wr.user_id = $2)),
                         '[]'::json) AS "myRoles"
           FROM work_items i
           JOIN projects p ON p.id = i.project_id
           JOIN project_statuses st ON st.id = i.status_id
          WHERE ${where.join(' AND ')}
          ORDER BY (st.category = 'done'), i.updated_at DESC
          LIMIT $${params.length}`,
        params,
      );
      return rows;
    },
  );
};
