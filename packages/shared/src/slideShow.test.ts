import { describe, expect, it } from 'vitest';
import {
  initialShowState,
  showCommandForKey,
  showPlaylist,
  showReducer,
  startSlideId,
  swipeDirection,
  transitionDuration,
  transitionFrames,
  type ShowAction,
  type ShowSlide,
} from './slideShow.js';
import type { SlideSnapshot } from './slides.js';

const slide = (id: string, hidden = false): SlideSnapshot => ({ id, layoutId: 'blank', background: null, hidden, transition: { kind: 'none' }, elements: [], notes: '' });
const list: ShowSlide[] = [{ id: 'a', steps: 0 }, { id: 'b', steps: 2 }, { id: 'c', steps: 0 }];
const run = (actions: ShowAction[], playlist = list) => actions.reduce((s, a) => showReducer(s, a, playlist), initialShowState(playlist));

describe('playlist', () => {
  it('skips hidden slides', () => {
    expect(showPlaylist([slide('a'), slide('b', true), slide('c')]).map((s) => s.id)).toEqual(['a', 'c']);
  });
  it('starts from the current slide, or the nearest shown one when it is hidden', () => {
    const slides = [slide('a'), slide('b', true), slide('c'), slide('d', true)];
    expect(startSlideId(slides, 'c')).toBe('c');
    expect(startSlideId(slides, 'b')).toBe('c');
    expect(startSlideId(slides, 'd')).toBe('c');
    expect(startSlideId(slides, null)).toBe('a');
    expect(startSlideId([slide('a', true)], 'a')).toBeNull();
  });
});

describe('navigation', () => {
  it('walks build steps before moving to the next slide', () => {
    let s = run([{ type: 'next' }]);
    expect(s).toMatchObject({ slideId: 'b', step: 0 });
    s = showReducer(s, { type: 'next' }, list);
    s = showReducer(s, { type: 'next' }, list);
    expect(s).toMatchObject({ slideId: 'b', step: 2 });
    s = showReducer(s, { type: 'next' }, list);
    expect(s).toMatchObject({ slideId: 'c', step: 0 });
  });
  it('goes back to the previous slide fully built', () => {
    expect(run([{ type: 'goto', index: 2 }, { type: 'prev' }])).toMatchObject({ slideId: 'b', step: 2 });
  });
  it('stops at either end', () => {
    expect(run([{ type: 'prev' }]).slideId).toBe('a');
    expect(run([{ type: 'last' }, { type: 'next' }]).slideId).toBe('c');
  });
  it('jumps by typed number and ignores nonsense', () => {
    expect(run([{ type: 'digit', digit: '3' }, { type: 'commitJump' }]).slideId).toBe('c');
    expect(run([{ type: 'digit', digit: '9' }, { type: 'commitJump' }]).slideId).toBe('c');
    expect(run([{ type: 'digit', digit: '0' }, { type: 'commitJump' }]).slideId).toBe('a');
    expect(run([{ type: 'digit', digit: 'x' }]).jump).toBe('');
    expect(run([{ type: 'digit', digit: '2' }, { type: 'unDigit' }]).jump).toBe('');
  });
  it('toggles a blank screen, and any move brings the slide back', () => {
    expect(run([{ type: 'blank', color: 'black' }]).blank).toBe('black');
    expect(run([{ type: 'blank', color: 'black' }, { type: 'blank', color: 'black' }]).blank).toBeNull();
    expect(run([{ type: 'blank', color: 'black' }, { type: 'blank', color: 'white' }]).blank).toBe('white');
    expect(run([{ type: 'blank', color: 'white' }, { type: 'next' }])).toMatchObject({ blank: null, slideId: 'a' });
  });
  it('survives its slide going away', () => {
    const state = run([{ type: 'goto', index: 1 }]);
    expect(showReducer(state, { type: 'next' }, [{ id: 'a', steps: 0 }, { id: 'c', steps: 0 }]).slideId).toBe('c');
  });
});

describe('keys', () => {
  it('maps clicker keys', () => {
    expect(showCommandForKey('PageDown')).toEqual({ type: 'next' });
    expect(showCommandForKey('PageUp')).toEqual({ type: 'prev' });
    expect(showCommandForKey('.')).toEqual({ type: 'blank', color: 'black' });
    expect(showCommandForKey('Escape')).toEqual({ type: 'exit' });
    expect(showCommandForKey('q')).toBeNull();
  });
  it('gives Enter, Backspace and Escape jump meanings while digits are pending', () => {
    expect(showCommandForKey('Enter', { jumping: true })).toEqual({ type: 'commitJump' });
    expect(showCommandForKey('Enter')).toEqual({ type: 'next' });
    expect(showCommandForKey('Backspace', { jumping: true })).toEqual({ type: 'unDigit' });
    expect(showCommandForKey('Escape', { jumping: true })).toEqual({ type: 'cancelJump' });
    expect(showCommandForKey(' ', { shift: true })).toEqual({ type: 'prev' });
  });
});

describe('transitions', () => {
  it('has no duration for none and clamps the rest', () => {
    expect(transitionDuration({ kind: 'none', durationMs: 900 })).toBe(0);
    expect(transitionDuration({ kind: 'fade' })).toBe(500);
    expect(transitionDuration({ kind: 'fade', durationMs: 99_999 })).toBe(3000);
  });
  it('reverses push and wipe going back', () => {
    expect(transitionFrames('push', 1).incoming[0]).toEqual({ transform: 'translateX(100%)' });
    expect(transitionFrames('push', -1).incoming[0]).toEqual({ transform: 'translateX(-100%)' });
    expect(transitionFrames('wipe', 1).incoming[0]).not.toEqual(transitionFrames('wipe', -1).incoming[0]);
    expect(transitionFrames('none', 1)).toEqual({ outgoing: [], incoming: [] });
  });
  it('reads swipes', () => {
    expect(swipeDirection(-120, 10)).toBe(1);
    expect(swipeDirection(120, 10)).toBe(-1);
    expect(swipeDirection(10, 5)).toBe(0);
    expect(swipeDirection(60, 80)).toBe(0);
  });
});
