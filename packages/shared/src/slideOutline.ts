import * as Y from 'yjs';
import {
  BLANK_LAYOUT_ID,
  DEFAULT_LAYOUTS,
  createSlide,
  notesFragmentName,
  paragraphNodes,
  readDeck,
  setSlideElement,
  slideElementText,
  tableCellKey,
  type DeckSnapshot,
  type LayoutPlaceholder,
  type RichParagraph,
  type SlideElement,
  type SlideLayout,
  type SlideSnapshot,
} from './slides.js';

/**
 * Decks as text, for the assistant tools: a deck read as markdown, and an
 * outline written as markdown made into slides laid out from the deck's own
 * layouts.
 */

/**
 * Where a presentation opens in the app, on a slide when one is given. The
 * slide travels as `?slide=<id>` for the editor and the slideshow to honor.
 */
export function presentationPath(workspaceId: string, presentationId: string, slideId?: string): string {
  const path = `/w/${workspaceId}/sl/${presentationId}`;
  return slideId ? `${path}?slide=${encodeURIComponent(slideId)}` : path;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function placeholderOf(element: SlideElement): string | undefined {
  return element.type === 'richText' ? element.placeholder : undefined;
}

function elementLines(element: SlideElement): string[] {
  if (element.type === 'table') {
    const rows: string[][] = [];
    for (let r = 0; r < element.rows; r++) {
      const cells: string[] = [];
      for (let c = 0; c < element.columns; c++) cells.push(element.cells[tableCellKey(r, c)]?.text ?? '');
      rows.push(cells);
    }
    return rows.map((cells) => `| ${cells.join(' | ')} |`);
  }
  if (element.type === 'image') return [`[image${element.alt ? `: ${element.alt}` : ''}]`];
  return slideElementText(element)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

/** A slide's title: its title placeholder's text, else the first line of text on it. */
export function slideTitle(slide: Pick<SlideSnapshot, 'elements'>): string {
  const titled = slide.elements.find((e) => placeholderOf(e) === 'title');
  const source = titled ?? slide.elements.find((e) => slideElementText(e).trim());
  return source ? (slideElementText(source).split('\n').find((l) => l.trim()) ?? '').trim() : '';
}

/**
 * A deck as markdown: a heading per slide, its text below, and its speaker
 * notes after "Notes:". What sits in a body placeholder reads as bullets, the
 * way {@link parseOutline} writes them.
 */
export function deckMarkdown(title: string, deck: DeckSnapshot): string {
  const layouts = new Map(deck.layouts.map((l) => [l.id, l.name]));
  const count = deck.slides.length;
  const out = [`# ${title || 'Untitled'}`, `${count} slide${count === 1 ? '' : 's'}, ${deck.settings.size.width}x${deck.settings.size.height}`];
  deck.slides.forEach((slide, index) => {
    const heading = slideTitle(slide);
    const tags = [layouts.has(slide.layoutId) ? `layout: ${layouts.get(slide.layoutId)}` : null, slide.hidden ? 'hidden' : null].filter(Boolean);
    out.push('', `## Slide ${index + 1}${heading ? `: ${heading}` : ''}${tags.length ? ` (${tags.join(', ')})` : ''}`);
    let titleSkipped = false;
    for (const element of slide.elements) {
      const placeholder = placeholderOf(element);
      let lines = elementLines(element);
      // The heading already says the title.
      if (placeholder === 'title' && !titleSkipped) {
        titleSkipped = true;
        lines = lines.slice(1);
      }
      out.push(...(placeholder === 'body' ? lines.map((l) => `- ${l}`) : lines));
    }
    if (slide.notes.trim()) out.push('', 'Notes:', ...slide.notes.split('\n').filter((l) => l.trim()));
  });
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface OutlineItem {
  text: string;
  bullet: boolean;
  /** Nesting depth of a bullet, from 0. */
  level: number;
}

export interface OutlineSlide {
  title: string;
  items: OutlineItem[];
  notes: string[];
}

export const MAX_OUTLINE_SLIDES = 100;
const MAX_LINE = 2000;

/**
 * An outline as slides. A heading (`#`, `##` or `###`) starts a slide; `-`, `*`
 * or `•` lines under it are bullets (indented two spaces per level), other
 * lines are plain text, and everything after a `Notes:` line, up to the next
 * heading, is the slide's speaker notes.
 */
export function parseOutline(text: string): OutlineSlide[] {
  const slides: OutlineSlide[] = [];
  let current: OutlineSlide | null = null;
  let inNotes = false;
  const slide = (): OutlineSlide => {
    if (!current) {
      current = { title: '', items: [], notes: [] };
      slides.push(current);
    }
    return current;
  };

  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\t/g, '  ').trimEnd().slice(0, MAX_LINE);
    const heading = /^#{1,3}\s+(.*)$/.exec(line.trim());
    if (heading) {
      current = { title: heading[1].trim(), items: [], notes: [] };
      slides.push(current);
      inNotes = false;
      continue;
    }
    if (!line.trim()) continue;
    const notes = /^\s*notes?:\s*(.*)$/i.exec(line);
    if (notes) {
      inNotes = true;
      if (notes[1].trim()) slide().notes.push(notes[1].trim());
      continue;
    }
    if (inNotes) {
      slide().notes.push(line.trim());
      continue;
    }
    const bullet = /^(\s*)[-*•]\s+(.*)$/.exec(line);
    if (bullet) slide().items.push({ text: bullet[2].trim(), bullet: true, level: Math.min(Math.floor(bullet[1].length / 2), 4) });
    else slide().items.push({ text: line.trim(), bullet: false, level: 0 });
  }
  return slides;
}

/** An outline line as a rich text paragraph: a bullet with its depth. Its size and style come from the placeholder. */
function paragraph(text: string, item?: OutlineItem): RichParagraph {
  return {
    ...(item?.bullet ? { bullet: 'bullet' as const, ...(item.level > 0 ? { level: item.level } : {}) } : {}),
    runs: [{ text }],
  };
}

function layoutFor(layouts: SlideLayout[], id: string): SlideLayout {
  return (
    layouts.find((l) => l.id === id) ??
    DEFAULT_LAYOUTS.find((l) => l.id === id) ?? { id: BLANK_LAYOUT_ID, name: 'Blank', placeholders: [] }
  );
}

/**
 * Adds the outline's slides to a deck, at `index` or the end: each laid out
 * from the deck's own layouts with its text in the layout's placeholders. A
 * slide with no body is a Title slide; the first slide with one plain line is
 * a Title slide with that line as its subtitle; the rest are Title and content.
 * Returns the new slide ids in order.
 */
export function addOutlineSlides(doc: Y.Doc, slides: OutlineSlide[], index?: number): string[] {
  const { layouts } = readDeck(doc);
  const ids: string[] = [];
  doc.transact(() => {
    slides.forEach((outline, n) => {
      const subtitleOnly = n === 0 && outline.items.length === 1 && !outline.items[0].bullet;
      const layout = layoutFor(layouts, outline.items.length === 0 || subtitleOnly ? 'title' : 'titleAndContent');
      const id = createSlide(doc, { layoutId: layout.id, ...(index === undefined ? {} : { index: index + n }) });
      ids.push(id);

      const place = (kind: LayoutPlaceholder['kind'], items: OutlineItem[], z: number) => {
        const slot = layout.placeholders.find((p) => p.kind === kind);
        if (!slot || items.length === 0) return;
        setSlideElement(doc, id, {
          id: crypto.randomUUID(),
          type: 'richText',
          // No position or size: the box inherits both from the layout's placeholder, so editing the layout moves it.
          placeholder: slot.id,
          z,
          paragraphs: items.map((item) => paragraph(item.text, item)),
        } as unknown as SlideElement);
      };
      place('title', outline.title ? [{ text: outline.title, bullet: false, level: 0 }] : [], 1);
      place(subtitleOnly ? 'subtitle' : 'body', outline.items, 2);

      if (outline.notes.length) doc.getXmlFragment(notesFragmentName(id)).insert(0, paragraphNodes(outline.notes.map((line) => paragraph(line))));
    });
  });
  return ids;
}
