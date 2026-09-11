import { app, dialog } from 'electron';
import { addConnection, lastOpened, listConnections, type Connection } from './connections.js';
import { registerIpc } from './ipc.js';
import { buildMenu } from './menu.js';
import { initUpdates } from './updater.js';
import { focusAppWindow, hasOpenWindow, openConnection, shutdownAll } from './windows.js';

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
    if (!focusAppWindow()) void openStartup();
  });

  await app.whenReady();
  registerIpc();
  buildMenu();
  initUpdates();
  await openStartup();

  app.on('activate', () => {
    if (!hasOpenWindow()) void openStartup();
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

function localConnection(): Connection {
  return listConnections().find((c) => c.kind === 'local') ?? addConnection({ kind: 'local', label: '' });
}

/**
 * Comes back to whatever was on screen last. A first launch has nothing to come
 * back to, so it opens a workspace on this computer: writing can start before
 * anyone needs to know what a server is.
 */
async function openStartup(): Promise<void> {
  const preferred = lastOpened() ?? listConnections()[0] ?? localConnection();
  try {
    await openConnection(preferred);
  } catch (err) {
    await recover(preferred, err as Error);
  }
}

/**
 * A server that has moved, or a database that will not open, must not leave an
 * empty window. The workspace on this computer stands in where there is one to
 * fall back to; otherwise the choice is put to the person at the machine.
 */
async function recover(failed: Connection, error: Error): Promise<void> {
  const fallback = listConnections().find((c) => c.kind === 'local' && c.id !== failed.id);
  if (fallback) {
    try {
      await openConnection(fallback);
      void dialog.showMessageBox({
        type: 'warning',
        title: 'Could not open',
        message: `Could not open “${failed.label}”.`,
        detail: `${error.message}\n\n${fallback.label} is open instead.`,
      });
      return;
    } catch {
      // Neither opens; ask below.
    }
  }

  const offerLocal = failed.kind !== 'local';
  const { response } = await dialog.showMessageBox({
    type: 'error',
    title: 'Could not open',
    message: `Could not open “${failed.label}”.`,
    detail: error.message,
    buttons: offerLocal ? ['Try again', 'Use this computer', 'Quit'] : ['Try again', 'Quit'],
    defaultId: 0,
    cancelId: offerLocal ? 2 : 1,
  });

  if (response === 0) {
    await openConnection(failed).catch((err: Error) => recover(failed, err));
  } else if (offerLocal && response === 1) {
    const local = localConnection();
    await openConnection(local).catch((err: Error) => recover(local, err));
  } else {
    app.quit();
  }
}
