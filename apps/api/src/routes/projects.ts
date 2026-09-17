import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  canMoveTo,
  createProjectSchema,
  createRoleSchema,
  createStatusSchema,
  createWorkItemSchema,
  createWorkflowSchema,
  deleteStatusSchema,
  MAX_ROLE_HOLDERS,
  memberRef,
  moveWorkItemsSchema,
  resolveWorkItemsSchema,
  setTypeWorkflowSchema,
  setWorkItemRoleSchema,
  textMembers,
  textWorkItems,
  updateProjectSchema,
  updateRoleSchema,
  updateStatusSchema,
  updateWorkItemSchema,
  updateWorkflowSchema,
  workItemCommentSchema,
  workflowForType,
  type Project,
  type ProjectKind,
  type ProjectRole,
  type ProjectStatus,
  type ProjectWorkflow,
  type StatusCategory,
  type WorkItem,
  type WorkItemActivity,
  type WorkItemActivityData,
  type WorkItemBacklinks,
  type WorkItemComment,
  type WorkItemListing,
  type WorkItemSummary,
  type WorkItemTimeline,
  type WorkItemType,
} from '@paradocs/shared';
import { query, transaction, type DbClient } from '../db/pool.js';
import { badRequest, conflict, forbidden, notFound, parse } from '../lib/http.js';
import {
  UUID,
  assertProjectAccess,
  assertWorkItemAccess,
  channelLevelSql,
  documentLevelSql,
  managesAccess,
  permissionSql,
  projectLevelSql,
  roleSql,
} from '../lib/access.js';
import { appEnabledSql } from '../lib/apps.js';
import { resolveReferences, resolveWorkItems } from '../lib/chatReferences.js';
import { uploadUrlSql } from '../lib/storage.js';
import { notifyAboutWorkItem, projectChanged, syncWorkItemMentions } from '../lib/workItems.js';
import { assertWorkspaceAccess } from '../plugins/session.js';

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
  i.id, i.project_id AS "projectId", i.number, p.key || '-' || i.number AS key, i.title, i.type, i.priority,
  i.status_id AS "statusId", i.position, to_char(i.due_date, 'YYYY-MM-DD') AS "dueDate",
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
  i.created_at AS "createdAt", i.updated_at AS "updatedAt", i.completed_at AS "completedAt"`;

function authorJson(alias: string): string {
  return `CASE WHEN ${alias}.id IS NULL THEN NULL
    ELSE json_build_object('id', ${alias}.id, 'name', ${alias}.name, 'email', ${alias}.email,
                           'avatarUrl', ${uploadUrlSql(`${alias}.avatar_key`)}) END`;
}

/** A workflow's moves as the client wants them: to-statuses keyed by from-status. */
const TRANSITIONS_JSON = `COALESCE((
  SELECT json_object_agg(g.from_status, g.tos)
    FROM (SELECT t.from_status, json_agg(t.to_status) AS tos
            FROM project_workflow_transitions t
           WHERE t.workflow_id = w.id
           GROUP BY t.from_status) g
), '{}'::json)`;

async function fetchProject(id: string, userId: string): Promise<Project> {
  const { rows } = await query<Project>(
    `SELECT ${projectColumns('$2', roleSql('$2', 'p.workspace_id'))},
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
            COALESCE((SELECT json_object_agg(tw.type, tw.workflow_id)
                        FROM project_type_workflows tw WHERE tw.project_id = p.id), '{}'::json) AS "typeWorkflows",
            (${roleSql('$2', 'p.workspace_id')} IN ('owner', 'admin') OR p.created_by = $2) AS "canDelete"
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
  moves: { key: string; type: WorkItemType; from: string; to: string }[],
): void {
  if (role === 'owner' || role === 'admin') return;
  const name = (id: string) => project.statuses.find((s) => s.id === id)?.name ?? 'that status';
  for (const move of moves) {
    if (canMoveTo(project, move.type, move.from, move.to)) continue;
    const workflow = workflowForType(project, move.type)!;
    throw badRequest(
      `${move.key} cannot go from ${name(move.from)} to ${name(move.to)}: the ${workflow.name} workflow does not allow it`,
    );
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
async function insertRoleHolders(
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

async function logActivity(db: Queryable, itemId: string, actorId: string, data: WorkItemActivityData): Promise<void> {
  await db.query('INSERT INTO work_item_activity (work_item_id, actor_id, data) VALUES ($1, $2, $3)', [
    itemId,
    actorId,
    JSON.stringify(data),
  ]);
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
async function endOfStatus(db: Queryable, statusId: string): Promise<number> {
  const { rows } = await db.query<{ next: number }>(
    'SELECT COALESCE(max(position), 0)::float8 + 1 AS next FROM work_items WHERE status_id = $1',
    [statusId],
  );
  return rows[0].next;
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
    const role = await assertWorkspaceAccess(req, req.params.id, 'viewer', 'projects');
    const { rows } = await query(
      `SELECT ${projectColumns('$3', '$4')}
         FROM projects p
        WHERE p.workspace_id = $1
          AND (p.archived_at IS NOT NULL) = $2
          AND ${projectLevelSql('$3', '$4')} > 0
        ORDER BY p.kind, lower(p.name)`,
      [req.params.id, req.query.archived === 'true', req.user!.id, role],
    );
    return rows;
  });

  app.post<{ Params: { id: string } }>('/workspaces/:id/projects', async (req, reply) => {
    await assertWorkspaceAccess(req, req.params.id, 'editor', 'projects');
    const input = parse(createProjectSchema, req.body ?? {});
    const kind = input.kind ?? 'project';
    await assertKeyFree(req.params.id, input.key);
    const defaults = DEFAULTS[kind];

    const id = await transaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO projects (workspace_id, kind, key, name, description, icon, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [req.params.id, kind, input.key, input.name, input.description ?? '', input.icon ?? null, req.user!.id],
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
    const { workspaceId } = await assertProjectAccess(req, req.params.id, 'edit');
    const input = parse(updateProjectSchema, req.body ?? {});
    if (input.key) await assertKeyFree(workspaceId, input.key, req.params.id);

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
      ],
    );
    projectChanged(workspaceId, req.params.id);
    return fetchProject(req.params.id, req.user!.id);
  });

  app.delete<{ Params: { id: string } }>('/projects/:id', async (req, reply) => {
    const { workspaceId, role } = await assertProjectAccess(req, req.params.id, 'edit');
    const { rows } = await query<{ created_by: string | null }>('SELECT created_by FROM projects WHERE id = $1', [
      req.params.id,
    ]);
    if (!managesAccess(role) && rows[0]?.created_by !== req.user!.id) {
      throw forbidden('Only an owner, an admin or whoever made this project can delete it. You can archive it instead.');
    }
    await query('DELETE FROM projects WHERE id = $1', [req.params.id]);
    projectChanged(workspaceId, req.params.id);
    reply.status(204);
  });

  // --- statuses --------------------------------------------------------------

  app.post<{ Params: { id: string } }>('/projects/:id/statuses', async (req, reply) => {
    const { workspaceId } = await assertProjectAccess(req, req.params.id, 'edit');
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
    const { workspaceId } = await assertProjectAccess(req, projectId, 'edit');
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
              SET completed_at = CASE WHEN $2 = 'done' THEN COALESCE(completed_at, now()) ELSE NULL END
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
    const { workspaceId } = await assertProjectAccess(req, projectId, 'edit');
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
    const { workspaceId } = await assertProjectAccess(req, req.params.id, 'edit');
    const input = parse(createRoleSchema, req.body ?? {});
    await assertRoleNameFree(req.params.id, input.name);
    const { rows } = await query<ProjectRole>(
      `INSERT INTO project_roles (project_id, name, multiple, free_form, position)
       VALUES ($1, $2, $3, $4, (SELECT COALESCE(max(position), 0) + 1 FROM project_roles WHERE project_id = $1))
       RETURNING id, name, multiple, free_form AS "freeForm", position`,
      [req.params.id, input.name, input.multiple, input.freeForm],
    );
    projectChanged(workspaceId, req.params.id);
    reply.status(201);
    return rows[0];
  });

  app.patch<{ Params: { id: string } }>('/project-roles/:id', async (req) => {
    const projectId = await projectOfRole(req.params.id);
    const { workspaceId } = await assertProjectAccess(req, projectId, 'edit');
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
    const { workspaceId } = await assertProjectAccess(req, projectId, 'edit');
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
    const { workspaceId } = await assertProjectAccess(req, req.params.id, 'edit');
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
    const { workspaceId } = await assertProjectAccess(req, projectId, 'edit');
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
    const { workspaceId } = await assertProjectAccess(req, projectId, 'edit');
    // The types that followed it lose their row too, and move freely again.
    await query('DELETE FROM project_workflows WHERE id = $1', [req.params.id]);
    projectChanged(workspaceId, projectId);
    reply.status(204);
  });

  /** Points one item type at a workflow, or at none. */
  app.put<{ Params: { id: string } }>('/projects/:id/type-workflows', async (req) => {
    const { workspaceId } = await assertProjectAccess(req, req.params.id, 'edit');
    const input = parse(setTypeWorkflowSchema, req.body ?? {});
    if (input.workflowId) {
      if ((await projectOfWorkflow(input.workflowId)) !== req.params.id) {
        throw badRequest('That workflow is in another project');
      }
      await query(
        `INSERT INTO project_type_workflows (project_id, type, workflow_id) VALUES ($1, $2, $3)
         ON CONFLICT (project_id, type) DO UPDATE SET workflow_id = EXCLUDED.workflow_id`,
        [req.params.id, input.type, input.workflowId],
      );
    } else {
      await query('DELETE FROM project_type_workflows WHERE project_id = $1 AND type = $2', [req.params.id, input.type]);
    }
    projectChanged(workspaceId, req.params.id);
    return fetchProject(req.params.id, req.user!.id);
  });

  // --- work items --------------------------------------------------------------

  app.get<{ Params: { id: string } }>('/projects/:id/items', async (req) => {
    await assertProjectAccess(req, req.params.id);
    const { rows } = await query<WorkItemSummary>(
      `SELECT ${ITEM_COLUMNS}
         FROM work_items i JOIN projects p ON p.id = i.project_id
        WHERE i.project_id = $1
        ORDER BY i.position, i.number
        LIMIT 5000`,
      [req.params.id],
    );
    return rows;
  });

  app.post<{ Params: { id: string } }>('/projects/:id/items', async (req, reply) => {
    const { workspaceId } = await assertProjectAccess(req, req.params.id, 'edit');
    const parsed = parse(createWorkItemSchema, req.body ?? {});
    const input = { ...parsed, description: parsed.description ?? '' };
    const project = await fetchProject(req.params.id, req.user!.id);
    if (project.archivedAt) throw badRequest('This project is archived. Restore it to add work to it.');

    const status = input.statusId ? project.statuses.find((s) => s.id === input.statusId) : project.statuses[0];
    if (!status) throw badRequest('That status is not in this project');

    const roleIds = new Set([...Object.keys(input.roles ?? {}), ...Object.keys(input.roleNames ?? {})]);
    const roles = [...roleIds].map((roleId) => {
      const role = project.roles.find((r) => r.id === roleId);
      if (!role) throw badRequest('That role is not in this project');
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
        `INSERT INTO work_items (project_id, workspace_id, number, title, description, type, priority, status_id,
                                 position, due_date, estimate, created_by, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CASE WHEN $13 THEN now() END)
         RETURNING id`,
        [
          req.params.id,
          workspaceId,
          numbered[0].number,
          input.title,
          input.description,
          input.type,
          input.priority,
          status.id,
          await endOfStatus(client, status.id),
          input.dueDate ?? null,
          input.estimate ?? null,
          req.user!.id,
          status.category === 'done',
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
    const { workspaceId, role } = await assertProjectAccess(req, req.params.id, 'edit');
    const input = parse(moveWorkItemsSchema, req.body ?? {});
    const project = await fetchProject(req.params.id, req.user!.id);
    const target = project.statuses.find((s) => s.id === input.statusId);
    if (!target) throw badRequest('That status is not in this project');
    const itemIds = [...new Set(input.itemIds)];

    const { rows: moving } = await query<{ key: string; type: WorkItemType; status_id: string }>(
      `SELECT p.key || '-' || i.number AS key, i.type, i.status_id
         FROM work_items i JOIN projects p ON p.id = i.project_id
        WHERE i.id = ANY($1::uuid[]) AND i.project_id = $2`,
      [itemIds, req.params.id],
    );
    assertMoveAllowed(
      project,
      role,
      moving.map((item) => ({ key: item.key, type: item.type, from: item.status_id, to: target.id })),
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
    const { workspaceId, projectId, role } = await assertWorkItemAccess(req, req.params.id, 'edit');
    const input = parse(updateWorkItemSchema, req.body ?? {});

    const { rows: before } = await query<{
      key: string;
      title: string;
      description: string;
      type: WorkItemType;
      priority: WorkItem['priority'];
      status_id: string;
      status_name: string;
      status_category: StatusCategory;
    }>(
      `SELECT p.key || '-' || i.number AS key, i.title, i.description, i.type, i.priority, i.status_id,
              st.name AS status_name, st.category AS status_category
         FROM work_items i
         JOIN projects p ON p.id = i.project_id
         JOIN project_statuses st ON st.id = i.status_id
        WHERE i.id = $1`,
      [req.params.id],
    );
    const current = before[0];

    let target: { id: string; name: string; category: StatusCategory } | null = null;
    if (input.statusId && input.statusId !== current.status_id) {
      const project = await fetchProject(projectId, req.user!.id);
      const status = project.statuses.find((s) => s.id === input.statusId);
      if (!status) throw badRequest('That status is not in this project');
      // The type it is being given, if it is being given one, is the type it moves as.
      const type = input.type ?? current.type;
      assertMoveAllowed(project, role, [{ key: current.key, type, from: current.status_id, to: status.id }]);
      target = status;
    }

    await transaction(async (client) => {
      // Moved into another status with nowhere in particular to go: the end of it.
      const position = input.position ?? (target ? await endOfStatus(client, target.id) : null);
      await client.query(
        `UPDATE work_items
            SET title = COALESCE($2, title),
                description = COALESCE($3, description),
                type = COALESCE($4, type),
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
                updated_at = now()
          WHERE id = $1`,
        [
          req.params.id,
          input.title ?? null,
          input.description ?? null,
          input.type ?? null,
          input.priority ?? null,
          target?.id ?? null,
          position,
          input.dueDate !== undefined,
          input.dueDate ?? null,
          input.estimate !== undefined,
          input.estimate ?? null,
          target?.category ?? null,
        ],
      );
      const actor = req.user!.id;
      if (target) await logActivity(client, req.params.id, actor, { kind: 'status', from: current.status_name, to: target.name });
      if (input.priority && input.priority !== current.priority) {
        await logActivity(client, req.params.id, actor, { kind: 'priority', from: current.priority, to: input.priority });
      }
      if (input.title && input.title !== current.title) {
        await logActivity(client, req.params.id, actor, { kind: 'title', from: current.title, to: input.title });
      }
    });

    if (input.description !== undefined && input.description !== current.description) {
      await recordItemMentions(req, req.params.id, workspaceId);
      // Only people newly named are told; editing a typo elsewhere is not news to them.
      const already = new Set(textMembers([current.description]));
      await tell(req, req.params.id, textMembers([input.description]).filter((id) => !already.has(id)), 'mention');
    }
    projectChanged(workspaceId, projectId, req.params.id);
    return fetchItem(req.params.id, workspaceId, req.user!.id);
  });

  app.put<{ Params: { id: string; roleId: string } }>('/work-items/:id/roles/:roleId', async (req) => {
    const { workspaceId, projectId } = await assertWorkItemAccess(req, req.params.id, 'edit');
    const input = parse(setWorkItemRoleSchema, req.body ?? {});
    if (!UUID.test(req.params.roleId)) throw notFound('Role not found');
    const { rows: roles } = await query<{ name: string; multiple: boolean; freeForm: boolean }>(
      'SELECT name, multiple, free_form AS "freeForm" FROM project_roles WHERE id = $1 AND project_id = $2',
      [req.params.roleId, projectId],
    );
    const role = roles[0];
    if (!role) throw notFound('Role not found');
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
    const { workspaceId, projectId } = await assertWorkItemAccess(req, req.params.id, 'edit');
    await query('DELETE FROM work_items WHERE id = $1', [req.params.id]);
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
    const { workspaceId, projectId } = await assertWorkItemAccess(req, req.params.id, 'edit');
    const input = parse(workItemCommentSchema, req.body ?? {});
    const { rows } = await query<{ id: string }>(
      'INSERT INTO work_item_comments (work_item_id, author_id, body) VALUES ($1, $2, $3) RETURNING id',
      [req.params.id, req.user!.id, input.body],
    );
    await query('UPDATE work_items SET updated_at = now() WHERE id = $1', [req.params.id]);
    await recordItemMentions(req, req.params.id, workspaceId);
    await tell(req, req.params.id, textMembers([input.body]), 'mention');
    projectChanged(workspaceId, projectId, req.params.id);
    reply.status(201);
    return { id: rows[0].id };
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
    const { workspaceId, projectId } = await assertWorkItemAccess(req, found.work_item_id, 'edit');
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
    const role = roleSql('$2', '$3');
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
      const role = await assertWorkspaceAccess(req, req.params.id, 'viewer', 'projects');
      const input = parse(listQuerySchema, req.query ?? {});
      const params: unknown[] = [req.params.id, req.user!.id, role];
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
