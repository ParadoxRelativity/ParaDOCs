import { BrowserWindow, ipcMain, app } from 'electron';
import http from 'node:http';
import https from 'node:https';
import {
  addConnection,
  getConnection,
  listConnections,
  normalizeServerUrl,
  removeConnection,
  updateConnection,
  type Connection,
} from './connections.js';
import { openConnection, windowForConnection } from './windows.js';
import { buildMenu } from './menu.js';
import {
  check as checkForUpdates,
  install as installUpdate,
  onUpdateStatus,
  setAutoDownload,
  setCheckOnLaunch,
  updateStatus,
} from './updater.js';

function broadcastChange(): void {
  // The Servers menu is generated from this list, so it is rebuilt alongside
  // any window showing it.
  buildMenu();
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('connections:changed');
  }
}

export interface ServerCheck {
  ok: boolean;
  origin?: string;
  version?: string;
  error?: string;
}

/**
 * Confirms an address is actually a ParaDOCs server before it is saved, so a
 * typo is caught here rather than as a blank window later. The health endpoint
 * needs no authentication.
 */
export function checkServer(rawUrl: string, timeoutMs = 8000): Promise<ServerCheck> {
  let origin: string;
  try {
    origin = normalizeServerUrl(rawUrl);
  } catch (err) {
    return Promise.resolve({ ok: false, error: (err as Error).message });
  }

  return new Promise((resolve) => {
    const target = new URL('/api/health', origin);
    const agent = target.protocol === 'https:' ? https : http;
    const done = (result: ServerCheck) => {
      clearTimeout(timer);
      resolve(result);
    };

    const request = agent.get(target, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        // A wrong address can point at something that streams forever.
        if (body.length < 4096) body += chunk;
      });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          done({ ok: false, error: `The server answered ${res.statusCode} at /api/health.` });
          return;
        }
        try {
          const payload = JSON.parse(body) as { ok?: boolean; version?: string };
          if (!payload.ok) throw new Error('not ParaDOCs');
          done({ ok: true, origin, version: payload.version });
        } catch {
          done({ ok: false, error: 'That address answered, but it is not a ParaDOCs server.' });
        }
      });
    });

    const timer = setTimeout(() => {
      request.destroy();
      done({ ok: false, error: `${origin} did not respond within ${Math.round(timeoutMs / 1000)}s.` });
    }, timeoutMs);

    request.on('error', (err: NodeJS.ErrnoException) => {
      done({ ok: false, error: describe(err, origin) });
    });
  });
}

function describe(err: NodeJS.ErrnoException, origin: string): string {
  switch (err.code) {
    case 'ENOTFOUND':
      return `Cannot find ${new URL(origin).hostname}. Check the address.`;
    case 'ECONNREFUSED':
      return `${origin} refused the connection. Is the server running?`;
    case 'CERT_HAS_EXPIRED':
      return `${origin} has an expired TLS certificate.`;
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
      return `${origin} uses a self-signed certificate, which this app will not trust.`;
    default:
      return `Cannot reach ${origin} (${err.code ?? err.message}).`;
  }
}

export function registerIpc(): void {
  ipcMain.handle('connections:list', (): Connection[] => listConnections());

  ipcMain.handle('connections:add', async (_event, input: { label: string; kind: string; url?: string }) => {
    const kind = input?.kind === 'local' ? 'local' : 'remote';
    if (kind === 'remote') {
      const check = await checkServer(input.url ?? '');
      if (!check.ok) throw new Error(check.error ?? 'That server could not be reached.');
    }
    const connection = addConnection({ label: input?.label ?? '', kind, url: input?.url });
    broadcastChange();
    return connection;
  });

  ipcMain.handle('connections:update', (_event, input: { id: string; label?: string; url?: string }) => {
    const connection = updateConnection(input.id, { label: input.label, url: input.url });
    broadcastChange();
    return connection;
  });

  ipcMain.handle('connections:remove', (_event, id: string) => {
    // Removing the entry leaves the local data on disk on purpose: dropping a
    // workspace from the list must never be a silent way to delete documents.
    windowForConnection(id)?.close();
    removeConnection(id);
    broadcastChange();
  });

  ipcMain.handle('connections:open', async (_event, id: string) => {
    const connection = getConnection(id);
    if (!connection) throw new Error('That connection no longer exists.');
    await openConnection(connection);
  });

  ipcMain.handle('connections:test', (_event, url: string) => checkServer(url));

  ipcMain.handle('updates:status', () => updateStatus());
  ipcMain.handle('updates:check', () => checkForUpdates({ explicit: true }));
  ipcMain.handle('updates:install', () => installUpdate());
  ipcMain.handle('updates:setAutoDownload', (_event, enabled: boolean) => setAutoDownload(!!enabled));
  ipcMain.handle('updates:setCheckOnLaunch', (_event, enabled: boolean) => setCheckOnLaunch(!!enabled));

  // The connection manager mirrors download progress, so it is pushed rather
  // than polled.
  onUpdateStatus((status) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('updates:changed', status);
    }
  });

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
  }));
}
