/**
 * Build animations: elements that appear (or leave) one at a time as the
 * presenter clicks, so points can be revealed as they are spoken to.
 *
 * The model is deliberately the small subset PowerPoint's main timeline has,
 * so the .pptx importer and exporter (PARA-95, PARA-97) can map to it:
 *
 *   effect     appear | fade | fly | zoom | wipe
 *              (presetID 1 / 10 / 2 / 53 / 22)
 *   direction  left | right | top | bottom, for fly and wipe (presetSubtype)
 *   trigger    onClick | withPrevious | afterPrevious
 *              (nodeType clickEffect / withEffect / afterEffect)
 *   phase      entrance | exit (presetClass entr / exit)
 *   delayMs, durationMs   (the delay of the effect's cTn, and its dur)
 *   byParagraph  a text box builds one paragraph at a time (bldP build="p")
 *   order      position in the slide's animation list, from 0
 *
 * It is stored as one plain `animation` object on the element, so it lives and
 * dies with the element. Ordering is the `order` number with the element's z
 * and id breaking ties, which keeps two people adding animations at once
 * deterministic. The slideshow's `step` is the number of clicks pressed: a
 * click step is an onClick unit plus everything chained after it with
 * "with previous" / "after previous"; units before the first click play when
 * the slide appears (step 0).
 */

import { z } from 'zod';
import type { SlideElement } from './slides.js';

export const ANIMATION_EFFECTS = ['appear', 'fade', 'fly', 'zoom', 'wipe'] as const;
export type AnimationEffect = (typeof ANIMATION_EFFECTS)[number];

export const ANIMATION_DIRECTIONS = ['left', 'right', 'top', 'bottom'] as const;
export type AnimationDirection = (typeof ANIMATION_DIRECTIONS)[number];

export const ANIMATION_TRIGGERS = ['onClick', 'withPrevious', 'afterPrevious'] as const;
export type AnimationTrigger = (typeof ANIMATION_TRIGGERS)[number];

export const ANIMATION_PHASES = ['entrance', 'exit'] as const;
export type AnimationPhase = (typeof ANIMATION_PHASES)[number];

export const ANIMATION_EFFECT_LABELS: Record<AnimationEffect, string> = {
  appear: 'Appear',
  fade: 'Fade',
  fly: 'Fly in',
  zoom: 'Zoom',
  wipe: 'Wipe',
};
export const ANIMATION_TRIGGER_LABELS: Record<AnimationTrigger, string> = {
  onClick: 'On click',
  withPrevious: 'With previous',
  afterPrevious: 'After previous',
};

export const DEFAULT_ANIMATION_MS = 500;
export const MAX_ANIMATION_MS = 10_000;
export const MAX_ANIMATION_DELAY_MS = 30_000;
/** More paragraphs than this in one box build as one block, so a plan stays small. */
export const MAX_BUILD_PARAGRAPHS = 50;

export interface ElementAnimation {
  effect: AnimationEffect;
  /** For fly and wipe: the side it comes from (entrance) or goes to (exit). Left when absent. */
  direction?: AnimationDirection;
  trigger: AnimationTrigger;
  /** Entrance when absent. */
  phase?: AnimationPhase;
  order: number;
  delayMs?: number;
  durationMs?: number;
  byParagraph?: boolean;
}

export const elementAnimationSchema = z.object({
  effect: z.enum(ANIMATION_EFFECTS),
  direction: z.enum(ANIMATION_DIRECTIONS).optional(),
  trigger: z.enum(ANIMATION_TRIGGERS),
  phase: z.enum(ANIMATION_PHASES).optional(),
  order: z.number().int().min(0),
  delayMs: z.number().int().min(0).max(MAX_ANIMATION_DELAY_MS).optional(),
  durationMs: z.number().int().min(0).max(MAX_ANIMATION_MS).optional(),
  byParagraph: z.boolean().optional(),
});

/** An animation read from a Y.Doc or an import: valid as given, else null (the element is simply not animated). */
export function readAnimation(value: unknown): ElementAnimation | null {
  const parsed = elementAnimationSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function animationDuration(animation: ElementAnimation): number {
  if (animation.effect === 'appear') return 0;
  return Math.min(Math.max(Math.round(animation.durationMs ?? DEFAULT_ANIMATION_MS), 0), MAX_ANIMATION_MS);
}

export function animationDelay(animation: ElementAnimation): number {
  return Math.min(Math.max(Math.round(animation.delayMs ?? 0), 0), MAX_ANIMATION_DELAY_MS);
}

/** Elements whose text can be built a paragraph at a time. */
export function supportsParagraphBuild(element: Pick<SlideElement, 'type'>): boolean {
  return element.type === 'richText' || element.type === 'text' || element.type === 'shape';
}

function paragraphsOf(element: SlideElement): number {
  const text = (element as { text?: string }).text ?? '';
  return Math.min(Math.max(text.split('\n').length, 1), MAX_BUILD_PARAGRAPHS);
}

/** One thing that appears or leaves: a whole element, or one paragraph of it. */
export interface BuildUnit {
  elementId: string;
  /** Which paragraph, from 0, or null for the whole element. */
  paragraph: number | null;
  animation: ElementAnimation;
  /** The click step it plays on: 0 plays as the slide appears, N on the Nth click. */
  step: number;
  /** When it starts within its step, after the click. */
  startMs: number;
  durationMs: number;
}

export interface BuildPlan {
  units: BuildUnit[];
  /** Clicks to build the slide completely. */
  steps: number;
}

/** Animated elements in the order they build. */
export function animatedElements(elements: SlideElement[]): { element: SlideElement; animation: ElementAnimation }[] {
  return elements
    .map((element) => ({ element, animation: readAnimation((element as { animation?: unknown }).animation) }))
    .filter((entry): entry is { element: SlideElement; animation: ElementAnimation } => entry.animation !== null)
    .sort((a, b) => a.animation.order - b.animation.order || (a.element.z ?? 0) - (b.element.z ?? 0) || a.element.id.localeCompare(b.element.id));
}

export function buildPlan(elements: SlideElement[]): BuildPlan {
  const units: BuildUnit[] = [];
  let step = 0;
  let prev: BuildUnit | null = null;
  for (const { element, animation } of animatedElements(elements)) {
    const paragraphs = animation.byParagraph && supportsParagraphBuild(element) ? paragraphsOf(element) : 0;
    const count = paragraphs > 1 ? paragraphs : 1;
    for (let i = 0; i < count; i++) {
      if (animation.trigger === 'onClick') step++;
      const durationMs = animationDuration(animation);
      const delay = animationDelay(animation);
      // Chained units start relative to the one before in the same step; the first of a step starts at its own delay.
      const before: BuildUnit | null = prev && prev.step === step ? prev : null;
      const startMs =
        animation.trigger === 'withPrevious' && before
          ? before.startMs + delay
          : animation.trigger === 'afterPrevious' && before
            ? before.startMs + before.durationMs + delay
            : delay;
      const unit: BuildUnit = { elementId: element.id, paragraph: paragraphs > 1 ? i : null, animation, step, startMs, durationMs };
      units.push(unit);
      prev = unit;
    }
  }
  return { units, steps: step };
}

/** Click steps of a slide: what the slideshow presses through before leaving it. */
export function slideBuildSteps(slide: { elements: SlideElement[] }): number {
  return buildPlan(slide.elements).steps;
}

/** Whether a unit is on screen once `step` clicks have been pressed. */
export function unitShown(unit: Pick<BuildUnit, 'step' | 'animation'>, step: number): boolean {
  return unit.animation.phase === 'exit' ? step < unit.step : step >= unit.step;
}

/** The units of one element: one, or one per paragraph. */
export function elementBuildUnits(plan: BuildPlan, elementId: string): BuildUnit[] {
  return plan.units.filter((u) => u.elementId === elementId);
}

/** A short name for an element in the animation list: its first line of text, else its kind. */
export function buildElementLabel(element: SlideElement): string {
  const text =
    element.type === 'richText' || element.type === 'text' || element.type === 'shape' ? ((element as { text?: string }).text ?? '').trim().split('\n')[0] : '';
  const trimmed = text.length > 32 ? `${text.slice(0, 31)}…` : text;
  return trimmed || element.type;
}

/** What the next click will do, for a presenter's preview: one line per unit playing on step `step + 1`. Empty when the slide is fully built. */
export function describeNextBuild(slide: { elements: SlideElement[] }, step: number): string[] {
  const plan = buildPlan(slide.elements);
  const byId = new Map(slide.elements.map((e) => [e.id, e]));
  return plan.units
    .filter((u) => u.step === step + 1)
    .map((u) => {
      const element = byId.get(u.elementId);
      const name = element ? buildElementLabel(element) : 'element';
      const para = u.paragraph === null ? '' : ` (paragraph ${u.paragraph + 1})`;
      const verb = u.animation.phase === 'exit' ? 'Remove' : ANIMATION_EFFECT_LABELS[u.animation.effect];
      return `${verb}: ${name}${para}`;
    });
}

/** Keyframes for a unit entering or leaving, as the Web Animations API takes them. Entrance runs them as given; exit reverses. */
export function animationKeyframes(animation: ElementAnimation): Record<string, string | number>[] {
  const from = animation.direction ?? 'left';
  const frames: Record<string, string | number>[] = (() => {
    switch (animation.effect) {
      case 'fade':
        return [{ opacity: 0 }, { opacity: 1 }];
      case 'zoom':
        return [
          { opacity: 0, transform: 'scale(0.3)' },
          { opacity: 1, transform: 'scale(1)' },
        ];
      case 'fly': {
        const offset = { left: 'translateX(-60%)', right: 'translateX(60%)', top: 'translateY(-60%)', bottom: 'translateY(60%)' }[from];
        return [
          { opacity: 0, transform: offset },
          { opacity: 1, transform: 'none' },
        ];
      }
      case 'wipe': {
        const inset = { left: 'inset(0 100% 0 0)', right: 'inset(0 0 0 100%)', top: 'inset(0 0 100% 0)', bottom: 'inset(100% 0 0 0)' }[from];
        return [{ clipPath: inset }, { clipPath: 'inset(0 0 0 0)' }];
      }
      case 'appear':
      default:
        return [{ opacity: 0 }, { opacity: 1 }];
    }
  })();
  return animation.phase === 'exit' ? [...frames].reverse() : frames;
}
