import { useRef, useState, type ReactNode } from 'react';
import { deleteLayout, deleteSlide, readSlideOrder, slideMapName } from '@paradocs/shared';
import { readPowerPointSlides } from '../../lib/powerPointClipboard';
import { insertImport, resolveMedia, uploadImportMedia, type PasteFormatting } from '../../lib/slideImport';
import { importSlideFile } from '../../lib/slideImportClient';
import type { ImportedDeck, ImportReportItem } from '../../lib/slideImportTypes';
import { uploadSlideFile } from '../../lib/slideUploads';
import { cx } from '../../lib/util';
import { useToast } from '../Toast';
import Icon from '../Icon';
import { ImportReportDialog } from './SlideImportHost';
import type { SlideEditorContext } from './slideExtensions';

const FORMATTING_KEY = 'paradocs.slides.pasteFormatting';

function savedFormatting(): PasteFormatting {
  try {
    return localStorage.getItem(FORMATTING_KEY) === 'source' ? 'source' : 'deck';
  } catch {
    return 'deck';
  }
}

function saveFormatting(formatting: PasteFormatting): void {
  try {
    localStorage.setItem(FORMATTING_KEY, formatting);
  } catch {
    // Storage can be blocked; the choice still holds for this paste.
  }
}

/** The slides a paste added, and how, for the formatting choice offered after it. */
interface Pasted {
  deck: ImportedDeck;
  index: number;
  formatting: PasteFormatting;
  slideIds: string[];
  layoutIds: string[];
}

/**
 * Pasting slides copied in PowerPoint: they are read like a .pptx (at this
 * deck's size), their pictures uploaded to the presentation, and they go in
 * after the current slide as one undo step. A bar then offers PowerPoint's two
 * paste options, matching this deck or keeping the source formatting, and
 * remembers the last one chosen for the next paste.
 */
export function usePowerPointPaste(ctx: SlideEditorContext, onPasted: (slideIds: string[]) => void): { paste: (data: DataTransfer) => boolean; host: ReactNode } {
  const toast = useToast();
  const [status, setStatus] = useState<string | null>(null);
  const [pasted, setPasted] = useState<Pasted | null>(null);
  const [report, setReport] = useState<ImportReportItem[] | null>(null);
  const busy = useRef(false);
  const latest = useRef(ctx);
  latest.current = ctx;

  const insert = (deck: ImportedDeck, index: number, formatting: PasteFormatting): Pasted => {
    let result = { slideIds: [] as string[], layoutIds: [] as string[] };
    const { actions } = latest.current;
    actions.checkpoint();
    actions.edit((doc) => {
      result = insertImport(doc, deck, { index, formatting });
    });
    actions.checkpoint();
    return { deck, index, formatting, ...result };
  };

  const paste = (data: DataTransfer): boolean => {
    const bytes = readPowerPointSlides(data);
    if (!bytes) return false;
    if (busy.current) return true;
    busy.current = true;
    setPasted(null);
    const { presentationId, workspaceId, deck, slide, slides } = latest.current;
    const index = slide ? slides.indexOf(slide) + 1 : slides.length;
    void (async () => {
      try {
        const progress = (p: { message: string }) => setStatus(p.message);
        setStatus('Reading the slides from PowerPoint…');
        const parsed = await importSlideFile(new File([bytes as BlobPart], 'PowerPoint slides.pptx'), progress, deck.settings.size);
        const { urls, failed } = await uploadImportMedia(parsed, (file) => uploadSlideFile(workspaceId, presentationId, file), progress);
        const resolved = resolveMedia(parsed, urls, failed);
        if (resolved.slides.length === 0) throw new Error('The clipboard held no slides');
        const result = insert(resolved, index, savedFormatting());
        setPasted(result);
        onPasted(result.slideIds);
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Could not paste those slides', 'error');
      } finally {
        busy.current = false;
        setStatus(null);
      }
    })();
    return true;
  };

  /** Takes the last paste out (what is left of it) and puts it back with the other formatting. */
  const reformat = (formatting: PasteFormatting) => {
    if (!pasted || !live || pasted.formatting === formatting) return;
    saveFormatting(formatting);
    const { actions } = latest.current;
    let index = pasted.index;
    actions.edit((doc) => {
      const order = readSlideOrder(doc);
      const still = pasted.slideIds.filter((id) => order.includes(id));
      if (still.length) index = order.indexOf(still[0]);
      for (const id of still) deleteSlide(doc, id);
      // Layouts the paste brought in go too, unless a slide has since been put on one.
      const inUse = new Set(readSlideOrder(doc).map((id) => doc.getMap<unknown>(slideMapName(id)).get('layoutId')));
      for (const id of pasted.layoutIds) if (!inUse.has(id)) deleteLayout(doc, id);
    });
    const result = insert(pasted.deck, index, formatting);
    setPasted(result);
    onPasted(result.slideIds);
  };

  // Once its slides are gone (undone, or deleted), there is nothing left to reformat.
  const live = pasted !== null && pasted.slideIds.some((id) => ctx.slides.some((s) => s.id === id));
  const count = pasted?.slideIds.length ?? 0;
  const items = pasted?.deck.report.items ?? [];
  const host = (
    <>
      {status && (
        <div role="status" className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center px-4">
          <span className="flex items-center gap-2 rounded-full bg-[var(--color-canvas)] px-3 py-1.5 text-xs shadow-lg ring-1 ring-[var(--color-line)]">
            <span aria-hidden className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-[var(--color-line)] border-t-[var(--color-accent)]" /> {status}
          </span>
        </div>
      )}
      {pasted && live && !status && (
        <div className="absolute inset-x-0 bottom-3 z-20 flex justify-center px-4">
          <div
            role="group"
            aria-label="Paste options"
            className="flex max-w-full flex-wrap items-center gap-2 rounded-lg bg-[var(--color-canvas)] px-3 py-2 text-xs shadow-lg ring-1 ring-[var(--color-line)]"
          >
            <span title="Pasted from PowerPoint">
              Pasted {count} slide{count === 1 ? '' : 's'}
            </span>
            <span className="flex overflow-hidden rounded-md border border-[var(--color-line)]">
              {(
                [
                  ['deck', 'Match this deck'],
                  ['source', 'Keep source formatting'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={pasted.formatting === value}
                  onClick={() => reformat(value)}
                  className={cx(
                    'min-h-7 px-2 py-1',
                    pasted.formatting === value ? 'bg-[var(--color-accent)] text-white' : 'hover:bg-[var(--color-surface)]',
                  )}
                >
                  {label}
                </button>
              ))}
            </span>
            {items.length > 0 && (
              <button type="button" className="text-[var(--color-accent)] hover:underline" onClick={() => setReport(items)}>
                What changed
              </button>
            )}
            <button type="button" aria-label="Close paste options" className="grid h-6 w-6 place-items-center rounded hover:bg-[var(--color-surface)]" onClick={() => setPasted(null)}>
              <Icon name="x-lg" />
            </button>
          </div>
        </div>
      )}
      {report && pasted && (
        <ImportReportDialog report={{ fileName: 'PowerPoint', slides: count, items: report }} onClose={() => setReport(null)} />
      )}
    </>
  );
  return { paste, host };
}
