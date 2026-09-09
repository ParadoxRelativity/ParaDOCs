import { contextBridge, ipcRenderer } from 'electron';

/**
 * The bridge for the connection manager window. Every entry is a named,
 * argument-checked call into the main process — the renderer never sees
 * ipcRenderer, Node or the filesystem.
 */
const api = {
  list: () => ipcRenderer.invoke('connections:list'),
  add: (input: { label: string; kind: 'remote' | 'local'; url?: string }) =>
    ipcRenderer.invoke('connections:add', input),
  update: (input: { id: string; label?: string; url?: string }) =>
    ipcRenderer.invoke('connections:update', input),
  remove: (id: string) => ipcRenderer.invoke('connections:remove', id),
  open: (id: string) => ipcRenderer.invoke('connections:open', id),
  test: (url: string) => ipcRenderer.invoke('connections:test', url),
  info: () => ipcRenderer.invoke('app:info'),
  updates: {
    status: () => ipcRenderer.invoke('updates:status'),
    check: () => ipcRenderer.invoke('updates:check'),
    install: () => ipcRenderer.invoke('updates:install'),
    setAutoDownload: (enabled: boolean) => ipcRenderer.invoke('updates:setAutoDownload', enabled),
    setCheckOnLaunch: (enabled: boolean) => ipcRenderer.invoke('updates:setCheckOnLaunch', enabled),
    onChanged: (handler: (status: unknown) => void) => {
      const listener = (_event: unknown, status: unknown) => handler(status);
      ipcRenderer.on('updates:changed', listener);
      return () => ipcRenderer.removeListener('updates:changed', listener);
    },
  },
  onChanged: (handler: () => void) => {
    const listener = () => handler();
    ipcRenderer.on('connections:changed', listener);
    return () => ipcRenderer.removeListener('connections:changed', listener);
  },
};

contextBridge.exposeInMainWorld('paradocs', api);

export type DesktopBridge = typeof api;
