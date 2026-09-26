/**
 * Insights: how a project or queue has been doing, worked out from its items.
 *
 * Everything here is read from what the app already keeps — when an item was
 * made, when it last went into a done status, its due date, estimate, sprint
 * and priority — plus, for a queue, when each item first had a response. It is
 * worked out on the reader's side from the items they already have, so weeks
 * and days fall where the reader's own calendar puts them.
 *
 * Archived work is not loaded with the rest, so callers pass the archived
 * items finished within the range alongside the current ones; nothing older
 * matters here except to velocity, which reads the project's archive totals.
 *
 * Epics are left out throughout: they hold work rather than being worked, and
 * are finished only when what is under them is.
 */

import type { Project, WorkItemPriority, WorkItemSummary } from './projects.js';
import { WORK_ITEM_PRIORITIES } from './projects.js';

/** How far back insights look, in days. */
export type InsightsRange = 30 | 90 | 180 | 365;
export const INSIGHTS_RANGES: InsightsRange[] = [30, 90, 180, 365];

/**
 * When each item in a queue first had a response, keyed by item id: the first
 * comment from someone other than whoever filed it, the first move to another
 * status, or its being finished, whichever came first. Items nobody has
 * responded to are left out.
 */
export type WorkItemResponses = Record<string, string>;

/** How long something took, over a set of items. Milliseconds. */
export interface DurationStats {
  count: number;
  median: number | null;
  average: number | null;
  /** Nine in ten took no longer than this. */
  p90: number | null;
}

/** One week of work coming in and going out. */
export interface FlowWeek {
  /** The Monday it starts on, YYYY-MM-DD. */
  start: string;
  created: number;
  completed: number;
}

/** What a finished sprint got done. */
export interface SprintVelocity {
  id: string;
  name: string;
  completedAt: string;
  items: number;
  estimate: number;
}

/** How a priority has been handled. */
export interface PriorityInsight {
  priority: WorkItemPriority;
  open: number;
  /** Finished within the range. */
  completed: number;
  /** Median time from filed to finished, for those. */
  resolve: number | null;
  /** Median time to first response, for items filed within the range. Queues only. */
  response: number | null;
}

export interface ProjectInsights {
  range: InsightsRange;
  /** Oldest first, ending with the week today is in. */
  flow: FlowWeek[];
  /** Filed within the range. */
  created: number;
  /** Finished within the range. */
  completed: number;
  /** Finished per week, averaged over the range. */
  throughput: number;
  open: {
    total: number;
    backlog: number;
    notStarted: number;
    inProgress: number;
    /** Waiting on another item that is not done. */
    blocked: number;
    overdue: number;
    /** Untouched for `STALE_DAYS` or more. */
    stale: number;
    /** How long the oldest open item has been open, off the backlog. */
    oldest: number | null;
  };
  /** Filed to finished, for work finished within the range. */
  leadTime: DurationStats;
  /**
   * Whether work was finished by its due date, counted when that was settled
   * within the range: when it was finished, or when its due date went by
   * while it was still open.
   */
  dueDates: {
    onTime: number;
    /** Finished, but after its due date. */
    late: number;
    /** Still open past its due date. */
    missed: number;
    /** On time out of all of them, 0–1. Null when none had a due date settle. */
    rate: number | null;
  };
  /** Only for a project run in sprints. Oldest first, the last `VELOCITY_SPRINTS`. */
  velocity: {
    sprints: SprintVelocity[];
    /** Over the last three. */
    average: { items: number; estimate: number } | null;
    /** Whether any of it was estimated, so velocity is worth giving in estimate. */
    estimated: boolean;
  } | null;
  /** Filed to first response, for items filed within the range. Null without response times. */
  response: DurationStats | null;
  /** Open items nobody has responded to yet. Null without response times. */
  unanswered: number | null;
  /** Highest priority first. */
  priorities: PriorityInsight[];
}

export const STALE_DAYS = 14;
export const VELOCITY_SPRINTS = 8;
const DAY = 86_400_000;

/** YYYY-MM-DD for the local calendar day a moment falls on. */
function localDate(value: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

/** Local midnight at the start of the Monday of the week a moment falls in. */
function weekStart(value: Date): Date {
  const start = new Date(value.getFullYear(), value.getMonth(), value.getDate());
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return start;
}

function quantile(sorted: number[], q: number): number {
  const at = (sorted.length - 1) * q;
  const low = Math.floor(at);
  const high = Math.ceil(at);
  return sorted[low] + (sorted[high] - sorted[low]) * (at - low);
}

export function durationStats(values: number[]): DurationStats {
  if (values.length === 0) return { count: 0, median: null, average: null, p90: null };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    median: quantile(sorted, 0.5),
    average: sorted.reduce((total, v) => total + v, 0) / sorted.length,
    p90: quantile(sorted, 0.9),
  };
}

function median(values: number[]): number | null {
  return values.length ? quantile([...values].sort((a, b) => a - b), 0.5) : null;
}

/** Local midnight on the first day a range covers. */
export function insightsRangeStart(range: InsightsRange, now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - range + 1);
}

export function projectInsights(
  project: Pick<Project, 'kind' | 'statuses' | 'itemTypes' | 'sprints' | 'sprintsEnabled' | 'archive'>,
  allItems: WorkItemSummary[],
  options: { range: InsightsRange; responses?: WorkItemResponses | null; now?: Date },
): ProjectInsights {
  const now = options.now ?? new Date();
  const { range, responses } = options;
  const today = localDate(now);
  const from = insightsRangeStart(range, now);
  const fromDate = localDate(from);
  const since = from.getTime();

  const categories = new Map(project.statuses.map((s) => [s.id, s.category]));
  const epicTypes = new Set(project.itemTypes.filter((t) => t.epic).map((t) => t.id));
  const items = allItems.filter((item) => !epicTypes.has(item.typeId));
  const isDone = (item: WorkItemSummary) => categories.get(item.statusId) === 'done' && item.completedAt !== null;

  // Weeks, Monday to Sunday, from the one the range starts in to this one.
  const flow: FlowWeek[] = [];
  const weekIndex = new Map<string, number>();
  for (let week = weekStart(from); week.getTime() <= now.getTime(); week.setDate(week.getDate() + 7)) {
    weekIndex.set(localDate(week), flow.length);
    flow.push({ start: localDate(week), created: 0, completed: 0 });
  }
  const bucket = (at: Date) => flow[weekIndex.get(localDate(weekStart(at))) ?? -1];

  const open = { total: 0, backlog: 0, notStarted: 0, inProgress: 0, blocked: 0, overdue: 0, stale: 0, oldest: null as number | null };
  const dueDates = { onTime: 0, late: 0, missed: 0 };
  const leadTimes: number[] = [];
  const responseTimes: number[] = [];
  let created = 0;
  let completed = 0;
  let unanswered = 0;

  const byPriority = new Map(
    WORK_ITEM_PRIORITIES.map((priority) => [priority, { open: 0, resolve: [] as number[], response: [] as number[] }]),
  );

  for (const item of items) {
    const madeAt = new Date(item.createdAt);
    const priority = byPriority.get(item.priority)!;
    if (madeAt.getTime() >= since) {
      created++;
      const week = bucket(madeAt);
      if (week) week.created++;
    }

    if (responses) {
      const respondedAt = responses[item.id];
      if (respondedAt && madeAt.getTime() >= since) {
        const took = Math.max(0, new Date(respondedAt).getTime() - madeAt.getTime());
        responseTimes.push(took);
        priority.response.push(took);
      }
      if (!respondedAt && !isDone(item)) unanswered++;
    }

    if (isDone(item)) {
      const doneAt = new Date(item.completedAt!);
      const doneDate = localDate(doneAt);
      if (doneAt.getTime() >= since) {
        completed++;
        const week = bucket(doneAt);
        if (week) week.completed++;
        const took = Math.max(0, doneAt.getTime() - madeAt.getTime());
        leadTimes.push(took);
        priority.resolve.push(took);
      }
      // Settled when it was finished, or when its due date went by if that was first.
      if (item.dueDate) {
        const settled = doneDate <= item.dueDate ? doneDate : item.dueDate;
        if (settled >= fromDate) {
          if (doneDate <= item.dueDate) dueDates.onTime++;
          else dueDates.late++;
        }
      }
      continue;
    }

    const category = categories.get(item.statusId);
    open.total++;
    priority.open++;
    if (category === 'backlog') {
      open.backlog++;
      continue;
    }
    if (category === 'todo') open.notStarted++;
    else open.inProgress++;
    if (item.blockedBy > 0) open.blocked++;
    if (item.dueDate && item.dueDate < today) {
      open.overdue++;
      if (item.dueDate >= fromDate) dueDates.missed++;
    }
    if (now.getTime() - new Date(item.updatedAt).getTime() >= STALE_DAYS * DAY) open.stale++;
    const age = now.getTime() - madeAt.getTime();
    if (open.oldest === null || age > open.oldest) open.oldest = age;
  }

  const settled = dueDates.onTime + dueDates.late + dueDates.missed;

  let velocity: ProjectInsights['velocity'] = null;
  if (project.kind === 'project' && project.sprintsEnabled) {
    const finished = project.sprints
      .filter((s) => s.state === 'completed' && s.completedAt)
      .sort((a, b) => a.completedAt!.localeCompare(b.completedAt!))
      .slice(-VELOCITY_SPRINTS);
    // A completed sprint keeps only what was finished in it, so what is in it
    // is what it got done: what is current, and what has since been archived,
    // which the totals count whether or not it was loaded.
    const sprints = finished.map((sprint) => {
      const done = items.filter((item) => item.sprintId === sprint.id && isDone(item) && !item.archivedAt);
      const archived = project.archive.sprints[sprint.id];
      return {
        id: sprint.id,
        name: sprint.name,
        completedAt: sprint.completedAt!,
        items: done.length + (archived?.items ?? 0),
        estimate: done.reduce((total, item) => total + (item.estimate ?? 0), 0) + (archived?.estimate ?? 0),
      };
    });
    const recent = sprints.slice(-3);
    velocity = {
      sprints,
      average: recent.length
        ? {
            items: recent.reduce((t, s) => t + s.items, 0) / recent.length,
            estimate: recent.reduce((t, s) => t + s.estimate, 0) / recent.length,
          }
        : null,
      estimated: sprints.some((s) => s.estimate > 0),
    };
  }

  return {
    range,
    flow,
    created,
    completed,
    throughput: completed / (range / 7),
    open,
    leadTime: durationStats(leadTimes),
    dueDates: { ...dueDates, rate: settled ? dueDates.onTime / settled : null },
    velocity,
    response: responses ? durationStats(responseTimes) : null,
    unanswered: responses ? unanswered : null,
    priorities: WORK_ITEM_PRIORITIES.map((p) => {
      const entry = byPriority.get(p)!;
      return {
        priority: p,
        open: entry.open,
        completed: entry.resolve.length,
        resolve: median(entry.resolve),
        response: responses ? median(entry.response) : null,
      };
    }),
  };
}
