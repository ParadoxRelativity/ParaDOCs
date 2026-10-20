import { useRef, useSyncExternalStore } from 'react';
import { PLACEHOLDER_KIND_LABELS, resetPlaceholder, type RichTextElement, type SlideImageElement } from '@paradocs/shared';
import { uploadPicture } from './BackgroundEditor';
import { Button } from '../ui';
import BackgroundEditor from './BackgroundEditor';
import { Group } from './inspectorParts';
import LayoutEditor from './LayoutEditor';
import SlideDesignDialog from './SlideDesignDialog';
import { registerSlideInspectorSection, registerSlideToolbarAction, type SlideEditorContext } from './slideExtensions';

/**
 * Themes, layouts and masters (PARA-91), plugged into the editor through the
 * registries in slideExtensions.tsx: a Design button in the toolbar, a Layout
 * and Background block in the slide inspector, and a Placeholder block when a
 * box that fills a layout placeholder is selected. The two windows (Design,
 * Edit layouts) are drawn by `SlideDesignHost`, which the editor mounts once.
 */

type View = 'design' | 'layouts' | null;
let view: View = null;
const listeners = new Set<() => void>();

export function openSlideDesign(next: View) {
  view = next;
  listeners.forEach((l) => l());
}

function useView(): View {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => view,
  );
}

export function SlideDesignHost({ ctx }: { ctx: SlideEditorContext }) {
  const current = useView();
  if (current === 'design') return <SlideDesignDialog ctx={ctx} onClose={() => openSlideDesign(null)} onEditLayouts={() => openSlideDesign('layouts')} />;
  if (current === 'layouts') return <LayoutEditor ctx={ctx} onClose={() => openSlideDesign(null)} />;
  return null;
}

registerSlideToolbarAction({
  id: 'design',
  label: 'Design: theme, layouts, footer',
  icon: 'palette',
  order: 80,
  run: () => openSlideDesign('design'),
});


function SlideDesignSection({ ctx }: { ctx: SlideEditorContext }) {
  const { slide, canEdit, actions, theme } = ctx;
  if (!slide) return null;
  const layouts = ctx.deck.layouts;
  const placeholderIds = slide.elements.filter((el) => (el as RichTextElement).placeholder);
  return (
    <>
      <Group title="Layout">
        <select
          aria-label="Slide layout"
          value={slide.layoutId}
          disabled={!canEdit}
          onChange={(e) => actions.setLayout(slide.id, e.target.value)}
          className="w-full rounded border border-[var(--color-line)] bg-[var(--color-canvas)] px-1.5 py-1.5 text-sm"
        >
          {!layouts.some((l) => l.id === slide.layoutId) && <option value={slide.layoutId}>{slide.layoutId}</option>}
          {layouts.map((layout) => (
            <option key={layout.id} value={layout.id}>
              {layout.name}
            </option>
          ))}
        </select>
        <div className="flex flex-wrap gap-1">
          {canEdit && placeholderIds.length > 0 && (
            <Button
              variant="subtle"
              className="!px-2 !py-1 text-xs"
              onClick={() => actions.edit((doc) => placeholderIds.forEach((el) => resetPlaceholder(doc, slide.id, el.id)))}
            >
              Reset placeholders
            </Button>
          )}
          <Button variant="subtle" className="!px-2 !py-1 text-xs" onClick={() => openSlideDesign('layouts')}>
            Edit layouts
          </Button>
        </div>
      </Group>
      <Group title="Background">
        <BackgroundEditor
          value={slide.background}
          theme={theme}
          disabled={!canEdit}
          inheritLabel="Same as layout"
          onChange={(background) => actions.setBackground(slide.id, background)}
          upload={uploadPicture(ctx)}
        />
      </Group>
      <Button variant="subtle" className="w-full text-xs" onClick={() => openSlideDesign('design')}>
        <i aria-hidden className="bi bi-palette" /> Theme, footer and slide numbers
      </Button>
    </>
  );
}

registerSlideInspectorSection({
  id: 'slide-design',
  order: 5,
  applies: (_ctx, scope) => scope === 'slide',
  render: (ctx) => <SlideDesignSection ctx={ctx} />,
});

function PlaceholderSection({ ctx }: { ctx: SlideEditorContext }) {
  const { slide, selection, canEdit, actions } = ctx;
  const file = useRef<HTMLInputElement>(null);
  const element = selection[0] as (RichTextElement | SlideImageElement) | undefined;
  if (!slide || !element?.placeholder) return null;
  const empty = element.type === 'image' && !element.url;
  const choose = async (picked: File) => {
    try {
      const url = await uploadPicture(ctx)(picked);
      actions.updateElements(slide.id, [{ id: element.id, patch: { url, alt: picked.name.replace(/\.[^.]+$/, '') } }]);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Could not upload that picture.');
    }
  };
  return (
    <Group title={`Placeholder: ${PLACEHOLDER_KIND_LABELS[element.placeholderKind ?? 'body']}`}>
      <p className="text-xs text-[var(--color-muted)]">Takes its position and text style from the layout until you change them here.</p>
      <div className="flex flex-wrap gap-1">
        {empty && (
          <Button variant="primary" className="!px-2 !py-1 text-xs" disabled={!canEdit} onClick={() => file.current?.click()}>
            Choose picture
          </Button>
        )}
        <Button variant="subtle" className="!px-2 !py-1 text-xs" disabled={!canEdit} onClick={() => actions.edit((doc) => resetPlaceholder(doc, slide.id, element.id))}>
          Reset to layout
        </Button>
      </div>
      <input
        ref={file}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const picked = e.target.files?.[0];
          e.target.value = '';
          if (picked) void choose(picked);
        }}
      />
    </Group>
  );
}

registerSlideInspectorSection({
  id: 'placeholder',
  order: 4,
  applies: (ctx, scope) => scope === 'elements' && ctx.selection.length === 1 && Boolean((ctx.selection[0] as RichTextElement).placeholder),
  render: (ctx) => <PlaceholderSection ctx={ctx} />,
});
