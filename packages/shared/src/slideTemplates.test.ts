import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  BLANK_LAYOUT_ID,
  SLIDE_SIZE_4_3,
  addLayout,
  applyStarterTheme,
  applyTemplate,
  createSlide,
  readDeck,
  richTextBody,
  setSlideElement,
  setSlideLayout,
  templateAssetUrls,
  templateDeckFrom,
  templatePreview,
  templateStyleOf,
  matchTemplateLayout,
  titleLayoutOf,
  updateLayout,
  updateMaster,
  writeDeckSettings,
  writeParagraphs,
  type RichTextElement,
  type SlideLayout,
  type TemplateStyle,
} from './index.js';

const decode = (update: Uint8Array) => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  return doc;
};

/** A deck in the Paper theme with a logo on its master and three slides with something written on each. */
function styledDeck() {
  const doc = new Y.Doc();
  applyStarterTheme(doc, 'paper');
  updateMaster(doc, {
    background: { kind: 'image', url: '/uploads/ws/back.png' },
    elements: [{ id: 'logo', type: 'image', url: '/uploads/ws/logo.png', x: 10, y: 10, width: 100, height: 50, z: 1 } as never],
  });
  const ids = ['title', 'titleAndContent', 'titleOnly'].map((layout) => {
    const id = createSlide(doc, { layoutId: BLANK_LAYOUT_ID });
    setSlideLayout(doc, id, layout);
    return id;
  });
  return { doc, ids };
}

function titleOf(doc: Y.Doc, slideId: string): string {
  const slide = readDeck(doc).slides.find((s) => s.id === slideId)!;
  return (slide.elements.find((e) => e.type === 'richText' && (e as RichTextElement).placeholder === 'title') as RichTextElement | undefined)?.text ?? '';
}

describe('presentation templates', () => {
  it('keeps a deck’s look and one empty Title slide, and none of its slides', () => {
    const { doc } = styledDeck();
    const template = decode(templateDeckFrom(doc));
    const deck = readDeck(template);
    expect(deck.settings.themeId).toBe('paper');
    expect(deck.themes.map((t) => t.id)).toEqual(['paper']);
    expect(deck.master.elements.map((e) => e.id)).toEqual(['logo']);
    expect(deck.master.background).toEqual({ kind: 'image', url: '/uploads/ws/back.png' });
    expect(deck.layouts).toEqual(readDeck(doc).layouts);
    expect(deck.slides).toHaveLength(1);
    expect(deck.slides[0].layoutId).toBe('title');
    expect(deck.slides[0].elements.every((e) => e.type !== 'richText' || !(e as RichTextElement).text)).toBe(true);
  });

  it('finds the Title layout by type, then id, then name, then the first that is not blank', () => {
    const layout = (id: string, name: string, type?: string): SlideLayout => ({ id, name, ...(type ? { type } : {}), placeholders: [] });
    expect(titleLayoutOf([layout('a', 'Blank', 'blank'), layout('b', 'Cover', 'title')])?.id).toBe('b');
    expect(titleLayoutOf([layout('a', 'Other'), layout('title', 'Opening')])?.id).toBe('title');
    expect(titleLayoutOf([layout('a', 'Other'), layout('b', 'Title Slide')])?.id).toBe('b');
    expect(titleLayoutOf([layout(BLANK_LAYOUT_ID, 'Blank'), layout('c', 'Agenda')])?.id).toBe('c');
  });

  it('previews the Title slide with sample text where the title and subtitle go', () => {
    const { doc } = styledDeck();
    const preview = templatePreview(decode(templateDeckFrom(doc)))!;
    expect(preview.theme.id).toBe('paper');
    expect(preview.slide.frame?.elements.map((e) => e.id)).toEqual(['logo']);
    expect(preview.slide.elements).toEqual([]);
    expect(preview.samples.map((s) => s.text)).toEqual(['Presentation title', 'Subtitle']);
    expect(preview.samples[0].style.fontFamily).toBe(preview.theme.fonts.heading);
  });

  it('lists the uploads the master and layouts show', () => {
    const { doc } = styledDeck();
    updateLayout(doc, 'title', { background: { kind: 'image', url: '/uploads/ws/cover.jpg' } });
    expect(templateAssetUrls(templateStyleOf(readDeck(doc))).sort()).toEqual(['/uploads/ws/back.png', '/uploads/ws/cover.jpg', '/uploads/ws/logo.png']);
  });

  it('matches a slide’s layout by type, then name, then the boxes it has', () => {
    const candidates: SlideLayout[] = [
      { id: 'i0', name: 'Title Slide', type: 'title', placeholders: [{ id: 't', kind: 'title' }, { id: 's', kind: 'subtitle' }] },
      { id: 'i1', name: 'Agenda', placeholders: [{ id: 't', kind: 'title' }, { id: 'b', kind: 'body' }] },
      { id: 'i2', name: 'Empty', placeholders: [{ id: 'f', kind: 'footer' }] },
    ];
    expect(matchTemplateLayout({ id: 'x', name: 'Opening', type: 'title', placeholders: [] }, candidates)?.id).toBe('i0');
    expect(matchTemplateLayout({ id: 'x', name: 'agenda', placeholders: [] }, candidates)?.id).toBe('i1');
    expect(matchTemplateLayout({ id: 'x', name: 'Bullets', placeholders: [{ id: 't', kind: 'title' }, { id: 'b', kind: 'body' }] }, candidates)?.id).toBe('i1');
    expect(matchTemplateLayout(undefined, candidates)?.id).toBe('i2');
  });

  it('puts a template on a deck in one undo step, keeping every slide’s content', () => {
    const doc = new Y.Doc();
    const ids = ['title', 'titleAndContent'].map((layout) => {
      const id = createSlide(doc, { layoutId: BLANK_LAYOUT_ID });
      setSlideLayout(doc, id, layout);
      return id;
    });
    const before = readDeck(doc);
    ids.forEach((id, i) => {
      const box = before.slides[i].elements.find((e) => (e as RichTextElement).placeholder === 'title')!;
      writeParagraphs(richTextBody(doc, id, box.id)!, [{ runs: [{ text: `Heading ${i + 1}` }] }]);
    });
    setSlideElement(doc, ids[1], { id: 'mine', type: 'text', text: 'Note', x: 1, y: 2, width: 3, height: 4, z: 9 } as never);

    // A template from another deck whose layouts share ids with this one's, in another theme.
    const { doc: source } = styledDeck();
    addLayout(source, 'Extra');
    const style = templateStyleOf(readDeck(decode(templateDeckFrom(source))));

    const undo = new Y.UndoManager([doc.getMap('deck'), doc.getMap('themes'), doc.getMap('layouts'), doc.getMap('master'), ...ids.map((id) => doc.getMap(`slide:${id}`))]);
    applyTemplate(doc, style);

    const after = readDeck(doc);
    expect(after.settings.themeId).toBe('paper');
    expect(after.layouts.map((l) => l.id)).toEqual(style.layouts.map((l) => l.id));
    expect(after.master.elements.map((e) => e.id)).toEqual(['logo']);
    expect(after.slides.map((s) => s.layoutId)).toEqual(['title', 'titleAndContent']);
    expect(titleOf(doc, ids[0])).toBe('Heading 1');
    expect(titleOf(doc, ids[1])).toBe('Heading 2');
    expect(after.slides[1].elements.some((e) => e.id === 'mine')).toBe(true);

    undo.undo();
    const undone = readDeck(doc);
    expect(undone.settings.themeId).toBe('default');
    expect(undone.master.elements).toEqual([]);
    expect(undone.layouts).toEqual(before.layouts);
  });

  it('fits a template drawn for another slide size to the deck', () => {
    const doc = new Y.Doc();
    createSlide(doc, { layoutId: BLANK_LAYOUT_ID });
    const source = new Y.Doc();
    writeDeckSettings(source, { size: SLIDE_SIZE_4_3 });
    applyStarterTheme(source, 'ocean');
    const style: TemplateStyle = templateStyleOf(readDeck(decode(templateDeckFrom(source))));
    const title = (s: TemplateStyle | ReturnType<typeof readDeck>) => s.master.placeholders.find((p) => p.kind === 'title')!;
    applyTemplate(doc, style);
    const after = readDeck(doc);
    expect(after.settings.size).toEqual({ width: 1920, height: 1080 });
    expect(title(after).width).toBe(Math.round((title(style).width * 1920) / 1440));
  });
});
