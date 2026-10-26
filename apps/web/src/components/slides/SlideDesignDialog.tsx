import { useState, type ReactNode } from 'react';
import {
  SLIDE_FONTS,
  STARTER_THEMES,
  THEME_COLOR_SLOTS,
  applyStarterTheme,
  applyTemplate,
  resolveSlideColor,
  updateTheme,
  writeDeckSettings,
  type DeckSettings,
  type PresentationTemplateSummary,
} from '@paradocs/shared';
import { usePresentationTemplateActions, usePresentationTemplates, useWorkspaces } from '../../api/hooks';
import { useIsMobile } from '../../lib/mobile';
import { canFrom } from '../../lib/permissions';
import { cx } from '../../lib/util';
import Icon from '../Icon';
import { useToast } from '../Toast';
import { Button } from '../ui';
import { Modal } from '../Modal';
import { TemplateGrid } from './PresentationTemplates';
import BackgroundEditor, { SLOT_LABELS, uploadPicture } from './BackgroundEditor';
import { ColorInput, Field, SelectInput } from './inspectorParts';
import type { SlideEditorContext } from './slideExtensions';
import { backgroundStyle } from './SlideView';

type Tab = 'slide' | 'theme' | 'footer';

const TABS: { id: Tab; label: string }[] = [
  { id: 'slide', label: 'This slide' },
  { id: 'theme', label: 'Theme' },
  { id: 'footer', label: 'Footer' },
];

/**
 * The deck's look in one window: pick a layout and background for the current
 * slide, switch or tune the theme, and turn the footer, slide number and date
 * on. A full-screen sheet on a phone, with controls sized for touch.
 */
/** The template windows the Design window opens in its place, coming back to it when they close. */
export type TemplateView = 'saveTemplate' | 'importTemplate' | 'manageTemplates';

export default function SlideDesignDialog({
  ctx,
  onClose,
  onEditLayouts,
  onOpen,
}: {
  ctx: SlideEditorContext;
  onClose: () => void;
  onEditLayouts: () => void;
  onOpen: (view: TemplateView) => void;
}) {
  const mobile = useIsMobile();
  const [tab, setTab] = useState<Tab>('theme');
  return (
    <Modal
      title="Design"
      onClose={onClose}
      wide
      fullScreen={mobile}
      footer={
        <>
          {ctx.canEdit && (
            <Button variant="subtle" onClick={onEditLayouts}>
              Edit layouts
            </Button>
          )}
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <div role="tablist" aria-label="Design sections" className="mb-3 flex gap-1 border-b border-[var(--color-line)]">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cx(
              '-mb-px border-b-2 px-3 py-2 text-sm',
              tab === t.id ? 'border-[var(--color-accent)] font-medium text-[var(--color-ink)]' : 'border-transparent text-[var(--color-muted)]',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className={cx('scroll-thin space-y-4 overflow-y-auto text-sm', mobile ? 'min-h-0 flex-1' : 'max-h-[60vh]')}>
        {tab === 'slide' && <SlideTab ctx={ctx} />}
        {tab === 'theme' && <ThemeTab ctx={ctx} onOpen={onOpen} />}
        {tab === 'footer' && <FooterTab ctx={ctx} />}
      </div>
    </Modal>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">{title}</h3>
      {children}
    </section>
  );
}

function SlideTab({ ctx }: { ctx: SlideEditorContext }) {
  const { slide, deck, canEdit, actions, theme } = ctx;
  if (!slide) return <p className="text-[var(--color-muted)]">Open a slide to choose its layout and background.</p>;
  return (
    <>
      <Section title="Layout">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {deck.layouts.map((layout) => (
            <button
              key={layout.id}
              type="button"
              disabled={!canEdit}
              aria-pressed={slide.layoutId === layout.id}
              onClick={() => actions.setLayout(slide.id, layout.id)}
              className={cx(
                'rounded-md border px-2 py-2.5 text-left text-sm',
                slide.layoutId === layout.id ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]' : 'border-[var(--color-line)] hover:bg-[var(--color-surface)]',
              )}
            >
              <LayoutGlyph ctx={ctx} layoutId={layout.id} />
              <span className="mt-1 block truncate">{layout.name}</span>
            </button>
          ))}
        </div>
      </Section>
      <Section title="Background">
        <BackgroundEditor
          value={slide.background}
          theme={theme}
          disabled={!canEdit}
          inheritLabel="Same as layout"
          onChange={(background) => actions.setBackground(slide.id, background)}
          upload={uploadPicture(ctx)}
        />
      </Section>
    </>
  );
}

/** A layout drawn as boxes, so choosing one is by what it looks like. */
export function LayoutGlyph({ ctx, layoutId }: { ctx: SlideEditorContext; layoutId: string }) {
  const { deck } = ctx;
  const layout = deck.layouts.find((l) => l.id === layoutId);
  const { width, height } = deck.settings.size;
  const master = deck.master;
  if (!layout) return null;
  return (
    <span className="relative block w-full overflow-hidden rounded-sm border border-[var(--color-line)] bg-[var(--color-canvas)]" style={{ aspectRatio: `${width} / ${height}` }}>
      {layout.placeholders
        .filter((p) => p.kind !== 'footer' && p.kind !== 'date' && p.kind !== 'slideNumber')
        .map((p) => {
          const base = master.placeholders.find((m) => m.kind === (p.kind === 'subtitle' || p.kind === 'image' ? 'body' : p.kind));
          const x = p.x ?? base?.x ?? 0;
          const y = p.y ?? base?.y ?? 0;
          const w = p.width ?? base?.width ?? 0;
          const h = p.height ?? base?.height ?? 0;
          return (
            <span
              key={p.id}
              className={cx('absolute rounded-[1px]', p.kind === 'image' ? 'bg-[var(--color-accent)] opacity-40' : 'bg-[var(--color-muted)] opacity-40')}
              style={{ left: `${(x / width) * 100}%`, top: `${(y / height) * 100}%`, width: `${(w / width) * 100}%`, height: `${(h / height) * 100}%` }}
            />
          );
        })}
    </span>
  );
}

function ThemeTab({ ctx, onOpen }: { ctx: SlideEditorContext; onOpen: (view: TemplateView) => void }) {
  const { deck, canEdit, actions, theme } = ctx;
  const fonts = SLIDE_FONTS.map((f) => ({ value: f.family, label: f.family }));
  const update = (patch: Parameters<typeof updateTheme>[2]) => actions.edit((doc) => updateTheme(doc, theme.id, patch));
  return (
    <>
      <Section title="Starter themes">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {STARTER_THEMES.map((starter) => (
            <button
              key={starter.theme.id}
              type="button"
              disabled={!canEdit}
              aria-pressed={deck.settings.themeId === starter.theme.id}
              onClick={() => actions.edit((doc) => void applyStarterTheme(doc, starter.theme.id))}
              className={cx(
                'overflow-hidden rounded-md border text-left',
                deck.settings.themeId === starter.theme.id ? 'border-[var(--color-accent)] ring-1 ring-[var(--color-accent)]' : 'border-[var(--color-line)]',
              )}
            >
              <ThemeSwatch starter={starter} />
              <span className="block px-2 py-1.5">
                <span className="block text-sm font-medium">{starter.theme.name}</span>
                <span className="block text-xs text-[var(--color-muted)]">{starter.description}</span>
              </span>
            </button>
          ))}
        </div>
        <p className="text-xs text-[var(--color-muted)]">Changing the theme recolors everything that uses theme colors, on every slide. Colors you chose yourself stay.</p>
      </Section>
      <TemplatesSection ctx={ctx} onOpen={onOpen} />
      <Section title={`Colors: ${theme.name}`}>
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
          {THEME_COLOR_SLOTS.map((slot) => (
            <Field key={slot} label={SLOT_LABELS[slot]}>
              <ColorInput label={SLOT_LABELS[slot]} value={theme.colors[slot]} fallback={theme.colors[slot]} disabled={!canEdit} onChange={(color) => update({ colors: { [slot]: color } })} />
            </Field>
          ))}
        </div>
      </Section>
      <Section title="Fonts">
        <Field label="Headings">
          <SelectInput label="Heading font" value={theme.fonts.heading} options={fonts} disabled={!canEdit} onChange={(heading) => heading && update({ fonts: { heading } })} />
        </Field>
        <Field label="Body">
          <SelectInput label="Body font" value={theme.fonts.body} options={fonts} disabled={!canEdit} onChange={(body) => body && update({ fonts: { body } })} />
        </Field>
      </Section>
    </>
  );
}

/**
 * The workspace's saved templates: choosing one puts its theme, master and
 * layouts on this deck in one undoable step, each slide moving to the layout
 * of the same kind. The deck's own look can be saved as one from here too.
 */
function TemplatesSection({ ctx, onOpen }: { ctx: SlideEditorContext; onOpen: (view: TemplateView) => void }) {
  const { workspaceId, presentationId, canEdit, actions } = ctx;
  const templates = usePresentationTemplates(workspaceId).data ?? [];
  const templateActions = usePresentationTemplateActions(workspaceId);
  const workspaces = useWorkspaces();
  const canCreate = canFrom(workspaces.data?.find((w) => w.id === workspaceId)?.permissions)('slides.create');
  const toast = useToast();
  const [applied, setApplied] = useState<string | null>(null);

  const apply = (template: PresentationTemplateSummary) =>
    templateActions.apply.mutate(
      { presentationId, templateId: template.id },
      {
        onSuccess: (style) => {
          actions.edit((doc) => applyTemplate(doc, style));
          setApplied(template.id);
          toast(`Applied ${template.name}. Undo puts the old look back.`);
        },
        onError: (err) => toast(err instanceof Error ? err.message : 'Could not apply the template', 'error'),
      },
    );

  if (templates.length === 0 && !canCreate) return null;
  return (
    <Section title="Templates">
      <TemplateGrid workspaceId={workspaceId} selectedId={applied} disabled={!canEdit || templateActions.apply.isPending} onPick={apply} className="sm:grid-cols-3" />
      {templates.length > 0 ? (
        <p className="text-xs text-[var(--color-muted)]">A template brings its theme, master and layouts. Each slide keeps its content and moves to the layout of the same kind.</p>
      ) : (
        <p className="text-xs text-[var(--color-muted)]">No templates yet. Save this presentation&apos;s look, or import one from PowerPoint.</p>
      )}
      <div className="flex flex-wrap gap-2">
        {canCreate && (
          <>
            <Button variant="subtle" className="min-h-9 text-xs" onClick={() => onOpen('saveTemplate')}>
              <Icon name="bookmark-star" /> Save as template…
            </Button>
            <Button variant="subtle" className="min-h-9 text-xs" onClick={() => onOpen('importTemplate')}>
              <Icon name="box-arrow-in-down" /> Import a template…
            </Button>
          </>
        )}
        {templates.length > 0 && (
          <Button variant="subtle" className="min-h-9 text-xs" onClick={() => onOpen('manageTemplates')}>
            <Icon name="collection" /> Manage templates…
          </Button>
        )}
      </div>
    </Section>
  );
}

/** A theme as a little slide: its background, a heading in its heading font, and its accents. */
export function ThemeSwatch({ starter }: { starter: (typeof STARTER_THEMES)[number] }) {
  const { theme } = starter;
  const background = backgroundStyle(starter.background ?? { kind: 'color', color: 'theme:background1' }, theme);
  return (
    <span className="block px-3 pb-3 pt-4" style={background}>
      <span className="block truncate text-base font-bold" style={{ color: resolveSlideColor('theme:text1', theme), fontFamily: theme.fonts.heading }}>
        Title text
      </span>
      <span className="mt-0.5 block truncate text-xs" style={{ color: resolveSlideColor('theme:text2', theme), fontFamily: theme.fonts.body }}>
        Body text
      </span>
      <span className="mt-2 flex gap-1">
        {(['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'] as const).map((slot) => (
          <span key={slot} className="h-2.5 w-2.5 rounded-full" style={{ background: theme.colors[slot] }} />
        ))}
      </span>
    </span>
  );
}

function FooterTab({ ctx }: { ctx: SlideEditorContext }) {
  const { deck, canEdit, actions } = ctx;
  const { settings } = deck;
  const set = (patch: Partial<DeckSettings>) => actions.edit((doc) => writeDeckSettings(doc, patch));
  const toggle = (label: string, key: 'showFooter' | 'showSlideNumber' | 'showDate') => (
    <label className="flex min-h-9 items-center gap-2">
      <input type="checkbox" checked={settings[key]} disabled={!canEdit} onChange={(e) => set({ [key]: e.target.checked })} className="h-4 w-4" />
      {label}
    </label>
  );
  const text = (label: string, value: string, key: 'footerText' | 'dateText', placeholder: string) => (
    <input
      aria-label={label}
      defaultValue={value}
      key={value}
      placeholder={placeholder}
      disabled={!canEdit}
      onBlur={(e) => e.target.value !== value && set({ [key]: e.target.value })}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        e.stopPropagation();
      }}
      className="w-full rounded border border-[var(--color-line)] bg-[var(--color-canvas)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
    />
  );
  return (
    <Section title="On every slide">
      {toggle('Footer', 'showFooter')}
      {settings.showFooter && text('Footer text', settings.footerText, 'footerText', 'Footer text')}
      {toggle('Slide number', 'showSlideNumber')}
      {toggle('Date', 'showDate')}
      {settings.showDate && text('Date text', settings.dateText, 'dateText', "Leave empty for today's date")}
      <p className="text-xs text-[var(--color-muted)]">Where they appear is set by the layout; use Edit layouts to move them.</p>
    </Section>
  );
}
