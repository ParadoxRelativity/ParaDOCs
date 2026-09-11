import { getMediaPreferences } from './mediaPreferences';

/**
 * A soft two-note ring for an incoming call, made with Web Audio rather than
 * shipped as a file, at the output volume chosen in Settings. Returns a
 * function that stops it.
 *
 * A browser that will not play sound before the page has been clicked simply
 * stays quiet; the call card still shows.
 */
export function startRingtone(): () => void {
  let context: AudioContext;
  try {
    context = new AudioContext();
  } catch {
    return () => {};
  }
  const level = 0.08 * (getMediaPreferences().outputVolume / 100);

  const ring = () => {
    const now = context.currentTime;
    for (const [offset, frequency] of [
      [0, 660],
      [0.18, 880],
    ] as const) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.linearRampToValueAtTime(Math.max(level, 0.0001), now + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.35);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(now + offset);
      oscillator.stop(now + offset + 0.4);
    }
  };

  void context.resume().catch(() => {});
  ring();
  const timer = setInterval(ring, 2_000);
  return () => {
    clearInterval(timer);
    void context.close().catch(() => {});
  };
}
