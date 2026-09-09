import { paths } from './paths.js';
import { readJson, writeJson } from './store.js';
import path from 'node:path';

/** Application preferences, as opposed to the list of connections. */
export interface Settings {
  /** Fetch an available update in the background rather than asking first. */
  autoDownloadUpdates: boolean;
  /** Skip the check that runs shortly after launch. */
  checkForUpdatesOnLaunch: boolean;
  /** A version the user chose to pass over; it is not offered again. */
  skippedVersion?: string;
}

const defaults: Settings = {
  autoDownloadUpdates: true,
  checkForUpdatesOnLaunch: true,
};

const file = path.join(paths.userData, 'settings.json');

export function getSettings(): Settings {
  return readJson<Settings>(file, defaults);
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch };
  writeJson(file, next);
  return next;
}
