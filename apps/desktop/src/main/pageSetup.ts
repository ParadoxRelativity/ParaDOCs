import { shell, type BaseWindow, type WebContents } from 'electron';
import { bundlePath, paths } from './paths.js';
import { readJson, writeJson } from './store.js';

/**
 * What every page the app puts on screen has in common, whether it fills the
 * main window as a connection or holds a single channel popped out into a
 * window of its own: the bridge it is given, the colour behind it before it
 * loads, where its links are allowed to go, and the size it comes back at.
 */

/** Painted behind a page before it loads, so opening one is not a white flash. */
export const BACKGROUND = '#0b0b0f';

/**
 * Pages get the desktop bridge: a short list of argument-checked calls for
 * switching connections, adding a server, popping a channel out and applying
 * updates. Nothing in it reaches the file system, and the main process answers
 * it only from the main frame of a page the app itself opened.
 */
export const clientPreload = bundlePath('client-preload.cjs');

/**
 * A page may only ever show its own proxy. Anything else — a link in a
 * document, an embedded page trying to navigate the top frame — opens in the
 * user's browser, where it belongs and where it cannot reach the session.
 */
export function confineNavigation(contents: WebContents, allowedOrigin: string): void {
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
    openOutside(url);
  });

  contents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: 'deny' };
  });
}

/**
 * Hands a link to the operating system, for web pages and email only. Anything
 * else — file:, smb:, or a scheme some installed program registered — would
 * let a link planted in a shared document start a program on this machine.
 */
const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

function openOutside(url: string): void {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return;
  }
  if (EXTERNAL_SCHEMES.has(protocol)) void shell.openExternal(url);
}

/** Commands a page acts on; the desktop menu and the other windows send these. */
export type DesktopCommand =
  | { type: 'navigate'; path: string }
  | { type: 'open-settings'; section: 'account' | 'servers' | 'updates' }
  | { type: 'connect-server' }
  /**
   * Take over a call: sent to the main window when a pop-out hands one back,
   * and to a pop-out when the main window hands one over.
   */
  | { type: 'take-call'; workspaceId: string; channelId: string; join: boolean }
  /**
   * Sent to a pop-out when the main window asks for its channel back. The
   * pop-out answers by handing over, which is the same path as its own button,
   * so a call in it comes back rather than ending with the window.
   */
  | { type: 'hand-back'; channelId: string };

// --- window geometry --------------------------------------------------------

export interface Bounds {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized?: boolean;
}

export function savedBounds(key: string, defaults: Bounds): Bounds {
  const all = readJson<Record<string, Bounds>>(paths.windowStateFile, {});
  return { ...defaults, ...all[key] };
}

export function rememberBounds(key: string, window: BaseWindow): void {
  if (window.isDestroyed()) return;
  const all = readJson<Record<string, Bounds>>(paths.windowStateFile, {});
  const bounds = window.getNormalBounds();
  all[key] = { ...bounds, maximized: window.isMaximized() };
  writeJson(paths.windowStateFile, all);
}
