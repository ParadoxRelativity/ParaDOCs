import { useSyncExternalStore } from 'react';
import { desktop, type DesktopPreferenceKey } from './desktop';

/**
 * A choice that belongs to the person at the computer rather than to their
 * account, such as the theme.
 *
 * In a browser it lives in this page's storage. In the desktop app the app
 * keeps it instead: every connection is a different page with storage of its
 * own, and a choice like this should be the same on every server. Page storage
 * is still written there too, for anything that reads it before React runs.
 */
export function createPreference<T>({
  key,
  storageKey,
  fallback,
  isValid,
}: {
  key: DesktopPreferenceKey;
  storageKey: string;
  fallback: T;
  isValid: (value: unknown) => value is T;
}) {
  function load(): T {
    const saved = desktop?.preferences.initial[key];
    if (isValid(saved)) return saved;
    try {
      const stored = localStorage.getItem(storageKey);
      const parsed: unknown = stored ? JSON.parse(stored) : null;
      return isValid(parsed) ? parsed : fallback;
    } catch {
      return fallback;
    }
  }

  let current = load();
  const listeners = new Set<() => void>();

  function apply(next: T) {
    current = next;
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // Storage can be blocked; the choice still holds for this session.
    }
    listeners.forEach((listener) => listener());
  }

  function set(next: T) {
    if (Object.is(next, current)) return;
    apply(next);
    void desktop?.preferences.set(key, next).catch(() => {});
  }

  // Another connection's page in the desktop app changed it.
  desktop?.preferences.onChanged((changed, value) => {
    if (changed === key && isValid(value) && !Object.is(value, current)) apply(value);
  });

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const get = () => current;

  return {
    get,
    set,
    use: (): [T, (next: T) => void] => [useSyncExternalStore(subscribe, get), set],
  };
}
