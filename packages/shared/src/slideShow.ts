/**
 * The slideshow's logic, free of React and the DOM so it can be tested and
 * shared: which slides are shown, how a key press moves through them, and how
 * a transition between two slides is animated.
 *
 * The state is deliberately small and serialisable ({slideId, step, blank}),
 * so a presenter view on a second screen (PARA-94) or a live audience
 * (PARA-99) can mirror it by sending it over a channel, and build animations
 * (PARA-100) advance `step` within a slide before the show moves on.
 */

import type { SlideSnapshot, SlideTransition, SlideTransitionKind } from './slides.js';

/** What the show needs to know about a slide it is going to show. */
export interface ShowSlide {
  id: string;
  /** Build steps within the slide: 0 shows it whole, 3 takes three presses to reveal it. */
  steps: number;
}

/** The slides to present, in order: hidden ones are skipped. */
export function showPlaylist(slides: SlideSnapshot[], stepsOf: (slide: SlideSnapshot) => number = () => 0): ShowSlide[] {
  return slides.filter((s) => !s.hidden).map((s) => ({ id: s.id, steps: Math.max(0, Math.floor(stepsOf(s))) }));
}

/**
 * Where to start so that "from the current slide" works even when that slide
 * is hidden: the next shown slide at or after it, else the last one before it.
 */
export function startSlideId(slides: SlideSnapshot[], fromId: string | null | undefined): string | null {
  const playlist = slides.filter((s) => !s.hidden);
  if (playlist.length === 0) return null;
  const at = slides.findIndex((s) => s.id === fromId);
  if (at < 0) return playlist[0].id;
  const after = slides.slice(at).find((s) => !s.hidden);
  return (after ?? [...slides.slice(0, at)].reverse().find((s) => !s.hidden) ?? playlist[0]).id;
}

export type ShowBlank = 'black' | 'white' | null;

export interface ShowState {
  slideId: string | null;
  /** How many build steps of the slide are revealed. */
  step: number;
  /** A black or white screen, as a clicker's B and W keys give. */
  blank: ShowBlank;
  /** Digits typed towards "go to slide N", committed with Enter. */
  jump: string;
}

export type ShowAction =
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'first' }
  | { type: 'last' }
  /** `index` counts shown slides from 0. */
  | { type: 'goto'; index: number }
  | { type: 'gotoId'; id: string }
  | { type: 'digit'; digit: string }
  | { type: 'unDigit' }
  | { type: 'cancelJump' }
  | { type: 'commitJump' }
  | { type: 'blank'; color: 'black' | 'white' }
  | { type: 'unblank' };

export function initialShowState(playlist: ShowSlide[], startId?: string | null): ShowState {
  const slideId = playlist.find((s) => s.id === startId)?.id ?? playlist[0]?.id ?? null;
  return { slideId, step: 0, blank: null, jump: '' };
}

/** Index of the current slide in the playlist; falls back to the first when it has gone (deleted, or hidden meanwhile). */
export function showIndex(state: ShowState, playlist: ShowSlide[]): number {
  const at = playlist.findIndex((s) => s.id === state.slideId);
  return at >= 0 ? at : 0;
}

function at(playlist: ShowSlide[], index: number, step: number): Pick<ShowState, 'slideId' | 'step'> {
  const slide = playlist[Math.min(Math.max(index, 0), playlist.length - 1)];
  return { slideId: slide?.id ?? null, step: Math.min(step, slide?.steps ?? 0) };
}

/** The most digits a jump takes: more than any deck has slides. */
const MAX_JUMP_DIGITS = 4;

export function showReducer(state: ShowState, action: ShowAction, playlist: ShowSlide[]): ShowState {
  if (playlist.length === 0) return state;
  const index = showIndex(state, playlist);
  const current = playlist[index];
  const moved = (to: Pick<ShowState, 'slideId' | 'step'>): ShowState => ({ ...state, ...to, blank: null, jump: '' });
  // The slide the state names may be gone; steps are then those of the one standing in for it.
  const step = state.slideId === current.id ? state.step : 0;

  switch (action.type) {
    case 'next':
      // A blank screen is brought back by the next press rather than moving on behind it.
      if (state.blank) return { ...state, blank: null, jump: '' };
      if (step < current.steps) return moved({ slideId: current.id, step: step + 1 });
      return index < playlist.length - 1 ? moved(at(playlist, index + 1, 0)) : { ...state, jump: '' };
    case 'prev':
      if (state.blank) return { ...state, blank: null, jump: '' };
      if (step > 0) return moved({ slideId: current.id, step: step - 1 });
      // Going back lands on the earlier slide fully built, as it was left.
      return index > 0 ? moved(at(playlist, index - 1, playlist[index - 1].steps)) : { ...state, jump: '' };
    case 'first':
      return moved(at(playlist, 0, 0));
    case 'last':
      return moved(at(playlist, playlist.length - 1, playlist[playlist.length - 1].steps));
    case 'goto':
      return moved(at(playlist, action.index, 0));
    case 'gotoId': {
      const to = playlist.findIndex((s) => s.id === action.id);
      return to >= 0 ? moved(at(playlist, to, 0)) : state;
    }
    case 'digit':
      return /^[0-9]$/.test(action.digit) && state.jump.length < MAX_JUMP_DIGITS ? { ...state, jump: state.jump + action.digit } : state;
    case 'unDigit':
      return { ...state, jump: state.jump.slice(0, -1) };
    case 'cancelJump':
      return { ...state, jump: '' };
    case 'commitJump': {
      const n = Number.parseInt(state.jump, 10);
      return Number.isFinite(n) && n >= 1 ? moved(at(playlist, n - 1, 0)) : { ...state, jump: '' };
    }
    case 'blank':
      return { ...state, blank: state.blank === action.color ? null : action.color, jump: '' };
    case 'unblank':
      return state.blank ? { ...state, blank: null } : state;
  }
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export type ShowCommand = ShowAction | { type: 'exit' } | { type: 'laser' } | { type: 'fullscreen' };

/**
 * What a key press means to the show, or null to leave it alone. The keys a
 * presentation clicker sends (PageDown, PageUp, period for a black screen,
 * Escape) are all here. `jumping` says digits are pending, which gives Enter,
 * Backspace and Escape their jump meanings.
 */
export function showCommandForKey(key: string, opts: { shift?: boolean; jumping?: boolean } = {}): ShowCommand | null {
  if (/^[0-9]$/.test(key)) return { type: 'digit', digit: key };
  switch (key) {
    case 'Escape':
      return opts.jumping ? { type: 'cancelJump' } : { type: 'exit' };
    case 'Enter':
      return opts.jumping ? { type: 'commitJump' } : { type: 'next' };
    case 'Backspace':
      return opts.jumping ? { type: 'unDigit' } : { type: 'prev' };
    case ' ':
      return opts.shift ? { type: 'prev' } : { type: 'next' };
    case 'ArrowRight':
    case 'ArrowDown':
    case 'PageDown':
    case 'n':
    case 'N':
      return { type: 'next' };
    case 'ArrowLeft':
    case 'ArrowUp':
    case 'PageUp':
    case 'p':
    case 'P':
      return { type: 'prev' };
    case 'Home':
      return { type: 'first' };
    case 'End':
      return { type: 'last' };
    case 'b':
    case 'B':
    case '.':
      return { type: 'blank', color: 'black' };
    case 'w':
    case 'W':
    case ',':
      return { type: 'blank', color: 'white' };
    case 'l':
    case 'L':
      return { type: 'laser' };
    case 'f':
    case 'F':
      return { type: 'fullscreen' };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

export const DEFAULT_TRANSITION_MS = 500;
export const MAX_TRANSITION_MS = 3000;

export const SLIDE_TRANSITION_LABELS: Record<SlideTransitionKind, string> = {
  none: 'None',
  fade: 'Fade',
  push: 'Push',
  wipe: 'Wipe',
  zoom: 'Zoom',
};

/** How long a transition runs; 0 for none. */
export function transitionDuration(transition: SlideTransition | undefined): number {
  if (!transition || transition.kind === 'none') return 0;
  const ms = transition.durationMs ?? DEFAULT_TRANSITION_MS;
  return Math.min(Math.max(Math.round(ms), 0), MAX_TRANSITION_MS);
}

/** A keyframe as the Web Animations API takes it. */
export type ShowKeyframe = Record<string, string | number>;

export interface TransitionFrames {
  /** The slide being left, drawn beneath the new one. */
  outgoing: ShowKeyframe[];
  /** The slide arriving, drawn on top. */
  incoming: ShowKeyframe[];
}

/**
 * Keyframes for the two slides of a transition. `direction` is 1 going
 * forward and -1 going back, which reverses push and wipe.
 */
export function transitionFrames(kind: SlideTransitionKind, direction: 1 | -1): TransitionFrames {
  switch (kind) {
    case 'fade':
      // A dissolve: the old slide stays solid beneath while the new one comes up, so nothing dips to the backdrop.
      return { outgoing: [{ opacity: 1 }, { opacity: 1 }], incoming: [{ opacity: 0 }, { opacity: 1 }] };
    case 'push':
      return {
        outgoing: [{ transform: 'translateX(0)' }, { transform: `translateX(${-100 * direction}%)` }],
        incoming: [{ transform: `translateX(${100 * direction}%)` }, { transform: 'translateX(0)' }],
      };
    case 'wipe':
      return {
        outgoing: [{ opacity: 1 }, { opacity: 1 }],
        incoming: [{ clipPath: direction === 1 ? 'inset(0 100% 0 0)' : 'inset(0 0 0 100%)' }, { clipPath: 'inset(0 0 0 0)' }],
      };
    case 'zoom':
      return {
        outgoing: [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(1.15)' }],
        incoming: [{ opacity: 0, transform: 'scale(0.85)' }, { opacity: 1, transform: 'scale(1)' }],
      };
    case 'none':
    default:
      return { outgoing: [], incoming: [] };
  }
}

/** Swipe threshold in pixels: far enough to mean it. */
export const SWIPE_MIN_DISTANCE = 48;

/** 1 swiping left (forward), -1 swiping right (back), 0 for a tap or a mostly vertical drag. */
export function swipeDirection(dx: number, dy: number): -1 | 0 | 1 {
  if (Math.abs(dx) < SWIPE_MIN_DISTANCE || Math.abs(dx) < Math.abs(dy) * 1.5) return 0;
  return dx < 0 ? 1 : -1;
}
