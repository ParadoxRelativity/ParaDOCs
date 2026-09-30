import { app, BrowserWindow } from 'electron';
import { bundlePath } from './paths.js';
import { getPreferences } from './preferences.js';

/**
 * The app's own sounds, for notifications no page has played.
 *
 * The main process has no audio of its own, so a hidden window plays them: the
 * same files the web client uses, from the copy of it bundled with the app.
 * It is made on first use and kept, so later sounds start at once.
 */

/**
 * The sounds the notifier may ask for, at the levels the sound suite
 * recommends, and how many variants each has (`_v1` … `_vN`, picked at random).
 */
const SOUNDS = {
  mention_or_dm: { level: 0.75, variants: 0 },
  message_received: { level: 0.36, variants: 3 },
  notification_generic: { level: 0.5, variants: 0 },
} as const;

export type AppSound = keyof typeof SOUNDS;

const lastVariant = new Map<AppSound, number>();

/** A variant's file, never the same one twice running. */
function fileFor(sound: AppSound): string {
  const { variants } = SOUNDS[sound];
  if (!variants) return sound;
  let index = Math.floor(Math.random() * variants);
  if (index === lastVariant.get(sound)) index = (index + 1) % variants;
  lastVariant.set(sound, index);
  return `${sound}_v${index + 1}`;
}

let player: BrowserWindow | null = null;
let ready: Promise<boolean> | null = null;
/** Set once the page has failed to load, so the system's sound is used from then on. */
let broken = false;

function open(): Promise<boolean> {
  if (ready && player && !player.isDestroyed()) return ready;
  player = new BrowserWindow({
    show: false,
    width: 1,
    height: 1,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Hidden, and never clicked: it must neither be slowed nor wait for a gesture.
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  player.on('closed', () => {
    player = null;
    ready = null;
  });
  ready = player
    .loadFile(bundlePath('sounds', 'player.html'))
    .then(() => true)
    .catch(() => {
      broken = true;
      closeSoundPlayer();
      return false;
    });
  return ready;
}

/**
 * Plays a sound at the level chosen in Settings, through the speaker chosen
 * for calls. False when it cannot be played here, so the caller can let the
 * system make a sound instead.
 */
export function playAppSound(sound: AppSound): boolean {
  if (broken || !app.isReady()) return false;
  const preferences = getPreferences();
  const volume = SOUNDS[sound].level * ((preferences.sounds?.volume ?? 100) / 100);
  const speaker = preferences.media?.speakerId ?? '';
  void open().then((loaded) => {
    if (!loaded || !player || player.isDestroyed()) return;
    void player.webContents
      .executeJavaScript(`play(${JSON.stringify(fileFor(sound))}, ${volume}, ${JSON.stringify(speaker)})`)
      .catch(() => {});
  });
  return true;
}

/**
 * Closes the hidden window. Outside macOS the app quits when its last window
 * closes, and this one must not count as the last.
 */
export function closeSoundPlayer(): void {
  if (player && !player.isDestroyed()) player.destroy();
  player = null;
  ready = null;
}
