import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';
import * as Y from 'yjs';
import { fragmentText, notesFragmentName, readDeck, readSlideOrder, type RichTextElement, type SlideElement, type TableElement } from '@paradocs/shared';
import { applyImport, claimImport, rememberImport, resolveMedia, uploadImportMedia } from '../src/lib/slideImport';
import { parseSlideFile } from '../src/lib/slideImportParse';
import { describeReportItem, mediaUrl, type ImportedDeck } from '../src/lib/slideImportTypes';
import { importFixture } from './helpers';

/** What a slide says, as lines, whichever way the importer stored it. */
function textOf(elements: SlideElement[]): string[] {
  return elements.flatMap((el) => {
    if (el.type === 'richText') return (el.paragraphs ?? []).map((p) => p.runs.map((r) => r.text ?? '').join(''));
    if (el.type === 'table') return Object.values((el as TableElement).cells).map((c) => c.text);
    return [];
  });
}

const reportFeatures = (deck: ImportedDeck) => deck.report.items.map((i) => i.feature);

describe('PowerPoint (python-pptx on the stock template)', () => {
  it('imports slides in order with text, notes, hidden state and transitions', async () => {
    const deck = await importFixture('powerpoint-quarterly.pptx');
    expect(deck.format).toBe('pptx');
    expect(deck.title).toBe('Quarterly Review');
    expect(deck.size).toEqual({ width: 1440, height: 1080 });
    expect(deck.slides).toHaveLength(5);
    expect(textOf(deck.slides[0].elements)).toEqual(['Quarterly Review', 'Finance and Operations']);
    expect(deck.slides[0].notes).toEqual(['Welcome everyone.', 'Keep this to two minutes.']);
    expect(textOf(deck.slides[1].elements)).toContain('Revenue up 12%');
    expect(deck.slides[1].notes).toEqual(['Mention the churn numbers.']);
    expect(deck.slides.map((s) => s.hidden)).toEqual([false, false, false, true, false]);
    expect(deck.slides[4].transition).toEqual({ kind: 'fade', durationMs: 700 });
    expect(deck.slides[4].notes).toEqual(['Open the floor.']);
  });

  it('maps the theme, master and layouts, and keeps placeholders live', async () => {
    const deck = await importFixture('powerpoint-quarterly.pptx');
    expect(deck.theme?.name).toBe('Office Theme');
    expect(deck.theme?.colors.accent1).toBe('#4f81bd');
    expect(deck.theme?.colorMap).toEqual({ background1: 'light1', text1: 'dark1', background2: 'light2', text2: 'dark2' });
    expect(deck.theme?.fonts).toEqual({ heading: 'Carlito', body: 'Carlito' });
    expect(deck.master?.placeholders?.map((p) => p.kind)).toEqual(['title', 'body', 'date', 'footer', 'slideNumber']);
    expect(deck.layouts?.map((l) => l.name)).toEqual(['Title Slide', 'Title and Content', 'Title Only', 'Section Header']);
    expect(deck.layouts?.[0].type).toBe('title');
    // The title slide's subtitle is a layout placeholder, and a slide that does not move it writes no geometry.
    const [title, subtitle] = deck.slides[0].elements as RichTextElement[];
    expect(title.placeholder).toBe('title');
    expect(subtitle.placeholder).toBe('subtitle');
    expect(title.x).toBeUndefined();
    expect(subtitle.width).toBeUndefined();
    const layoutIds = deck.layouts![0].placeholders.map((p) => p.id);
    expect(layoutIds).toContain('subtitle');
  });

  it('keeps run formatting, bullets, levels, numbering and links', async () => {
    const deck = await importFixture('powerpoint-quarterly.pptx');
    const body = deck.slides[1].elements.find((e) => e.type === 'richText' && e.placeholder === 'body') as RichTextElement;
    expect(body.paragraphs?.map((p) => [p.bullet, p.level ?? 0])).toEqual([['bullet', 0], ['bullet', 1], ['bullet', 0]]);
    const runs = body.paragraphs![2].runs;
    expect(runs[0]).toEqual({ text: 'Bold ', marks: { bold: true } });
    expect(runs[1].marks).toEqual({ italic: true });
    expect(runs[2].marks).toMatchObject({ color: '#c00000', fontSize: 56 });
    expect(runs[3].marks?.link).toBe('https://example.com/report');
    const appendix = deck.slides[3].elements.find((e) => e.type === 'richText' && e.placeholder === 'body') as RichTextElement;
    expect(appendix.paragraphs?.map((p) => p.bullet)).toEqual(['number', 'number']);
  });

  it('imports pictures with crop, tables with merges, shapes, lines and groups', async () => {
    const deck = await importFixture('powerpoint-quarterly.pptx');
    const els = deck.slides[2].elements;
    const image = els.find((e) => e.type === 'image') as SlideElement & { url: string; crop?: unknown };
    expect(image.url).toBe(mediaUrl('m1'));
    expect(image.crop).toEqual({ x: 0.1, y: 0, width: 0.8, height: 1 });
    expect(deck.media).toHaveLength(1);
    expect(deck.media[0].mimeType).toBe('image/png');
    const table = els.find((e) => e.type === 'table') as TableElement;
    expect(table.rows).toBe(3);
    expect(table.columns).toBe(3);
    expect(table.cells['0:0']).toMatchObject({ text: 'Region', colSpan: 2 });
    expect(table.cells['1:2']).toMatchObject({ text: '30', fill: '#fff2cc' });
    expect(table.headerRow).toBe(true);
    const shapes = els.filter((e) => e.type === 'shape').map((e) => (e as { shape: string }).shape);
    expect(shapes).toEqual(expect.arrayContaining(['roundRect', 'arrowRight', 'line', 'ellipse']));
    // Group members are flattened onto the slide.
    expect(shapes.filter((s) => s === 'ellipse')).toHaveLength(2);
    expect(textOf(els)).toContain('On track');
  });

  it('maps click animations to build animations in timeline order', async () => {
    const deck = await importFixture('powerpoint-quarterly.pptx');
    const [title, body] = deck.slides[4].elements as (RichTextElement & { animation?: unknown })[];
    expect(title.animation).toMatchObject({ effect: 'fade', trigger: 'onClick', order: 0 });
    expect(body.animation).toMatchObject({ effect: 'fly', trigger: 'onClick', order: 1, direction: 'bottom' });
  });

  it('reports what it approximated', async () => {
    const deck = await importFixture('powerpoint-quarterly.pptx');
    expect(reportFeatures(deck)).toEqual(expect.arrayContaining(['Shapes without an equivalent', 'Table styles']));
    const hexagon = deck.report.items.find((i) => i.feature === 'Shapes without an equivalent')!;
    expect(hexagon.slides).toEqual([3]);
    expect(describeReportItem(hexagon)).toContain('slide 3');
  });

  it('follows the slide list, not the order of the relationships, in a reordered deck', async () => {
    // PowerPoint keeps a slide's relationship when it is moved; only p:sldIdLst says where it now sits.
    const { readFileSync } = await import('node:fs');
    const { fixturePath } = await import('./helpers');
    const zip = await JSZip.loadAsync(readFileSync(fixturePath('powerpoint-quarterly.pptx')));
    const presentation = await zip.file('ppt/presentation.xml')!.async('string');
    const ids = ['rId11', 'rId7', 'rId12', 'rId9', 'rId10'].map((rid, i) => `<p:sldId id="${256 + i}" r:id="${rid}"/>`).join('');
    zip.file('ppt/presentation.xml', presentation.replace(/<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/, `<p:sldIdLst>${ids}</p:sldIdLst>`));
    const deck = await parseSlideFile(await zip.generateAsync({ type: 'uint8array' }), 'reordered.pptx', {
      parseXml: (t) => new DOMParser().parseFromString(t, 'text/xml') as unknown as Document,
    });
    expect(deck.slides).toHaveLength(5);
    expect(deck.slides.map((s) => s.hidden)).toEqual([true, false, false, false, false]);
    expect(textOf(deck.slides[1].elements)).toEqual(['Quarterly Review', 'Finance and Operations']);
    expect(textOf(deck.slides[3].elements)).toContain('Revenue up 12%');
    expect(deck.slides[2].transition).toEqual({ kind: 'fade', durationMs: 700 });
  });
});

describe('Google Slides export', () => {
  it('imports a 16:9 deck with explicit geometry, Arial text, a table and notes', async () => {
    const deck = await importFixture('google-slides-export.pptx');
    expect(deck.size).toEqual({ width: 1920, height: 1080 });
    expect(deck.title).toBe('Team offsite');
    expect(deck.slides).toHaveLength(3);
    expect(deck.layouts?.map((l) => l.name)).toEqual(['TITLE', 'TITLE_AND_BODY']);
    expect(textOf(deck.slides[0].elements)).toEqual(['Team offsite', 'Planning for next year']);
    expect(textOf(deck.slides[1].elements)).toEqual(['Agenda', 'Agenda', 'Welcome', 'Goals', 'Budget', 'Book the venue']);
    expect(deck.slides[1].notes).toEqual(['Walk through each agenda item.', 'Leave time for questions.']);
    expect(deck.slides[0].notes).toEqual(['Open with the offsite photo.']);
    expect(deck.slides[2].transition?.kind).toBe('push');
    expect(deck.media.map((m) => m.mimeType)).toEqual(['image/png']);
    const table = deck.slides[2].elements.find((e) => e.type === 'table') as TableElement;
    expect(table.cells['0:0']).toMatchObject({ text: 'Item', bold: true, fill: '#d9ead3' });
    expect(table.cells['2:1'].text).toBe('$2,500');
  });

  it('writes geometry only where a slide moves a placeholder', async () => {
    const deck = await importFixture('google-slides-export.pptx');
    const [title, body] = deck.slides[1].elements as RichTextElement[];
    expect(title.x).toBeUndefined();
    expect(body.x).toBeGreaterThan(0);
    expect(body.width).toBe(840);
    // The layout's own title style is a difference from the master and so is kept.
    const titleLayout = deck.layouts![0].placeholders.find((p) => p.id === 'title')!;
    expect(titleLayout.style?.align).toBe('center');
  });

  it('maps fonts through the Office font map and leaves others as written', async () => {
    const deck = await importFixture('google-slides-export.pptx');
    expect(deck.theme?.fonts).toEqual({ heading: 'Liberation Sans', body: 'Liberation Sans' });
    const label = deck.slides[1].elements.find((e) => e.type === 'richText' && JSON.stringify(e).includes('Book the venue')) as RichTextElement;
    expect(label.paragraphs![0].runs[0].marks).toMatchObject({ fontFamily: 'Roboto', bold: true, color: '#ffffff' });
  });
});

describe('Keynote export', () => {
  it('flattens groups with their transforms and reports what it could not carry', async () => {
    const deck = await importFixture('keynote-export.pptx');
    expect(deck.size).toEqual({ width: 1920, height: 1080 });
    expect(deck.slides).toHaveLength(2);
    const rects = deck.slides[1].elements.filter((e) => e.type === 'shape' && (e as { fill?: string }).fill !== 'transparent');
    // The group is twice the size of its child space, so two 1016000-EMU squares become 320 units each.
    expect(rects.slice(0, 2).map((e) => [e.x, e.width])).toEqual([[160, 320], [480, 320]]);
    const rotated = deck.slides[1].elements.find((e) => e.type === 'richText') as RichTextElement;
    expect(rotated.rotation).toBe(-20);
    expect(rotated.paragraphs![0].runs[0].marks).toMatchObject({ italic: true });

    expect(reportFeatures(deck)).toEqual(expect.arrayContaining(['Charts', 'Pictures and media in .emf format', 'Freeform shapes', 'Links to slides, files and actions']));
    const dropped = deck.report.items.filter((i) => i.kind === 'dropped').map((i) => i.feature);
    expect(dropped).toEqual(expect.arrayContaining(['Charts', 'Pictures and media in .emf format']));
    // The chart's place is marked rather than silently empty.
    expect(deck.slides[1].elements.some((e) => e.type === 'shape' && (e as { text?: string }).text === 'Chart (not imported)')).toBe(true);
    // Only the PNG made it into the media list; the EMF did not.
    expect(deck.media.map((m) => m.name)).toEqual(['image2.png']);
  });

  it('draws freeform shapes to pictures when the host can', async () => {
    const calls: number[] = [];
    const deck = await importFixture('keynote-export.pptx', {
      rasterize: async (shape) => {
        calls.push(shape.paths[0].commands.length);
        return new Uint8Array([137, 80, 78, 71]);
      },
    });
    expect(calls).toEqual([4]);
    expect(deck.media.some((m) => m.name.startsWith('shape-'))).toBe(true);
    const freeform = deck.report.items.find((i) => i.feature === 'Freeform shapes')!;
    expect(freeform.detail).toContain('pictures');
    expect(deck.slides[1].elements.filter((e) => e.type === 'image')).toHaveLength(2);
  });
});

describe('LibreOffice Impress', () => {
  it('imports a .pptx with a gradient background, a fade transition, video and a hidden slide', async () => {
    const deck = await importFixture('libreoffice-impress.pptx');
    expect(deck.size).toEqual({ width: 1440, height: 1080 });
    expect(deck.slides).toHaveLength(3);
    expect(deck.slides[0].background).toMatchObject({ kind: 'gradient', stops: [{ offset: 0, color: '#1f3864' }, { offset: 1, color: '#2e75b6' }] });
    // DrawingML's top-to-bottom is the model's 180 degrees.
    expect((deck.slides[0].background as { angle: number }).angle).toBe(180);
    expect(deck.slides[0].transition).toEqual({ kind: 'fade', durationMs: 1200 });
    expect(deck.layouts?.[1].hideMasterElements).toBe(true);
    expect(deck.master?.background).toEqual({ kind: 'color', color: 'theme:background1' });
    const video = deck.slides[1].elements.find((e) => e.type === 'video')!;
    expect((video as { url: string }).url).toMatch(/^import-media:/);
    expect(deck.media.map((m) => m.mimeType)).toEqual(['video/mp4']);
    expect(deck.slides.map((s) => s.hidden)).toEqual([false, false, true]);
    expect(deck.report.items).toEqual([]);
  });

  it('imports an .odp: text styles, lists, links, a table, a picture, notes, a hidden slide, a transition and an animation', async () => {
    const deck = await importFixture('libreoffice-impress.odp');
    expect(deck.format).toBe('odp');
    expect(deck.title).toBe('Site survey');
    expect(deck.size).toEqual({ width: 1920, height: 1080 });
    expect(deck.slides).toHaveLength(2);
    expect(deck.master?.background).toEqual({ kind: 'color', color: '#f2f2f2' });

    const [title, outline] = deck.slides[0].elements as (RichTextElement & { animation?: unknown })[];
    expect(title.paragraphs![0]).toMatchObject({ align: 'center', runs: [{ text: 'Site survey', marks: { bold: true } }] });
    expect(outline.paragraphs!.map((p) => [p.bullet, p.level ?? 0, p.runs.map((r) => r.text).join('')])).toEqual([
      ['bullet', 0, 'Findings urgent'],
      ['bullet', 1, 'Access road'],
      ['number', 0, 'Next steps plan'],
    ]);
    expect(outline.paragraphs![0].runs[1].marks).toMatchObject({ bold: true, color: '#cc0000' });
    expect(outline.paragraphs![2].runs[1].marks?.link).toBe('https://example.com/plan');
    expect(outline.animation).toMatchObject({ effect: 'fade', trigger: 'onClick', order: 0 });
    expect(deck.slides[0].notes).toEqual(['Remember the access road photos.', 'Second note line.']);
    expect(deck.slides[0].transition).toMatchObject({ kind: 'fade' });

    expect(deck.slides[1].hidden).toBe(true);
    const els = deck.slides[1].elements;
    expect(els.find((e) => e.type === 'shape')).toMatchObject({ shape: 'roundRect', fill: '#ff9900', stroke: '#663300' });
    expect(els.find((e) => e.type === 'table')).toMatchObject({ rows: 2, columns: 2 });
    expect((els.find((e) => e.type === 'table') as TableElement).cells['0:0']).toMatchObject({ text: 'Totals', colSpan: 2, fill: '#d9ead3' });
    expect(els.filter((e) => e.type === 'image')).toHaveLength(1);
    expect(deck.media.map((m) => m.name)).toEqual(['chart.png']);
  });
});

describe('applying a deck', () => {
  it('writes a whole deck into a Y.Doc in one transaction and reads back', async () => {
    const deck = await importFixture('powerpoint-quarterly.pptx');
    // Pretend the pictures were uploaded.
    const resolved = resolveMedia(deck, new Map(deck.media.map((m) => [m.key, `/uploads/${m.name}`])));
    const doc = new Y.Doc();
    let updates = 0;
    doc.on('update', () => updates++);
    applyImport(doc, resolved);
    expect(updates).toBe(1);

    const snapshot = readDeck(doc);
    expect(snapshot.settings.size).toEqual({ width: 1440, height: 1080 });
    expect(snapshot.slides).toHaveLength(5);
    expect(snapshot.slides.map((s) => s.hidden)).toEqual([false, false, false, true, false]);
    expect(snapshot.slides[0].notes).toBe('Welcome everyone.\nKeep this to two minutes.');
    expect(snapshot.themes.find((t) => t.id === snapshot.settings.themeId)?.colors.accent1).toBe('#4f81bd');
    expect(snapshot.layouts.map((l) => l.name)).toEqual(expect.arrayContaining(['Title Slide', 'Title and Content']));
    expect(snapshot.layouts.every((l) => l.id.startsWith('layout-'))).toBe(true);
    expect(snapshot.slides[0].layoutId).toBe(snapshot.layouts.find((l) => l.name === 'Title Slide')!.id);
    expect(snapshot.slides[4].transition.kind).toBe('fade');

    const picture = snapshot.slides[2].elements.find((e) => e.type === 'image') as SlideElement & { url: string };
    expect(picture.url).toBe('/uploads/image1.png');
    const [title] = snapshot.slides[0].elements.filter((e) => e.type === 'richText') as RichTextElement[];
    expect(title.text).toBe('Quarterly Review');
    // Inheritance is live: the title carries no geometry of its own, but resolves to the layout's.
    expect(title.placeholder).toBe('title');
    expect(snapshot.slides[0].frame).toBeDefined();
    const order = readSlideOrder(doc);
    expect(fragmentText(doc.getXmlFragment(notesFragmentName(order[1])))).toBe('Mention the churn numbers.');
  });

  it('replaces what was there, and applies an .odp that has no layouts', async () => {
    const doc = new Y.Doc();
    applyImport(doc, resolveMedia(await importFixture('libreoffice-impress.pptx'), new Map([['m1', '/uploads/clip.mp4']])));
    expect(readDeck(doc).slides).toHaveLength(3);
    const odp = await importFixture('libreoffice-impress.odp');
    applyImport(doc, resolveMedia(odp, new Map([['m1', '/uploads/chart.png']])));
    const snapshot = readDeck(doc);
    expect(snapshot.slides).toHaveLength(2);
    expect(snapshot.slides[1].hidden).toBe(true);
    expect(snapshot.slides[0].notes).toBe('Remember the access road photos.\nSecond note line.');
    // Every slide is on a layout that exists.
    for (const slide of snapshot.slides) expect(snapshot.layouts.some((l) => l.id === slide.layoutId)).toBe(true);
  });

  it('hands a parsed deck over once, as the editor opens', async () => {
    const deck = await importFixture('libreoffice-impress.odp');
    rememberImport('p1', deck);
    expect(claimImport('p1')).toBe(deck);
    expect(claimImport('p1')).toBeNull();
  });

  it('leaves out what could not be uploaded and says so', async () => {
    const deck = await importFixture('google-slides-export.pptx');
    const { urls, failed } = await uploadImportMedia(deck, async () => {
      throw new Error('image1.png is larger than the 1 MB limit');
    });
    expect(failed).toHaveLength(1);
    const resolved = resolveMedia(deck, urls, failed);
    expect(resolved.slides[1].elements.some((e) => e.type === 'image')).toBe(false);
    const item = resolved.report.items.find((i) => i.feature === 'Pictures and media that could not be uploaded')!;
    expect(item).toMatchObject({ kind: 'dropped', slides: [2] });
    expect(item.detail).toContain('image1.png');
    expect(resolved.media).toEqual([]);
  });
});

describe('bad files', () => {
  const parse = (bytes: Uint8Array, name: string) => parseSlideFile(bytes, name, { parseXml: (t) => new DOMParser().parseFromString(t, 'text/xml') as unknown as Document });

  it('refuses a file that is not a zip', async () => {
    await expect(parse(new TextEncoder().encode('hello'), 'x.pptx')).rejects.toThrow(/not a readable presentation/);
  });

  it('refuses a zip that is not a presentation', async () => {
    const zip = new JSZip();
    zip.file('readme.txt', 'hi');
    await expect(parse(await zip.generateAsync({ type: 'uint8array' }), 'x.pptx')).rejects.toThrow(/not a PowerPoint/);
  });
});

describe('a large deck', () => {
  it('imports 100 slides and ~50 MB of pictures without reading media twice', async () => {
    // Built from the PowerPoint fixture's own parts: one slide repeated 100 times, each with the same big picture.
    const { readFileSync } = await import('node:fs');
    const { fixturePath } = await import('./helpers');
    const source = await JSZip.loadAsync(readFileSync(fixturePath('powerpoint-quarterly.pptx')));
    const zip = new JSZip();
    for (const name of Object.keys(source.files)) if (!source.files[name].dir && !/slides\/|notesSlides\/|media\//.test(name)) zip.file(name, await source.files[name].async('uint8array'));
    const slideXml = await source.file('ppt/slides/slide3.xml')!.async('string');
    const slideRels = await source.file('ppt/slides/_rels/slide3.xml.rels')!.async('string');
    const big = new Uint8Array(1_600_000);
    for (let i = 0; i < big.length; i += 4096) big[i] = (i / 4096) & 255;
    const count = 100;
    let ids = '';
    let presRels = (await source.file('ppt/_rels/presentation.xml.rels')!.async('string')).replace(/<Relationship [^>]*relationships\/slide"[^>]*\/>/g, '');
    for (let i = 1; i <= count; i++) {
      zip.file(`ppt/slides/slide${i}.xml`, slideXml);
      // Thirty distinct pictures, the rest shared, ~48 MB in all.
      zip.file(`ppt/slides/_rels/slide${i}.xml.rels`, slideRels.replace('../media/image1.png', `../media/big${i % 30}.png`));
      ids += `<p:sldId id="${300 + i}" r:id="rIdS${i}"/>`;
      presRels = presRels.replace('</Relationships>', `<Relationship Id="rIdS${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i}.xml"/></Relationships>`);
    }
    for (let i = 0; i < 30; i++) zip.file(`ppt/media/big${i}.png`, big.map((b, j) => (b + i + j) & 255));
    zip.file('ppt/_rels/presentation.xml.rels', presRels);
    const presentation = (await source.file('ppt/presentation.xml')!.async('string')).replace(/<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/, `<p:sldIdLst>${ids}</p:sldIdLst>`);
    zip.file('ppt/presentation.xml', presentation);
    const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
    expect(bytes.length).toBeGreaterThan(45_000_000);

    // Even on one thread the parse yields between slides; measure the longest stretch it holds the event loop.
    let last = Date.now();
    let worstGap = 0;
    const timer = setInterval(() => {
      worstGap = Math.max(worstGap, Date.now() - last);
      last = Date.now();
    }, 10);
    const heapBefore = process.memoryUsage().heapUsed;
    const started = Date.now();
    const deck = await parseSlideFile(bytes, 'big.pptx', { parseXml: (t) => new DOMParser().parseFromString(t, 'text/xml') as unknown as Document });
    const elapsed = Date.now() - started;
    clearInterval(timer);
    const rssMb = Math.round(process.memoryUsage().rss / 1e6);
    console.log(`large deck: ${Math.round(bytes.length / 1e6)} MB, ${count} slides, parsed in ${elapsed} ms, longest event-loop stall ${worstGap} ms, heap +${Math.round((process.memoryUsage().heapUsed - heapBefore) / 1e6)} MB, rss ${rssMb} MB`);
    expect(elapsed).toBeLessThan(20_000);
    expect(worstGap).toBeLessThan(1500);
    expect(deck.slides).toHaveLength(count);
    expect(deck.media).toHaveLength(30);
    expect(deck.media.reduce((n, m) => n + m.data.length, 0)).toBeGreaterThan(45_000_000);
  }, 60_000);
});

describe('the import runs in a worker', () => {
  it('hands the file to a module Web Worker and parses nothing on the page thread', async () => {
    const created: { url: URL; options: WorkerOptions | undefined; transferred: boolean }[] = [];
    class FakeWorker {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: ErrorEvent) => void) | null = null;
      constructor(url: URL, options?: WorkerOptions) {
        created.push({ url, options, transferred: false });
      }
      postMessage(message: { data: ArrayBuffer }, transfer?: Transferable[]) {
        created[created.length - 1].transferred = transfer?.[0] === message.data;
        const deck = { fileName: 'a.pptx', title: 'A', format: 'pptx', size: { width: 1920, height: 1080 }, settings: {}, slides: [], media: [], report: { items: [] } };
        queueMicrotask(() => this.onmessage?.({ data: { type: 'progress', progress: { stage: 'parsing', done: 1, total: 2, message: 'Converting slide 1 of 2' } } } as MessageEvent));
        queueMicrotask(() => this.onmessage?.({ data: { type: 'done', deck } } as MessageEvent));
      }
      terminate() {}
    }
    (globalThis as unknown as { Worker: unknown }).Worker = FakeWorker;
    try {
      const { importSlideFile } = await import('../src/lib/slideImportClient');
      const messages: string[] = [];
      const deck = await importSlideFile(new File([new Uint8Array([1, 2, 3])], 'a.pptx'), (p) => messages.push(p.message));
      expect(deck.title).toBe('A');
      expect(created).toHaveLength(1);
      expect(String(created[0].url)).toContain('slideImportWorker');
      expect(created[0].options).toEqual({ type: 'module' });
      expect(created[0].transferred).toBe(true);
      expect(messages).toContain('Converting slide 1 of 2');
    } finally {
      delete (globalThis as unknown as { Worker?: unknown }).Worker;
    }
  });
});
