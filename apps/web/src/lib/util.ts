import { useCallback, useEffect, useRef, useState } from 'react';

/** Distinct, readable accent colors for generated avatars and cursors. */
export const ID_COLORS = [
  '#6366f1',
  '#0ea5e9',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#ec4899',
  '#8b5cf6',
  '#14b8a6',
];

/** Picks a stable color for a string, so the same id always looks the same. */
export function colorFromString(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  return ID_COLORS[hash % ID_COLORS.length];
}

/**
 * A random UUID. `crypto.randomUUID` only exists on secure pages — HTTPS or
 * localhost — so a server opened by its LAN address over plain HTTP would
 * crash on the first id it made. `getRandomValues` is there either way.
 */
export function randomId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/** A file size for people to read: "820 B", "4.2 KB", "25 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Number((bytes / 1024).toFixed(1))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Number((bytes / (1024 * 1024)).toFixed(1))} MB`;
  return `${Number((bytes / (1024 * 1024 * 1024)).toFixed(1))} GB`;
}

/** State mirrored into localStorage, used for sidebar and theme preferences. */
export function useLocalStorage<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored === null ? initial : (JSON.parse(stored) as T);
    } catch {
      return initial;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Storage can be full or blocked; the preference just will not persist.
    }
  }, [key, value]);

  return [value, setValue] as const;
}

export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/** Fires `fn` after `delayMs` of quiet, and immediately on unmount if pending. */
export function useAutosave<T>(fn: (value: T) => void, delayMs: number) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const pending = useRef<{ value: T } | null>(null);

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
    if (pending.current) {
      const { value } = pending.current;
      pending.current = null;
      fnRef.current(value);
    }
  }, []);

  const schedule = useCallback(
    (value: T) => {
      pending.current = { value };
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, delayMs);
    },
    [delayMs, flush],
  );

  // Do not lose the last keystrokes when navigating away from a document.
  useEffect(() => flush, [flush]);
  useEffect(() => {
    const onHide = () => flush();
    window.addEventListener('beforeunload', onHide);
    return () => window.removeEventListener('beforeunload', onHide);
  }, [flush]);

  return { schedule, flush };
}

export const todayISO = () => toISODate(new Date());

export function toISODate(date: Date): string {
  // Local calendar date, not UTC: a day on the calendar is the user's day.
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

export function formatDay(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

/** Absolute local datetime, e.g. "Sep 8, 2026, 2:14 PM". */
export function formatDateTime(isoTimestamp: string): string {
  return new Date(isoTimestamp).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Word count over the derived markdown, ignoring markdown punctuation. */
export function countWords(markdown: string): number {
  const prose = plainSnippet(markdown);
  return prose ? prose.split(/\s+/).length : 0;
}

/** Handles past and future timestamps: "3 days ago" and "in 14 days". */
export function formatRelative(isoTimestamp: string): string {
  const then = new Date(isoTimestamp).getTime();
  const seconds = Math.round((Date.now() - then) / 1000);
  const magnitude = Math.abs(seconds);
  if (magnitude < 60) return 'just now';
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['minute', 60],
    ['hour', 3600],
    ['day', 86_400],
    ['week', 604_800],
    ['month', 2_592_000],
    ['year', 31_536_000],
  ];
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  let chosen: [Intl.RelativeTimeFormatUnit, number] = units[0];
  for (const unit of units) if (magnitude >= unit[1]) chosen = unit;
  return formatter.format(-Math.round(seconds / chosen[1]), chosen[0]);
}

/** Strips markdown noise so a snippet reads as plain prose. */
export function plainSnippet(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/^\s*[-*]\s+(\[[ x]\]\s*)?/gm, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}
