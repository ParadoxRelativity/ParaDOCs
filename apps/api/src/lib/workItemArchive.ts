import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';
import { projectChanged } from './workItems.js';

/** How often finished work is looked over for what has sat long enough. */
const SWEEP_INTERVAL = 60 * 60 * 1000;

let running = false;

/**
 * Archives finished work that has sat untouched for its project's
 * `archive_after_days`, across every project or just one, and writes each
 * item a history entry with no actor, which is how the sweep is told apart
 * from someone archiving by hand. Everyone looking at a project that changed
 * is told, so its board and list drop what went.
 *
 * Untouched means neither finished nor changed since: `updated_at` moves with
 * any edit, so housekeeping that touches an item only puts its archiving off,
 * and never brings back what is already archived.
 */
export async function archiveDormantWorkItems(projectId?: string): Promise<number> {
  // A slow sweep of everything is not started again over itself. Sweeps that
  // do overlap are still safe: each row is re-checked under its lock, so an
  // item is archived, and logged, once.
  if (!projectId) {
    if (running) return 0;
    running = true;
  }
  try {
    const { rows } = await query<{ projectId: string; workspaceId: string; archived: number }>(
      `WITH archived AS (
         UPDATE work_items i
            SET archived_at = now()
           FROM projects p
          WHERE p.id = i.project_id
            AND p.archive_after_days IS NOT NULL
            AND ($1::uuid IS NULL OR i.project_id = $1)
            AND i.archived_at IS NULL
            AND i.completed_at IS NOT NULL
            AND GREATEST(i.completed_at, i.updated_at) < now() - make_interval(days => p.archive_after_days)
         RETURNING i.id, i.project_id, i.workspace_id
       ),
       logged AS (
         INSERT INTO work_item_activity (work_item_id, actor_id, data)
         SELECT id, NULL, '{"kind": "archived"}'::jsonb FROM archived
       )
       SELECT project_id AS "projectId", workspace_id AS "workspaceId", count(*)::int AS archived
         FROM archived GROUP BY project_id, workspace_id`,
      [projectId ?? null],
    );
    for (const row of rows) projectChanged(row.workspaceId, row.projectId);
    return rows.reduce((total, row) => total + row.archived, 0);
  } finally {
    if (!projectId) running = false;
  }
}

/** Sweeps once the server is up and hourly after, until it closes. */
export function scheduleWorkItemArchiving(app: FastifyInstance): void {
  const sweep = (log: FastifyBaseLogger) =>
    archiveDormantWorkItems().catch((err) => log.warn({ err }, 'work item archive sweep failed'));
  let timer: NodeJS.Timeout | undefined;
  app.addHook('onReady', async () => {
    void sweep(app.log);
    timer = setInterval(() => void sweep(app.log), SWEEP_INTERVAL);
    timer.unref();
  });
  app.addHook('onClose', async () => clearInterval(timer));
}
