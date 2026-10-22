import { useQuery } from '@tanstack/react-query';
import type { WorkItemDetail, WorkItemReference } from '@paradocs/shared';
import { api } from '../api/client';

/**
 * Work items as documents and canvases show them: key, title and where each
 * has got to.
 *
 * A page with a dozen chips asks once, not a dozen times: lookups made in the
 * same moment are gathered into one request. Each answer is cached per item,
 * and a change to an item heard over the socket invalidates its entry, so a
 * chip moves to "Done" while the document is open.
 */

let queued = new Map<string, ((item: WorkItemReference | null) => void)[]>();
let timer: ReturnType<typeof setTimeout> | null = null;

async function flush(): Promise<void> {
  timer = null;
  const waiting = queued;
  queued = new Map();
  try {
    const { items } = await api.post<{ items: WorkItemReference[] }>('/work-item-refs/resolve', { ids: [...waiting.keys()] });
    const found = new Map(items.map((item) => [item.id, item]));
    for (const [id, resolvers] of waiting) for (const resolve of resolvers) resolve(found.get(id) ?? null);
  } catch {
    // Unreachable reads the same as unavailable; the chip keeps its label.
    for (const resolvers of waiting.values()) for (const resolve of resolvers) resolve(null);
  }
}

function lookup(id: string): Promise<WorkItemReference | null> {
  return new Promise((resolve) => {
    queued.set(id, [...(queued.get(id) ?? []), resolve]);
    if (!timer) timer = setTimeout(() => void flush(), 20);
  });
}

/** One work item, or null once it is known not to be available to this reader. */
export function useWorkItemRef(id: string | null | undefined, live = false) {
  return useQuery({
    queryKey: ['workItemRef', id ?? ''],
    queryFn: () => lookup(id!.toLowerCase()),
    enabled: Boolean(id),
    staleTime: 30_000,
    // A card on a slide being watched keeps up with the item even where no socket event reaches it.
    refetchInterval: live ? 5000 : false,
  });
}

// ---------------------------------------------------------------------------
// In detail, for status slides
// ---------------------------------------------------------------------------

let detailQueue = new Map<string, ((item: WorkItemDetail | null) => void)[]>();
let detailTimer: ReturnType<typeof setTimeout> | null = null;

/** Work items in detail, as the person asking may see them; those they may not are left out. */
export async function fetchWorkItemDetails(ids: string[]): Promise<WorkItemDetail[]> {
  if (ids.length === 0) return [];
  const { items } = await api.post<{ items: WorkItemDetail[] }>('/work-item-refs/details', { ids });
  return items;
}

async function flushDetails(): Promise<void> {
  detailTimer = null;
  const waiting = detailQueue;
  detailQueue = new Map();
  try {
    const found = new Map((await fetchWorkItemDetails([...waiting.keys()])).map((item) => [item.id, item]));
    for (const [id, resolvers] of waiting) for (const resolve of resolvers) resolve(found.get(id) ?? null);
  } catch {
    for (const resolvers of waiting.values()) for (const resolve of resolvers) resolve(null);
  }
}

function lookupDetail(id: string): Promise<WorkItemDetail | null> {
  return new Promise((resolve) => {
    detailQueue.set(id, [...(detailQueue.get(id) ?? []), resolve]);
    if (!detailTimer) detailTimer = setTimeout(() => void flushDetails(), 20);
  });
}

export const workItemDetailKey = (id: string) => ['workItemDetail', id.toLowerCase()] as const;

/**
 * One work item with who is on it and how far the work under it has got, or
 * null once it is known not to be available to this reader. Lookups made in
 * the same moment share a request, as `useWorkItemRef`'s do.
 */
export function useWorkItemDetail(id: string | null | undefined, live = false) {
  return useQuery({
    queryKey: workItemDetailKey(id ?? ''),
    queryFn: () => lookupDetail(id!.toLowerCase()),
    enabled: Boolean(id),
    staleTime: 30_000,
    refetchInterval: live ? 5000 : false,
  });
}
