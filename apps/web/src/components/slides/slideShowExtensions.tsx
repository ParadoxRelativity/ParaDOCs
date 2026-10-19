import { createContext, useContext, type ReactNode } from 'react';
import type { SlideSnapshot, Theme } from '@paradocs/shared';
import type { SlideShowController } from '../../lib/slideShow';

/**
 * The seams later stories plug into the slideshow, so SlideShow.tsx never has
 * to know about notes windows, build animations or live following.
 *
 *   registerSlideShowSteps  how many build steps a slide has (PARA-100). The
 *                           show presses through them before leaving the slide.
 *   registerSlideShowAddon  anything rendered alongside the show with the
 *                           controller in hand: the presenter view's popout
 *                           (PARA-94), a broadcaster of `controller.state`
 *                           to the audience (PARA-99)
 *   useSlideShowStep        for an element renderer: how far the slide it
 *                           sits on is built
 *
 * Like the editor's registries, these fill by importing a module for its side
 * effect, and registering an id again replaces it.
 */

export type SlideShowStepCounter = (slide: SlideSnapshot) => number;

const stepCounters = new Map<string, SlideShowStepCounter>();

export function registerSlideShowSteps(id: string, count: SlideShowStepCounter) {
  stepCounters.set(id, count);
}

/** Build steps of a slide: the sum over every registered counter, 0 when none are. */
export function slideShowSteps(slide: SlideSnapshot): number {
  let total = 0;
  for (const count of stepCounters.values()) total += Math.max(0, Math.floor(count(slide) || 0));
  return total;
}

export interface SlideShowAddonContext {
  controller: SlideShowController;
  theme: Theme;
  presentationId: string;
  workspaceId: string;
  /** Leaves the show. */
  exit: () => void;
}

export interface SlideShowAddon {
  id: string;
  order?: number;
  render: (ctx: SlideShowAddonContext) => ReactNode;
}

const addons = new Map<string, SlideShowAddon>();

export function registerSlideShowAddon(addon: SlideShowAddon) {
  addons.set(addon.id, addon);
}

export function slideShowAddons(): SlideShowAddon[] {
  return [...addons.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}

/**
 * How far the slide being drawn is built. Outside a show, and for a slide the
 * show is leaving or has not reached, everything is shown (infinity), so an
 * element only hides itself for steps above `step` while its slide is live.
 */
export interface SlideShowStep {
  slideId: string | null;
  step: number;
}

export const SlideShowStepContext = createContext<SlideShowStep>({ slideId: null, step: Number.POSITIVE_INFINITY });

export function useSlideShowStep(): SlideShowStep {
  return useContext(SlideShowStepContext);
}
