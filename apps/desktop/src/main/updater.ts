import { app, BrowserWindow, dialog } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import electronUpdater, { type UpdateInfo } from 'electron-updater';
import { getSettings, updateSettings } from './settings.js';

const { autoUpdater } = electronUpdater;

/**
 * Updates for the packaged app.
 *
 * Where they come from is deliberately not fixed. A build published to GitHub
 * Releases carries its own `app-update.yml`; a self-hoster who would rather not
 * depend on GitHub can point `PARADOCS_UPDATE_URL` at any static directory
 * holding the artifacts and their `latest*.yml`. If neither is configured the
 * feature turns itself off rather than reporting an error on every launch —
 * a build someone made for themselves should not nag about updates that do not
 * exist.
 */

export type UpdatePhase =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error';

export interface UpdateStatus {
  phase: UpdatePhase;
  currentVersion: string;
  newVersion?: string;
  percent?: number;
  message?: string;
  /** Why updates are off, when they are. */
  reason?: string;
  autoDownload: boolean;
  checkOnLaunch: boolean;
}

const SIX_HOURS = 6 * 60 * 60 * 1000;

let status: UpdateStatus = {
  phase: 'idle',
  currentVersion: app.getVersion(),
  autoDownload: true,
  checkOnLaunch: true,
};
let configured = false;
const listeners = new Set<(status: UpdateStatus) => void>();

export function onUpdateStatus(listener: (status: UpdateStatus) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setStatus(patch: Partial<UpdateStatus>): void {
  status = { ...status, ...patch };
  for (const listener of listeners) listener(status);
}

export function updateStatus(): UpdateStatus {
  return status;
}

/**
 * A packaged build carries app-update.yml only when it was built with a publish
 * target. Its absence is what tells us this build has no release channel.
 */
function bakedFeedExists(): boolean {
  const candidates = [
    path.join(process.resourcesPath, 'app-update.yml'),
    path.join(process.resourcesPath, 'app', 'app-update.yml'),
  ];
  return candidates.some((candidate) => fs.existsSync(candidate));
}

export function initUpdates(): void {
  const settings = getSettings();
  setStatus({
    autoDownload: settings.autoDownloadUpdates,
    checkOnLaunch: settings.checkForUpdatesOnLaunch,
    currentVersion: app.getVersion(),
  });

  if (!app.isPackaged) {
    setStatus({ phase: 'unsupported', reason: 'Updates apply to an installed build, not a development run.' });
    return;
  }

  // electron-updater reads app-update.yml for its own bookkeeping even when the
  // feed is overridden, so its absence disables updates either way. It is
  // written by any build that has a publish target — which a release build
  // does and a bare `--dir` build does not.
  if (!bakedFeedExists()) {
    setStatus({
      phase: 'unsupported',
      reason:
        'This build carries no update metadata. Builds made with a publish target update themselves; this one was not.',
    });
    return;
  }

  // A deployment that would rather not fetch from GitHub can serve the release
  // files from anywhere it likes.
  const override = process.env.PARADOCS_UPDATE_URL?.trim();
  if (override) autoUpdater.setFeedURL({ provider: 'generic', url: override });

  configured = true;
  autoUpdater.autoDownload = settings.autoDownloadUpdates;
  // Applying a downloaded update on quit means the user is never interrupted
  // mid-sentence; the restart prompt is an offer, not a demand.
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  autoUpdater.on('checking-for-update', () => setStatus({ phase: 'checking', message: undefined }));

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    setStatus({ phase: autoUpdater.autoDownload ? 'downloading' : 'available', newVersion: info.version });
  });

  autoUpdater.on('update-not-available', () => {
    setStatus({ phase: 'idle', newVersion: undefined, message: undefined });
  });

  autoUpdater.on('download-progress', ({ percent }) => {
    setStatus({ phase: 'downloading', percent: Math.round(percent) });
  });

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    setStatus({ phase: 'downloaded', newVersion: info.version, percent: 100 });
    void offerRestart(info.version);
  });

  autoUpdater.on('error', (err: Error) => {
    if (isEmptyChannel(err)) {
      setStatus({ phase: 'idle', newVersion: undefined, message: undefined });
      return;
    }
    setStatus({ phase: 'error', message: friendlyError(err) });
  });

  if (settings.checkForUpdatesOnLaunch) {
    // Late enough that it never competes with opening a workspace.
    setTimeout(() => void check({ explicit: false }), 10_000).unref();
    setInterval(() => void check({ explicit: false }), SIX_HOURS).unref();
  }
}

/**
 * A channel with nothing published yet is the normal state of a project before
 * its first release, not a failure. Reporting it in red on every launch would
 * make the first release look broken to everyone who installed it.
 */
function isEmptyChannel(err: Error): boolean {
  return /no published versions|404/i.test(err?.message ?? String(err));
}

/**
 * Squirrel refuses to replace an application whose signature it cannot verify,
 * which is the usual reason a self-built copy fails at the last step.
 */
function friendlyError(err: Error): string {
  const text = err?.message ?? String(err);
  if (/code signature|not signed|Could not get code signature/i.test(text)) {
    return 'This copy of ParaDOCs is not code signed, so it cannot update itself. Download the new version manually.';
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT/i.test(text)) {
    return 'Could not reach the update server.';
  }
  if (/404/.test(text)) {
    return 'No releases were found on the update channel.';
  }
  return text;
}

export async function check({ explicit }: { explicit: boolean }): Promise<UpdateStatus> {
  if (!configured) {
    if (explicit) {
      await dialog.showMessageBox({
        type: 'info',
        title: 'Updates',
        message: 'Automatic updates are not available for this build.',
        detail: status.reason,
      });
    }
    return status;
  }

  try {
    const result = await autoUpdater.checkForUpdates();
    const version = result?.updateInfo?.version;

    if (explicit && version && version === app.getVersion()) {
      await dialog.showMessageBox({
        type: 'info',
        title: 'Updates',
        message: 'ParaDOCs is up to date.',
        detail: `Version ${app.getVersion()}.`,
      });
    } else if (explicit && version && !autoUpdater.autoDownload) {
      await promptDownload(version);
    }
  } catch (err) {
    const empty = isEmptyChannel(err as Error);
    const message = friendlyError(err as Error);
    setStatus(empty ? { phase: 'idle', message: undefined } : { phase: 'error', message });
    if (explicit) {
      await dialog.showMessageBox({
        type: empty ? 'info' : 'warning',
        title: empty ? 'Updates' : 'Could not check for updates',
        message: empty ? 'No releases have been published yet.' : 'Could not check for updates.',
        detail: empty ? `You are running ${app.getVersion()}.` : message,
      });
    }
  }
  return status;
}

async function promptDownload(version: string): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Download', 'Not now'],
    defaultId: 0,
    cancelId: 1,
    title: 'Update available',
    message: `ParaDOCs ${version} is available.`,
    detail: `You are running ${app.getVersion()}.`,
  });
  if (response === 0) await autoUpdater.downloadUpdate();
}

async function offerRestart(version: string): Promise<void> {
  const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const options = {
    type: 'info' as const,
    buttons: ['Restart now', 'Later'],
    defaultId: 0,
    cancelId: 1,
    title: 'Update ready',
    message: `ParaDOCs ${version} is ready to install.`,
    detail: 'It will be applied the next time you quit, or you can restart now.',
  };
  const { response } = target
    ? await dialog.showMessageBox(target, options)
    : await dialog.showMessageBox(options);
  if (response === 0) install();
}

/**
 * Local workspaces have debounced document saves in flight, so the servers are
 * shut down before the installer takes over.
 */
export function install(): void {
  void import('./windows.js').then(async ({ shutdownAll }) => {
    await shutdownAll();
    autoUpdater.quitAndInstall();
  });
}

export function setAutoDownload(enabled: boolean): UpdateStatus {
  updateSettings({ autoDownloadUpdates: enabled });
  autoUpdater.autoDownload = enabled;
  setStatus({ autoDownload: enabled });
  return status;
}

export function setCheckOnLaunch(enabled: boolean): UpdateStatus {
  updateSettings({ checkForUpdatesOnLaunch: enabled });
  setStatus({ checkOnLaunch: enabled });
  return status;
}
