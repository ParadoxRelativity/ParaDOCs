import { BrowserWindow, session as electronSession, webContents } from 'electron';
import { pickShareSource } from './screenPicker.js';

/**
 * Screen sharing in Electron.
 *
 * A renderer calling `getDisplayMedia` is refused outright unless the main
 * process answers the request, so without this a shared screen simply never
 * starts in the desktop app while working fine in a browser.
 *
 * The answer comes from ParaDOCs' own picker on every platform, which shows
 * each screen and window as it currently looks. Nothing is chosen
 * automatically: sharing a screen is meant to be deliberate.
 */
export function enableScreenSharing(partition: string): void {
  electronSession.fromPartition(partition).setDisplayMediaRequestHandler((request, callback) => {
    const contents = request.frame ? webContents.fromFrame(request.frame) : undefined;
    const parent = (contents && BrowserWindow.fromWebContents(contents)) ?? BrowserWindow.getFocusedWindow();
    // Electron captures system audio only on Windows. Elsewhere the option is
    // left out rather than offered and silently ignored.
    const offerAudio = request.audioRequested && process.platform === 'win32';

    void pickShareSource(parent, { offerAudio })
      .then((picked) => {
        if (!picked) {
          callback({});
          return;
        }
        callback({
          video: { id: picked.id, name: picked.name },
          ...(picked.audio ? { audio: 'loopback' as const } : {}),
        });
      })
      .catch(() => callback({}));
  });
}
