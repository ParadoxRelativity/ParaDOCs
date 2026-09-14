import { useEffect, useSyncExternalStore } from 'react';
import { replaceSheetRefs, sheetRefKey, type ResolvedSheetRef, type SheetRef } from '@paradocs/shared';
import { api } from '../api/client';

/**
 * Values of spreadsheet references, as documents and canvases show them.
 *
 * Every reference asks the server afresh when the page showing it mounts —
 * that is what makes a document opened today show today's numbers — and the
 * requests from one page are gathered into a single call. The last answer is
 * kept, so a reference draws its previous value at once and then updates, and
 * so copying text can read the value synchronously, which the clipboard needs.
 */

const cache = new Map<string, ResolvedSheetRef>();
const listeners = new Set<() => void>();
let version = 0;

let queued = new Map<string, SheetRef>();
let timer: ReturnType<typeof setTimeout> | null = null;

function notify(): void {
  version++;
  for (const listener of listeners) listener();
}

async function flush(): Promise<void> {
  timer = null;
  const refs = [...queued.values()];
  queued = new Map();
  if (refs.length === 0) return;
  try {
    const { results } = await api.post<{ results: Record<string, ResolvedSheetRef> }>('/sheet-refs/resolve', { refs });
    for (const [key, result] of Object.entries(results)) cache.set(key, result);
  } catch {
    // An unreachable server keeps whatever was last known rather than blanking
    // every reference on the page.
    for (const ref of refs) {
      const key = sheetRefKey(ref);
      if (!cache.has(key)) cache.set(key, { kind: ref.kind, status: 'missing', problem: 'unavailable' });
    }
  }
  notify();
}

/** Asks for fresh values. Calls in the same moment share one request. */
export function refreshSheetRefs(refs: SheetRef[]): void {
  for (const ref of refs) queued.set(sheetRefKey(ref), ref);
  if (!timer) timer = setTimeout(() => void flush(), 30);
}

/** The last known value, synchronously — for copying, which cannot wait. */
export function cachedSheetRef(ref: SheetRef): ResolvedSheetRef | undefined {
  return cache.get(sheetRefKey(ref));
}

/** Resolves every reference currently queued or cached again, such as after a spreadsheet changed. */
export function refreshAllKnown(): void {
  for (const key of cache.keys()) {
    const [kind, spreadsheetId, sheetId, target] = key.split(':');
    refreshSheetRefs([
      kind === 'cell' ? { kind: 'cell', spreadsheetId, sheetId, cell: target } : { kind: 'chart', spreadsheetId, sheetId, chartId: target },
    ]);
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The current value of one reference. Mounting asks the server for the latest,
 * whatever is cached, so a reference is never older than the page showing it.
 */
export function useSheetRef(ref: SheetRef | null): ResolvedSheetRef | undefined {
  useSyncExternalStore(subscribe, () => version, () => version);
  const key = ref ? sheetRefKey(ref) : '';
  useEffect(() => {
    if (ref) refreshSheetRefs([ref]);
    // The key captures everything the reference is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return ref ? cache.get(key) : undefined;
}

/**
 * Markdown carrying reference placeholders, with each replaced by its last
 * known value — for copying from a board, which has to answer synchronously.
 */
export function withCachedSheetValues(markdown: string): string {
  return replaceSheetRefs(markdown, cache);
}

/** How a cell reference reads as plain text: its value, or its label when it cannot be shown. */
export function sheetCellText(ref: SheetRef, label: string): string {
  const result = cachedSheetRef(ref);
  if (result?.status === 'ok' && result.kind === 'cell') return result.display;
  return label || (ref.kind === 'cell' ? ref.cell : 'Chart');
}

export interface SpreadsheetOutline {
  id: string;
  title: string;
  sheets: { id: string; name: string; charts: { id: string; title: string; kind: string; range: string }[] }[];
}

export function fetchOutline(spreadsheetId: string): Promise<SpreadsheetOutline> {
  return api.get<SpreadsheetOutline>(`/spreadsheets/${spreadsheetId}/outline`);
}
