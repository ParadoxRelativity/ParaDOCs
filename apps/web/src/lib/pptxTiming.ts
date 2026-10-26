import { MAX_ANIMATION_DELAY_MS, MAX_ANIMATION_MS, type AnimationDirection, type AnimationEffect, type ElementAnimation } from '@paradocs/shared';
import { attr, child, descendants, numAttr } from './ooxml';
import type { ReportBuilder } from './slideImportTypes';

/**
 * A slide's animation timeline (`p:timing`) as element build animations.
 *
 * The timeline is a tree of timing nodes. The ones that matter here are the
 * effect nodes: those carrying a `presetID` and a `nodeType` of clickEffect,
 * withEffect or afterEffect. Each names the shape it acts on, in document
 * order, which is the order they play in. Only the effects the model has
 * (appear, fade, fly in, zoom, wipe; entrance or exit) are kept, and the rest
 * go in the report.
 */

const EFFECTS: Record<number, AnimationEffect> = { 1: 'appear', 10: 'fade', 2: 'fly', 53: 'zoom', 22: 'wipe' };
const DIRECTIONS: Record<number, AnimationDirection> = { 1: 'top', 2: 'right', 4: 'bottom', 8: 'left' };
const TRIGGERS = { clickEffect: 'onClick', withEffect: 'withPrevious', afterEffect: 'afterPrevious' } as const;

export function parseTiming(timing: Element, shapes: Map<string, string[]>, report: ReportBuilder, slideNo: number): Map<string, ElementAnimation> {
  const byParagraph = new Set(
    descendants(timing, 'bldP')
      .filter((b) => attr(b, 'build') === 'p')
      .map((b) => attr(b, 'spid') ?? ''),
  );

  const result = new Map<string, ElementAnimation>();
  const seenTargets = new Set<string>();
  let order = 0;

  for (const node of descendants(timing, 'cTn')) {
    const presetId = numAttr(node, 'presetID');
    const nodeType = attr(node, 'nodeType') as keyof typeof TRIGGERS | undefined;
    if (presetId === undefined || !nodeType || !(nodeType in TRIGGERS)) continue;

    const phase = attr(node, 'presetClass');
    const effect = EFFECTS[presetId];
    if ((phase !== 'entr' && phase !== 'exit') || !effect) {
      report.dropped('Animation effects without an equivalent', slideNo, 'only appear, fade, fly in, zoom and wipe are kept');
      continue;
    }

    const target = descendants(node, 'spTgt')[0];
    const spid = attr(target, 'spid');
    const ids = spid ? shapes.get(spid) : undefined;
    if (!spid || !ids || ids.length === 0) continue;
    const paragraphBuild = !!child(target, 'txEl') || byParagraph.has(spid);
    // Later paragraphs of a box built one at a time are the same animation.
    const targetKey = `${spid}:${phase}`;
    if (paragraphBuild && seenTargets.has(targetKey)) continue;
    seenTargets.add(targetKey);

    const delay = numAttr(child(child(node, 'stCondLst'), 'cond'), 'delay');
    const durations = descendants(node, 'cTn').map((n) => numAttr(n, 'dur') ?? 0).filter((d) => d > 1);

    ids.forEach((id, index) => {
      const animation: ElementAnimation = {
        effect,
        trigger: index === 0 ? TRIGGERS[nodeType] : 'withPrevious',
        order: order++,
        ...(phase === 'exit' ? { phase: 'exit' as const } : {}),
        ...((effect === 'fly' || effect === 'wipe') && DIRECTIONS[numAttr(node, 'presetSubtype') ?? 0] ? { direction: DIRECTIONS[numAttr(node, 'presetSubtype') ?? 0] } : {}),
        ...(delay && delay > 0 ? { delayMs: Math.min(Math.round(delay), MAX_ANIMATION_DELAY_MS) } : {}),
        ...(effect !== 'appear' && durations.length ? { durationMs: Math.min(Math.round(Math.max(...durations)), MAX_ANIMATION_MS) } : {}),
        ...(paragraphBuild && ids.length === 1 ? { byParagraph: true } : {}),
      };
      // An element animated twice keeps its first animation: the model has one per element.
      if (result.has(id)) {
        report.dropped('Elements with more than one animation', slideNo, 'only the first is kept');
        return;
      }
      result.set(id, animation);
    });
  }
  // Dropped duplicates leave gaps in the numbering; the model counts 0 to n-1.
  [...result.values()].sort((a, b) => a.order - b.order).forEach((animation, index) => (animation.order = index));
  return result;
}
