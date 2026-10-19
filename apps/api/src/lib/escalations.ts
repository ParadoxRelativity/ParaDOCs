import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { MAX_ROLE_HOLDERS, formatMinutes } from '@paradocs/shared';
import { query, transaction } from '../db/pool.js';
import { insertRoleHolders, logActivity } from '../routes/projects.js';
import { appEnabledSql } from './apps.js';
import { onCallAt } from './schedules.js';
import { notifyAboutWorkItem, projectChanged } from './workItems.js';

/**
 * A queue's response time: work nobody has responded to in time is passed on,
 * step by step, to the roles its escalation names. A server-side sweep, so
 * work filed through intake forms, the API and AI connections is watched as
 * closely as work filed in the app.
 *
 * A response is what insights counts as one (GET /projects/:id/responses): a
 * comment from anyone but whoever filed it, a move to another status, or its
 * being finished. One stops every step still to come.
 */

const SWEEP_INTERVAL = 60_000;

/** The roles a queue escalates to, which are left empty when work is filed: they are filled when it escalates. */
export async function escalationRoleIds(projectId: string): Promise<string[]> {
  const { rows } = await query<{ role_id: string }>(
    `SELECT es.role_id FROM project_escalation_steps es JOIN projects p ON p.id = es.project_id
      WHERE es.project_id = $1 AND p.kind = 'queue' AND p.escalation_since IS NOT NULL`,
    [projectId],
  );
  return rows.map((r) => r.role_id);
}

interface DueStep {
  itemId: string;
  projectId: string;
  workspaceId: string;
  typeId: string;
  responseRoleId: string | null;
  position: number;
  roleId: string;
  /** Minutes from filing the step is due at. */
  deadline: number;
}

/**
 * The next step due on each item still waiting for a response: filed in a
 * queue since its response time was turned on, neither finished nor archived,
 * in a workspace with Projects on. One step per item per sweep, the earliest
 * not yet taken, so work that waited out several while no server was running
 * still goes through them in order.
 */
async function dueSteps(now: Date): Promise<DueStep[]> {
  const { rows } = await query<DueStep>(
    `SELECT i.id AS "itemId", i.project_id AS "projectId", i.workspace_id AS "workspaceId", i.type_id AS "typeId",
            p.response_role_id AS "responseRoleId", s.position, s.role_id AS "roleId", s.deadline::int AS deadline
       FROM work_items i
       JOIN projects p ON p.id = i.project_id
       JOIN LATERAL (
         SELECT es.position, es.role_id, sum(es.after_minutes) OVER (ORDER BY es.position) AS deadline
           FROM project_escalation_steps es WHERE es.project_id = p.id
       ) s ON true
      WHERE p.kind = 'queue' AND p.escalation_since IS NOT NULL AND p.archived_at IS NULL
        AND ${appEnabledSql('p.workspace_id', 'projects')}
        AND i.created_at >= p.escalation_since
        AND i.archived_at IS NULL AND i.completed_at IS NULL
        AND i.created_at + make_interval(mins => s.deadline::int) <= $1
        AND NOT EXISTS (SELECT 1 FROM work_item_escalations e WHERE e.work_item_id = i.id AND e.position = s.position)
        AND NOT EXISTS (SELECT 1 FROM work_item_comments c
                         WHERE c.work_item_id = i.id AND c.author_id IS DISTINCT FROM i.created_by)
        AND NOT EXISTS (SELECT 1 FROM work_item_activity a WHERE a.work_item_id = i.id AND a.data->>'kind' = 'status')
      ORDER BY i.created_at, s.position`,
    [now.toISOString()],
  );
  const seen = new Set<string>();
  return rows.filter((row) => !seen.has(row.itemId) && seen.add(row.itemId));
}

interface Escalated {
  role: string;
  added: string[];
  held: string[];
  /** Members taken out of a role one person holds, to make way for whoever is on call. */
  removed: string[];
  /** Who it was waiting on: the waited-on role and the steps before this one. */
  passed: string[];
}

/**
 * Takes one step, once: claims it, brings in whoever is on the role's
 * schedule now — in place of whoever held a role one person holds, beside
 * those in one several can — and otherwise leaves the role's holders to be
 * told. Null when another sweep took the step first, or the item's type has
 * no such role.
 */
async function escalate(step: DueStep): Promise<Escalated | null> {
  const { rows: roles } = await query<{ name: string; multiple: boolean; scheduleId: string | null }>(
    'SELECT name, multiple, fill_from_schedule_id AS "scheduleId" FROM project_roles WHERE id = $1',
    [step.roleId],
  );
  const role = roles[0];
  const onCall = role?.scheduleId ? await onCallAt(role.scheduleId, step.workspaceId) : [];

  return transaction(async (client) => {
    const { rows: claimed } = await client.query(
      'INSERT INTO work_item_escalations (work_item_id, position) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING position',
      [step.itemId, step.position],
    );
    if (claimed.length === 0 || !role) return null;
    const { rows: offered } = await client.query(
      'SELECT 1 FROM project_item_type_roles WHERE type_id = $1 AND role_id = $2',
      [step.typeId, step.roleId],
    );
    if (offered.length === 0) return null;

    const { rows: holders } = await client.query<{ user_id: string | null; name: string | null }>(
      'SELECT user_id, name FROM work_item_roles WHERE work_item_id = $1 AND role_id = $2 ORDER BY created_at',
      [step.itemId, step.roleId],
    );
    const had = holders.flatMap((h) => (h.user_id ? [h.user_id] : []));
    let added = onCall.filter((id) => !had.includes(id));
    let removed: string[] = [];
    if (role.multiple) {
      added = added.slice(0, Math.max(0, MAX_ROLE_HOLDERS - holders.length));
    } else if (added.length > 0 && onCall[0] !== had[0]) {
      added = [onCall[0]];
      removed = had;
      await client.query('DELETE FROM work_item_roles WHERE work_item_id = $1 AND role_id = $2', [step.itemId, step.roleId]);
    } else {
      added = [];
    }
    if (added.length > 0) await insertRoleHolders(client, step.itemId, step.roleId, added, []);
    const held = had.filter((id) => !removed.includes(id));

    await logActivity(client, step.itemId, null, {
      kind: 'escalated',
      role: role.name,
      added,
      removed,
      held,
      minutes: step.deadline,
    });
    await client.query('UPDATE work_items SET updated_at = now() WHERE id = $1', [step.itemId]);

    const { rows: waited } = await client.query<{ user_id: string }>(
      `SELECT DISTINCT r.user_id FROM work_item_roles r
        WHERE r.work_item_id = $1 AND r.user_id IS NOT NULL
          AND (r.role_id = $2 OR r.role_id IN (SELECT role_id FROM project_escalation_steps
                                                WHERE project_id = $3 AND position < $4))`,
      [step.itemId, step.responseRoleId, step.projectId, step.position],
    );
    return { role: role.name, added, held, removed, passed: [...waited.map((w) => w.user_id), ...removed] };
  });
}

/** Tells those it reached that it is theirs now, and those it passed where it went. */
async function tell(step: DueStep, escalated: Escalated): Promise<void> {
  const reached = [...escalated.added, ...escalated.held];
  const after = `after ${formatMinutes(step.deadline)} without a response`;
  await notifyAboutWorkItem(step.itemId, reached, 'escalated', `Escalated to you as ${escalated.role} ${after}`, null);

  const passed = escalated.passed.filter((id) => !reached.includes(id));
  if (passed.length === 0) return;
  const { rows: people } = await query<{ name: string }>(
    'SELECT name FROM users WHERE id = ANY($1::uuid[]) ORDER BY array_position($1::uuid[], id)',
    [reached],
  );
  const to = people.length > 0 ? `${people.map((p) => p.name).join(', ')} (${escalated.role})` : null;
  await notifyAboutWorkItem(
    step.itemId,
    passed,
    'escalated',
    to ? `Escalated to ${to} ${after}` : `Nobody was in ${escalated.role} to escalate to ${after}`,
    null,
  );
}

let running = false;

/** Takes every step that is due. Returns how many were taken. */
export async function sweepEscalations(now = new Date()): Promise<number> {
  // Overlapping sweeps would be safe, each step being claimed, but a slow one is not started again over itself.
  if (running) return 0;
  running = true;
  try {
    let taken = 0;
    for (const step of await dueSteps(now)) {
      const escalated = await escalate(step);
      if (!escalated) continue;
      taken += 1;
      await tell(step, escalated);
      projectChanged(step.workspaceId, step.projectId, step.itemId);
    }
    return taken;
  } finally {
    running = false;
  }
}

/** Sweeps every minute once the server is up, until it closes. */
export function scheduleEscalations(app: FastifyInstance): void {
  const sweep = (log: FastifyBaseLogger) => sweepEscalations().catch((err) => log.warn({ err }, 'escalation sweep failed'));
  let timer: NodeJS.Timeout | undefined;
  app.addHook('onReady', async () => {
    timer = setInterval(() => void sweep(app.log), SWEEP_INTERVAL);
    timer.unref();
  });
  app.addHook('onClose', async () => clearInterval(timer));
}
