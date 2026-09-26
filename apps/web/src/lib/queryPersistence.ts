import type { Query, QueryClient } from '@tanstack/react-query';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import type { PersistQueryClientOptions } from '@tanstack/react-query-persist-client';
import { serverOrigin } from './server';

/**
 * Keeping what the sidebars show on disk between launches.
 *
 * Opening the app paints the sidebar from what was there last time and asks
 * the server again straight away, so it appears at once and is current a
 * moment later, however long the app was closed. Live updates keep it current
 * while the app is open, as they always have; this only covers the gap before
 * the first answer arrives.
 *
 * Only lists that find your way around are kept: workspaces, folder trees and
 * their open folders, channels, conversations, projects, people and tags. What
 * is written in documents, messages and work items is not, and neither is who
 * is signed in, which is always asked of the server, so a session that has
 * ended is never taken for one that has not.
 *
 * It is kept per server — each desktop connection has storage of its own, and
 * the mobile app's key names its server — and for one person at a time: when
 * someone else signs in on the same server, or nobody is, it is thrown away.
 */

/** The query-key roots worth keeping: what the sidebars and switchers are drawn from. */
const KEPT = new Set(['workspaces', 'tree', 'sheetTree', 'channels', 'directs', 'projects', 'members', 'tags']);

/**
 * Bumped whenever something kept here changes shape, so a client never draws
 * last week's shape with this week's code. The release version does the same
 * across releases.
 */
const CACHE_FORMAT = 1;

/** How long a kept answer is worth showing before it is not worth showing at all. */
const MAX_AGE = 14 * 24 * 60 * 60 * 1000;

const DB_NAME = 'paradocs-cache';
const STORE = 'queries';
const OWNER_KEY = 'paradocs.cacheOwner';

/** A key per server, for the mobile app, whose one storage serves whichever server it was pointed at. */
function cacheKey(): string {
  return `queries:${serverOrigin() ?? 'here'}`;
}

let opening: Promise<IDBDatabase> | null = null;

/** The cache's IndexedDB database, opened once. */
function database(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  // A failed open is tried again next time rather than remembered.
  opening.catch(() => (opening = null));
  return opening;
}

function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return database().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const request = work(db.transaction(STORE, mode).objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }),
  );
}

/**
 * The storage the persister writes through. IndexedDB rather than
 * localStorage, since a large tree would not fit in localStorage's few
 * megabytes, and writing it would hold up the page. It is a cache: anything
 * going wrong with it — private browsing, a full disk, storage cleared — only
 * means the next launch fetches everything, as it did before.
 */
const storage = {
  getItem: (key: string) => run<string | undefined>('readonly', (store) => store.get(key)).then((v) => v ?? null).catch(() => null),
  setItem: (key: string, value: string) => run('readwrite', (store) => store.put(value, key)).then(() => undefined).catch(() => undefined),
  removeItem: (key: string) => run('readwrite', (store) => store.delete(key)).then(() => undefined).catch(() => undefined),
};

const persister = createAsyncStoragePersister({
  storage,
  key: cacheKey(),
  // Written at most once a second, however busy the socket is.
  throttleTime: 1000,
});

function kept(query: Query): boolean {
  return query.state.status === 'success' && KEPT.has(String(query.queryKey[0]));
}

export const persistOptions: Omit<PersistQueryClientOptions, 'queryClient'> = {
  persister,
  maxAge: MAX_AGE,
  buster: `${__PARADOCS_VERSION__ ?? 'dev'}:${CACHE_FORMAT}`,
  dehydrateOptions: { shouldDehydrateQuery: kept },
};

/**
 * Lets kept lists outlive the default few minutes in memory. A list nobody is
 * looking at is otherwise dropped from memory, and so from the next save, which
 * would keep only the workspaces opened in the last few minutes. Everything
 * else keeps the default.
 */
export function keepLonger(queryClient: QueryClient): void {
  for (const root of KEPT) queryClient.setQueryDefaults([root], { gcTime: MAX_AGE });
}

/**
 * Throws away what was kept, on disk and in memory: when someone signs out,
 * and when whoever is signed in is not who it was kept for.
 */
export async function forgetCache(queryClient: QueryClient): Promise<void> {
  queryClient.removeQueries({ predicate: kept });
  await persister.removeClient();
}

/**
 * Deletes what was kept for any server but this one, run once at startup.
 * Only the mobile app keeps more than one, and it changes server by reloading,
 * so the next start is when the last server's cache is known to be finished
 * with — however that change was made, and even if it was cut short. With no
 * server chosen yet, nothing is kept.
 */
export async function sweepOtherServers(): Promise<void> {
  const current = cacheKey();
  try {
    const stored = await run<IDBValidKey[]>('readonly', (store) => store.getAllKeys());
    for (const key of stored) {
      if (typeof key === 'string' && key !== current) await storage.removeItem(key);
    }
  } catch {
    // Storage unavailable: there is nothing kept to sweep either.
  }
  try {
    const ownerKey = `${OWNER_KEY}:${current}`;
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(`${OWNER_KEY}:`) && key !== ownerKey) stale.push(key);
    }
    for (const key of stale) localStorage.removeItem(key);
  } catch {
    // Storage blocked.
  }
}

function storedOwner(): string | null {
  try {
    return localStorage.getItem(`${OWNER_KEY}:${cacheKey()}`);
  } catch {
    return null;
  }
}

function storeOwner(userId: string | null) {
  try {
    if (userId) localStorage.setItem(`${OWNER_KEY}:${cacheKey()}`, userId);
    else localStorage.removeItem(`${OWNER_KEY}:${cacheKey()}`);
  } catch {
    // Storage blocked: nothing was kept on disk either.
  }
}

/**
 * Called with whoever the server says is signed in, each time it says. What
 * was kept belongs to one person; for anyone else, or nobody, it goes, before
 * anything drawn from it is shown.
 */
export async function claimCache(queryClient: QueryClient, userId: string | null): Promise<void> {
  // Whatever cannot be shown to be theirs is not theirs: a cache with no
  // owner recorded goes too, which costs at most one launch's head start.
  if (storedOwner() !== userId) await forgetCache(queryClient);
  storeOwner(userId);
}
