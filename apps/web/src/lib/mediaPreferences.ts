import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

/**
 * Which devices a call uses, and how loud. Kept in this browser rather than on
 * the account: a device id means nothing on another machine.
 */
export interface MediaPreferences {
  /** Empty means the system default. */
  microphoneId: string;
  speakerId: string;
  cameraId: string;
  /** Percent. Above 100 boosts a quiet microphone. */
  inputVolume: number;
  /** Percent, up to 100: an audio element cannot play louder than its source. */
  outputVolume: number;
}

export const MAX_INPUT_VOLUME = 200;

const STORAGE_KEY = 'paradocs.media';

const DEFAULTS: MediaPreferences = {
  microphoneId: '',
  speakerId: '',
  cameraId: '',
  inputVolume: 100,
  outputVolume: 100,
};

function sanitize(raw: unknown): MediaPreferences {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const id = (v: unknown) => (typeof v === 'string' ? v : '');
  const level = (v: unknown, max: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(0, Math.round(v))) : 100;
  return {
    microphoneId: id(value.microphoneId),
    speakerId: id(value.speakerId),
    cameraId: id(value.cameraId),
    inputVolume: level(value.inputVolume, MAX_INPUT_VOLUME),
    outputVolume: level(value.outputVolume, 100),
  };
}

function load(): MediaPreferences {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? sanitize(JSON.parse(stored)) : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

/**
 * A store rather than component state, because two unrelated owners read it:
 * the settings dialog and the call, which must pick up a change made mid-call.
 */
let current = load();
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

export function getMediaPreferences(): MediaPreferences {
  return current;
}

export function setMediaPreferences(patch: Partial<MediaPreferences>) {
  current = sanitize({ ...current, ...patch });
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // Storage can be full or blocked; the choice holds for this session only.
  }
  emit();
}

export function subscribeMediaPreferences(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Another tab on this origin changed them.
window.addEventListener('storage', (event) => {
  if (event.key !== STORAGE_KEY) return;
  current = load();
  emit();
});

export function useMediaPreferences(): MediaPreferences {
  return useSyncExternalStore(subscribeMediaPreferences, getMediaPreferences);
}

/** Whether this browser can send audio to a chosen output device. */
export const canChooseSpeaker = 'setSinkId' in HTMLMediaElement.prototype;

/**
 * The saved device, if it is still connected. An unplugged headset must not
 * stop a call from starting, so a missing device means the system default.
 */
export async function connectedDeviceId(kind: MediaDeviceKind, id: string): Promise<string | undefined> {
  if (!id || !navigator.mediaDevices?.enumerateDevices) return undefined;
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  return devices.some((device) => device.kind === kind && device.deviceId === id) ? id : undefined;
}

/** The devices this machine has, kept current as they are plugged in and out. */
export function useMediaDevices() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);

  const refresh = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      setDevices(await navigator.mediaDevices.enumerateDevices());
    } catch {
      setDevices([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
    navigator.mediaDevices?.addEventListener('devicechange', refresh);
    return () => navigator.mediaDevices?.removeEventListener('devicechange', refresh);
  }, [refresh]);

  /**
   * Browsers withhold device names until a page has been allowed to use one.
   * The camera is asked for too so its names appear, but a machine without one
   * must still be able to name its microphones.
   */
  const requestAccess = useCallback(async () => {
    const stream = await navigator.mediaDevices
      .getUserMedia({ audio: true, video: true })
      .catch(() => navigator.mediaDevices.getUserMedia({ audio: true }));
    stream.getTracks().forEach((track) => track.stop());
    await refresh();
  }, [refresh]);

  return { devices, labelled: devices.some((device) => device.label !== ''), requestAccess };
}
