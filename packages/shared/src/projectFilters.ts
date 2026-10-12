/**
 * Filtering a project's work: a search, and any number of conditions on its
 * fields, every one of which an item must meet. Each condition on a field that
 * takes a choice is met by any of the values picked for it ("Assignee is Me or
 * Nobody"). Dates are picked by a preset ("Overdue", "This week") or a range.
 *
 * The board, the list and the rest match loaded work with `matchesFilter`; the
 * archive, which no reader holds all of, is matched by the server, which reads
 * the same filter and the same date bounds from `dateBounds`.
 */

import { z } from 'zod';
import { WORK_ITEM_PRIORITIES, type Project, type WorkItemPriority, type WorkItemSummary } from './projects.js';

/** How a date is picked. `range` is between `from` and `to`, either of which may be open. */
export type DateFilterKind = 'overdue' | 'today' | 'thisWeek' | 'next7' | 'last7' | 'none' | 'range';

export interface DateFilter {
  kind: DateFilterKind;
  /** YYYY-MM-DD, inclusive. Only for `range`. */
  from?: string;
  to?: string;
}

/** Who a role is held by: a member's id, `me` for whoever is looking, or `none` for nobody. */
export type RoleFilterValue = string | 'me' | 'none';

export interface WorkItemFilter {
  /** Matched against the title and key, and the description. */
  q?: string;
  type?: string[];
  status?: string[];
  priority?: WorkItemPriority[];
  /** Epic ids, or `none` for work under no epic. */
  epic?: string[];
  /** Sprint ids, or `none` for work in no sprint. */
  sprint?: string[];
  /** Keyed by role id. */
  roles?: Record<string, RoleFilterValue[]>;
  due?: DateFilter;
  created?: DateFilter;
  updated?: DateFilter;
}

/** The fields a condition can be put on, as they are offered and stored. */
export type FilterField = 'type' | 'status' | 'priority' | 'epic' | 'sprint' | 'due' | 'created' | 'updated' | `role:${string}`;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ids = z.array(z.string().max(64)).max(200);
const dateFilterSchema = z.object({
  kind: z.enum(['overdue', 'today', 'thisWeek', 'next7', 'last7', 'none', 'range']),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export const workItemFilterSchema = z.object({
  q: z.string().max(200).optional(),
  type: ids.optional(),
  status: ids.optional(),
  priority: z.array(z.enum(WORK_ITEM_PRIORITIES as [WorkItemPriority, ...WorkItemPriority[]])).optional(),
  epic: ids.optional(),
  sprint: ids.optional(),
  roles: z.record(z.string().max(64), ids).optional(),
  due: dateFilterSchema.optional(),
  created: dateFilterSchema.optional(),
  updated: dateFilterSchema.optional(),
});

/** Whether a filter would leave anything out. */
export function isFilterEmpty(filter: WorkItemFilter): boolean {
  return (
    !filter.q?.trim() &&
    !filter.type?.length &&
    !filter.status?.length &&
    !filter.priority?.length &&
    !filter.epic?.length &&
    !filter.sprint?.length &&
    !Object.values(filter.roles ?? {}).some((values) => values.length > 0) &&
    !filter.due &&
    !filter.created &&
    !filter.updated
  );
}

/** A filter as it goes in a link, `?f=`. Empty conditions are left out. */
export function encodeFilter(filter: WorkItemFilter): string {
  const roles = Object.fromEntries(Object.entries(filter.roles ?? {}).filter(([, values]) => values.length > 0));
  const compact: WorkItemFilter = {
    ...(filter.q?.trim() ? { q: filter.q.trim() } : {}),
    ...(filter.type?.length ? { type: filter.type } : {}),
    ...(filter.status?.length ? { status: filter.status } : {}),
    ...(filter.priority?.length ? { priority: filter.priority } : {}),
    ...(filter.epic?.length ? { epic: filter.epic } : {}),
    ...(filter.sprint?.length ? { sprint: filter.sprint } : {}),
    ...(Object.keys(roles).length ? { roles } : {}),
    ...(filter.due ? { due: filter.due } : {}),
    ...(filter.created ? { created: filter.created } : {}),
    ...(filter.updated ? { updated: filter.updated } : {}),
  };
  return JSON.stringify(compact);
}

/** A filter read back from a link, or null when it is not one. */
export function decodeFilter(text: string | null | undefined): WorkItemFilter | null {
  if (!text) return null;
  try {
    const parsed = workItemFilterSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * The days a date filter covers, inclusive, counted from `today` (the
 * reader's own calendar day). A week starts on Monday. `none` is for work with
 * no date, so has no bounds; it is told apart by its kind.
 */
export function dateBounds(filter: DateFilter, today: string): { from?: string; to?: string } {
  switch (filter.kind) {
    case 'overdue':
      return { to: addDays(today, -1) };
    case 'today':
      return { from: today, to: today };
    case 'thisWeek': {
      const weekday = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
      const monday = addDays(today, -weekday);
      return { from: monday, to: addDays(monday, 6) };
    }
    case 'next7':
      return { from: today, to: addDays(today, 6) };
    case 'last7':
      return { from: addDays(today, -6), to: today };
    case 'range':
      return { from: filter.from, to: filter.to };
    case 'none':
      return {};
  }
}

function dateMatches(value: string | null, filter: DateFilter | undefined, today: string): boolean {
  if (!filter) return true;
  if (filter.kind === 'none') return value === null;
  if (value === null) return false;
  const { from, to } = dateBounds(filter, today);
  return (!from || value >= from) && (!to || value <= to);
}

/** Whether a search finds an item by its title or key. Its description is searched by the server. */
export function searchMatches(item: Pick<WorkItemSummary, 'title' | 'key'>, q: string): boolean {
  const needle = q.trim().toLowerCase();
  return !needle || item.title.toLowerCase().includes(needle) || item.key.toLowerCase().includes(needle);
}

export interface FilterContext {
  /** Who `me` is. */
  selfId: string;
  /** YYYY-MM-DD, the reader's day. */
  today: string;
  /** The reader's calendar day of a moment, for the created and updated filters. */
  dayOf: (moment: string) => string;
  /** Items whose description the search found, when the server has been asked. */
  descriptionHits?: Set<string> | null;
}

/** Whether an item meets every condition of a filter. */
export function matchesFilter(
  project: Pick<Project, 'statuses'>,
  item: WorkItemSummary,
  filter: WorkItemFilter,
  context: FilterContext,
): boolean {
  const q = filter.q?.trim();
  if (q && !searchMatches(item, q) && !context.descriptionHits?.has(item.id)) return false;
  if (filter.type?.length && !filter.type.includes(item.typeId)) return false;
  if (filter.status?.length && !filter.status.includes(item.statusId)) return false;
  if (filter.priority?.length && !filter.priority.includes(item.priority)) return false;
  if (filter.epic?.length && !filter.epic.includes(item.epicId ?? 'none')) return false;
  if (filter.sprint?.length && !filter.sprint.includes(item.sprintId ?? 'none')) return false;
  for (const [roleId, values] of Object.entries(filter.roles ?? {})) {
    if (values.length === 0) continue;
    const holders = item.roles[roleId] ?? [];
    const empty = holders.length === 0 && (item.roleNames[roleId] ?? []).length === 0;
    const met = values.some((value) =>
      value === 'none' ? empty : holders.includes(value === 'me' ? context.selfId : value),
    );
    if (!met) return false;
  }
  if (filter.due) {
    // Finished work is never overdue, as it is never shown red.
    const done = project.statuses.find((s) => s.id === item.statusId)?.category === 'done';
    if (filter.due.kind === 'overdue' && done) return false;
    if (!dateMatches(item.dueDate, filter.due, context.today)) return false;
  }
  if (!dateMatches(context.dayOf(item.createdAt), filter.created, context.today)) return false;
  if (!dateMatches(context.dayOf(item.updatedAt), filter.updated, context.today)) return false;
  return true;
}
