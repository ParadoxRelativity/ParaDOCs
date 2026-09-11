import { BaseWindow, WebContentsView, shell, session as electronSession, type WebContents } from 'electron';
import { partitionFor, rememberLastOpened, rememberPort, type Connection } from './connections.js';
import { bundlePath, paths, resourcePath } from './paths.js';
import { readJson, writeJson } from './store.js';
import { startProxy, type ProxyHandle } from './proxy.js';
import { startLocalServer, type LocalServer } from './localServer.js';
import { enableScreenSharing } from './screenShare.js';

/**
 * The app is one window. Every connection opened in it — the workspace on this
 * computer, or a server — gets a view of its own, with its own browser session,
 * proxy and, for a local workspace, embedded server. Switching shows one view
 * and hides the rest, so a connection stays loaded once opened: going back to
 * it is instant, and a call on one server keeps running while another is on
 * screen.
 */

interface LoadedConnection {
  connection: Connection;
  view: WebContentsView;
  proxy: ProxyHandle;
  local?: LocalServer;
}

/** Commands the page on screen acts on; the desktop menu sends these. */
export type DesktopCommand =
  | { type: 'navigate'; path: string }
  | { type: 'open-settings'; section: 'account' | 'servers' | 'updates' }
  | { type: 'connect-server' };

let appWindow: BaseWindow | null = null;
const loaded = new Map<string, LoadedConnection>();
/** Loads in flight, so a second click on a server that is still starting waits on the first. */
const loading = new Map<string, Promise<LoadedConnection>>();
let activeId: string | null = null;
const activeListeners = new Set<() => void>();

export function onActiveChanged(listener: () => void): () => void {
  activeListeners.add(listener);
  return () => activeListeners.delete(listener);
}

function emitActiveChanged(): void {
  for (const listener of activeListeners) listener();
}

export function activeConnectionId(): string | null {
  return activeId;
}

export function getAppWindow(): BaseWindow | null {
  return appWindow;
}

export function hasOpenWindow(): boolean {
  return appWindow !== null;
}

/** The proxy origin of a loaded connection, which is how its API is reached. */
export function loadedOrigin(id: string): string | undefined {
  return loaded.get(id)?.proxy.origin;
}

/** Which connection a page belongs to, so IPC from anything else can be refused. */
export function connectionForWebContents(contents: WebContents): Connection | undefined {
  for (const entry of loaded.values()) {
    if (entry.view.webContents === contents) return entry.connection;
  }
  return undefined;
}

export function activeWebContents(): WebContents | undefined {
  const contents = activeId ? loaded.get(activeId)?.view.webContents : undefined;
  return contents && !contents.isDestroyed() ? contents : undefined;
}

/** Sends to every loaded page, on screen or not. */
export function broadcast(channel: string, ...args: unknown[]): void {
  for (const entry of loaded.values()) {
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.send(channel, ...args);
  }
}

/** Hands a command to the page on screen. False when there is no page to take it. */
export function sendCommand(command: DesktopCommand): boolean {
  const contents = activeWebContents();
  if (!contents) return false;
  focusAppWindow();
  contents.send('desktop:command', command);
  return true;
}

export function focusAppWindow(): boolean {
  if (!appWindow) return false;
  if (appWindow.isMinimized()) appWindow.restore();
  appWindow.focus();
  activeWebContents()?.focus();
  return true;
}

// --- window geometry --------------------------------------------------------

interface Bounds {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized?: boolean;
}

const WINDOW_KEY = 'app';
const DEFAULT_BOUNDS: Bounds = { width: 1280, height: 860 };

function savedBounds(key: string): Bounds {
  const all = readJson<Record<string, Bounds>>(paths.windowStateFile, {});
  return { ...DEFAULT_BOUNDS, ...all[key] };
}

function rememberBounds(key: string, window: BaseWindow): void {
  if (window.isDestroyed()) return;
  const all = readJson<Record<string, Bounds>>(paths.windowStateFile, {});
  const bounds = window.getNormalBounds();
  all[key] = { ...bounds, maximized: window.isMaximized() };
  writeJson(paths.windowStateFile, all);
}

// --- shared setup -----------------------------------------------------------

/** Painted behind a page before it loads, so opening one is not a white flash. */
const BACKGROUND = '#0b0b0f';

/**
 * Pages get the desktop bridge: a short list of argument-checked calls for
 * switching connections, adding a server and applying updates. Nothing in it
 * reaches the file system, and the main process answers it only from the main
 * frame of a connection's own page.
 */
const clientPreload = bundlePath('client-preload.cjs');

/**
 * A page may only ever show its own proxy. Anything else — a link in a
 * document, an embedded page trying to navigate the top frame — opens in the
 * user's browser, where it belongs and where it cannot reach the session.
 */
function confineNavigation(contents: WebContents, allowedOrigin: string): void {
  const isAllowed = (target: string) => {
    try {
      return new URL(target).origin === allowedOrigin;
    } catch {
      return false;
    }
  };

  contents.on('will-navigate', (event, url) => {
    if (isAllowed(url)) return;
    event.preventDefault();
    void shell.openExternal(url);
  });

  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
}

/**
 * Voice channels need the microphone and camera; nothing needs location, MIDI
 * or notifications-by-default. Screen sharing is not a permission here — it is
 * the display-media handler, which asks every time.
 */
const ALLOWED_PERMISSIONS = new Set(['media', 'audioCapture', 'videoCapture', 'clipboard-sanitized-write']);

function configurePermissions(partition: string): void {
  electronSession
    .fromPartition(partition)
    .setPermissionRequestHandler((_contents, permission, callback) => {
      callback(ALLOWED_PERMISSIONS.has(permission));
    });
  enableScreenSharing(partition, () => appWindow);
}

/**
 * Plants a session cookie in the connection's partition. Cookies ignore the
 * port, so this survives the proxy picking a different one on the next launch.
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

// --- the window -------------------------------------------------------------

function titleFor(connection: Connection): string {
  return `${connection.label} — ParaDOCs`;
}

function ensureWindow(): BaseWindow {
  if (appWindow && !appWindow.isDestroyed()) return appWindow;

  const bounds = savedBounds(WINDOW_KEY);
  const window = new BaseWindow({
    ...bounds,
    minWidth: 720,
    minHeight: 520,
    title: 'ParaDOCs',
    backgroundColor: BACKGROUND,
  });
  if (bounds.maximized) window.maximize();
  appWindow = window;

  const remember = () => rememberBounds(WINDOW_KEY, window);
  window.on('resize', () => {
    layout();
    remember();
  });
  window.on('move', remember);
  window.on('maximize', remember);
  window.on('unmaximize', remember);
  window.on('enter-full-screen', layout);
  window.on('leave-full-screen', layout);
  window.on('focus', () => activeWebContents()?.focus());

  window.on('closed', () => {
    appWindow = null;
    activeId = null;
    const entries = [...loaded.values()];
    loaded.clear();
    for (const entry of entries) void release(entry);
    emitActiveChanged();
  });

  return window;
}

/** Every view fills the window; only the active one is visible. */
function layout(): void {
  if (!appWindow || appWindow.isDestroyed()) return;
  const { width, height } = appWindow.getContentBounds();
  for (const entry of loaded.values()) entry.view.setBounds({ x: 0, y: 0, width, height });
}

function show(entry: LoadedConnection): void {
  const window = ensureWindow();
  activeId = entry.connection.id;
  layout();
  for (const other of loaded.values()) other.view.setVisible(other === entry);
  window.setTitle(titleFor(entry.connection));
  entry.view.webContents.focus();
  rememberLastOpened(entry.connection.id);
  emitActiveChanged();
}

async function release(entry: LoadedConnection): Promise<void> {
  // A page's storage is written lazily; closing it unflushed can lose the last
  // preference changed before quitting.
  electronSession.fromPartition(partitionFor(entry.connection)).flushStorageData();
  if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
  await entry.proxy.close();
  // Closing the local server flushes any debounced document saves.
  await entry.local?.close();
}

/** Closes a connection's page and everything behind it. */
export async function unloadConnection(id: string): Promise<void> {
  const entry = loaded.get(id);
  if (!entry) return;
  loaded.delete(id);
  if (appWindow && !appWindow.isDestroyed()) appWindow.contentView.removeChildView(entry.view);
  if (activeId === id) activeId = null;
  await release(entry);
}

async function load(connection: Connection, path: string): Promise<LoadedConnection> {
  // The embedded API is one set of modules around one database, so only one
  // local workspace can run at a time; another is closed before this starts.
  if (connection.kind === 'local') {
    for (const other of [...loaded.values()]) {
      if (other.connection.kind === 'local') await unloadConnection(other.connection.id);
    }
  }

  const window = ensureWindow();
  let local: LocalServer | undefined;
  let proxy: ProxyHandle | undefined;
  try {
    if (connection.kind === 'local') local = await startLocalServer(connection.id);
    const target = connection.kind === 'local' ? local!.origin : connection.url!;
    // The same port as last time where it is free: page storage is kept per
    // address, port included, so a new port would start the page with nothing
    // it saved before.
    proxy = await startProxy({ target, webDist: resourcePath('web'), port: connection.port });
    if (proxy.port !== connection.port) {
      rememberPort(connection.id, proxy.port);
      connection = { ...connection, port: proxy.port };
    }

    const partition = partitionFor(connection);
    configurePermissions(partition);
    // A local workspace signs itself in: the account exists only to satisfy the
    // server's own model, and there is nobody else on this machine to keep out.
    if (local) await adoptSession(partition, proxy.origin, local.sessionToken);
    if (window.isDestroyed()) throw new Error('The window was closed.');

    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: true,
        partition,
        preload: clientPreload,
      },
    });
    view.setBackgroundColor(BACKGROUND);
    view.setVisible(false);
    confineNavigation(view.webContents, proxy.origin);
    window.contentView.addChildView(view);

    const entry: LoadedConnection = { connection, view, proxy, local };
    loaded.set(connection.id, entry);
    layout();
    await view.webContents.loadURL(`${proxy.origin}${path}`);
    return entry;
  } catch (err) {
    if (proxy && loaded.get(connection.id)?.proxy === proxy) {
      await unloadConnection(connection.id);
    } else {
      await proxy?.close();
      await local?.close();
    }
    throw err;
  }
}

/**
 * Puts a connection on screen, loading it first if it is not already, and
 * optionally at a path within it. The page on screen stays until the new one
 * has loaded, so a slow server never leaves the window blank. Callers pass
 * only paths they have checked belong to the app.
 */
export async function openConnection(connection: Connection, path?: string): Promise<void> {
  const window = ensureWindow();
  let entry = loaded.get(connection.id);

  if (entry) {
    if (path) entry.view.webContents.send('desktop:command', { type: 'navigate', path });
  } else {
    const previousTitle = window.getTitle();
    window.setTitle(`Opening ${connection.label}…`);
    let pending = loading.get(connection.id);
    if (!pending) {
      pending = load(connection, path ?? '/').finally(() => loading.delete(connection.id));
      loading.set(connection.id, pending);
    }
    try {
      entry = await pending;
    } catch (err) {
      if (!window.isDestroyed()) window.setTitle(previousTitle);
      throw err;
    }
  }

  show(entry);
}

/** Picks up a rename, so the window title follows it. */
export function refreshConnection(connection: Connection): void {
  const entry = loaded.get(connection.id);
  if (!entry) return;
  entry.connection = connection;
  if (activeId === connection.id) appWindow?.setTitle(titleFor(connection));
}

/** Shuts every embedded server down cleanly before the app exits. */
export async function shutdownAll(): Promise<void> {
  const entries = [...loaded.values()];
  loaded.clear();
  await Promise.all(entries.map(release));
}
