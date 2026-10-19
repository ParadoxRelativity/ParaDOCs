/**
 * The presenter view's arithmetic, free of React and the clock: the elapsed
 * timer with pause and reset, how long each slide was on screen while
 * rehearsing, and the notes text size. The view passes `now` in, so all of it
 * is testable without waiting.
 */

export interface PresenterTimer {
  running: boolean;
  /** Time banked from earlier runs, in ms. */
  accumulatedMs: number;
  /** When the current run began, or null while paused. */
  startedAt: number | null;
}

export function startTimer(now: number): PresenterTimer {
  return { running: true, accumulatedMs: 0, startedAt: now };
}

export function timerElapsed(timer: PresenterTimer, now: number): number {
  const running = timer.running && timer.startedAt !== null ? Math.max(0, now - timer.startedAt) : 0;
  return timer.accumulatedMs + running;
}

export function pauseTimer(timer: PresenterTimer, now: number): PresenterTimer {
  return timer.running ? { running: false, accumulatedMs: timerElapsed(timer, now), startedAt: null } : timer;
}

export function resumeTimer(timer: PresenterTimer, now: number): PresenterTimer {
  return timer.running ? timer : { ...timer, running: true, startedAt: now };
}

/** Back to zero; a running timer keeps running from now. */
export function resetTimer(timer: PresenterTimer, now: number): PresenterTimer {
  return timer.running ? startTimer(now) : { running: false, accumulatedMs: 0, startedAt: null };
}

/** "4:07", or "1:04:07" from an hour up. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Milliseconds each slide has been on screen, by slide id. */
export type SlideTimings = Record<string, number>;

/** Adds `ms` to a slide's time; nothing is recorded for a missing slide or a non-positive span. */
export function recordTiming(timings: SlideTimings, slideId: string | null, ms: number): SlideTimings {
  if (!slideId || !(ms > 0)) return timings;
  return { ...timings, [slideId]: (timings[slideId] ?? 0) + ms };
}

export function totalTiming(timings: SlideTimings): number {
  return Object.values(timings).reduce((sum, ms) => sum + ms, 0);
}

export const NOTES_SIZE_MIN = 12;
export const NOTES_SIZE_MAX = 56;
export const NOTES_SIZE_DEFAULT = 22;

/** A notes text size in px kept within what stays readable, whole pixels. */
export function clampNotesSize(px: number): number {
  if (!Number.isFinite(px)) return NOTES_SIZE_DEFAULT;
  return Math.min(NOTES_SIZE_MAX, Math.max(NOTES_SIZE_MIN, Math.round(px)));
}

/** What the next press reveals: the next build of this slide, else the next slide. */
export function nextPreview(step: number, steps: number, hasNextSlide: boolean): 'build' | 'slide' | 'end' {
  if (step < steps) return 'build';
  return hasNextSlide ? 'slide' : 'end';
}
