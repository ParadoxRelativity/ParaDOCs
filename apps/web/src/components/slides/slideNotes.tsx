import { useRef, useState } from 'react';
import { BlockNoteSchema, defaultBlockSpecs } from '@blocknote/core';
import { withCollaboration } from '@blocknote/core/yjs';
import { BlockNoteView } from '@blocknote/mantine';
import { useCreateBlockNote } from '@blocknote/react';
import { notesFragmentName } from '@paradocs/shared';
import { useBackHandler } from '../../lib/back';
import { useIsMobile } from '../../lib/mobile';
import { useTheme } from '../../lib/theme';
import { cx, useLocalStorage } from '../../lib/util';
import Icon from '../Icon';
import SlideNotesView from './SlideNotesView';
import { registerSlidePanel, type SlideEditorContext } from './slideExtensions';

/**
 * Speaker notes under the stage: one collaborative rich text per slide, in the
 * deck's Y.Doc as the `notes:<slideId>` fragment, so collaborators see each
 * other type and the presenter view reads the same text. The pane collapses,
 * and its height is dragged (or set with the arrow keys on the handle) and
 * remembered on this device.
 *
 * Formatting is the basics: headings, bulleted, numbered and checklist
 * items, bold, italic, underline, strikethrough, code and links. People who
 * can only view read the notes without an editor mounted.
 */

const notesSchema = BlockNoteSchema.create({
  blockSpecs: {
    paragraph: defaultBlockSpecs.paragraph,
    heading: defaultBlockSpecs.heading,
    bulletListItem: defaultBlockSpecs.bulletListItem,
    numberedListItem: defaultBlockSpecs.numberedListItem,
    checkListItem: defaultBlockSpecs.checkListItem,
  },
});

const MIN_HEIGHT = 80;
const MAX_HEIGHT = 420;
const DEFAULT_HEIGHT = 140;
const clamp = (height: number) => Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(height)));

export function SlideNotesPanel({ ctx }: { ctx: SlideEditorContext }) {
  const mobile = useIsMobile();
  // A phone has little room under the stage: notes start folded there until asked for.
  const [openPref, setOpenPref] = useLocalStorage<boolean | null>('paradocs.slides.notes.open', null);
  const open = openPref ?? !mobile;
  const [height, setHeight] = useLocalStorage<number>('paradocs.slides.notes.height', DEFAULT_HEIGHT);
  const dragging = useRef<{ startY: number; startHeight: number } | null>(null);
  const slide = ctx.slide;

  // Android back folds the notes before leaving the deck.
  useBackHandler(() => setOpenPref(false), { active: mobile && open });

  if (!slide) return null;
  const paneHeight = clamp(height);

  return (
    <section aria-label="Speaker notes" className="bg-[var(--color-canvas)]">
      {open && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize speaker notes"
          aria-valuemin={MIN_HEIGHT}
          aria-valuemax={MAX_HEIGHT}
          aria-valuenow={paneHeight}
          tabIndex={0}
          className="h-1.5 cursor-row-resize touch-none bg-[var(--color-line)]/40 hover:bg-[var(--color-accent)]/40 focus-visible:bg-[var(--color-accent)]/60 focus-visible:outline-none"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            dragging.current = { startY: e.clientY, startHeight: paneHeight };
          }}
          onPointerMove={(e) => {
            if (dragging.current) setHeight(clamp(dragging.current.startHeight + dragging.current.startY - e.clientY));
          }}
          onPointerUp={() => (dragging.current = null)}
          onPointerCancel={() => (dragging.current = null)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp') setHeight(clamp(paneHeight + 24));
            else if (e.key === 'ArrowDown') setHeight(clamp(paneHeight - 24));
            else return;
            e.preventDefault();
            e.stopPropagation();
          }}
        />
      )}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpenPref(!open)}
        className="flex w-full items-center gap-1.5 px-3 py-1 text-left text-xs font-medium text-[var(--color-muted)] hover:text-[var(--color-ink)]"
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} />
        Speaker notes
      </button>
      {open && (
        <div className={cx('scroll-thin overflow-y-auto px-3 pb-2 text-sm')} style={{ height: paneHeight }}>
          {ctx.canEdit ? (
            // One editor per slide, so switching slides never carries a cursor or an undo history across.
            <NotesEditor key={slide.id} ctx={ctx} slideId={slide.id} />
          ) : (
            <SlideNotesView ydoc={ctx.session.ydoc} slideId={slide.id} emptyText="No speaker notes on this slide." />
          )}
        </div>
      )}
    </section>
  );
}

function NotesEditor({ ctx, slideId }: { ctx: SlideEditorContext; slideId: string }) {
  const { session } = ctx;
  const [theme] = useTheme();
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const awareness = session.provider.awareness ?? undefined;
  const state = awareness?.getLocalState() as { user?: { name: string; color: string } } | null | undefined;
  const user = state?.user ?? { name: 'Someone', color: '#6b7280' };
  const editor = useCreateBlockNote(
    withCollaboration({
      schema: notesSchema,
      collaboration: {
        provider: { awareness },
        fragment: session.ydoc.getXmlFragment(notesFragmentName(slideId)),
        user,
      },
      placeholders: { default: 'Speaker notes' },
    }),
    [session, slideId],
  );
  return (
    <div className="paradocs-slide-notes paradocs-embedded-doc -mx-2 text-sm">
      <BlockNoteView editor={editor} theme={dark ? 'dark' : 'light'} sideMenu={false} />
    </div>
  );
}

registerSlidePanel({ id: 'notes', order: 10, render: (ctx) => <SlideNotesPanel ctx={ctx} /> });
