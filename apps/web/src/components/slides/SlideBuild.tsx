import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { animationKeyframes, elementBuildUnits, unitShown, type BuildPlan, type SlideElement } from '@paradocs/shared';
import { useSlideShowStep } from './slideShowExtensions';

/**
 * The wrapper every element of a read-only slide sits in. In the slideshow it
 * applies build animations (PARA-100) at this level rather than inside each
 * renderer, so they work for every element type, including ones registered
 * later. Anywhere else (thumbnails, the editor's stage, the leaving slide of a
 * transition) the step is infinity and the element is simply drawn.
 */

const PLACEHOLDER_LINE = ' ';
const BLOCKS = 'p, li, h1, h2, h3, h4, h5, h6';

export function BuildBox({
  element,
  plan,
  style,
  children,
}: {
  element: SlideElement;
  plan: BuildPlan;
  style: CSSProperties;
  children: (element: SlideElement) => ReactNode;
}) {
  const { step } = useSlideShowStep();
  const units = useMemo(() => elementBuildUnits(plan, element.id), [plan, element.id]);
  if (units.length === 0 || !Number.isFinite(step)) {
    return (
      <div className="absolute" style={style}>
        {children(element)}
      </div>
    );
  }
  return (
    <LiveBuildBox element={element} units={units} step={step} style={style}>
      {children}
    </LiveBuildBox>
  );
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/** Blocks that hold text and no further blocks: the paragraphs and list items of a rich text body. */
function leafBlocks(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(BLOCKS)].filter((el) => !el.querySelector(BLOCKS));
}

function LiveBuildBox({
  element,
  units,
  step,
  style,
  children,
}: {
  element: SlideElement;
  units: ReturnType<typeof elementBuildUnits>;
  step: number;
  style: CSSProperties;
  children: (element: SlideElement) => ReactNode;
}) {
  const inner = useRef<HTMLDivElement>(null);
  const before = useRef<{ step: number; flags: boolean[] } | null>(null);
  // Units that have just left but are still playing their exit, so they stay drawn until it finishes.
  const [exiting, setExiting] = useState<number[]>([]);

  const byParagraph = units[0].paragraph !== null;
  const flags = units.map((unit) => unitShown(unit, step));
  const shown = flags.map((on, i) => on || exiting.includes(i));
  const flagsKey = flags.join();

  // Plain text and shapes keep their lines in one string: hidden lines become blanks so the box does not reflow as it builds.
  const visible = useMemo(() => {
    if (!byParagraph || element.type === 'richText') return element;
    const lines = ((element as { text?: string }).text ?? '').split('\n');
    return { ...element, text: lines.map((line, i) => (shown[i] ?? true ? line : PLACEHOLDER_LINE)).join('\n') } as SlideElement;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [element, byParagraph, shown.join()]);

  const targets = (): (HTMLElement | null)[] => {
    const root = inner.current;
    if (!root) return [];
    if (!byParagraph) return [root];
    // A rich text body is drawn by its own renderer: its blocks are found by what they are, and only trusted when they match the plan.
    if (element.type !== 'richText') return [];
    const blocks = leafBlocks(root);
    return blocks.length === units.length ? blocks : [];
  };

  // Every render: hide what is not built yet. (A renderer may redraw its DOM at any time, so this cannot be done once.)
  useLayoutEffect(() => {
    if (!byParagraph) return;
    targets().forEach((block, i) => {
      if (block) block.style.visibility = shown[i] ? '' : 'hidden';
    });
  });

  useLayoutEffect(() => {
    const previous = before.current;
    before.current = { step, flags };
    const nodes = targets();
    // A new run supersedes whatever was still playing: going back un-builds at once.
    for (const node of nodes) node?.getAnimations?.().forEach((a) => a.cancel());
    setExiting((now) => (now.length ? [] : now));
    // Respecting reduced motion: elements still build in and out, but as a plain appear.
    if (prefersReducedMotion()) return;
    const forward = !!previous && step > previous.step;
    units.forEach((unit, i) => {
      const node = nodes[i];
      if (!node?.animate) return;
      const entering = flags[i] && (previous ? !previous.flags[i] && forward : unit.step === 0 && step === 0);
      const leaving = !flags[i] && !!previous && previous.flags[i] && forward;
      if (!entering && !leaving) return;
      const animation = node.animate(animationKeyframes(unit.animation), {
        duration: Math.max(unit.durationMs, 1),
        delay: unit.startMs,
        easing: 'ease-out',
        fill: 'both',
      });
      if (leaving) {
        setExiting((now) => [...now, i]);
        const done = () => setExiting((now) => now.filter((x) => x !== i));
        animation.finished.then(done, () => {});
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, flagsKey]);

  return (
    <div className="absolute" style={style}>
      <div ref={inner} style={{ width: '100%', height: '100%', visibility: byParagraph || shown[0] ? undefined : 'hidden' }}>
        {children(visible)}
      </div>
    </div>
  );
}
