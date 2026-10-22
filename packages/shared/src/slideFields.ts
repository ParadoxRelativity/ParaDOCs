/**
 * Live fields: a value from elsewhere in the workspace, set in the running
 * text of a slide — "Revenue is {B5}", "{PARA-12 status}", "{the epic} is
 * {60%} done". Like a live element, a field stores only where its value lives;
 * each viewer's client asks for the value as it is now, answered for that
 * viewer, so someone who may not see the source sees a lock instead of it.
 *
 * In a rich text body a field is a `field` element whose attributes are the
 * strings {@link fieldAttributes} writes, plus `label`: what the field read
 * when it was placed, kept for the deck's search text and never shown in its
 * place to a viewer.
 */

import type { WorkItemReference } from './chat.js';
import type { EpicProgress, StatusCategory } from './projects.js';

export const FIELD_NODE = 'field';

/** What a work item field shows of the item. */
export type WorkItemFieldPart = 'key' | 'title' | 'status' | 'people' | 'due' | 'percent' | 'count';

export const WORK_ITEM_FIELD_PARTS: { part: WorkItemFieldPart; label: string }[] = [
  { part: 'status', label: 'Status' },
  { part: 'percent', label: 'Percent done (work under it)' },
  { part: 'count', label: 'Done of total (work under it)' },
  { part: 'title', label: 'Title' },
  { part: 'key', label: 'Key' },
  { part: 'people', label: 'Assignee' },
  { part: 'due', label: 'Due date' },
];

export type SlideField =
  | { kind: 'cell'; spreadsheetId: string; sheetId: string; cell: string }
  | { kind: 'workItem'; itemId: string; part: WorkItemFieldPart }
  /** A document's title, which opens it where the slide is being presented. */
  | { kind: 'document'; documentId: string };

const PARTS = new Set<string>(WORK_ITEM_FIELD_PARTS.map((p) => p.part));
const ID = /^[0-9a-f-]{36}$/i;
const CELL = /^[A-Z]{1,3}[0-9]{1,7}$/;

/** A field as the string attributes its node carries. */
export function fieldAttributes(ref: SlideField): Record<string, string> {
  switch (ref.kind) {
    case 'cell':
      return { kind: 'cell', target: ref.spreadsheetId, sheet: ref.sheetId, cell: ref.cell.toUpperCase() };
    case 'workItem':
      return { kind: 'workItem', target: ref.itemId, part: ref.part };
    case 'document':
      return { kind: 'document', target: ref.documentId };
  }
}

/** A field from its node's attributes; null for anything malformed, which is then dropped rather than shown. */
export function fieldFromAttributes(attrs: Record<string, unknown>): SlideField | null {
  const target = typeof attrs.target === 'string' && ID.test(attrs.target) ? attrs.target.toLowerCase() : null;
  if (!target) return null;
  if (attrs.kind === 'cell') {
    const cell = typeof attrs.cell === 'string' ? attrs.cell.toUpperCase() : '';
    const sheet = typeof attrs.sheet === 'string' ? attrs.sheet : '';
    return sheet && CELL.test(cell) ? { kind: 'cell', spreadsheetId: target, sheetId: sheet, cell } : null;
  }
  if (attrs.kind === 'workItem') {
    const part = typeof attrs.part === 'string' && PARTS.has(attrs.part) ? (attrs.part as WorkItemFieldPart) : 'status';
    return { kind: 'workItem', itemId: target, part };
  }
  if (attrs.kind === 'document') return { kind: 'document', documentId: target };
  return null;
}

/** One key per distinct field, so lookups made for the same field can be shared. */
export function fieldKey(ref: SlideField): string {
  switch (ref.kind) {
    case 'cell':
      return `cell:${ref.spreadsheetId}:${ref.sheetId}:${ref.cell}`;
    case 'workItem':
      return `workItem:${ref.itemId}:${ref.part}`;
    case 'document':
      return `document:${ref.documentId}`;
  }
}

// ---------------------------------------------------------------------------
// Work items in detail
// ---------------------------------------------------------------------------

/** A work item under another, as a progress card lists it. */
export interface WorkItemChild {
  id: string;
  key: string;
  title: string;
  statusName: string;
  statusCategory: StatusCategory;
  statusColor: string;
}

/**
 * A work item with what a status slide reports of it: who is on it, when it is
 * due, and for work with other work under it (an epic), how far along that is.
 */
export interface WorkItemDetail extends WorkItemReference {
  typeName: string;
  /** Its type is the project's epic type. */
  epic: boolean;
  dueDate: string | null;
  /** Who holds its project's first role: the assignee, unless the project has reordered its roles. */
  people: string[];
  /** How far along the work under it is, archived work counted as done; null when nothing is under it. */
  progress: EpicProgress | null;
  /** The work under it that is not archived: open work first, then by status order. At most {@link MAX_WORK_ITEM_CHILDREN}. */
  children: WorkItemChild[];
  /** How many of the work under it (archived included) are in each status, in board order; empty when nothing is. */
  statuses: { name: string; color: string; category: StatusCategory; count: number }[];
}

export const MAX_WORK_ITEM_CHILDREN = 50;

/** Done as a whole percentage: of the work under the item when there is any, else 0 or 100 by its own status. */
export function workItemPercent(item: Pick<WorkItemDetail, 'progress' | 'statusCategory'>): number {
  const progress = item.progress;
  if (progress && progress.total > 0) return Math.round((progress.done / progress.total) * 100);
  return item.statusCategory === 'done' ? 100 : 0;
}

/** A YYYY-MM-DD date as a reader expects it ("Oct 21, 2026"), read as a calendar date wherever the reader is. */
export function formatDueDate(date: string, locale?: string): string {
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return date;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/** What a work item field reads as, for the item as it is now. */
export function workItemFieldText(part: WorkItemFieldPart, item: WorkItemDetail, locale?: string): string {
  switch (part) {
    case 'key':
      return item.key;
    case 'title':
      return item.title;
    case 'status':
      return item.statusName;
    case 'people':
      return item.people.length ? item.people.join(', ') : 'Unassigned';
    case 'due':
      return item.dueDate ? formatDueDate(item.dueDate, locale) : 'No due date';
    case 'percent':
      return `${workItemPercent(item)}%`;
    case 'count': {
      const progress = item.progress;
      return progress && progress.total > 0 ? `${progress.done} of ${progress.total}` : item.statusCategory === 'done' ? '1 of 1' : '0 of 1';
    }
  }
}
