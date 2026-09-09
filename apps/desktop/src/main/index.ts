import { app, BrowserWindow, dialog } from 'electron';
import { lastOpened } from './connections.js';
import { registerIpc } from './ipc.js';
import { buildMenu } from './menu.js';
import { initUpdates } from './updater.js';
import { hasOpenWindows, openConnection, openShell, shutdownAll } from './windows.js';

// One instance owns the local workspaces; a second would open the same PGlite
// directory and corrupt it.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void main();
}

async function main(): Promise<void> {
  app.setAppUserModelId('com.paradocs.desktop'); // Windows taskbar grouping

  app.on('second-instance', () => {
    const [first] = BrowserWindow.getAllWindows();
    if (first) {
      if (first.isMinimized()) first.restore();
      first.focus();
    } else {
      openShell();
    }
  });

  await app.whenReady();
  registerIpc();
  buildMenu();
  initUpdates();
  await openStartupWindow();

  app.on('activate', () => {
    if (!hasOpenWindows()) void openStartupWindow();
  });

  app.on('window-all-closed', () => {
    // macOS apps stay running with no windows; everywhere else this is a quit.
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', (event) => {
    if (settled) return;
    // Local workspaces have debounced document saves to flush first.
    event.preventDefault();
    void shutdownAll().finally(() => {
      settled = true;
      app.quit();
    });
  });
}

let settled = false;

/**
 * Reopens whatever was last used, so the app comes back where it was left.
 * Anything that fails — a server that has moved, a local database that will not
 * open — falls back to the connection manager with the reason shown, rather
 * than an empty window.
 */
async function openStartupWindow(): Promise<void> {
  const previous = lastOpened();
  if (previous) {
    try {
      await openConnection(previous);
      return;
    } catch (err) {
      openShell();
      await dialog.showMessageBox({
        type: 'warning',
        title: 'Could not reopen',
        message: `Could not reopen “${previous.label}”.`,
        detail: (err as Error).message,
      });
      return;
    }
  }
  openShell();
}
