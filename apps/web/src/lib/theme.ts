import { useSyncExternalStore } from 'react';
import { desktop } from './desktop';

export type Theme = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'paradocs.theme';

function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark' || value === 'system';
}

/**
 * In a browser the theme lives in this page's storage, where the script in
 * index.html reads it before first paint. In the desktop app the app keeps it
 * instead: every connection is a different page with storage of its own, and
 * a theme belongs to the person at the computer rather than to one server.
 */
function load(): Theme {
  const saved = desktop?.preferences.initial.theme;
  if (isTheme(saved)) return saved;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = stored ? JSON.parse(stored) : null;
    return isTheme(parsed) ? parsed : 'system';
  } catch {
    return 'system';
  }
}

let current = load();
const listeners = new Set<() => void>();

function apply(next: Theme) {
  current = next;
  try {
    // Kept in page storage too, for the pre-paint script.
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage can be blocked; the theme still applies for this session.
  }
  listeners.forEach((listener) => listener());
}

export function setTheme(next: Theme) {
  if (next === current) return;
  apply(next);
  void desktop?.preferences.set('theme', next).catch(() => {});
}

// Another connection's page in the desktop app changed it.
desktop?.preferences.onChanged((key, value) => {
  if (key === 'theme' && isTheme(value) && value !== current) apply(value);
});

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTheme(): [Theme, (theme: Theme) => void] {
  return [useSyncExternalStore(subscribe, () => current), setTheme];
}
