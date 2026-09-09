import { app, BrowserWindow, Menu, dialog, shell, type MenuItemConstructorOptions } from 'electron';
import { listConnections } from './connections.js';
import { openConnection, openShell } from './windows.js';
import { check } from './updater.js';

const isMac = process.platform === 'darwin';

/**
 * Rebuilt whenever the connection list changes so the Servers submenu always
 * reflects what is configured. Menu accelerators are the native half of the
 * app: the web client keeps its own in-page shortcuts.
 */
export function buildMenu(): void {
  const connections = listConnections();

  const serverItems: MenuItemConstructorOptions[] = connections.length
    ? connections.map((connection, index) => ({
        label: connection.label,
        // ⌘1..⌘9 jump straight to a server, like tabs in a browser.
        accelerator: index < 9 ? `CmdOrCtrl+${index + 1}` : undefined,
        click: () => {
          void openConnection(connection).catch((err: Error) => reportOpenFailure(connection.label, err));
        },
      }))
    : [{ label: 'No servers yet', enabled: false }];

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { label: 'Check for Updates…', click: () => void check({ explicit: true }) },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ] as MenuItemConstructorOptions[])
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Servers and Workspaces…',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => openShell(),
        },
        { type: 'separator' },
        ...serverItems,
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'selectAll' },
        ...(isMac
          ? ([{ type: 'separator' }, { label: 'Speech', submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }] }] as MenuItemConstructorOptions[])
          : []),
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        // The single accelerator Chromium registers for zoom in does not fire
        // on the unshifted "=" key, which is what people actually press.
        { role: 'zoomIn', accelerator: 'CmdOrCtrl+=', visible: false },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac
          ? ([{ type: 'separator' }, { role: 'front' }, { type: 'separator' }, { role: 'window' }] as MenuItemConstructorOptions[])
          : ([{ role: 'close' }] as MenuItemConstructorOptions[])),
      ],
    },
    {
      role: 'help',
      submenu: [
        ...(isMac
          ? []
          : ([
              { label: 'Check for Updates…', click: () => void check({ explicit: true }) },
              { type: 'separator' },
            ] as MenuItemConstructorOptions[])),
        {
          label: 'ParaDOCs on GitHub',
          click: () => void shell.openExternal('https://github.com/paradocs/paradocs'),
        },
        ...(isMac ? [] : ([{ type: 'separator' }, { role: 'about' }] as MenuItemConstructorOptions[])),
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function reportOpenFailure(label: string, err: Error): void {
  const target = BrowserWindow.getFocusedWindow() ?? undefined;
  const options = {
    type: 'error' as const,
    title: 'Could not open',
    message: `Could not open “${label}”.`,
    detail: err.message,
  };
  if (target) void dialog.showMessageBox(target, options);
  else void dialog.showMessageBox(options);
}
