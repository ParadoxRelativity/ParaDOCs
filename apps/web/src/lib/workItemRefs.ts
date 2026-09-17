import { useQuery } from '@tanstack/react-query';
import type { WorkItemReference } from '@paradocs/shared';
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
export function useWorkItemRef(id: string | null | undefined) {
  return useQuery({
    queryKey: ['workItemRef', id ?? ''],
    queryFn: () => lookup(id!.toLowerCase()),
    enabled: Boolean(id),
    staleTime: 30_000,
  });
}
