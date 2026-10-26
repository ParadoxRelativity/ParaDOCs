import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  BLANK_LAYOUT_ID,
  DEFAULT_LAYOUTS,
  DEFAULT_THEME,
  STARTER_THEMES,
  THEME_COLOR_SLOTS,
  addLayout,
  cardPalette,
  applyStarterTheme,
  createSlide,
  createStyledDeck,
  deleteLayout,
  duplicateSlideElements,
  ensureDeckStyle,
  newPlaceholder,
  patchPlaceholder,
  patchSlideElements,
  readDeck,
  resetPlaceholder,
  richTextBody,
  writeParagraphs,
  resolveBackground,
  resolveSlideColor,
  setSlideElement,
  setSlideLayout,
  themeColor,
  updateLayout,
  updateTheme,
  writeDeckSettings,
  type RichTextElement,
  type SlideElement,
} from './index.js';

const rich = (slide: { elements: SlideElement[] }, placeholder: string) =>
  slide.elements.find((e): e is RichTextElement => e.type === 'richText' && e.placeholder === placeholder)!;

function deckWith(layoutId: string) {
  const doc = new Y.Doc();
  const id = createSlide(doc, { layoutId: BLANK_LAYOUT_ID });
  setSlideLayout(doc, id, layoutId);
  return { doc, id };
}

describe('theme colors', () => {
  it('has the twelve PowerPoint slots', () => {
    expect(THEME_COLOR_SLOTS).toHaveLength(12);
    expect(Object.keys(DEFAULT_THEME.colors).sort()).toEqual([...THEME_COLOR_SLOTS].sort());
  });

  it('resolves mapped names through the theme color map, so a dark theme swaps text and background', () => {
    const midnight = STARTER_THEMES.find((s) => s.theme.id === 'midnight')!.theme;
    expect(resolveSlideColor(themeColor('text1'), DEFAULT_THEME)).toBe(DEFAULT_THEME.colors.dark1);
    expect(resolveSlideColor(themeColor('background1'), DEFAULT_THEME)).toBe(DEFAULT_THEME.colors.light1);
    expect(resolveSlideColor(themeColor('text1'), midnight)).toBe(midnight.colors.light1);
    expect(resolveSlideColor(themeColor('background1'), midnight)).toBe(midnight.colors.dark1);
  });

  it('lightens and darkens a slot by a percentage', () => {
    expect(resolveSlideColor('theme:dark1+100', DEFAULT_THEME)).toBe('#ffffff');
    expect(resolveSlideColor('theme:light1-100', DEFAULT_THEME)).toBe('#000000');
    expect(resolveSlideColor(themeColor('accent1', 50), DEFAULT_THEME)).toBe('#92b1f5');
    expect(resolveSlideColor('theme:nope', DEFAULT_THEME)).toBe('theme:nope');
  });

  it('resolves gradient stops', () => {
    const background = resolveBackground({ kind: 'gradient', angle: 90, stops: [{ offset: 0, color: 'theme:accent1' }, { offset: 1, color: '#000' }] }, DEFAULT_THEME);
    expect(background).toMatchObject({ stops: [{ color: DEFAULT_THEME.colors.accent1 }, { color: '#000' }] });
  });
});

describe('live content cards', () => {
  it('are light unless set, and dark whatever the theme', () => {
    const midnight = STARTER_THEMES.find((s) => s.theme.id === 'midnight')!.theme;
    expect(cardPalette(undefined, midnight).raised).toBe('#ffffff');
    expect(cardPalette('dark', DEFAULT_THEME).ink).toBe('#ededf0');
  });

  it('take the slide background, text and accent of the deck theme', () => {
    const midnight = STARTER_THEMES.find((s) => s.theme.id === 'midnight')!.theme;
    const palette = cardPalette('theme', midnight);
    expect(palette.raised).toBe(resolveSlideColor(themeColor('background1'), midnight));
    expect(palette.ink).toBe(resolveSlideColor(themeColor('text1'), midnight));
    expect(palette.accent).toBe(midnight.colors.accent1);
    expect(palette.muted).not.toBe(palette.ink);
    expect(palette.line).not.toBe(palette.raised);
  });

  it('can drop the card, keeping the theme text colors', () => {
    const palette = cardPalette('transparent', DEFAULT_THEME);
    expect(palette.raised).toBe('transparent');
    expect(palette.border).toBe('transparent');
    expect(palette.ink).toBe(DEFAULT_THEME.colors.dark1);
  });
});

describe('layouts and placeholders', () => {
  it('ships the eight layouts, each with footer, slide number and date', () => {
    expect(DEFAULT_LAYOUTS.map((l) => l.name)).toEqual([
      'Blank',
      'Title',
      'Title and content',
      'Section header',
      'Two content',
      'Comparison',
      'Title only',
      'Picture with caption',
    ]);
    for (const layout of DEFAULT_LAYOUTS) {
      expect(layout.placeholders.map((p) => p.kind)).toEqual(expect.arrayContaining(['footer', 'slideNumber', 'date']));
    }
  });

  it('fills a new slide with empty placeholders that inherit position and style from the layout', () => {
    const { doc } = deckWith('titleAndContent');
    const [slide] = readDeck(doc).slides;
    expect(slide.elements).toHaveLength(2);
    expect(rich(slide, 'title')).toMatchObject({ x: 120, y: 80, width: 1680, height: 140, fontSize: 64, bold: true, placeholderKind: 'title', prompt: 'Click to add title' });
    expect(rich(slide, 'body')).toMatchObject({ x: 120, y: 260, fontSize: 32, placeholderKind: 'body', prompt: 'Click to add text' });
    // Nothing is stored on the element itself, so there is nothing to go stale.
    const stored = doc.getMap<unknown>(`slide:${slide.id}`).get('elements') as Y.Map<Y.Map<unknown>>;
    expect([...stored.values()].every((m) => !m.has('x') && !m.has('fontSize'))).toBe(true);
  });

  it('adds a picture placeholder as an empty picture', () => {
    const { doc } = deckWith('pictureWithCaption');
    const [slide] = readDeck(doc).slides;
    const picture = slide.elements.find((e) => e.type === 'image')!;
    expect(picture).toMatchObject({ placeholder: 'picture', url: '', x: 840, width: 960 });
  });

  it('editing a layout moves every slide on it, except boxes a slide has moved itself', () => {
    const { doc, id: a } = deckWith('titleAndContent');
    const b = createSlide(doc, { layoutId: BLANK_LAYOUT_ID });
    setSlideLayout(doc, b, 'titleAndContent');
    const moved = rich(readDeck(doc).slides[1], 'title');
    patchSlideElements(doc, b, [{ id: moved.id, patch: { x: 33, fontSize: 20 } }]);

    const layout = readDeck(doc).layouts.find((l) => l.id === 'titleAndContent')!;
    updateLayout(doc, 'titleAndContent', {
      placeholders: layout.placeholders.map((p) => (p.id === 'title' ? { ...p, x: 500, y: 40, style: { ...p.style, fontSize: 90 } } : p)),
    });

    const [first, second] = readDeck(doc).slides;
    expect(rich(first, 'title')).toMatchObject({ x: 500, y: 40, fontSize: 90 });
    expect(rich(second, 'title')).toMatchObject({ x: 33, y: 40, fontSize: 20 });
    expect(a).toBe(first.id);

    resetPlaceholder(doc, b, moved.id);
    expect(rich(readDeck(doc).slides[1], 'title')).toMatchObject({ x: 500, fontSize: 90 });
  });

  it('editing the master restyles layouts that inherit from it', () => {
    const { doc } = deckWith('titleAndContent');
    ensureDeckStyle(doc);
    const master = readDeck(doc).master;
    doc.getMap('master').set('placeholders', master.placeholders.map((p) => (p.kind === 'body' ? { ...p, style: { ...p.style, fontSize: 40 } } : p)));
    expect(rich(readDeck(doc).slides[0], 'body').fontSize).toBe(40);
  });

  it('changes a slide to another layout, keeping content and dropping empty boxes', () => {
    const { doc, id } = deckWith('titleAndContent');
    const body = rich(readDeck(doc).slides[0], 'body');
    writeParagraphs(richTextBody(doc, id, body.id)!, [{ runs: [{ text: 'Kept' }] }]);
    // The body has no counterpart on Title only and holds text: it stays, as a plain box where it was.
    setSlideLayout(doc, id, 'titleOnly');
    let slide = readDeck(doc).slides[0];
    expect(slide.layoutId).toBe('titleOnly');
    expect(slide.elements.map((e) => (e as RichTextElement).placeholder ?? null).sort()).toEqual([null, 'title']);
    const kept = slide.elements.find((e) => (e as RichTextElement).text === 'Kept') as RichTextElement;
    expect(kept).toMatchObject({ x: 120, y: 260, width: 1680, fontSize: 32 });
    expect(kept.placeholder).toBeUndefined();

    // Title stays the same box; moving to Title and content adds the empty body back.
    const title = rich(slide, 'title').id;
    setSlideLayout(doc, id, 'titleAndContent');
    slide = readDeck(doc).slides[0];
    expect(rich(slide, 'title').id).toBe(title);
    expect(slide.elements).toHaveLength(3);

    // An empty text box with no home is removed.
    setSlideLayout(doc, id, BLANK_LAYOUT_ID);
    expect(readDeck(doc).slides[0].elements.map((e) => (e as RichTextElement).text)).toEqual(['Kept']);
  });

  it('maps a subtitle onto a body and onward, and a title onto a title', () => {
    const { doc, id } = deckWith('title');
    const before = readDeck(doc).slides[0].elements.map((e) => e.id);
    setSlideLayout(doc, id, 'titleAndContent');
    const after = readDeck(doc).slides[0].elements;
    expect(after.map((e) => e.id).sort()).toEqual([...before].sort());
    expect(after.map((e) => (e as RichTextElement).placeholder).sort()).toEqual(['body', 'title']);
  });

  it('copies a placeholder box as a plain box where it was', () => {
    const { doc, id } = deckWith('titleAndContent');
    const title = rich(readDeck(doc).slides[0], 'title');
    const [copy] = duplicateSlideElements(doc, id, [title.id], id, { offset: 10, makeId: () => 'copy' });
    const element = readDeck(doc).slides[0].elements.find((e) => e.id === copy)!;
    expect(element).toMatchObject({ x: 130, y: 90, width: 1680, fontSize: 64 });
    expect((element as RichTextElement).placeholder).toBeUndefined();
  });

  it('adds, copies and deletes layouts, moving slides off a deleted one', () => {
    const { doc, id } = deckWith('titleAndContent');
    const copy = addLayout(doc, 'My layout', 'titleAndContent');
    expect(readDeck(doc).layouts.find((l) => l.id === copy)).toMatchObject({ name: 'My layout' });
    setSlideLayout(doc, id, copy);
    expect(deleteLayout(doc, copy)).toBe(true);
    expect(readDeck(doc).slides[0].layoutId).toBe(BLANK_LAYOUT_ID);
  });
});

describe('editing placeholders', () => {
  const list = [{ id: 'title', kind: 'title' as const, x: 1, y: 2, width: 3, height: 4, style: { fontSize: 10, bold: true } }];

  it('sets fields, merges style, and forgets what is set to null', () => {
    const [a] = patchPlaceholder(list, 'title', { x: 50, prompt: 'Name it', style: { fontSize: 20, italic: true } });
    expect(a).toMatchObject({ x: 50, y: 2, prompt: 'Name it', style: { fontSize: 20, bold: true, italic: true } });
    const [b] = patchPlaceholder([{ id: 'body', kind: 'body' as const, x: 5, style: { bold: true } }], 'body', { x: null, style: { bold: null } });
    expect(b).toEqual({ id: 'body', kind: 'body' });
    expect(patchPlaceholder(list, 'other', { x: 9 })).toEqual(list);
  });

  it('makes a placeholder with a fresh id, centred, or a bare one for the footer kinds', () => {
    const size = { width: 1000, height: 500 };
    expect(newPlaceholder('body', ['body'], size)).toMatchObject({ id: 'body2', kind: 'body', x: 250, width: 500 });
    expect(newPlaceholder('footer', [], size)).toEqual({ id: 'footer', kind: 'footer' });
  });
});

describe('themes', () => {
  function themed() {
    const doc = new Y.Doc();
    const id = createSlide(doc, { layoutId: BLANK_LAYOUT_ID });
    setSlideElement(doc, id, { id: 'themed', type: 'shape', shape: 'rectangle', x: 0, y: 0, width: 10, height: 10, z: 1, fill: themeColor('accent1') } as unknown as SlideElement);
    setSlideElement(doc, id, { id: 'custom', type: 'shape', shape: 'rectangle', x: 0, y: 0, width: 10, height: 10, z: 2, fill: '#123456' } as unknown as SlideElement);
    return doc;
  }

  it('switching theme changes what theme-bound elements resolve to, and leaves custom colors alone', () => {
    const doc = themed();
    const fills = () => {
      const deck = readDeck(doc);
      const theme = deck.themes.find((t) => t.id === deck.settings.themeId)!;
      return deck.slides[0].elements.map((e) => resolveSlideColor((e as { fill?: string }).fill, theme));
    };
    expect(fills()).toEqual([DEFAULT_THEME.colors.accent1, '#123456']);
    expect(applyStarterTheme(doc, 'paper')).toBe(true);
    const paper = STARTER_THEMES.find((s) => s.theme.id === 'paper')!.theme;
    expect(readDeck(doc).settings.themeId).toBe('paper');
    expect(fills()).toEqual([paper.colors.accent1, '#123456']);
    // The stored element still names the slot.
    expect(readDeck(doc).slides[0].elements[0]).toMatchObject({ fill: 'theme:accent1' });
    expect(applyStarterTheme(doc, 'nope')).toBe(false);
  });

  it('editing a theme color or font updates the theme in place', () => {
    const doc = themed();
    updateTheme(doc, 'default', { colors: { accent1: '#ff0000' }, fonts: { heading: 'Caladea' } });
    const theme = readDeck(doc).themes.find((t) => t.id === 'default')!;
    expect(theme.colors.accent1).toBe('#ff0000');
    expect(theme.colors.accent2).toBe(DEFAULT_THEME.colors.accent2);
    expect(theme.fonts).toEqual({ heading: 'Caladea', body: 'Inter' });
  });

  it('applying a theme sets the master background (a gradient for Ocean) but not slide backgrounds', () => {
    const doc = themed();
    const id = readDeck(doc).slides[0].id;
    doc.getMap(`slide:${id}`).set('background', { kind: 'color', color: '#fedcba' });
    applyStarterTheme(doc, 'ocean');
    const [slide] = readDeck(doc).slides;
    expect(readDeck(doc).master.background.kind).toBe('gradient');
    expect(slide.frame?.background).toEqual({ kind: 'color', color: '#fedcba' });
    const other = createSlide(doc, {});
    expect(readDeck(doc).slides.find((s) => s.id === other)?.frame?.background.kind).toBe('gradient');
  });

  it('a layout background sits between the slide and the master', () => {
    const { doc } = deckWith('title');
    updateLayout(doc, 'title', { background: { kind: 'color', color: '#010203' } });
    expect(readDeck(doc).slides[0].frame?.background).toEqual({ kind: 'color', color: '#010203' });
    updateLayout(doc, 'title', { background: null });
    expect(readDeck(doc).slides[0].frame?.background).toEqual({ kind: 'color', color: 'theme:background1' });
  });
});

describe('footer, slide number and date', () => {
  it('draws them from the deck toggles at the layout placeholder positions', () => {
    const { doc } = deckWith('titleAndContent');
    createSlide(doc, { layoutId: 'titleAndContent' });
    expect(readDeck(doc).slides[0].frame?.chrome).toEqual([]);
    writeDeckSettings(doc, { showFooter: true, footerText: 'Acme', showSlideNumber: true, showDate: true, dateText: 'Q3' });
    const chrome = readDeck(doc).slides[1].frame!.chrome;
    expect(chrome.map((c) => [c.kind, c.text])).toEqual([
      ['date', 'Q3'],
      ['footer', 'Acme'],
      ['slideNumber', '2'],
    ]);
    expect(chrome[2]).toMatchObject({ x: 1380, y: 1000, style: { align: 'right' } });
  });

  it('draws nothing for a blank footer text', () => {
    const { doc } = deckWith('title');
    writeDeckSettings(doc, { showFooter: true });
    expect(readDeck(doc).slides[0].frame?.chrome).toEqual([]);
  });
});

describe('a deck made from a starter theme', () => {
  it('starts with the theme applied and a first Title slide', () => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, createStyledDeck('midnight'));
    const deck = readDeck(doc);
    expect(deck.settings.themeId).toBe('midnight');
    expect(deck.themes.map((t) => t.id)).toEqual(['midnight']);
    expect(deck.layouts).toHaveLength(8);
    expect(deck.slides).toHaveLength(1);
    expect(deck.slides[0].layoutId).toBe('title');
    expect(deck.slides[0].elements.map((e) => (e as RichTextElement).placeholder).sort()).toEqual(['subtitle', 'title']);
  });

  it('scales layouts to a 4:3 deck', () => {
    const doc = new Y.Doc();
    writeDeckSettings(doc, { size: { width: 1440, height: 1080 } });
    const layout = readDeck(doc).layouts.find((l) => l.id === 'title')!;
    expect(layout.placeholders[0]).toMatchObject({ x: 120, width: 1200 });
  });
});
