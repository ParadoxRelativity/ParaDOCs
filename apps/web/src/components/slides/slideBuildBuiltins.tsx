import { useEffect, useState } from 'react';
import {
  ANIMATION_DIRECTIONS,
  ANIMATION_EFFECTS,
  ANIMATION_EFFECT_LABELS,
  ANIMATION_TRIGGERS,
  ANIMATION_TRIGGER_LABELS,
  DEFAULT_ANIMATION_MS,
  animatedElements,
  buildElementLabel,
  readAnimation,
  slideBuildSteps,
  supportsParagraphBuild,
  type AnimationDirection,
  type AnimationEffect,
  type AnimationTrigger,
  type ElementAnimation,
} from '@paradocs/shared';
import { Button } from '../ui';
import SlideView from './SlideView';
import { registerSlideInspectorSection, type SlideEditorContext } from './slideExtensions';
import { SlideShowStepContext, registerSlideShowSteps } from './slideShowExtensions';

/**
 * Element build animations (PARA-100): the slideshow presses through a slide's
 * build steps before leaving it, and the inspector's Animation section edits
 * the effect, trigger and order of the selected elements, with a preview.
 * How a step is drawn lives in SlideBuild.tsx, at the element wrapper.
 */

registerSlideShowSteps('builds', slideBuildSteps);

const PREVIEW_STEP_MS = 1100;
const PREVIEW_WIDTH = 240;
const FIELD = 'w-32 rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-1 py-1 text-xs';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center justify-between gap-2">
      <span className="text-xs text-[var(--color-muted)]">{label}</span>
      {children}
    </label>
  );
}

/** The selected slide played from its first build step, in a small window. */
function Preview({ ctx }: { ctx: SlideEditorContext }) {
  const { slide } = ctx;
  const [run, setRun] = useState(0);
  const [step, setStep] = useState(Number.POSITIVE_INFINITY);
  const steps = slide ? slideBuildSteps(slide) : 0;

  useEffect(() => {
    if (run === 0) return;
    setStep(0);
    let at = 0;
    const timer = window.setInterval(() => {
      at += 1;
      if (at > steps) {
        window.clearInterval(timer);
        // Left fully built, as the slide is when going back to it.
        window.setTimeout(() => setStep(Number.POSITIVE_INFINITY), PREVIEW_STEP_MS);
      } else setStep(at);
    }, PREVIEW_STEP_MS);
    return () => window.clearInterval(timer);
  }, [run, steps]);

  if (!slide || steps === 0) return null;
  const size = { width: ctx.center.x * 2, height: ctx.center.y * 2 };
  return (
    <div className="space-y-2">
      <div className="overflow-hidden rounded border border-[var(--color-line)]">
        <SlideShowStepContext.Provider value={{ slideId: slide.id, step }}>
          <SlideView key={run} slide={slide} size={size} theme={ctx.theme} width={PREVIEW_WIDTH} />
        </SlideShowStepContext.Provider>
      </div>
      <Button onClick={() => setRun((n) => n + 1)}>Preview</Button>
    </div>
  );
}

function AnimationSection({ ctx }: { ctx: SlideEditorContext }) {
  const { slide, selection, canEdit, actions } = ctx;
  if (!slide) return null;

  const ids = selection.map((e) => e.id);
  const current = selection.length ? readAnimation((selection[0] as { animation?: unknown }).animation) : null;
  const set = (change: Partial<Omit<ElementAnimation, 'order'>> | null) => actions.setAnimation(slide.id, ids, change);
  const animated = animatedElements(slide.elements);
  const canParagraph = selection.length > 0 && selection.every(supportsParagraphBuild);

  return (
    <section className="space-y-2 text-sm">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">Animation</h3>

      {selection.length > 0 &&
        (current ? (
          <div className="space-y-2">
            <Row label="Effect">
              <select
                aria-label="Animation effect"
                value={current.effect}
                disabled={!canEdit}
                onChange={(e) => set({ effect: e.target.value as AnimationEffect })}
                className={FIELD}
              >
                {ANIMATION_EFFECTS.map((effect) => (
                  <option key={effect} value={effect}>
                    {ANIMATION_EFFECT_LABELS[effect]}
                  </option>
                ))}
              </select>
            </Row>
            <Row label="Type">
              <select
                aria-label="Animation type"
                value={current.phase ?? 'entrance'}
                disabled={!canEdit}
                onChange={(e) => set({ phase: e.target.value === 'exit' ? 'exit' : undefined })}
                className={FIELD}
              >
                <option value="entrance">Entrance</option>
                <option value="exit">Exit</option>
              </select>
            </Row>
            {(current.effect === 'fly' || current.effect === 'wipe') && (
              <Row label="From">
                <select
                  aria-label="Animation direction"
                  value={current.direction ?? 'left'}
                  disabled={!canEdit}
                  onChange={(e) => set({ direction: e.target.value as AnimationDirection })}
                  className={FIELD}
                >
                  {ANIMATION_DIRECTIONS.map((d) => (
                    <option key={d} value={d}>
                      {d[0].toUpperCase() + d.slice(1)}
                    </option>
                  ))}
                </select>
              </Row>
            )}
            <Row label="Start">
              <select
                aria-label="Animation start"
                value={current.trigger}
                disabled={!canEdit}
                onChange={(e) => set({ trigger: e.target.value as AnimationTrigger })}
                className={FIELD}
              >
                {ANIMATION_TRIGGERS.map((t) => (
                  <option key={t} value={t}>
                    {ANIMATION_TRIGGER_LABELS[t]}
                  </option>
                ))}
              </select>
            </Row>
            {current.effect !== 'appear' && (
              <Row label="Duration (s)">
                <input
                  type="number"
                  aria-label="Animation duration in seconds"
                  min={0}
                  max={10}
                  step={0.1}
                  disabled={!canEdit}
                  value={((current.durationMs ?? DEFAULT_ANIMATION_MS) / 1000).toString()}
                  onChange={(e) => {
                    const seconds = Number(e.target.value);
                    if (Number.isFinite(seconds)) set({ durationMs: Math.round(Math.min(Math.max(seconds, 0), 10) * 1000) });
                  }}
                  className={FIELD}
                />
              </Row>
            )}
            <Row label="Delay (s)">
              <input
                type="number"
                aria-label="Animation delay in seconds"
                min={0}
                max={30}
                step={0.1}
                disabled={!canEdit}
                value={((current.delayMs ?? 0) / 1000).toString()}
                onChange={(e) => {
                  const seconds = Number(e.target.value);
                  if (Number.isFinite(seconds)) set({ delayMs: Math.round(Math.min(Math.max(seconds, 0), 30) * 1000) });
                }}
                className={FIELD}
              />
            </Row>
            {canParagraph && (
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={current.byParagraph === true}
                  disabled={!canEdit}
                  onChange={(e) => set({ byParagraph: e.target.checked ? true : undefined })}
                />
                By paragraph
              </label>
            )}
            {canEdit && <Button onClick={() => set(null)}>Remove animation</Button>}
          </div>
        ) : (
          canEdit && <Button onClick={() => set({})}>Add animation</Button>
        ))}

      {animated.length > 0 ? (
        <ol aria-label="Animation order" className="space-y-1">
          {animated.map(({ element, animation }, index) => (
            <li
              key={element.id}
              className="flex items-center gap-1 rounded-md border border-[var(--color-line)] px-2 py-1 text-xs data-[selected=true]:bg-[var(--color-hover)]"
              data-selected={ids.includes(element.id)}
            >
              <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => ctx.select([element.id])} title={buildElementLabel(element)}>
                <span className="tabular-nums text-[var(--color-muted)]">{index + 1}. </span>
                {buildElementLabel(element)}
                <span className="text-[var(--color-muted)]">
                  {' '}
                  · {animation.phase === 'exit' ? 'Exit ' : ''}
                  {ANIMATION_EFFECT_LABELS[animation.effect]}, {ANIMATION_TRIGGER_LABELS[animation.trigger].toLowerCase()}
                </span>
              </button>
              {canEdit && (
                <>
                  <button
                    type="button"
                    aria-label="Move animation earlier"
                    disabled={index === 0}
                    onClick={() => actions.moveAnimation(slide.id, element.id, index - 1)}
                    className="grid h-8 w-8 place-items-center rounded hover:bg-[var(--color-hover)] disabled:opacity-30"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label="Move animation later"
                    disabled={index === animated.length - 1}
                    onClick={() => actions.moveAnimation(slide.id, element.id, index + 1)}
                    className="grid h-8 w-8 place-items-center rounded hover:bg-[var(--color-hover)] disabled:opacity-30"
                  >
                    ↓
                  </button>
                </>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-xs text-[var(--color-muted)]">Select an element to animate it. Elements build in the order listed here.</p>
      )}

      <Preview ctx={ctx} />
    </section>
  );
}

registerSlideInspectorSection({
  id: 'animation',
  order: 60,
  applies: () => true,
  render: (ctx) => <AnimationSection ctx={ctx} />,
});
