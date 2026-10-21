import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';
import * as Y from 'yjs';
import { createStyledDeck, fragmentText, notesFragmentName, readDeck, type RichTextElement, type SlideElement } from '@paradocs/shared';
import { decodeSlidesClip, readPowerPointSlides } from '../src/lib/powerPointClipboard';
import { insertImport, resolveMedia } from '../src/lib/slideImport';
import { parseSlideFile } from '../src/lib/slideImportParse';
import type { ImportedDeck } from '../src/lib/slideImportTypes';
import { fixturePath } from './helpers';

/**
 * A deck as PowerPoint puts copied slides on the clipboard: a .pptx package
 * whose parts sit under `clipboard/` rather than `ppt/`, found through the
 * package relationships.
 */
async function asClipboardPackage(name: string): Promise<Uint8Array> {
  const source = await JSZip.loadAsync(readFileSync(fixturePath(name)));
  const out = new JSZip();
  for (const [path, file] of Object.entries(source.files)) {
    if (file.dir) continue;
    let content: string | Uint8Array = await file.async('uint8array');
    if (/\.(xml|rels)$/.test(path)) content = (await file.async('string')).replace(/\/ppt\//g, '/clipboard/').replace(/"ppt\//g, '"clipboard/');
    out.file(path.replace(/^ppt\//, 'clipboard/'), content);
  }
  return out.generateAsync({ type: 'uint8array' });
}

/** The `ppt/slides` web custom format PowerPoint writes beside its own. */
function slidesClip(bytes: Uint8Array, extra: Record<string, unknown> = {}): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return JSON.stringify({ ccpid: '{x}', packageKey: '{y}', objectCount: 1, isDataCompressed: false, packageSize: bytes.length / 1048576, data: btoa(binary), ...extra });
}

const parseXml = (text: string) => new DOMParser().parseFromString(text, 'text/xml') as unknown as Document;

/** The quarterly deck (4:3) pasted from the clipboard into a new 16:9 deck, its pictures "uploaded". */
async function pasted(): Promise<{ doc: Y.Doc; deck: ImportedDeck }> {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, createStyledDeck('paper'));
  const bytes = decodeSlidesClip(slidesClip(await asClipboardPackage('powerpoint-quarterly.pptx')))!;
  const parsed = await parseSlideFile(bytes, 'PowerPoint slides', { parseXml, fitTo: readDeck(doc).settings.size });
  return { doc, deck: resolveMedia(parsed, new Map(parsed.media.map((m) => [m.key, `/uploads/${m.name}`]))) };
}

const titleOf = (elements: SlideElement[]) => (elements.find((e) => e.type === 'richText') as RichTextElement | undefined)?.text;

describe('reading slides off the clipboard', () => {
  it('decodes the package PowerPoint puts on the clipboard for the web', async () => {
    const bytes = await asClipboardPackage('powerpoint-quarterly.pptx');
    const transfer = { types: ['text/plain', 'ppt/slides'], getData: (type: string) => (type === 'ppt/slides' ? slidesClip(bytes) : '') } as unknown as DataTransfer;
    expect(readPowerPointSlides(transfer)).toEqual(bytes);
  });

  it('reads nothing from anything else', () => {
    const none = { types: ['text/plain'], getData: () => 'hello' } as unknown as DataTransfer;
    expect(readPowerPointSlides(none)).toBeNull();
    expect(decodeSlidesClip('')).toBeNull();
    expect(decodeSlidesClip('not json')).toBeNull();
    expect(decodeSlidesClip(JSON.stringify({ data: 42 }))).toBeNull();
    expect(decodeSlidesClip(JSON.stringify({ data: btoa('not a zip at all') }))).toBeNull();
    expect(decodeSlidesClip(slidesClip(new Uint8Array([0x50, 0x4b, 3, 4, 0]), { isDataCompressed: true }))).toBeNull();
  });

  it('reads the clipboard package like a .pptx, scaled and centred to fit the deck', async () => {
    const bytes = await asClipboardPackage('powerpoint-quarterly.pptx');
    const own = await parseSlideFile(bytes, 'clip', { parseXml });
    expect(own.slides).toHaveLength(5);
    expect(own.size).toEqual({ width: 1440, height: 1080 });

    const fitted = await parseSlideFile(bytes, 'clip', { parseXml, fitTo: { width: 1920, height: 1080 } });
    expect(fitted.size).toEqual({ width: 1920, height: 1080 });
    // 4:3 in 16:9: the same scale (the heights match), moved right by the 240-unit pillarbox.
    const picture = (deck: ImportedDeck) => deck.slides[2].elements.find((e) => e.type === 'image')!;
    expect(picture(fitted).x).toBe(picture(own).x + 240);
    expect(picture(fitted).y).toBe(picture(own).y);
    expect(picture(fitted).width).toBe(picture(own).width);
  });
});

describe('pasting slides into a deck', () => {
  it('adds the slides after the given one, in one transaction, leaving the rest of the deck alone', async () => {
    const { doc, deck } = await pasted();
    const before = readDeck(doc);
    let updates = 0;
    doc.on('update', () => updates++);
    const { slideIds } = insertImport(doc, deck, { index: 1, formatting: 'deck' });
    expect(updates).toBe(1);

    const after = readDeck(doc);
    expect(after.slides.map((s) => s.id)).toEqual([before.slides[0].id, ...slideIds]);
    expect(after.settings).toEqual(before.settings);
    expect(after.themes).toEqual(before.themes);
    expect(after.master).toEqual(before.master);
    expect(after.slides.map((s) => s.hidden)).toEqual([false, false, false, false, true, false]);
    expect(titleOf(after.slides[1].elements)).toBe('Quarterly Review');
    expect(fragmentText(doc.getXmlFragment(notesFragmentName(slideIds[1])))).toBe('Mention the churn numbers.');
  });

  it('puts each slide on the deck layout of the same kind when matching the deck', async () => {
    const { doc, deck } = await pasted();
    const layoutsBefore = readDeck(doc).layouts;
    const { slideIds, layoutIds } = insertImport(doc, deck, { index: 1, formatting: 'deck' });
    const after = readDeck(doc);
    expect(layoutIds).toEqual([]);
    expect(after.layouts).toEqual(layoutsBefore);
    const slides = slideIds.map((id) => after.slides.find((s) => s.id === id)!);
    expect(slides.map((s) => s.layoutId)).toEqual(['title', 'titleAndContent', 'titleOnly', 'titleAndContent', 'sectionHeader']);
    // The title takes the deck's title placeholder: its box and the deck theme's colors, not PowerPoint's.
    const title = slides[0].elements.find((e) => (e as RichTextElement).placeholder === 'title') as RichTextElement;
    expect(title.text).toBe('Quarterly Review');
    expect([title.x, title.y, title.width, title.height]).toEqual([160, 340, 1600, 220]);
    expect(title.fontSize).toBe(64);
  });

  it('brings the source layouts across, looking as they did, when keeping the source formatting', async () => {
    const { doc, deck } = await pasted();
    const { slideIds, layoutIds } = insertImport(doc, deck, { index: 1, formatting: 'source' });
    const after = readDeck(doc);
    expect(layoutIds).toHaveLength(4);
    const added = layoutIds.map((id) => after.layouts.find((l) => l.id === id)!);
    expect(added.map((l) => l.name)).toEqual(['Title Slide (Office Theme)', 'Title and Content (Office Theme)', 'Title Only (Office Theme)', 'Section Header (Office Theme)']);
    for (const layout of added) {
      expect(layout.hideMasterElements).toBe(true);
      // Nothing left for the deck's theme to restyle.
      expect(JSON.stringify(layout)).not.toContain('theme:');
      expect(layout.placeholders.every((p) => p.x !== undefined && p.width !== undefined)).toBe(true);
    }
    const slides = slideIds.map((id) => after.slides.find((s) => s.id === id)!);
    expect(slides[0].layoutId).toBe(layoutIds[0]);
    const title = slides[0].elements.find((e) => (e as RichTextElement).placeholder === 'title') as RichTextElement;
    expect(title.fontFamily).toBe('Carlito');
    expect(JSON.stringify(slides.map((s) => s.elements))).not.toContain('theme:');
    // The paper theme's background is the deck's; a pasted slide keeps the source's white.
    expect(slides[0].frame?.background).toEqual({ kind: 'color', color: '#ffffff' });
  });

  it('reuses the layouts an earlier paste of the same slides brought in', async () => {
    const { doc, deck } = await pasted();
    const first = insertImport(doc, deck, { index: 1, formatting: 'source' });
    const second = insertImport(doc, deck, { index: 1, formatting: 'source' });
    expect(second.layoutIds).toEqual([]);
    const after = readDeck(doc);
    expect(after.slides).toHaveLength(11);
    expect(after.slides.find((s) => s.id === second.slideIds[0])!.layoutId).toBe(first.layoutIds[0]);
  });
});
