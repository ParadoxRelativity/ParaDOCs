import { createPreference } from './preference';
import { getMediaPreferences } from './mediaPreferences';

/**
 * The app's sounds: short cues for messages and calls, and the two ringtones.
 *
 * The files live in `public/sounds/`, one folder per format, named after the
 * sound (`ogg/participant_joined.ogg`). A sound with variants has one file per
 * variant (`message_sent_v1` … `_v3`), and one is picked at random each time,
 * never the same one twice running. Replacing a file there changes the sound;
 * nothing else needs to know.
 *
 * Ogg Opus is played first, since it is the smallest and loops without a gap.
 * A browser that cannot decode it — older Safari, and the iOS app's web view —
 * gets the M4A (AAC) copy instead. See `public/sounds/README.md`.
 */
export type SoundName =
  | 'message_received'
  | 'message_sent'
  | 'message_failed'
  | 'mention_or_dm'
  | 'reaction_added'
  | 'notification_generic'
  | 'error'
  | 'call_incoming'
  | 'call_outgoing'
  | 'call_waiting'
  | 'call_connected'
  | 'call_declined'
  | 'call_missed'
  | 'self_join_call'
  | 'self_leave_call'
  | 'participant_joined'
  | 'participant_left'
  | 'mic_mute'
  | 'mic_unmute'
  | 'camera_on'
  | 'camera_off'
  | 'screenshare_start'
  | 'screenshare_stop'
  | 'screenshare_remote_started'
  | 'screenshare_remote_stopped'
  | 'connection_lost'
  | 'connection_restored';

interface SoundSpec {
  /** How many `_vN` files there are, if the sound has variants. */
  variants?: number;
  /**
   * The playback level the suite recommends, from its manifest. In-call sounds
   * are capped by it so they never sit on top of someone speaking.
   */
  volume: number;
  /**
   * A catch-all, such as an error: it gives way to a more particular sound
   * played at the same moment, whichever of the two comes first.
   */
  generic?: boolean;
}

const SOUNDS: Record<SoundName, SoundSpec> = {
  message_received: { variants: 3, volume: 0.36 },
  message_sent: { variants: 3, volume: 0.32 },
  message_failed: { volume: 0.55 },
  mention_or_dm: { volume: 0.75 },
  reaction_added: { volume: 0.35 },
  notification_generic: { volume: 0.5, generic: true },
  error: { volume: 0.75, generic: true },
  call_incoming: { volume: 0.8 },
  call_outgoing: { volume: 0.55 },
  call_waiting: { volume: 0.28 },
  call_connected: { volume: 0.5 },
  call_declined: { volume: 0.55 },
  call_missed: { volume: 0.45 },
  self_join_call: { volume: 0.5 },
  self_leave_call: { volume: 0.5 },
  participant_joined: { volume: 0.35 },
  participant_left: { volume: 0.35 },
  mic_mute: { variants: 3, volume: 0.3 },
  mic_unmute: { variants: 3, volume: 0.3 },
  camera_on: { volume: 0.4 },
  camera_off: { volume: 0.4 },
  screenshare_start: { volume: 0.37 },
  screenshare_stop: { volume: 0.34 },
  screenshare_remote_started: { volume: 0.38 },
  screenshare_remote_stopped: { volume: 0.36 },
  connection_lost: { volume: 0.34 },
  connection_restored: { volume: 0.37 },
};

/** Sounds on or off, and how loud, for the person at this computer. */
export interface SoundPreferences {
  enabled: boolean;
  /** Percent, applied on top of each sound's own level. */
  volume: number;
}

const preference = createPreference<SoundPreferences>({
  key: 'sounds',
  storageKey: 'paradocs.sounds',
  fallback: { enabled: true, volume: 100 },
  isValid: (value): value is SoundPreferences =>
    Boolean(value) &&
    typeof value === 'object' &&
    typeof (value as SoundPreferences).enabled === 'boolean' &&
    typeof (value as SoundPreferences).volume === 'number' &&
    (value as SoundPreferences).volume >= 0 &&
    (value as SoundPreferences).volume <= 100,
});

export function useSoundPreferences(): [SoundPreferences, (next: SoundPreferences) => void] {
  return preference.use();
}

export function soundsEnabled(): boolean {
  return preference.get().enabled;
}

const FORMATS = [
  { folder: 'ogg', extension: 'ogg' },
  { folder: 'm4a', extension: 'm4a' },
] as const;

/** Moves on to M4A for good once this browser has failed to decode an Ogg. */
let formatIndex = 0;
let context: AudioContext | null = null;
/** Applied once per chosen speaker rather than on every sound. */
let sinkId: string | null = null;
const buffers = new Map<string, Promise<AudioBuffer | null>>();
const lastVariant = new Map<SoundName, number>();

interface Playing {
  name: SoundName;
  startedAt: number;
  stop: () => void;
}
/** Sounds asked for in the last moment, for a generic one to give way to a particular one. */
const recent: Playing[] = [];
const SAME_MOMENT_MS = 400;

function audioContext(): AudioContext | null {
  if (context) return context;
  try {
    context = new AudioContext();
  } catch {
    return null;
  }
  return context;
}

// A browser keeps a page quiet until it has been clicked or typed in, and iOS
// until audio has started from one of those. The first of either wakes it, so
// a message that arrives later can be heard.
function unlock() {
  void audioContext()?.resume().catch(() => {});
  window.removeEventListener('pointerdown', unlock, true);
  window.removeEventListener('keydown', unlock, true);
}
window.addEventListener('pointerdown', unlock, true);
window.addEventListener('keydown', unlock, true);

/** Plays through the speaker chosen for calls, where the browser allows choosing one. */
function followSpeaker(ctx: AudioContext) {
  const speaker = getMediaPreferences().speakerId;
  if (speaker === sinkId) return;
  sinkId = speaker;
  const settable = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
  // An unplugged device is refused, and the system default carries on.
  void settable.setSinkId?.(speaker).catch(() => {});
}

function url(file: string): string {
  const { folder, extension } = FORMATS[formatIndex];
  return `${import.meta.env.BASE_URL}sounds/${folder}/${file}.${extension}`;
}

async function fetchAndDecode(ctx: AudioContext, file: string): Promise<AudioBuffer | null> {
  while (formatIndex < FORMATS.length) {
    const format = formatIndex;
    try {
      const response = await fetch(url(file));
      if (!response.ok) return null;
      return await ctx.decodeAudioData(await response.arrayBuffer());
    } catch {
      // Could not decode this format: try the next one, for this and every later sound.
      if (formatIndex === format) formatIndex += 1;
    }
  }
  return null;
}

/** Decoded once and kept; a failure is forgotten so a later play can try again. */
function load(ctx: AudioContext, file: string): Promise<AudioBuffer | null> {
  let buffer = buffers.get(file);
  if (!buffer) {
    buffer = fetchAndDecode(ctx, file);
    buffers.set(file, buffer);
    void buffer.then((decoded) => {
      if (!decoded) buffers.delete(file);
    });
  }
  return buffer;
}

function pickFile(name: SoundName): string {
  const count = SOUNDS[name].variants;
  if (!count) return name;
  const previous = lastVariant.get(name);
  let index = Math.floor(Math.random() * count);
  if (count > 1 && index === previous) index = (index + 1 + Math.floor(Math.random() * (count - 1))) % count;
  lastVariant.set(name, index);
  return `${name}_v${index + 1}`;
}

function start(name: SoundName, loop: boolean): (() => void) | null {
  const settings = preference.get();
  if (!settings.enabled || settings.volume === 0) return null;
  const ctx = audioContext();
  if (!ctx) return null;
  followSpeaker(ctx);
  void ctx.resume().catch(() => {});

  let stopped = false;
  let source: AudioBufferSourceNode | null = null;
  const requestedAt = performance.now();

  void load(ctx, pickFile(name)).then((buffer) => {
    // Too late to matter: a cue that arrives a second after the fact is noise.
    if (!buffer || stopped || (!loop && performance.now() - requestedAt > 1_500)) return;
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.loop = loop;
    const gain = ctx.createGain();
    gain.gain.value = SOUNDS[name].volume * (settings.volume / 100);
    node.connect(gain).connect(ctx.destination);
    node.start();
    source = node;
  });

  return () => {
    stopped = true;
    try {
      source?.stop();
    } catch {
      // Already finished.
    }
  };
}

/**
 * Plays a sound once. A generic sound is skipped when another sound has just
 * started, and silenced when a particular one follows it. `instead` names
 * sounds of the same moment that this one replaces, such as someone joining
 * when what they did was answer your call.
 */
export function playSound(name: SoundName, { instead = [] }: { instead?: SoundName[] } = {}): void {
  const now = performance.now();
  while (recent.length && now - recent[0].startedAt > SAME_MOMENT_MS) recent.shift();
  const generic = Boolean(SOUNDS[name].generic);
  if (generic && recent.length > 0) return;
  for (const playing of recent) {
    if (instead.includes(playing.name) || (!generic && SOUNDS[playing.name].generic)) playing.stop();
  }
  const stop = start(name, false);
  if (stop) recent.push({ name, startedAt: now, stop });
}

/** Plays a ringtone round and round until the returned function is called. */
export function loopSound(name: SoundName): () => void {
  return start(name, true) ?? (() => {});
}
