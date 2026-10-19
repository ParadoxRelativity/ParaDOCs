import { describe, expect, it } from 'vitest';
import {
  NOTES_SIZE_DEFAULT,
  NOTES_SIZE_MAX,
  NOTES_SIZE_MIN,
  clampNotesSize,
  formatDuration,
  nextPreview,
  pauseTimer,
  recordTiming,
  resetTimer,
  resumeTimer,
  startTimer,
  timerElapsed,
  totalTiming,
} from './presenter.js';

describe('timer', () => {
  it('counts while running and holds while paused', () => {
    let t = startTimer(1000);
    expect(timerElapsed(t, 4000)).toBe(3000);
    t = pauseTimer(t, 4000);
    expect(timerElapsed(t, 90000)).toBe(3000);
    t = resumeTimer(t, 100000);
    expect(timerElapsed(t, 102000)).toBe(5000);
  });
  it('resets to zero, staying in the state it was in', () => {
    const running = resetTimer(startTimer(0), 5000);
    expect(timerElapsed(running, 6000)).toBe(1000);
    const paused = resetTimer(pauseTimer(startTimer(0), 5000), 9000);
    expect(paused.running).toBe(false);
    expect(timerElapsed(paused, 20000)).toBe(0);
  });
  it('formats minutes and hours', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(247000)).toBe('4:07');
    expect(formatDuration(3847000)).toBe('1:04:07');
    expect(formatDuration(-5)).toBe('0:00');
  });
});

describe('timings', () => {
  it('adds up time per slide and ignores nothing-spans', () => {
    let t = recordTiming({}, 'a', 1500);
    t = recordTiming(t, 'a', 500);
    t = recordTiming(t, 'b', 1000);
    expect(t).toEqual({ a: 2000, b: 1000 });
    expect(totalTiming(t)).toBe(3000);
    expect(recordTiming(t, null, 10)).toBe(t);
    expect(recordTiming(t, 'a', 0)).toBe(t);
  });
});

describe('notes size and preview', () => {
  it('clamps the size', () => {
    expect(clampNotesSize(1)).toBe(NOTES_SIZE_MIN);
    expect(clampNotesSize(500)).toBe(NOTES_SIZE_MAX);
    expect(clampNotesSize(20.4)).toBe(20);
    expect(clampNotesSize(Number.NaN)).toBe(NOTES_SIZE_DEFAULT);
  });
  it('previews the next build before the next slide', () => {
    expect(nextPreview(1, 3, true)).toBe('build');
    expect(nextPreview(3, 3, true)).toBe('slide');
    expect(nextPreview(0, 0, false)).toBe('end');
  });
});
