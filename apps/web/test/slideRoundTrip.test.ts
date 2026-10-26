import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import * as Y from 'yjs';
import { DOMParser } from '@xmldom/xmldom';
import {
  applyStarterTheme,
  createSlide,
  notesFragmentName,
  readDeck,
  setElementAnimations,
  setSlideElement,
  setSlideLayout,
  writeDeckSettings,
  type DeckSnapshot,
  type RichTextElement,
  type SlideElement,
} from '@paradocs/shared';
import { buildPptx } from '../src/lib/slidesExport/pptx';
import { parseSlideFile } from '../src/lib/slideImportParse';
import { applyImport, resolveMedia } from '../src/lib/slideImport';

const parseXml = (t: string) => new DOMParser().parseFromString(t, 'text/xml') as unknown as Document;

const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

const rich = (id: string, extra: Partial<RichTextElement>): RichTextElement => ({ id, type: 'richText', x: 100, y: 100, width: 800, height: 200, z: 1, ...extra });

function note(text: string): Y.XmlElement {
  const p = new Y.XmlElement('paragraph');
  const t = new Y.XmlText();
  t.insert(0, text);
  p.insert(0, [t]);
  return p;
}

function build(): DeckSnapshot {
  const doc = new Y.Doc();
  applyStarterTheme(doc, 'midnight');
  const one = createSlide(doc, { id: 's1' });
  setSlideLayout(doc, one, 'title');
  setSlideElement(doc, one, rich('t', { placeholder: 'title', paragraphs: [{ runs: [{ text: 'Round trip' }] }] }));
  setSlideElement(doc, one, rich('sub', { placeholder: 'subtitle', paragraphs: [{ runs: [{ text: 'There and back' }] }] }));
  doc.getXmlFragment(notesFragmentName(one)).insert(0, [note('First note'), note('Second note')]);
  doc.getMap('slide:s1').set('transition', { kind: 'fade', durationMs: 700 });

  const two = createSlide(doc, { id: 's2', hidden: true });
  setSlideLayout(doc, two, 'titleAndContent');
  setSlideElement(doc, two, rich('b', { placeholder: 'body', paragraphs: [{ bullet: 'bullet', runs: [{ text: 'One' }] }, { bullet: 'bullet', level: 1, runs: [{ text: 'Two', marks: { italic: true } }] }] }));
  setSlideElement(doc, two, { id: 'pic', type: 'image', url: '/uploads/a.png', x: 100, y: 500, width: 600, height: 400, z: 3 } as SlideElement);
  // Shown smaller than its box, with a margin all round.
  setSlideElement(doc, two, { id: 'inset', type: 'image', url: '/uploads/a.png', crop: { x: -0.1, y: -0.05, width: 1.2, height: 1.1 }, x: 800, y: 500, width: 600, height: 400, z: 4 } as SlideElement);
  doc.getMap('slide:s2').set('transition', { kind: 'push' });

  const three = createSlide(doc, { id: 's3' });
  setSlideElement(doc, three, rich('a1', { x: 1200, y: 100, width: 500, height: 100, paragraphs: [{ runs: [{ text: 'Para one' }] }, { runs: [{ text: 'Para two' }] }] }));
  setSlideElement(doc, three, rich('a2', { x: 1200, y: 250, width: 500, height: 100, paragraphs: [{ runs: [{ text: 'Later' }] }] }));
  setElementAnimations(doc, three, ['a1'], { effect: 'fly', direction: 'left', trigger: 'onClick' });
  setElementAnimations(doc, three, ['a2'], { effect: 'fade', trigger: 'afterPrevious', durationMs: 800 });
  const deck = readDeck(doc);
  doc.destroy();
  return deck;
}

const texts = (els: SlideElement[]) => els.filter((e) => e.type === 'richText').map((e) => (e as RichTextElement).text);

describe('export, then import', () => {
  it('keeps slides, text, notes, theme, layouts, placeholders, transitions and animations', async () => {
    const original = build();
    const exported = await buildPptx(original, {
      title: 'Round trip',
      assets: { image: async () => ({ data: PNG, ext: 'png', width: 1, height: 1 }), media: async () => null, live: async () => null },
    });
    const imported = await parseSlideFile(exported.data, 'round.pptx', { parseXml });
    const doc = new Y.Doc();
    applyImport(doc, resolveMedia(imported, new Map(imported.media.map((m) => [m.key, `/uploads/${m.name}`]))));
    const back = readDeck(doc);

    // Slides: count, order, text, hidden.
    expect(back.slides).toHaveLength(3);
    expect(back.slides.map((s) => s.hidden)).toEqual([false, true, false]);
    expect(texts(back.slides[0].elements)).toEqual(expect.arrayContaining(['Round trip', 'There and back']));
    expect(texts(back.slides[1].elements)).toEqual(expect.arrayContaining(['One\nTwo']));
    expect(texts(back.slides[2].elements)).toEqual(expect.arrayContaining(['Para one\nPara two', 'Later']));
    expect(back.slides[1].elements.some((e) => e.type === 'image')).toBe(true);
    const inset = back.slides[1].elements.find((e) => e.type === 'image' && e.x === 800) as SlideElement & { crop: { x: number; y: number; width: number; height: number } };
    expect(inset.crop.x).toBeCloseTo(-0.1);
    expect(inset.crop.y).toBeCloseTo(-0.05);
    expect(inset.crop.width).toBeCloseTo(1.2);
    expect(inset.crop.height).toBeCloseTo(1.1);

    // Notes.
    expect(back.slides[0].notes).toBe('First note\nSecond note');

    // Theme colors and fonts.
    const theme = original.themes.find((t) => t.id === original.settings.themeId)!;
    const got = back.themes.find((t) => t.id === back.settings.themeId)!;
    for (const slot of ['dark1', 'light1', 'accent1', 'accent2', 'accent3'] as const) expect(got.colors[slot]).toBe(theme.colors[slot]);
    expect(got.fonts.heading).toBe(theme.fonts.heading);
    expect(got.fonts.body).toBe(theme.fonts.body);

    // Layouts and the ties between placeholders and them.
    // The exporter writes the layouts the slides use.
    for (const name of original.slides.map((s) => original.layouts.find((l) => l.id === s.layoutId)!.name)) expect(back.layouts.map((l) => l.name)).toEqual(expect.arrayContaining([name]));
    const titleLayout = back.layouts.find((l) => l.id === back.slides[0].layoutId)!;
    const rt = back.slides[0].elements.filter((e) => e.type === 'richText') as RichTextElement[];
    const t = rt.find((e) => e.text === 'Round trip')!;
    const sub = rt.find((e) => e.text === 'There and back')!;
    expect(titleLayout.placeholders.map((p) => p.id)).toEqual(expect.arrayContaining([t.placeholder!, sub.placeholder!]));
    expect(titleLayout.placeholders.find((p) => p.id === t.placeholder)?.kind).toBe('title');
    expect(titleLayout.placeholders.find((p) => p.id === sub.placeholder)?.kind).toBe('subtitle');

    // Transitions.
    expect(back.slides.map((s) => s.transition.kind)).toEqual(['fade', 'push', 'none']);
    expect(back.slides[0].transition.durationMs).toBe(700);

    // Animations, in order.
    const [a1, a2] = ['Para one\nPara two', 'Later'].map((text) => back.slides[2].elements.find((e) => e.type === 'richText' && (e as RichTextElement).text === text)!);
    expect(a1.animation).toMatchObject({ effect: 'fly', direction: 'left', trigger: 'onClick', order: 0 });
    expect(a2.animation).toMatchObject({ effect: 'fade', trigger: 'afterPrevious', order: 1 });
  });

  it('keeps text margins, wrapping and columns', async () => {
    const doc = new Y.Doc();
    const id = createSlide(doc, { id: 's1' });
    setSlideElement(doc, id, rich('cols', { columns: 2, columnGap: 36, insetLeft: 20, insetTop: 4, insetRight: 30, insetBottom: 0, paragraphs: [{ runs: [{ text: 'Two columns' }] }] }));
    setSlideElement(doc, id, rich('line', { y: 400, wrap: false, paragraphs: [{ runs: [{ text: 'One long line' }] }] }));
    const exported = await buildPptx(readDeck(doc), {
      title: 'Columns',
      assets: { image: async () => null, media: async () => null, live: async () => null },
    });
    doc.destroy();
    const imported = await parseSlideFile(exported.data, 'columns.pptx', { parseXml });
    const boxes = imported.slides[0].elements as RichTextElement[];
    const cols = boxes.find((e) => e.paragraphs?.[0]?.runs[0]?.text === 'Two columns')!;
    expect(cols).toMatchObject({ columns: 2, columnGap: 36, insetLeft: 20, insetTop: 4, insetRight: 30, insetBottom: 0 });
    expect(cols.wrap).not.toBe(false);
    const line = boxes.find((e) => e.paragraphs?.[0]?.runs[0]?.text === 'One long line')!;
    expect(line).toMatchObject({ wrap: false, insetLeft: 12, insetTop: 12, insetRight: 12, insetBottom: 12 });
    expect(line.columns ?? 1).toBe(1);

    // A body that sets no margins gets PowerPoint's: 0.1" at the sides, 0.05" above and below.
    const zip = await JSZip.loadAsync(exported.data);
    const slide = await zip.file('ppt/slides/slide1.xml')!.async('string');
    zip.file('ppt/slides/slide1.xml', slide.replace(/ [lrtb]Ins="\d+"/g, ''));
    const bare = await parseSlideFile(await zip.generateAsync({ type: 'uint8array' }), 'bare.pptx', { parseXml });
    for (const box of bare.slides[0].elements as RichTextElement[]) expect(box).toMatchObject({ insetLeft: 14, insetTop: 7, insetRight: 14, insetBottom: 7 });
  });
});
