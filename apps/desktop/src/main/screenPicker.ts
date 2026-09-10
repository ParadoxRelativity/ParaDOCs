import {
  BrowserWindow,
  desktopCapturer,
  systemPreferences,
  type BrowserWindowConstructorOptions,
  type DesktopCapturerSource,
} from 'electron';
import { bundlePath } from './paths.js';

/** A source as the picker page receives it. */
export interface PickerSource {
  id: string;
  name: string;
  kind: 'screen' | 'window';
  /** A JPEG data URL, or null when the platform had no picture to give. */
  thumbnail: string | null;
  icon: string | null;
}

export interface PickedSource {
  id: string;
  name: string;
  audio: boolean;
}

/** Refreshed this often while the picker is open, so the previews stay current. */
const REFRESH_MS = 2000;
const THUMBNAIL_SIZE = { width: 480, height: 270 };

let openPicker: BrowserWindow | null = null;

function toPickerSource(source: DesktopCapturerSource): PickerSource {
  return {
    id: source.id,
    name: source.name,
    kind: source.id.startsWith('screen:') ? 'screen' : 'window',
    // JPEG rather than PNG keeps a refresh with many windows open to a
    // fraction of the size.
    thumbnail: source.thumbnail.isEmpty()
      ? null
      : `data:image/jpeg;base64,${source.thumbnail.toJPEG(75).toString('base64')}`,
    icon: source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : null,
  };
}

/** The system accent colour as #rrggbb, on the platforms that have one. */
function accentColor(): string {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return '';
  try {
    const raw = systemPreferences.getAccentColor();
    return /^[0-9a-f]{6}/i.test(raw) ? `#${raw.slice(0, 6)}` : '';
  } catch {
    return '';
  }
}

/**
 * Asks which screen or window to share, showing each as a live thumbnail, and
 * resolves null when the picker is cancelled or closed.
 *
 * It is modal to the window that asked, which on macOS makes it a sheet. One
 * picker is open at a time: a second request while one is showing is refused
 * and the open one brought forward.
 */
export function pickShareSource(
  parent: BrowserWindow | null,
  { offerAudio }: { offerAudio: boolean },
): Promise<PickedSource | null> {
  if (openPicker && !openPicker.isDestroyed()) {
    openPicker.focus();
    return Promise.resolve(null);
  }

  const options: BrowserWindowConstructorOptions = {
    width: 760,
    height: 560,
    minWidth: 520,
    minHeight: 400,
    show: false,
    title: 'Share your screen',
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: bundlePath('picker-preload.cjs'),
    },
  };
  if (parent && !parent.isDestroyed()) {
    options.parent = parent;
    options.modal = true;
  }
  if (process.platform === 'darwin') {
    // The sheet material shows through the page, as it does in system dialogs.
    options.vibrancy = 'sheet';
    options.visualEffectState = 'active';
    options.backgroundColor = '#00000000';
  }

  const picker = new BrowserWindow(options);
  openPicker = picker;

  return new Promise((resolve) => {
    let sources = new Map<string, DesktopCapturerSource>();
    let settled = false;
    let refreshing = false;

    const finish = (result: PickedSource | null) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      if (openPicker === picker) openPicker = null;
      resolve(result);
      if (!picker.isDestroyed()) picker.close();
    };

    const refresh = async () => {
      if (refreshing || settled || picker.isDestroyed()) return;
      refreshing = true;
      try {
        const found = await desktopCapturer.getSources({
          types: ['screen', 'window'],
          thumbnailSize: THUMBNAIL_SIZE,
          fetchWindowIcons: true,
        });
        if (settled || picker.isDestroyed()) return;
        // The picker would otherwise offer to share itself.
        const ownId = picker.getMediaSourceId();
        const listed = found.filter((source) => source.id !== ownId);
        sources = new Map(listed.map((source) => [source.id, source]));
        picker.webContents.send('picker:sources', listed.map(toPickerSource));
      } catch {
        // A failed refresh keeps the last list; the next one may succeed.
      } finally {
        refreshing = false;
      }
    };
    const timer = setInterval(() => void refresh(), REFRESH_MS);

    // The page can only answer with an id it was sent; anything else is ignored.
    picker.webContents.ipc.on('picker:choose', (_event, id: unknown, audio: unknown) => {
      const source = typeof id === 'string' ? sources.get(id) : undefined;
      if (source) finish({ id: source.id, name: source.name, audio: offerAudio && audio === true });
    });
    picker.webContents.ipc.on('picker:cancel', () => finish(null));
    picker.webContents.on('will-navigate', (event) => event.preventDefault());
    picker.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    picker.webContents.once('did-finish-load', () => void refresh());
    picker.once('ready-to-show', () => picker.show());
    picker.on('closed', () => finish(null));

    picker
      .loadFile(bundlePath('picker', 'index.html'), {
        query: { platform: process.platform, audio: offerAudio ? '1' : '0', accent: accentColor() },
      })
      .catch(() => finish(null));
  });
}
