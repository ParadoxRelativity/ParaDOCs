import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  DEFAULT_SLIDE_SIZE,
  DEFAULT_THEME,
  ELEMENT_BODY_KEY,
  SLIDE_ELEMENTS_KEY,
  createSlide,
  deckSearchText,
  deleteSlide,
  fitScale,
  moveSlide,
  normalizeSlideSize,
  notesFragmentName,
  presentationIdFromCollabName,
  readDeck,
  readSlideOrder,
  removeSlideElement,
  resolveSlideColor,
  setSlideElement,
  slideMapName,
  slidesCollabName,
  tableCellKey,
  themeColor,
  writeDeckSettings,
} from './slides.js';

const base = { x: 10, y: 20, width: 300, height: 100, z: 0 };

function sync(a: Y.Doc, b: Y.Doc) {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
}

/** A paragraph of plain text, as the editor and the notes both store one. */
function paragraph(text: string): Y.XmlElement {
  const p = new Y.XmlElement('paragraph');
  const run = new Y.XmlText();
  p.insert(0, [run]);
  run.insert(0, text);
  return p;
}

describe('collab names', () => {
  it('round-trips and ignores other names', () => {
    expect(presentationIdFromCollabName(slidesCollabName('abc'))).toBe('abc');
    expect(presentationIdFromCollabName('sheet:abc')).toBeNull();
    expect(presentationIdFromCollabName('abc')).toBeNull();
  });
});

describe('slide size', () => {
  it('defaults to 16:9 and accepts 4:3 and custom sizes', () => {
    expect(normalizeSlideSize(undefined)).toEqual(DEFAULT_SLIDE_SIZE);
    expect(normalizeSlideSize({ width: 1440, height: 1080 })).toEqual({ width: 1440, height: 1080 });
    expect(normalizeSlideSize({ width: 1000.4, height: 500 })).toEqual({ width: 1000, height: 500 });
  });
  it('rejects nonsense', () => {
    expect(normalizeSlideSize({ width: 0, height: 1080 })).toEqual(DEFAULT_SLIDE_SIZE);
    expect(normalizeSlideSize({ width: 1e9, height: 1080 })).toEqual(DEFAULT_SLIDE_SIZE);
  });
  it('fits a slide in a box', () => {
    expect(fitScale(DEFAULT_SLIDE_SIZE, 960, 960)).toBe(0.5);
  });
});

describe('theme colors', () => {
  it('resolves slots and passes literals through', () => {
    expect(resolveSlideColor(themeColor('accent1'), DEFAULT_THEME)).toBe(DEFAULT_THEME.colors.accent1);
    expect(resolveSlideColor('#abcdef', DEFAULT_THEME)).toBe('#abcdef');
    expect(resolveSlideColor('theme:nope', DEFAULT_THEME)).toBe('theme:nope');
    expect(resolveSlideColor(undefined, DEFAULT_THEME)).toBeUndefined();
  });
});

describe('deck in a Y.Doc', () => {
  it('reads an empty doc as a default deck', () => {
    const deck = readDeck(new Y.Doc());
    expect(deck.settings.size).toEqual(DEFAULT_SLIDE_SIZE);
    expect(deck.settings.themeId).toBe('default');
    expect(deck.slides).toEqual([]);
    expect(deck.themes).toEqual([DEFAULT_THEME]);
    expect(deck.layouts.length).toBeGreaterThan(0);
  });

  it('writes settings', () => {
    const doc = new Y.Doc();
    writeDeckSettings(doc, { size: { width: 1440, height: 1080 }, showSlideNumber: true });
    const { settings } = readDeck(doc);
    expect(settings.size).toEqual({ width: 1440, height: 1080 });
    expect(settings.showSlideNumber).toBe(true);
    expect(settings.showFooter).toBe(false);
  });

  it('creates, orders and deletes slides', () => {
    const doc = new Y.Doc();
    const a = createSlide(doc);
    const b = createSlide(doc);
    const c = createSlide(doc, { index: 0 });
    expect(readSlideOrder(doc)).toEqual([c, a, b]);
    moveSlide(doc, c, 2);
    expect(readSlideOrder(doc)).toEqual([a, b, c]);
    deleteSlide(doc, b);
    expect(readDeck(doc).slides.map((s) => s.id)).toEqual([a, c]);
  });

  it('lists a duplicated id once and skips an id with no slide', () => {
    const doc = new Y.Doc();
    const a = createSlide(doc);
    doc.getArray<string>('slideOrder').push([a, 'ghost']);
    expect(readSlideOrder(doc)).toEqual([a, 'ghost']);
    expect(readDeck(doc).slides.map((s) => s.id)).toEqual([a]);
  });

  it('stores elements, a rich text body, tables and notes', () => {
    const doc = new Y.Doc();
    const id = createSlide(doc, { background: { kind: 'color', color: '#000' } });
    setSlideElement(doc, id, { id: 'e1', type: 'shape', shape: 'rectangle', text: 'Box', rotation: 15, ...base, z: 2 });
    setSlideElement(doc, id, { id: 'e2', type: 'richText', ...base, z: 1 });
    setSlideElement(doc, id, {
      id: 'e3',
      type: 'table',
      rows: 2,
      columns: 2,
      cells: { [tableCellKey(1, 0)]: { text: 'B1' }, [tableCellKey(0, 1)]: { text: 'A2' } },
      ...base,
      z: 3,
    });

    const elements = doc.getMap(slideMapName(id)).get(SLIDE_ELEMENTS_KEY) as Y.Map<Y.Map<unknown>>;
    const body = elements.get('e2')!.get(ELEMENT_BODY_KEY) as Y.XmlFragment;
    body.insert(0, [paragraph('Hello world'), paragraph('second')]);
    doc.getXmlFragment(notesFragmentName(id)).insert(0, [paragraph('say hi')]);

    const slide = readDeck(doc).slides[0];
    expect(slide.background).toEqual({ kind: 'color', color: '#000' });
    expect(slide.elements.map((e) => e.id)).toEqual(['e2', 'e1', 'e3']);
    expect(slide.elements[0]).toMatchObject({ type: 'richText', text: 'Hello world\nsecond' });
    expect(slide.elements[1]).toMatchObject({ rotation: 15 });
    expect(slide.notes).toBe('say hi');
    expect(deckSearchText([slide])).toBe('Hello world\nsecond\nBox\nA2\nB1\nsay hi');

    removeSlideElement(doc, id, 'e1');
    expect(readDeck(doc).slides[0].elements.map((e) => e.id)).toEqual(['e2', 'e3']);
  });

  it('converges when two copies edit different elements', () => {
    const a = new Y.Doc();
    const id = createSlide(a);
    const b = new Y.Doc();
    sync(a, b);
    setSlideElement(a, id, { id: 'x', type: 'text', text: 'from a', ...base });
    setSlideElement(b, id, { id: 'y', type: 'text', text: 'from b', ...base, z: 1 });
    sync(a, b);
    expect(readDeck(a)).toEqual(readDeck(b));
    expect(readDeck(a).slides[0].elements).toHaveLength(2);
  });

  it('survives encoding and reloading', () => {
    const a = new Y.Doc();
    const id = createSlide(a);
    setSlideElement(a, id, { id: 'x', type: 'text', text: 'kept', ...base });
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(readDeck(b)).toEqual(readDeck(a));
  });
});

describe('deckSearchText', () => {
  it('is empty for an empty deck and skips blank slides', () => {
    expect(deckSearchText([])).toBe('');
    expect(deckSearchText([{ elements: [], notes: '' }, { elements: [], notes: 'n' }])).toBe('n');
  });
});
