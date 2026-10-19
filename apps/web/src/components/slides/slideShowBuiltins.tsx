import {
  DEFAULT_TRANSITION_MS,
  SLIDE_TRANSITION_KINDS,
  SLIDE_TRANSITION_LABELS,
  type SlideTransitionKind,
} from '@paradocs/shared';
import { Button } from '../ui';
import { registerSlideInspectorSection, registerSlideToolbarAction, type SlideEditorContext } from './slideExtensions';

/**
 * What the editor offers around the slideshow: the Present buttons (which
 * viewers see too, as presenting changes nothing) and the slide's transition.
 */

registerSlideToolbarAction({
  id: 'present',
  label: 'Present from the first slide',
  icon: 'play-fill',
  order: 900,
  viewers: true,
  run: (ctx) => ctx.present('start'),
});
registerSlideToolbarAction({
  id: 'present-current',
  label: 'Present from this slide',
  icon: 'play-circle',
  order: 901,
  viewers: true,
  run: (ctx) => ctx.present('current'),
});

function TransitionSection({ ctx }: { ctx: SlideEditorContext }) {
  const { slide, canEdit, actions, slides } = ctx;
  if (!slide) return null;
  const { kind, durationMs } = slide.transition;
  const set = (next: { kind: SlideTransitionKind; durationMs?: number }, ids = [slide.id]) => actions.setTransition(ids, next);

  return (
    <section className="space-y-2 text-sm">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">Transition</h3>
      <label className="flex items-center justify-between gap-2">
        <span className="text-xs text-[var(--color-muted)]">Effect</span>
        <select
          aria-label="Transition effect"
          value={kind}
          disabled={!canEdit}
          onChange={(e) => set({ kind: e.target.value as SlideTransitionKind, durationMs })}
          className="w-28 rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-1 py-1 text-xs"
        >
          {SLIDE_TRANSITION_KINDS.map((k) => (
            <option key={k} value={k}>
              {SLIDE_TRANSITION_LABELS[k]}
            </option>
          ))}
        </select>
      </label>
      {kind !== 'none' && (
        <label className="flex items-center justify-between gap-2">
          <span className="text-xs text-[var(--color-muted)]">Duration (s)</span>
          <input
            type="number"
            aria-label="Transition duration in seconds"
            min={0}
            max={3}
            step={0.1}
            disabled={!canEdit}
            value={((durationMs ?? DEFAULT_TRANSITION_MS) / 1000).toString()}
            onChange={(e) => {
              const seconds = Number(e.target.value);
              if (Number.isFinite(seconds)) set({ kind, durationMs: Math.round(Math.min(Math.max(seconds, 0), 3) * 1000) });
            }}
            className="w-28 rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-1 py-1 text-xs"
          />
        </label>
      )}
      {canEdit && slides.length > 1 && (
        <Button onClick={() => set(slide.transition, slides.map((s) => s.id))}>Apply to all slides</Button>
      )}
    </section>
  );
}

registerSlideInspectorSection({
  id: 'transition',
  order: 50,
  applies: (_ctx, scope) => scope === 'slide',
  render: (ctx) => <TransitionSection ctx={ctx} />,
});
