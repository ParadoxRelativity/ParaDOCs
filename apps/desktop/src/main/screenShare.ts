import { desktopCapturer, dialog, session as electronSession, type Session } from 'electron';

/**
 * Screen sharing in Electron.
 *
 * A renderer calling `getDisplayMedia` is refused outright unless the main
 * process answers the request, so without this a shared screen simply never
 * starts in the desktop app while working fine in a browser.
 *
 * macOS is handed to the system picker, which is the one people recognise and
 * which keeps the choice of what to reveal inside the OS. Everywhere else the
 * sources are listed and picked explicitly — never chosen automatically, since
 * the whole point of the prompt is that sharing a screen is deliberate.
 */
export function enableScreenSharing(partition: string): void {
  const session: Session = electronSession.fromPartition(partition);

  session.setDisplayMediaRequestHandler(
    (_request, callback) => {
      void desktopCapturer
        .getSources({ types: ['screen', 'window'], fetchWindowIcons: false })
        .then(async (sources) => {
          if (sources.length === 0) {
            // An empty list on macOS almost always means the screen recording
            // permission has never been granted.
            callback({});
            await dialog.showMessageBox({
              type: 'info',
              title: 'Screen sharing',
              message: 'No screens or windows are available to share.',
              detail:
                'On macOS, allow ParaDOCs under System Settings → Privacy & Security → Screen Recording, then try again.',
            });
            return;
          }

          // showMessageBox is a poor list for dozens of windows, so the whole
          // screens come first and the list is capped at something readable.
          const choices = sources.slice(0, 8);
          const { response } = await dialog.showMessageBox({
            type: 'question',
            title: 'Share your screen',
            message: 'Choose what to share',
            detail: 'Everyone in the call will see this until you stop sharing.',
            buttons: [...choices.map((source) => source.name), 'Cancel'],
            cancelId: choices.length,
            defaultId: 0,
          });

          if (response >= choices.length) {
            callback({});
            return;
          }
          // 'loopback' shares system audio alongside the picture where the
          // platform supports it, and is ignored where it does not.
          callback({ video: choices[response], audio: 'loopback' });
        })
        .catch(() => callback({}));
    },
    // ScreenCaptureKit's own picker on macOS; ignored elsewhere, where the
    // handler above runs instead.
    { useSystemPicker: true },
  );
}
