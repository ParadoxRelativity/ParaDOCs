import { BrowserWindow, screen, type BaseWindow, type WebContents } from 'electron';
import { BACKGROUND } from './pageSetup.js';

/**
 * The presenter view's window, and where the slideshow and it sit on a
 * two-display setup.
 *
 * The slideshow is the app's own window; the presenter view is a second window
 * the page opens with `window.open` and draws into, so it shares the page's
 * deck, notes and show state directly instead of loading them a second time.
 * It is the one `window.open` the app allows, by a fixed frame name and a blank
 * page, so a link in a document still cannot open windows.
 */

/** The frame name the page opens the presenter view under. */
export const PRESENTER_FRAME = 'paradocs-presenter';

let presenter: BrowserWindow | null = null;

export function isPresenterOpen(url: string, frameName: string): boolean {
  return url === 'about:blank' && frameName === PRESENTER_FRAME;
}

/** A function, as pageSetup and this file import each other and BACKGROUND must not be read at load. */
export function presenterWindowOptions() {
  return {
    backgroundColor: BACKGROUND,
    autoHideMenuBar: true,
    title: 'Presenter view',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  };
}

/** Keeps hold of the window the page just opened, and keeps it a presenter view and nothing else. */
export function trackPresenter(_opener: WebContents, window: BrowserWindow): void {
  presenter = window;
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.on('closed', () => {
    if (presenter === window) presenter = null;
  });
}

export type Arrangement = { ok: true; displays: number } | { ok: false; error: string };

/**
 * Puts the show on one display and the presenter view on the other: the
 * external display (any that is not the primary) shows the slides by default,
 * the primary keeps the presenter view, and `swap` exchanges them. With one
 * display there is nothing to arrange.
 *
 * The page takes the show out of full screen before this is called, as a
 * full-screen window cannot be moved between displays, and puts it back after.
 */
export function arrangePresenter(show: BaseWindow | null, swap: boolean): Arrangement {
  const displays = screen.getAllDisplays();
  if (displays.length < 2) return { ok: true, displays: displays.length };
  if (!show || show.isDestroyed()) return { ok: false, error: 'The show is not open.' };
  const primary = screen.getPrimaryDisplay();
  const external = displays.find((d) => d.id !== primary.id) ?? primary;
  const [audience, notes] = swap ? [primary, external] : [external, primary];
  if (show.isFullScreen()) show.setFullScreen(false);
  show.setBounds(audience.bounds);
  if (presenter && !presenter.isDestroyed()) {
    if (presenter.isFullScreen()) presenter.setFullScreen(false);
    presenter.setBounds(notes.workArea);
    presenter.show();
  }
  return { ok: true, displays: displays.length };
}
