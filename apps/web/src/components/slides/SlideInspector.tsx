import { useEffect, useState, type ReactNode } from 'react';
import { resolveSlideColor, type ZOrder } from '@paradocs/shared';
import type { Alignment } from '../../lib/canvasArrange';
import { cx } from '../../lib/util';
import { Button, IconButton } from '../ui';
import Icon, { type IconName } from '../Icon';
import { slideInspectorSections, type SlideEditorContext } from './slideExtensions';

export interface InspectorHandlers {
  onAlign: (alignment: Alignment) => void;
  onDistribute: (axis: 'x' | 'y') => void;
  onArrange: (how: ZOrder) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

const ALIGNMENTS: { id: Alignment; label: string; icon: IconName }[] = [
  { id: 'left', label: 'Align left', icon: 'align-start' },
  { id: 'centerX', label: 'Align center', icon: 'align-center' },
  { id: 'right', label: 'Align right', icon: 'align-end' },
  { id: 'top', label: 'Align top', icon: 'align-top' },
  { id: 'centerY', label: 'Align middle', icon: 'align-middle' },
  { id: 'bottom', label: 'Align bottom', icon: 'align-bottom' },
];

/**
 * The right-hand panel for the selected slide, or for the selected elements.
 * Type-specific controls come from registered sections, so rich text, tables
 * and images add their own without this file knowing them.
 */
export default function SlideInspector({ ctx, handlers }: { ctx: SlideEditorContext; handlers: InspectorHandlers }) {
  const { selection, slide, canEdit, actions, theme } = ctx;
  const scope = selection.length > 0 ? 'elements' : 'slide';
  const extra = slideInspectorSections().filter((section) => section.applies(ctx, scope));

  if (!slide) return null;

  const patch = (changes: Record<string, unknown>) =>
    actions.updateElements(slide.id, selection.map((element) => ({ id: element.id, patch: changes })));
  const first = selection[0];
  const single = selection.length === 1 ? first : undefined;
  const hasFill = selection.some((el) => el.type === 'shape');
  const hasText = selection.some((el) => el.type === 'text');

  return (
    <div className="scroll-thin h-full w-full space-y-4 overflow-y-auto p-3 text-sm">
      {scope === 'slide' ? (
        <Section title="Slide">
          <Row label="Background">
            <ColorField
              value={slide.background?.kind === 'color' ? slide.background.color : undefined}
              fallback={resolveSlideColor('theme:light1', theme) ?? '#ffffff'}
              disabled={!canEdit}
              onChange={(color) => actions.setBackground(slide.id, color ? { kind: 'color', color } : null)}
              clearable={slide.background !== null}
            />
          </Row>
        </Section>
      ) : (
        <>
          <Section title={single ? 'Position and size' : `${selection.length} elements`}>
            {single && (
              <div className="grid grid-cols-2 gap-2">
                {(['x', 'y', 'width', 'height'] as const).map((key) => (
                  <NumberField
                    key={key}
                    label={key === 'x' ? 'X' : key === 'y' ? 'Y' : key === 'width' ? 'W' : 'H'}
                    value={single[key]}
                    min={key === 'width' || key === 'height' ? 1 : undefined}
                    disabled={!canEdit}
                    onCommit={(value) => patch({ [key]: value })}
                  />
                ))}
                <NumberField
                  label="Rotate"
                  value={single.rotation ?? 0}
                  suffix="deg"
                  disabled={!canEdit}
                  onCommit={(value) => patch({ rotation: value % 360 === 0 ? undefined : ((value % 360) + 360) % 360 })}
                />
              </div>
            )}
          </Section>

          {canEdit && (
            <>
              <Section title="Arrange">
                <div className="flex flex-wrap gap-1">
                  <IconButton label="Bring to front" onClick={() => handlers.onArrange('front')}>
                    <Icon name="chevron-bar-up" />
                  </IconButton>
                  <IconButton label="Bring forward" onClick={() => handlers.onArrange('forward')}>
                    <Icon name="chevron-up" />
                  </IconButton>
                  <IconButton label="Send backward" onClick={() => handlers.onArrange('backward')}>
                    <Icon name="chevron-down" />
                  </IconButton>
                  <IconButton label="Send to back" onClick={() => handlers.onArrange('back')}>
                    <Icon name="chevron-bar-down" />
                  </IconButton>
                </div>
              </Section>
              <Section title={selection.length > 1 ? 'Align' : 'Align to slide'}>
                <div className="flex flex-wrap gap-1">
                  {ALIGNMENTS.map((a) => (
                    <IconButton key={a.id} label={a.label} onClick={() => handlers.onAlign(a.id)}>
                      <Icon name={a.icon} />
                    </IconButton>
                  ))}
                </div>
                {selection.length > 2 && (
                  <div className="mt-1 flex gap-1">
                    <Button variant="subtle" className="!px-2 !py-1 text-xs" onClick={() => handlers.onDistribute('x')}>
                      Distribute horizontally
                    </Button>
                    <Button variant="subtle" className="!px-2 !py-1 text-xs" onClick={() => handlers.onDistribute('y')}>
                      Distribute vertically
                    </Button>
                  </div>
                )}
              </Section>
              {(hasFill || hasText) && (
                <Section title="Style">
                  {hasFill && (
                    <>
                      <Row label="Fill">
                        <ColorField
                          value={(first as { fill?: string }).fill === 'transparent' ? undefined : (first as { fill?: string }).fill}
                          fallback="#ffffff"
                          clearable
                          clearLabel="No fill"
                          onChange={(color) => patch({ fill: color ?? 'transparent' })}
                        />
                      </Row>
                      <Row label="Outline">
                        <ColorField
                          value={(first as { stroke?: string }).stroke}
                          fallback="#8f8f9c"
                          clearable
                          onChange={(color) => patch({ stroke: color })}
                        />
                      </Row>
                    </>
                  )}
                  {hasText && (
                    <>
                      <Row label="Color">
                        <ColorField value={first.color} fallback="#111827" onChange={(color) => patch({ color })} clearable />
                      </Row>
                      <NumberField
                        label="Size"
                        value={(first as { fontSize?: number }).fontSize ?? 48}
                        min={6}
                        suffix="px"
                        onCommit={(value) => patch({ fontSize: value })}
                      />
                    </>
                  )}
                </Section>
              )}
              <div className="flex gap-1">
                <Button variant="subtle" onClick={handlers.onDuplicate}>
                  <Icon name="copy" /> Duplicate
                </Button>
                <Button variant="danger" onClick={handlers.onDelete}>
                  <Icon name="trash" /> Delete
                </Button>
              </div>
            </>
          )}
        </>
      )}

      {extra.map((section) => (
        <div key={section.id}>{section.render(ctx)}</div>
      ))}
    </div>
  );
}

function Section({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[var(--color-muted)]">{label}</span>
      {children}
    </div>
  );
}

/** A number edited as text and applied when committed, so a half-typed value never reaches collaborators. */
function NumberField({
  label,
  value,
  min,
  suffix,
  disabled,
  onCommit,
}: {
  label: string;
  value: number;
  min?: number;
  suffix?: string;
  disabled?: boolean;
  onCommit: (value: number) => void;
}) {
  const shown = String(Math.round(value * 100) / 100);
  const [draft, setDraft] = useState(shown);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(shown);
  }, [shown, focused]);

  const commit = () => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed) || draft.trim() === '') return setDraft(shown);
    const next = min !== undefined ? Math.max(min, parsed) : parsed;
    if (next !== value) onCommit(next);
    setDraft(String(next));
  };

  return (
    <label className="flex items-center gap-1.5">
      <span className="w-9 shrink-0 text-xs text-[var(--color-muted)]">{label}</span>
      <input
        inputMode="decimal"
        value={draft}
        disabled={disabled}
        onFocus={(e) => {
          setFocused(true);
          e.currentTarget.select();
        }}
        onBlur={() => {
          setFocused(false);
          commit();
        }}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            setDraft(shown);
            e.currentTarget.blur();
          }
          e.stopPropagation();
        }}
        className="min-w-0 flex-1 rounded border border-[var(--color-line)] bg-[var(--color-canvas)] px-1.5 py-1 text-xs tabular-nums outline-none focus:border-[var(--color-accent)]"
      />
      {suffix && <span className="text-xs text-[var(--color-muted)]">{suffix}</span>}
    </label>
  );
}

function ColorField({
  value,
  fallback,
  disabled,
  clearable,
  clearLabel = 'Reset',
  onChange,
}: {
  value: string | undefined;
  fallback: string;
  disabled?: boolean;
  clearable?: boolean;
  clearLabel?: string;
  onChange: (color: string | undefined) => void;
}) {
  // A theme slot is not a hex color the picker can show; it stays until something else is chosen.
  const hex = value && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
  return (
    <span className="flex items-center gap-1.5">
      <input
        type="color"
        value={hex}
        disabled={disabled}
        aria-label="Color"
        onChange={(e) => onChange(e.target.value)}
        className={cx('h-6 w-9 cursor-pointer rounded border border-[var(--color-line)] bg-transparent p-0')}
      />
      {clearable && value !== undefined && !disabled && (
        <button type="button" className="text-xs text-[var(--color-muted)] hover:text-[var(--color-ink)]" onClick={() => onChange(undefined)}>
          {clearLabel}
        </button>
      )}
    </span>
  );
}
