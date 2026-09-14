import { app, ipcMain, session as electronSession, type IpcMainInvokeEvent } from 'electron';
import http from 'node:http';
import https from 'node:https';
import {
  addConnection,
  getConnection,
  listConnections,
  normalizeServerUrl,
  partitionFor,
  removeConnection,
  updateConnection,
  type Connection,
} from './connections.js';
import {
  activeConnectionId,
  broadcast,
  connectionForWebContents,
  loadedOrigin,
  onActiveChanged,
  openConnection,
  refreshConnection,
  sendToConnection,
  unloadConnection,
} from './windows.js';
import {
  closePopout,
  focusPopout,
  listPopouts,
  onPopoutsChanged,
  openPopout,
  popoutFor,
  sendToPopout,
  setPopoutCall,
} from './popouts.js';
import { buildMenu } from './menu.js';
import {
  check as checkForUpdates,
  download as downloadUpdate,
  install as installUpdate,
  onUpdateStatus,
  setAutoDownload,
  setCheckOnLaunch,
  updateStatus,
} from './updater.js';
import { forgetWorkspaces, notificationsFor, postTo, workspacesFor, type Outcome } from './connectionApi.js';
import { getPreferences, setPreference } from './preferences.js';

const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID = new RegExp(`^${UUID_SOURCE}$`, 'i');
/**
 * Where a page may ask a connection to land: a workspace, a channel, document
 * or spreadsheet in one, or an invitation. Nothing else, so a page cannot steer
 * another connection's page anywhere of its choosing.
 */
const APP_PATH = new RegExp(`^/(w/${UUID_SOURCE}(/(c|d|s)/${UUID_SOURCE})?|invite/[A-Za-z0-9_-]{8,128})$`, 'i');

function failure(err: unknown): Outcome {
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

const gone: Outcome = { ok: false, error: 'That connection no longer exists.' };

function broadcastChange(): void {
  // The File menu lists the connections too, so it is rebuilt alongside the pages.
  buildMenu();
  broadcast('desktop:connections-changed');
}

export interface ServerCheck {
  ok: boolean;
  origin?: string;
  version?: string;
  error?: string;
}

/**
 * Confirms an address is actually a ParaDOCs server before it is saved, so a
 * typo is caught here rather than as a blank page later. The health endpoint
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

/** What a page is told about a connection. */
function describeConnection(connection: Connection) {
  return {
    id: connection.id,
    label: connection.label,
    kind: connection.kind,
    url: connection.url ?? null,
    active: connection.id === activeConnectionId(),
  };
}

/**
 * Registers a call the web client may make. Only the main frame of a loaded
 * connection's page is answered: the bridge is exposed nowhere else, and this
 * holds even if something else found a way to send on the channel. The
 * listener is told which connection's page is asking.
 */
function handle(channel: string, listener: (caller: Connection, ...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    const caller = connectionForWebContents(event.sender);
    const fromMainFrame = event.senderFrame?.frameTreeNodeId === event.sender.mainFrame.frameTreeNodeId;
    if (!caller || !fromMainFrame) throw new Error('This is not available here.');
    return listener(caller, ...args);
  });
}

function connectionFrom(id: unknown): Connection | undefined {
  return typeof id === 'string' ? getConnection(id) : undefined;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/** A name a page supplied, cut down to something that fits in a title bar. */
function asTitle(value: unknown, fallback: string): string {
  const trimmed = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
  return trimmed || fallback;
}

export function registerIpc(): void {
  // --- connections -----------------------------------------------------------

  handle('desktop:connections:list', () => listConnections().map(describeConnection));

  handle('desktop:connections:workspaces', (_caller, id) => {
    const connection = connectionFrom(id);
    return connection ? workspacesFor(connection) : { status: 'unavailable', workspaces: [] };
  });

  handle('desktop:connections:open', async (_caller, id, path): Promise<Outcome> => {
    const connection = connectionFrom(id);
    if (!connection) return gone;
    try {
      await openConnection(connection, typeof path === 'string' && APP_PATH.test(path) ? path : undefined);
      return { ok: true };
    } catch (err) {
      return failure(err);
    }
  });

  handle('desktop:connections:test', (_caller, url) => checkServer(typeof url === 'string' ? url : ''));

  handle('desktop:connections:connect', async (_caller, input): Promise<Outcome> => {
    const { url, label } = (input && typeof input === 'object' ? input : {}) as { url?: unknown; label?: unknown };
    const result = await checkServer(typeof url === 'string' ? url : '');
    if (!result.ok || !result.origin) return { ok: false, error: result.error ?? 'That server could not be reached.' };

    // Connecting to a server already on the list opens it rather than adding it twice.
    const existing = listConnections().find((c) => c.kind === 'remote' && c.url === result.origin);
    const name = typeof label === 'string' && label.trim() ? label.trim().slice(0, 80) : new URL(result.origin).hostname;
    const connection = existing ?? addConnection({ kind: 'remote', url: result.origin, label: name });
    if (!existing) broadcastChange();
    try {
      await openConnection(connection);
      return { ok: true };
    } catch (err) {
      return failure(err);
    }
  });

  handle('desktop:connections:rename', (_caller, id, label): Outcome => {
    const name = typeof label === 'string' ? label.trim().slice(0, 80) : '';
    if (typeof id !== 'string' || !name) return { ok: false, error: 'Enter a name.' };
    try {
      refreshConnection(updateConnection(id, { label: name }));
      broadcastChange();
      return { ok: true };
    } catch (err) {
      return failure(err);
    }
  });

  handle('desktop:connections:remove', async (_caller, id): Promise<Outcome> => {
    const connection = connectionFrom(id);
    if (!connection) return gone;
    const others = listConnections().filter((c) => c.id !== connection.id);
    if (others.length === 0) {
      return { ok: false, error: 'This is the only place the app can open, so it cannot be removed.' };
    }
    try {
      // The window must have something to show, so it moves first — to this
      // computer where there is one.
      if (activeConnectionId() === connection.id) {
        await openConnection(others.find((c) => c.kind === 'local') ?? others[0]);
      }
      await unloadConnection(connection.id);
      removeConnection(connection.id);
      forgetWorkspaces(connection.id);
      // Removing a server signs the app out of it. A local workspace keeps its
      // documents on disk either way: taking it off the list must never be a
      // way to delete them.
      if (connection.kind === 'remote') {
        await electronSession.fromPartition(partitionFor(connection)).clearStorageData();
      }
      broadcastChange();
      return { ok: true };
    } catch (err) {
      return failure(err);
    }
  });

  // --- channels in windows of their own --------------------------------------

  // A page may only pop out its own connection's channels, and only ever asks
  // about its own: `caller` is the connection the request came from, so there
  // is no id here for a page to substitute someone else's.

  handle('desktop:popouts:list', (caller) => listPopouts(caller.id));

  handle('desktop:popouts:open', async (caller, input): Promise<Outcome> => {
    const { workspaceId, channelId, kind, title, withCall } = (
      input && typeof input === 'object' ? input : {}
    ) as Record<string, unknown>;
    if (!isUuid(workspaceId) || !isUuid(channelId)) {
      return { ok: false, error: 'That conversation is no longer available.' };
    }
    if (kind !== 'text' && kind !== 'voice') return { ok: false, error: 'That cannot be opened on its own.' };
    // The window is a page served by the connection's proxy, so there has to
    // be one: a connection that is not open has nothing to pop out of.
    const origin = loadedOrigin(caller.id);
    if (!origin) return { ok: false, error: `${caller.label} is not open.` };

    try {
      await openPopout(caller, origin, {
        workspaceId,
        channelId,
        kind,
        title: asTitle(title, kind === 'voice' ? 'Call' : 'Chat'),
        withCall: withCall === true,
      });
      return { ok: true };
    } catch (err) {
      return failure(err);
    }
  });

  handle('desktop:popouts:focus', (caller, channelId): Outcome =>
    isUuid(channelId) && focusPopout(caller.id, channelId)
      ? { ok: true }
      : { ok: false, error: 'That window is not open.' },
  );

  handle('desktop:popouts:close', (caller, channelId): Outcome =>
    isUuid(channelId) && closePopout(caller.id, channelId)
      ? { ok: true }
      : { ok: false, error: 'That window is not open.' },
  );

  /**
   * The other half of popping out: a window gives its channel back to the main
   * one and closes. The workspace comes from what the app recorded when the
   * window was opened rather than from the page, so a page can only ever hand
   * back the channel it was given.
   */
  handle('desktop:popouts:handBack', (caller, channelId, withCall): Outcome => {
    if (!isUuid(channelId)) return { ok: false, error: 'That window is not open.' };
    const popout = popoutFor(caller.id, channelId);
    if (!popout) return { ok: false, error: 'That window is not open.' };
    const taken = sendToConnection(caller.id, {
      type: 'take-call',
      workspaceId: popout.workspaceId,
      channelId,
      join: withCall === true,
    });
    if (!taken) return { ok: false, error: `${caller.label} is not open.` };
    closePopout(caller.id, channelId);
    return { ok: true };
  });

  /**
   * A pop-out saying whether the call is now running in it. The main window
   * draws a bar from this, so someone who moved a call into another window can
   * still find it.
   */
  handle('desktop:popouts:callState', (caller, channelId, inCall): Outcome =>
    isUuid(channelId) && setPopoutCall(caller.id, channelId, inCall === true)
      ? { ok: true }
      : { ok: false, error: 'That window is not open.' },
  );

  /**
   * Asks a pop-out for its channel back, rather than closing it outright: the
   * window answers through `handBack`, so a call in it is handed over instead
   * of ending along with the window.
   */
  handle('desktop:popouts:recall', (caller, channelId): Outcome =>
    isUuid(channelId) && sendToPopout(caller.id, channelId, { type: 'hand-back', channelId })
      ? { ok: true }
      : { ok: false, error: 'That window is not open.' },
  );

  /**
   * A pop-out has room for one conversation and nothing else, so a document or
   * another channel linked from inside it opens in the main window. The path is
   * checked against the same list as anywhere else.
   */
  handle('desktop:popouts:showInMain', (caller, path): Outcome => {
    if (typeof path !== 'string' || !APP_PATH.test(path)) return { ok: false, error: 'That cannot be opened.' };
    return sendToConnection(caller.id, { type: 'navigate', path })
      ? { ok: true }
      : { ok: false, error: `${caller.label} is not open.` };
  });

  // --- notifications from the other connections ------------------------------

  handle('desktop:notifications:list', (caller) =>
    Promise.all(
      listConnections()
        .filter((connection) => connection.id !== caller.id)
        .map(async (connection) => ({
          connection: describeConnection(connection),
          ...(await notificationsFor(connection)),
        })),
    ),
  );

  handle('desktop:notifications:markRead', (_caller, id, channelIds): Promise<Outcome> | Outcome => {
    const connection = connectionFrom(id);
    if (!connection) return gone;
    const ids = Array.isArray(channelIds)
      ? channelIds.filter((value): value is string => typeof value === 'string' && UUID.test(value)).slice(0, 500)
      : undefined;
    return postTo(connection, '/api/notifications/read', ids ? { channelIds: ids } : {});
  });

  handle('desktop:notifications:markMentionsRead', (_caller, id, documentIds): Promise<Outcome> | Outcome => {
    const connection = connectionFrom(id);
    if (!connection) return gone;
    const ids = Array.isArray(documentIds)
      ? documentIds.filter((value): value is string => typeof value === 'string' && UUID.test(value)).slice(0, 500)
      : undefined;
    return postTo(connection, '/api/notifications/mentions/read', ids ? { documentIds: ids } : {});
  });

  handle('desktop:notifications:declineInvite', (_caller, id, inviteId): Promise<Outcome> | Outcome => {
    const connection = connectionFrom(id);
    if (!connection) return gone;
    if (typeof inviteId !== 'string' || !UUID.test(inviteId)) {
      return { ok: false, error: 'That invitation is no longer available.' };
    }
    return postTo(connection, `/api/notifications/invites/${inviteId}/decline`);
  });

  // --- app-wide preferences --------------------------------------------------

  // Answered synchronously: the preload reads these before the page's first
  // script, so the saved theme is in place before anything paints.
  ipcMain.on('desktop:preferences:initial', (event) => {
    event.returnValue = connectionForWebContents(event.sender) ? getPreferences() : {};
  });

  handle('desktop:preferences:set', (_caller, key, value) => {
    const stored = setPreference(key, value);
    if (stored === undefined) return false;
    // Every connection's page follows, including ones loaded in the background.
    broadcast('desktop:preferences-changed', key, stored);
    return true;
  });

  // --- updates ---------------------------------------------------------------

  handle('desktop:updates:status', () => updateStatus());
  handle('desktop:updates:check', () => checkForUpdates({ explicit: true, dialogs: false }));
  handle('desktop:updates:download', () => downloadUpdate());
  handle('desktop:updates:install', () => installUpdate());
  handle('desktop:updates:setAutoDownload', (_caller, enabled) => setAutoDownload(enabled === true));
  handle('desktop:updates:setCheckOnLaunch', (_caller, enabled) => setCheckOnLaunch(enabled === true));

  handle('desktop:info', () => ({ version: app.getVersion(), platform: process.platform }));

  // Download progress is pushed rather than polled.
  onUpdateStatus((status) => broadcast('desktop:updates-changed', status));
  // The menu marks the connection on screen, and pages mark it in theirs.
  onActiveChanged(broadcastChange);
  // Every page shows which of its channels are in windows of their own, so
  // opening or closing one has to reach the pages as well as the windows.
  onPopoutsChanged(() => broadcast('desktop:popouts-changed'));
}
