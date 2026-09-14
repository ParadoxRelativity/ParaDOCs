import { app, Menu, dialog, shell, type MenuItemConstructorOptions, type WebContents } from 'electron';
import { listConnections } from './connections.js';
import { check } from './updater.js';
import {
  activeConnectionId,
  focusedPageContents,
  focusedWindow,
  getAppWindow,
  openConnection,
  sendCommand,
} from './windows.js';

const isMac = process.platform === 'darwin';

/**
 * Runs against the page in front — a popped-out channel when that is what has
 * the focus, otherwise the connection on screen. The main window's pages are
 * views inside it rather than its own, so reloading, zooming and developer
 * tools are wired to a page explicitly instead of through the built-in roles.
 */
function onPage(action: (contents: WebContents) => void): () => void {
  return () => {
    const contents = focusedPageContents();
    if (contents) action(contents);
  };
}

/**
 * Opens Settings at Updates and checks there. With no page loaded to show the
 * result in, the check answers in dialogs instead.
 */
function checkForUpdates(): void {
  const shown = sendCommand({ type: 'open-settings', section: 'updates' });
  void check({ explicit: true, dialogs: !shown });
}

/**
 * Rebuilt whenever the connections or the one on screen change, so the File
 * menu always lists them with the current one marked. Menu accelerators are
 * the native half of the app: the web client keeps its own in-page shortcuts.
 */
export function buildMenu(): void {
  const activeId = activeConnectionId();

  const connectionItems: MenuItemConstructorOptions[] = listConnections().map((connection, index) => ({
    label: connection.label,
    type: 'radio',
    checked: connection.id === activeId,
    // ⌘1..⌘9 switch straight to a connection, like tabs in a browser.
    accelerator: index < 9 ? `CmdOrCtrl+${index + 1}` : undefined,
    click: () => {
      void openConnection(connection).catch((err: Error) => {
        // The radio moved on click; put it back where the window actually is.
        buildMenu();
        reportOpenFailure(connection.label, err);
      });
    },
  }));

  const settingsItem: MenuItemConstructorOptions = {
    label: isMac ? 'Settings…' : 'Settings',
    accelerator: 'CmdOrCtrl+,',
    click: () => void sendCommand({ type: 'open-settings', section: 'account' }),
  };
  const zoomIn = onPage((contents) => contents.setZoomLevel(contents.getZoomLevel() + 0.5));

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { label: 'Check for Updates…', click: checkForUpdates },
              { type: 'separator' },
              settingsItem,
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
          label: 'Connect to a Server…',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => void sendCommand({ type: 'connect-server' }),
        },
        { type: 'separator' },
        ...connectionItems,
        { type: 'separator' },
        ...(isMac ? [] : ([settingsItem, { type: 'separator' }] as MenuItemConstructorOptions[])),
        {
          label: isMac ? 'Close Window' : 'Close',
          accelerator: 'CmdOrCtrl+W',
          // A popped-out channel is a window like any other, so this closes
          // the one in front rather than always the main one.
          click: () => focusedWindow()?.close(),
        },
        ...(isMac ? [] : ([{ role: 'quit' }] as MenuItemConstructorOptions[])),
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
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: onPage((contents) => contents.reload()) },
        {
          label: 'Force Reload',
          accelerator: 'Shift+CmdOrCtrl+R',
          click: onPage((contents) => contents.reloadIgnoringCache()),
        },
        { type: 'separator' },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: onPage((contents) => contents.setZoomLevel(0)) },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: zoomIn },
        // "Plus" is the shifted key; this catches the unshifted "=" people actually press.
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', visible: false, click: zoomIn },
        {
          label: 'Zoom Out',
          accelerator: 'CmdOrCtrl+-',
          click: onPage((contents) => contents.setZoomLevel(contents.getZoomLevel() - 0.5)),
        },
        { type: 'separator' },
        {
          label: 'Toggle Full Screen',
          accelerator: isMac ? 'Ctrl+Cmd+F' : 'F11',
          click: () => {
            const window = focusedWindow();
            window?.setFullScreen(!window.isFullScreen());
          },
        },
        {
          label: 'Toggle Developer Tools',
          accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
          click: onPage((contents) => contents.toggleDevTools()),
        },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { label: 'Minimize', accelerator: 'CmdOrCtrl+M', click: () => focusedWindow()?.minimize() },
        {
          label: 'Zoom',
          click: () => {
            const window = focusedWindow();
            if (!window) return;
            if (window.isMaximized()) window.unmaximize();
            else window.maximize();
          },
        },
        ...(isMac ? ([{ type: 'separator' }, { role: 'front' }] as MenuItemConstructorOptions[]) : []),
      ],
    },
    {
      role: 'help',
      submenu: [
        ...(isMac
          ? []
          : ([
              { label: 'Check for Updates…', click: checkForUpdates },
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
  const window = getAppWindow();
  const options = {
    type: 'error' as const,
    title: 'Could not open',
    message: `Could not open “${label}”.`,
    detail: err.message,
  };
  if (window) void dialog.showMessageBox(window, options);
  else void dialog.showMessageBox(options);
}
