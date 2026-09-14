import path from 'node:path';
import { paths } from './paths.js';
import { readJson, writeJson } from './store.js';

/**
 * Appearance and call-device choices, kept by the app rather than by each page.
 *
 * A page's own storage belongs to its address, and every connection is a
 * different address, so a theme chosen in one would not follow to the next.
 * These belong to the person at this computer rather than to a server, so the
 * app keeps one copy and hands it to every page.
 */

export interface MediaPreferences {
  microphoneId: string;
  speakerId: string;
  cameraId: string;
  inputVolume: number;
  outputVolume: number;
}

export interface Preferences {
  theme?: 'light' | 'dark' | 'system';
  media?: MediaPreferences;
  /** Where the other videos in a call go when one is focused. */
  callLayout?: 'side' | 'bottom';
  /** Whether clicking a notification moves the current tab or opens a new one. */
  openNotifications?: 'here' | 'tab';
}

const file = path.join(paths.userData, 'preferences.json');

function isTheme(value: unknown): value is NonNullable<Preferences['theme']> {
  return value === 'light' || value === 'dark' || value === 'system';
}

function isCallLayout(value: unknown): value is NonNullable<Preferences['callLayout']> {
  return value === 'side' || value === 'bottom';
}

function isOpenBehaviour(value: unknown): value is NonNullable<Preferences['openNotifications']> {
  return value === 'here' || value === 'tab';
}

/** Pages send these, so every field is checked rather than stored as given. */
function sanitizeMedia(value: unknown): MediaPreferences | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const id = (v: unknown) => (typeof v === 'string' ? v.slice(0, 512) : '');
  const level = (v: unknown, max: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(0, Math.round(v))) : 100;
  return {
    microphoneId: id(raw.microphoneId),
    speakerId: id(raw.speakerId),
    cameraId: id(raw.cameraId),
    inputVolume: level(raw.inputVolume, 200),
    outputVolume: level(raw.outputVolume, 100),
  };
}

export function getPreferences(): Preferences {
  const stored = readJson<Record<string, unknown>>(file, {});
  const preferences: Preferences = {};
  if (isTheme(stored.theme)) preferences.theme = stored.theme;
  if (isCallLayout(stored.callLayout)) preferences.callLayout = stored.callLayout;
  if (isOpenBehaviour(stored.openNotifications)) preferences.openNotifications = stored.openNotifications;
  const media = sanitizeMedia(stored.media);
  if (media) preferences.media = media;
  return preferences;
}

/** Stores one preference, returning what was stored, or undefined if it was refused. */
export function setPreference(key: unknown, value: unknown): unknown {
  const next = getPreferences();
  if (key === 'theme' && isTheme(value)) {
    next.theme = value;
  } else if (key === 'media' && sanitizeMedia(value)) {
    next.media = sanitizeMedia(value);
  } else if (key === 'callLayout' && isCallLayout(value)) {
    next.callLayout = value;
  } else if (key === 'openNotifications' && isOpenBehaviour(value)) {
    next.openNotifications = value;
  } else {
    return undefined;
  }
  writeJson(file, next);
  return next[key as keyof Preferences];
}
