import { useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  slideAspectRatio,
  type DeckSnapshot,
  type RichTextElement,
  type SlideSnapshot,
} from '@paradocs/shared';
import { PAPER, chunk, handoutGrid, handoutSlideWidth, pageSizeCss, sheetFor, type PdfLayout } from '../../lib/slidesExport/printLayout';
import SlideView from './SlideView';

/**
 * The PDF of a deck, made by the browser's own print pipeline from the same
 * read-only renderer the slideshow uses (SlideView). The slides are drawn into
 * a root of their own, everything else on the page is hidden for printing, and
 * `@page` fixes the paper to the slide's shape, so what comes out is vector
 * text, selectable and searchable, not a screenshot. The person chooses "Save
 * as PDF" in the print dialog, which also names the file after the deck.
 *
 * Hidden slides are left out, as they are when presenting.
 */

const ROOT_ID = 'slide-print-root';
const STYLE_ID = 'slide-print-style';
/** Gives up waiting for live content (a chart, a work item) to arrive after this long, and prints what is there. */
const LIVE_WAIT_MS = 10_000;

function printCss(layout: PdfLayout, deck: DeckSnapshot): string {
  const sheet = sheetFor(layout, deck.settings.size);
  return `
@page { size: ${pageSizeCss(sheet)}; margin: 0; }
#${ROOT_ID} { position: fixed; left: -100000px; top: 0; width: ${sheet.width}px; }
@media print {
  html, body { margin: 0 !important; padding: 0 !important; height: auto !important; overflow: visible !important; background: #fff !important; }
  body > *:not(#${ROOT_ID}) { display: none !important; }
  #${ROOT_ID} { position: static; left: auto; width: auto; display: block !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  #${ROOT_ID} .slide-print-page { box-sizing: border-box; width: ${sheet.width}px; min-height: ${sheet.height}px; overflow: hidden; break-after: page; page-break-after: always; break-inside: avoid; }
  #${ROOT_ID} .slide-print-page:last-child { break-after: auto; page-break-after: auto; }
}`;
}

function fontFamiliesOf(deck: DeckSnapshot): string[] {
  const families = new Set<string>();
  for (const theme of deck.themes) {
    families.add(theme.fonts.heading);
    families.add(theme.fonts.body);
  }
  const visit = (slide: Pick<SlideSnapshot, 'elements'>) => {
    for (const element of slide.elements) {
      const family = (element as { fontFamily?: string }).fontFamily;
      if (family) families.add(family);
      for (const paragraph of (element as RichTextElement).paragraphs ?? []) {
        for (const run of paragraph.runs) if (run.marks?.fontFamily) families.add(run.marks.fontFamily);
      }
    }
  };
  deck.slides.forEach(visit);
  [...deck.layouts, deck.master].forEach((part) => visit({ elements: part.elements ?? [] }));
  return [...families].filter(Boolean);
}

/** Waits until what is about to be printed is really there: web fonts, pictures, and live content that is still loading. */
async function whenReady(root: HTMLElement, deck: DeckSnapshot, cancelled: () => boolean): Promise<void> {
  const fonts = document.fonts;
  if (fonts) {
    const wanted = fontFamiliesOf(deck).flatMap((family) => ['', 'bold ', 'italic ', 'italic bold '].map((style) => fonts.load(`${style}32px "${family.replace(/"/g, '')}"`)));
    await Promise.allSettled(wanted);
    await fonts.ready;
  }
  const pictures = [...root.querySelectorAll('img')].map((img) =>
    img.complete ? null : new Promise<void>((resolve) => ((img.onload = img.onerror = () => resolve()), undefined)),
  );
  const backgrounds = [...root.querySelectorAll<HTMLElement>('*')]
    .map((el) => /url\(["']?([^"')]+)["']?\)/.exec(getComputedStyle(el).backgroundImage)?.[1])
    .filter((url): url is string => !!url)
    .map(
      (url) =>
        new Promise<void>((resolve) => {
          const image = new Image();
          image.onload = image.onerror = () => resolve();
          image.src = url;
        }),
    );
  await Promise.all([...pictures, ...backgrounds]);
  const deadline = Date.now() + LIVE_WAIT_MS;
  while (!cancelled() && Date.now() < deadline && /Loading…/.test(root.textContent ?? '')) await new Promise((resolve) => setTimeout(resolve, 150));
  // One more frame so layout (autofit text in particular) settles at the final fonts.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

export default function SlidePrintJob({
  deck,
  title,
  layout,
  onDone,
}: {
  deck: DeckSnapshot;
  title: string;
  layout: PdfLayout;
  /** Called once the print dialog has been dealt with, whether or not anything was saved. */
  onDone: () => void;
}) {
  const theme = deck.themes.find((t) => t.id === deck.settings.themeId) ?? deck.themes[0];
  const slides = useMemo(() => deck.slides.filter((slide) => !slide.hidden), [deck.slides]);
  const numbers = useMemo(() => new Map(deck.slides.map((slide, i) => [slide.id, i + 1])), [deck.slides]);
  const root = useRef<HTMLDivElement>(null);
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = printCss(layout, deck);
    document.head.appendChild(style);
    const before = document.title;
    let cancelled = false;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      window.removeEventListener('afterprint', finish);
      document.title = before;
      done.current();
    };
    void (async () => {
      const el = root.current;
      if (!el) return;
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await whenReady(el, deck, () => cancelled);
      if (cancelled) return;
      // Browsers name a saved PDF after the page title.
      document.title = title;
      window.addEventListener('afterprint', finish);
      window.print();
      // Some browsers return from print() before the dialog is shut and fire afterprint later; others never fire it. Do not wait forever.
      setTimeout(finish, 120_000);
    })();
    return () => {
      cancelled = true;
      style.remove();
      window.removeEventListener('afterprint', finish);
      document.title = before;
    };
    // A print job is one run: its deck and layout are fixed when it starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { size } = deck.settings;
  const sheet = sheetFor(layout, size);

  return createPortal(
    <div id={ROOT_ID} ref={root} aria-hidden>
      {layout.kind === 'slides' &&
        slides.map((slide) => (
          <div key={slide.id} className="slide-print-page" style={{ height: sheet.height }}>
            <SlideView slide={slide} size={size} theme={theme} width={sheet.width} />
          </div>
        ))}
      {layout.kind === 'notes' &&
        slides.map((slide) => (
          <div key={slide.id} className="slide-print-page" style={{ padding: PAPER.margin, fontFamily: 'system-ui, sans-serif', color: '#111' }}>
            <div style={{ border: '1px solid #cbd5e1' }}>
              <SlideView slide={slide} size={size} theme={theme} width={PAPER.width - PAPER.margin * 2 - 2} />
            </div>
            <div style={{ marginTop: 20, fontSize: 12, color: '#64748b' }}>Slide {numbers.get(slide.id)}</div>
            <div style={{ marginTop: 6, fontSize: 15, lineHeight: 1.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{slide.notes.trim() || ' '}</div>
          </div>
        ))}
      {layout.kind === 'handout' &&
        chunk(slides, layout.perPage).map((page, p) => {
          const { columns } = handoutGrid(layout.perPage);
          const width = handoutSlideWidth(layout.perPage, size);
          return (
            <div key={p} className="slide-print-page" style={{ padding: PAPER.margin, fontFamily: 'system-ui, sans-serif', color: '#111' }}>
              <div style={{ display: 'grid', gridTemplateColumns: `repeat(${columns}, ${width}px)`, gap: 24, justifyContent: 'space-between' }}>
                {page.map((slide) => (
                  <div key={slide.id}>
                    <div style={{ border: '1px solid #cbd5e1', width: width + 2, height: width / slideAspectRatio(size) + 2 }}>
                      <SlideView slide={slide} size={size} theme={theme} width={width} />
                    </div>
                    <div style={{ marginTop: 6, fontSize: 12, color: '#64748b' }}>Slide {numbers.get(slide.id)}</div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
    </div>,
    document.body,
  );
}
