import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

/**
 * The desktop bridge for the web client. It is narrow on purpose: a page can
 * list and switch connections, add or remove a server, read notifications from
 * the other connections, keep app-wide preferences, and see and apply updates.
 * It has no file system, no Node and no raw IPC, and the main process checks
 * every call again and answers only a connection page's main frame.
 */

function subscribe(channel: string, handler: (...args: unknown[]) => void): () => void {
  const listener = (_event: IpcRendererEvent, ...args: unknown[]) => handler(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

/**
 * Read synchronously, once, before the page's first script: the theme has to
 * be known before anything paints, and an asynchronous answer would arrive
 * after the wrong colours already had.
 */
function initialPreferences(): Record<string, unknown> {
  try {
    const value: unknown = ipcRenderer.sendSync('desktop:preferences:initial');
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

contextBridge.exposeInMainWorld('paradocsDesktop', {
  connections: {
    list: () => ipcRenderer.invoke('desktop:connections:list'),
    workspaces: (id: string) => ipcRenderer.invoke('desktop:connections:workspaces', id),
    open: (id: string, path?: string) => ipcRenderer.invoke('desktop:connections:open', id, path),
    test: (url: string) => ipcRenderer.invoke('desktop:connections:test', url),
    connect: (input: { url: string; label?: string }) => ipcRenderer.invoke('desktop:connections:connect', input),
    rename: (id: string, label: string) => ipcRenderer.invoke('desktop:connections:rename', id, label),
    remove: (id: string) => ipcRenderer.invoke('desktop:connections:remove', id),
    onChanged: (handler: () => void) => subscribe('desktop:connections-changed', () => handler()),
  },
  notifications: {
    list: () => ipcRenderer.invoke('desktop:notifications:list'),
    markRead: (connectionId: string, channelIds?: string[]) =>
      ipcRenderer.invoke('desktop:notifications:markRead', connectionId, channelIds),
    declineInvite: (connectionId: string, inviteId: string) =>
      ipcRenderer.invoke('desktop:notifications:declineInvite', connectionId, inviteId),
  },
  preferences: {
    initial: initialPreferences(),
    set: (key: string, value: unknown) => ipcRenderer.invoke('desktop:preferences:set', key, value),
    onChanged: (handler: (key: string, value: unknown) => void) =>
      subscribe('desktop:preferences-changed', (key, value) => handler(String(key), value)),
  },
  updates: {
    status: () => ipcRenderer.invoke('desktop:updates:status'),
    check: () => ipcRenderer.invoke('desktop:updates:check'),
    download: () => ipcRenderer.invoke('desktop:updates:download'),
    install: () => ipcRenderer.invoke('desktop:updates:install'),
    setAutoDownload: (enabled: boolean) => ipcRenderer.invoke('desktop:updates:setAutoDownload', enabled),
    setCheckOnLaunch: (enabled: boolean) => ipcRenderer.invoke('desktop:updates:setCheckOnLaunch', enabled),
    onChanged: (handler: (status: unknown) => void) => subscribe('desktop:updates-changed', (status) => handler(status)),
  },
  info: () => ipcRenderer.invoke('desktop:info'),
  onCommand: (handler: (command: unknown) => void) => subscribe('desktop:command', (command) => handler(command)),
});
