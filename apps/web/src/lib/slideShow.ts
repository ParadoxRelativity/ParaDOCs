import { useCallback, useMemo, useReducer } from 'react';
import {
  initialShowState,
  showIndex,
  showPlaylist,
  showReducer,
  type ShowAction,
  type ShowBlank,
  type ShowSlide,
  type ShowState,
  type SlideSnapshot,
} from '@paradocs/shared';

/**
 * The slideshow's state and moves, apart from how it is drawn. SlideShow.tsx
 * uses it for the full-screen show; a presenter view or a live-follow channel
 * (PARA-94, PARA-99) reads `state` and calls the moves, so every screen of one
 * show is driven by the same controller.
 */
export interface SlideShowController {
  /** Serialisable: {slideId, step, blank, jump}. Send it to mirror the show elsewhere. */
  state: ShowState;
  /** The slides being shown, hidden ones left out, with their build step counts. */
  playlist: ShowSlide[];
  /** Position of the current slide among the shown ones, from 0. */
  index: number;
  count: number;
  slide: SlideSnapshot | null;
  /** The slide after this one, for a presenter's preview and for preloading; null on the last. */
  nextSlide: SlideSnapshot | null;
  /** Build steps of the current slide, and how many are revealed. */
  steps: number;
  step: number;
  blank: ShowBlank;
  dispatch: (action: ShowAction) => void;
  next: () => void;
  prev: () => void;
  first: () => void;
  last: () => void;
  /** By position among the shown slides, from 0. */
  goTo: (index: number) => void;
  goToId: (id: string) => void;
}

/**
 * Runs a show over `slides`. The playlist follows the deck as it changes
 * (someone adding or deleting a slide mid-show), and `startId` is only where
 * it begins.
 */
export function useSlideShow(
  slides: SlideSnapshot[],
  startId: string | null,
  stepsOf?: (slide: SlideSnapshot) => number,
): SlideShowController {
  const playlist = useMemo(() => showPlaylist(slides, stepsOf), [slides, stepsOf]);
  const [state, rawDispatch] = useReducer(
    (s: ShowState, action: ShowAction & { playlist: ShowSlide[] }) => showReducer(s, action, action.playlist),
    undefined,
    () => initialShowState(playlist, startId),
  );
  const dispatch = useCallback((action: ShowAction) => rawDispatch({ ...action, playlist }), [playlist]);

  const index = showIndex(state, playlist);
  const byId = useMemo(() => new Map(slides.map((s) => [s.id, s])), [slides]);
  const slide = byId.get(playlist[index]?.id ?? '') ?? null;
  const nextSlide = byId.get(playlist[index + 1]?.id ?? '') ?? null;
  const steps = playlist[index]?.steps ?? 0;
  // The current slide may have been replaced by its neighbour (deleted mid-show), which starts unbuilt.
  const step = state.slideId === slide?.id ? Math.min(state.step, steps) : 0;

  return useMemo(
    () => ({
      state: { ...state, slideId: slide?.id ?? null, step },
      playlist,
      index,
      count: playlist.length,
      slide,
      nextSlide,
      steps,
      step,
      blank: state.blank,
      dispatch,
      next: () => dispatch({ type: 'next' }),
      prev: () => dispatch({ type: 'prev' }),
      first: () => dispatch({ type: 'first' }),
      last: () => dispatch({ type: 'last' }),
      goTo: (to: number) => dispatch({ type: 'goto', index: to }),
      goToId: (id: string) => dispatch({ type: 'gotoId', id }),
    }),
    [state, playlist, index, slide, nextSlide, steps, step, dispatch],
  );
}
