import { BrowserWindow, screen, type WebContents } from 'electron';
import { partitionFor, type Connection } from './connections.js';
import {
  BACKGROUND,
  clientPreload,
  confineNavigation,
  rememberBounds,
  savedBounds,
  type Bounds,
  type DesktopCommand,
} from './pageSetup.js';

/**
 * Channels living in windows of their own.
 *
 * A pop-out is another page on the same connection: the same browser session,
 * the same loopback proxy, the same bridge. It is not a second app — it signs
 * in to nothing, opens no server of its own, and holds no state the main
 * window cannot see. What it has is its own window, so a conversation can sit
 * beside the document it is about and a call can be watched while the rest of
 * the app is used for something else.
 *
 * They belong to the main window and go when it does. Closing the app closes
 * every one of them; so does closing the connection they came from.
 */

export type PopoutKind = 'text' | 'voice';

export interface PopoutSpec {
  workspaceId: string;
  channelId: string;
  kind: PopoutKind;
  /** What goes in the title bar: "#general", or the name of the person. */
  title: string;
  /**
   * Take the call with it. The window that asked has already left, so the
   * pop-out joins as it opens rather than leaving the room briefly empty.
   */
  withCall: boolean;
}

/** What a page is told about a channel that is popped out. */
export interface PoppedOut {
  workspaceId: string;
  channelId: string;
  kind: PopoutKind;
  title: string;
  /**
   * Whether the call is running in that window rather than the main one. A
   * call lives in one page at a time, so without this the main window has no
   * way to say where yours went.
   */
  inCall: boolean;
}

interface Popout extends PoppedOut {
  key: string;
  connectionId: string;
  window: BrowserWindow;
}

const popouts = new Map<string, Popout>();
const listeners = new Set<() => void>();

function keyOf(connectionId: string, channelId: string): string {
  return `${connectionId} ${channelId}`;
}

export function onPopoutsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emitChanged(): void {
  for (const listener of listeners) listener();
}

/** Which channels of a connection are in windows of their own. */
export function listPopouts(connectionId: string): PoppedOut[] {
  return [...popouts.values()]
    .filter((entry) => entry.connectionId === connectionId)
    .map(({ workspaceId, channelId, kind, title, inCall }) => ({ workspaceId, channelId, kind, title, inCall }));
}

/** Which connection a pop-out's page belongs to, so IPC from it is answered. */
export function popoutConnectionId(contents: WebContents): string | undefined {
  for (const entry of popouts.values()) {
    if (entry.window.webContents === contents) return entry.connectionId;
  }
  return undefined;
}

/** Every pop-out page, for anything the app broadcasts to all of them. */
export function popoutWebContents(): WebContents[] {
  return [...popouts.values()]
    .filter((entry) => !entry.window.isDestroyed() && !entry.window.webContents.isDestroyed())
    .map((entry) => entry.window.webContents);
}

/** The pop-out the person is working in, if that is where the focus is. */
export function focusedPopout(): BrowserWindow | undefined {
  const focused = BrowserWindow.getFocusedWindow();
  if (!focused) return undefined;
  for (const entry of popouts.values()) if (entry.window === focused) return entry.window;
  return undefined;
}

export function popoutFor(connectionId: string, channelId: string): PoppedOut | undefined {
  return popouts.get(keyOf(connectionId, channelId));
}

/** A pop-out saying whether it now holds the call, so the main window can say so too. */
export function setPopoutCall(connectionId: string, channelId: string, inCall: boolean): boolean {
  const entry = popouts.get(keyOf(connectionId, channelId));
  if (!entry) return false;
  if (entry.inCall === inCall) return true;
  entry.inCall = inCall;
  emitChanged();
  return true;
}

export function focusPopout(connectionId: string, channelId: string): boolean {
  const entry = popouts.get(keyOf(connectionId, channelId));
  if (!entry || entry.window.isDestroyed()) return false;
  if (entry.window.isMinimized()) entry.window.restore();
  entry.window.show();
  entry.window.focus();
  return true;
}

/** Tells a pop-out's page something, such as that a call is now its to hold. */
export function sendToPopout(connectionId: string, channelId: string, command: DesktopCommand): boolean {
  const entry = popouts.get(keyOf(connectionId, channelId));
  if (!entry || entry.window.isDestroyed() || entry.window.webContents.isDestroyed()) return false;
  entry.window.webContents.send('desktop:command', command);
  return true;
}

// --- opening ----------------------------------------------------------------

/**
 * Sizes are remembered per kind rather than per channel: every voice pop-out
 * comes back the size the last one was left at, and the file does not collect
 * an entry for every channel ever opened.
 */
const DEFAULTS: Record<PopoutKind, Bounds> = {
  text: { width: 520, height: 720 },
  voice: { width: 900, height: 620 },
};

/**
 * A second pop-out opened at the remembered size would land exactly on top of
 * the first, which looks like nothing happened.
 */
function cascade(bounds: Bounds, offset: number): Bounds {
  if (offset === 0 || bounds.x === undefined || bounds.y === undefined) return bounds;
  const step = 28 * offset;
  const { workArea } = screen.getDisplayMatching({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  });
  const x = bounds.x + step;
  const y = bounds.y + step;
  // Let the system place it once the cascade would walk off the screen.
  if (x + bounds.width > workArea.x + workArea.width || y + bounds.height > workArea.y + workArea.height) {
    return { ...bounds, x: undefined, y: undefined };
  }
  return { ...bounds, x, y };
}

function titleFor(connection: Connection, title: string): string {
  return `${title} — ${connection.label}`;
}

/**
 * Opens a channel in its own window, or brings the one it already has to the
 * front. `origin` is the connection's loopback proxy, which is both where the
 * page comes from and the only place it is allowed to go.
 */
export async function openPopout(connection: Connection, origin: string, spec: PopoutSpec): Promise<void> {
  const key = keyOf(connection.id, spec.channelId);
  const existing = popouts.get(key);
  if (existing && !existing.window.isDestroyed()) {
    focusPopout(connection.id, spec.channelId);
    // It was already open and the window that asked has just left the call,
    // so without this the room would be left with nobody in it.
    if (spec.withCall) {
      sendToPopout(connection.id, spec.channelId, {
        type: 'take-call',
        workspaceId: spec.workspaceId,
        channelId: spec.channelId,
        join: true,
      });
    }
    return;
  }

  const boundsKey = `popout:${spec.kind}`;
  const bounds = cascade(savedBounds(boundsKey, DEFAULTS[spec.kind]), popouts.size);
  const window = new BrowserWindow({
    ...bounds,
    minWidth: 360,
    minHeight: 320,
    title: titleFor(connection, spec.title),
    backgroundColor: BACKGROUND,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      partition: partitionFor(connection),
      preload: clientPreload,
    },
  });
  if (bounds.maximized) window.maximize();

  const entry: Popout = {
    key,
    connectionId: connection.id,
    workspaceId: spec.workspaceId,
    channelId: spec.channelId,
    kind: spec.kind,
    title: spec.title,
    // Set by the page itself once it has actually joined; opening a window
    // with a call in mind is not the same as being in one.
    inCall: false,
    window,
  };
  popouts.set(key, entry);

  // Every page in the app is titled "ParaDOCs", which is right for the main
  // window and useless on a row of pop-outs. The title is set here instead, so
  // the window list and the dock name the conversation each one holds.
  window.on('page-title-updated', (event) => event.preventDefault());

  const remember = () => rememberBounds(boundsKey, window);
  window.on('resize', remember);
  window.on('move', remember);
  window.on('maximize', remember);
  window.on('unmaximize', remember);
  window.on('closed', () => {
    popouts.delete(key);
    emitChanged();
  });
  confineNavigation(window.webContents, origin);
  emitChanged();

  const path = `/popout/${encodeURIComponent(spec.workspaceId)}/${encodeURIComponent(spec.channelId)}`;
  try {
    await window.loadURL(`${origin}${path}${spec.withCall ? '?call=1' : ''}`);
  } catch (err) {
    if (!window.isDestroyed()) window.destroy();
    throw err;
  }
  if (window.isDestroyed()) return;
  window.show();
  window.focus();
}

/** Picks up a rename, so every pop-out's title follows its connection. */
export function retitlePopouts(connection: Connection): void {
  for (const entry of popouts.values()) {
    if (entry.connectionId !== connection.id || entry.window.isDestroyed()) continue;
    entry.window.setTitle(titleFor(connection, entry.title));
  }
}

// --- closing ----------------------------------------------------------------

/**
 * Closed rather than destroyed, so the page gets its unload and can hang up a
 * call on the way out instead of being timed out of the room.
 */
function shut(entry: Popout): void {
  popouts.delete(entry.key);
  if (!entry.window.isDestroyed()) entry.window.close();
}

export function closePopout(connectionId: string, channelId: string): boolean {
  const entry = popouts.get(keyOf(connectionId, channelId));
  if (!entry) return false;
  shut(entry);
  emitChanged();
  return true;
}

/** A connection's windows go when the connection does. */
export function closePopoutsFor(connectionId: string): void {
  const entries = [...popouts.values()].filter((entry) => entry.connectionId === connectionId);
  if (entries.length === 0) return;
  for (const entry of entries) shut(entry);
  emitChanged();
}

/** They belong to the main window: when it goes, so do they. */
export function closeAllPopouts(): void {
  const entries = [...popouts.values()];
  if (entries.length === 0) return;
  for (const entry of entries) shut(entry);
  emitChanged();
}
