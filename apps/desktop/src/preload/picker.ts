import { contextBridge, ipcRenderer } from 'electron';

/**
 * The screen-share picker's bridge. It receives the sources the main process
 * offers and answers with one of them, or cancels; nothing else.
 */
contextBridge.exposeInMainWorld('picker', {
  onSources: (handler: (sources: unknown) => void) => {
    ipcRenderer.on('picker:sources', (_event, sources: unknown) => handler(sources));
  },
  choose: (id: string, audio: boolean) => ipcRenderer.send('picker:choose', id, audio),
  cancel: () => ipcRenderer.send('picker:cancel'),
});
