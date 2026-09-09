import { BrowserWindow, shell, session as electronSession } from 'electron';
import { partitionFor, rememberLastOpened, type Connection } from './connections.js';
import { bundlePath, paths, resourcePath } from './paths.js';
import { readJson, writeJson } from './store.js';
import { startProxy, type ProxyHandle } from './proxy.js';
import { startLocalServer, type LocalServer } from './localServer.js';

interface OpenWindow {
  window: BrowserWindow;
  connection: Connection;
  proxy: ProxyHandle;
  local?: LocalServer;
}

const open = new Map<number, OpenWindow>();
let shellWindow: BrowserWindow | null = null;

export function windowForConnection(id: string): BrowserWindow | undefined {
  for (const entry of open.values()) if (entry.connection.id === id) return entry.window;
  return undefined;
}

export function connectionForWindow(window: BrowserWindow): Connection | undefined {
  return open.get(window.id)?.connection;
}

export function hasOpenWindows(): boolean {
  return open.size > 0 || shellWindow !== null;
}

// --- window geometry --------------------------------------------------------

interface Bounds {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized?: boolean;
}

const DEFAULT_BOUNDS: Bounds = { width: 1280, height: 860 };

function savedBounds(key: string): Bounds {
  const all = readJson<Record<string, Bounds>>(paths.windowStateFile, {});
  return { ...DEFAULT_BOUNDS, ...all[key] };
}

function rememberBounds(key: string, window: BrowserWindow): void {
  if (window.isDestroyed()) return;
  const all = readJson<Record<string, Bounds>>(paths.windowStateFile, {});
  const bounds = window.getNormalBounds();
  all[key] = { ...bounds, maximized: window.isMaximized() };
  writeJson(paths.windowStateFile, all);
}

// --- shared window setup ----------------------------------------------------

const preload = bundlePath('preload.cjs');

/**
 * Only the connection manager gets a preload bridge. A window showing the web
 * client has no business reading or rewriting the server list, so it is given
 * no privileged API at all and a script injected into a document cannot reach
 * one.
 */
function baseOptions(bounds: Bounds, options: { partition?: string; bridge?: boolean } = {}) {
  return {
    ...bounds,
    minWidth: 720,
    minHeight: 520,
    show: false,
    // Painted before the client loads, so a launch is not a white flash.
    backgroundColor: '#0b0b0f',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      ...(options.bridge ? { preload } : {}),
      ...(options.partition ? { partition: options.partition } : {}),
    },
  };
}

/**
 * A window may only ever show the local proxy. Anything else — a link in a
 * document, an embedded page trying to navigate the top frame — opens in the
 * user's browser, where it belongs and where it cannot reach the session.
 */
function confineNavigation(window: BrowserWindow, allowedOrigin: string): void {
  const isAllowed = (target: string) => {
    try {
      return new URL(target).origin === allowedOrigin;
    } catch {
      return false;
    }
  };

  window.webContents.on('will-navigate', (event, url) => {
    if (isAllowed(url)) return;
    event.preventDefault();
    void shell.openExternal(url);
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
}

/** Nothing in ParaDOCs needs the camera, microphone or location. */
function denyDevicePermissions(partition: string): void {
  electronSession
    .fromPartition(partition)
    .setPermissionRequestHandler((_contents, permission, callback) => {
      callback(permission === 'clipboard-sanitized-write');
    });
}

/**
 * Plants a session cookie in the window's partition. Cookies ignore the port,
 * so this survives the proxy picking a different one on the next launch.
 */
async function adoptSession(partition: string, origin: string, token: string): Promise<void> {
  await electronSession.fromPartition(partition).cookies.set({
    url: `${origin}/`,
    name: 'paradocs_session',
    value: token,
    httpOnly: true,
    sameSite: 'lax',
    expirationDate: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
  });
}

// --- connection windows -----------------------------------------------------

export async function openConnection(connection: Connection): Promise<BrowserWindow> {
  const existing = windowForConnection(connection.id);
  if (existing) {
    existing.show();
    existing.focus();
    return existing;
  }

  let local: LocalServer | undefined;
  let proxy: ProxyHandle | undefined;
  try {
    if (connection.kind === 'local') local = await startLocalServer(connection.id);
    const target = connection.kind === 'local' ? local!.origin : connection.url!;
    proxy = await startProxy({ target, webDist: resourcePath('web') });

    const partition = partitionFor(connection);
    denyDevicePermissions(partition);
    // A local workspace signs itself in: the account exists only to satisfy the
    // server's own model, and there is nobody else on this machine to keep out.
    if (local) await adoptSession(partition, proxy.origin, local.sessionToken);

    const bounds = savedBounds(connection.id);
    const window = new BrowserWindow({
      ...baseOptions(bounds, { partition }),
      title: `${connection.label} — ParaDOCs`,
    });
    if (bounds.maximized) window.maximize();

    // The web client has no title of its own to offer, and the connection name
    // is what tells two windows apart.
    window.on('page-title-updated', (event) => event.preventDefault());
    confineNavigation(window, proxy.origin);

    open.set(window.id, { window, connection, proxy, local });
    rememberLastOpened(connection.id);

    window.once('ready-to-show', () => window.show());
    const remember = () => rememberBounds(connection.id, window);
    window.on('resize', remember);
    window.on('move', remember);
    window.on('maximize', remember);
    window.on('unmaximize', remember);

    window.on('closed', () => {
      open.delete(window.id);
      void proxy?.close();
      // Closing the local server flushes any debounced document saves.
      void local?.close();
    });

    await window.loadURL(`${proxy.origin}/`);
    return window;
  } catch (err) {
    await proxy?.close();
    await local?.close();
    throw err;
  }
}

// --- the connection manager -------------------------------------------------

export function openShell(): BrowserWindow {
  if (shellWindow && !shellWindow.isDestroyed()) {
    shellWindow.show();
    shellWindow.focus();
    return shellWindow;
  }
  shellWindow = new BrowserWindow({
    ...baseOptions({ width: 760, height: 660 }, { bridge: true }),
    title: 'ParaDOCs',
    minWidth: 560,
    minHeight: 480,
  });
  shellWindow.once('ready-to-show', () => shellWindow?.show());
  shellWindow.on('closed', () => {
    shellWindow = null;
  });
  void shellWindow.loadFile(bundlePath('shell', 'index.html'));
  return shellWindow;
}

export function isShell(window: BrowserWindow | null): boolean {
  return !!window && window === shellWindow;
}

export function closeShell(): void {
  shellWindow?.close();
}

/** Shuts every embedded server down cleanly before the app exits. */
export async function shutdownAll(): Promise<void> {
  await Promise.all(
    [...open.values()].map(async (entry) => {
      await entry.proxy.close();
      await entry.local?.close();
    }),
  );
  open.clear();
}
