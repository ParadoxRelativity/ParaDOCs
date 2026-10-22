import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import * as Y from 'yjs';
import {
  applyStarterTheme,
  createSlide,
  notesFragmentName,
  readDeck,
  setElementAnimations,
  setSlideElement,
  setSlideLayout,
  setTableCells,
  themeColor,
  updateLayout,
  updateMaster,
  writeDeckSettings,
  type DeckSnapshot,
  type RichTextElement,
  type SlideElement,
  type TableElement,
} from '@paradocs/shared';
import { buildPptx, type ExportAssets, type LiveSnapshot, type PptxExportResult } from './pptx';

// A 1x1 PNG.
const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

function assets(live: (el: SlideElement) => LiveSnapshot | null = () => null): ExportAssets {
  return {
    image: async (url) => (url.includes('missing') ? null : { data: PNG, ext: 'png', width: 800, height: 400 }),
    media: async () => null,
    live: async (el) => live(el),
  };
}

const rich = (id: string, extra: Partial<RichTextElement>): RichTextElement => ({ id, type: 'richText', x: 100, y: 100, width: 800, height: 200, z: 1, ...extra });

function paragraph(text: string): Y.XmlElement {
  const p = new Y.XmlElement('paragraph');
  const t = new Y.XmlText();
  t.insert(0, text);
  p.insert(0, [t]);
  return p;
}

/** A small but varied deck: dark starter theme, footer and numbers on, three slides. */
function fixture() {
  const doc = new Y.Doc();
  applyStarterTheme(doc, 'midnight');
  writeDeckSettings(doc, { showFooter: true, footerText: 'Quarterly review', showSlideNumber: true });

  const one = createSlide(doc, { id: 's1' });
  setSlideLayout(doc, one, 'title');
  setSlideElement(doc, one, rich('t', { placeholder: 'title', paragraphs: [{ runs: [{ text: 'Hello ' }, { text: 'world', marks: { bold: true, color: '#ff0000' } }, { text: ' styled', marks: { underline: true, strike: true, highlight: '#ffff00', fontSize: 40, fontFamily: 'Caladea', link: 'https://example.com/?a=1&b=2' } }] }] }));
  setSlideElement(doc, one, rich('sub', { placeholder: 'subtitle', paragraphs: [{ runs: [{ text: 'A subtitle' }] }] }));
  doc.getXmlFragment(notesFragmentName(one)).insert(0, [paragraph('First note'), paragraph('Second note')]);
  doc.getMap('slide:s1').set('transition', { kind: 'fade', durationMs: 700 });

  const two = createSlide(doc, { id: 's2', hidden: true });
  setSlideLayout(doc, two, 'titleAndContent');
  setSlideElement(doc, two, rich('b', { placeholder: 'body', paragraphs: [{ bullet: 'bullet', runs: [{ text: 'One' }] }, { bullet: 'bullet', level: 1, runs: [{ text: 'Two', marks: { italic: true } }] }, { bullet: 'number', runs: [{ text: 'Three', marks: { link: 'https://example.com' } }] }] }));
  setSlideElement(doc, two, { id: 'box', type: 'shape', shape: 'star', x: 1200, y: 400, width: 300, height: 300, z: 2, fill: themeColor('accent1', 40), text: 'Hi' } as SlideElement);
  setSlideElement(doc, two, { id: 'pic', type: 'image', url: '/uploads/a.png', x: 100, y: 500, width: 600, height: 400, z: 3, alt: 'A picture' } as SlideElement);
  setSlideElement(doc, two, { id: 'gone', type: 'image', url: '/uploads/missing.png', x: 100, y: 500, width: 100, height: 100, z: 4 } as SlideElement);
  doc.getMap('slide:s2').set('background', { kind: 'gradient', angle: 90, stops: [{ offset: 0, color: '#112233' }, { offset: 1, color: themeColor('accent2') }] });
  doc.getMap('slide:s2').set('transition', { kind: 'push' });

  const three = createSlide(doc, { id: 's3' });
  const table: TableElement = {
    id: 'tbl',
    type: 'table',
    x: 100,
    y: 100,
    width: 1000,
    height: 400,
    z: 1,
    rows: 3,
    columns: 3,
    columnWidths: [2, 1, 1],
    headerRow: true,
    cells: { '0:0': { text: 'Name' }, '0:1': { text: 'Qty', align: 'right' }, '1:0': { text: 'Merged', colSpan: 2, bold: true }, '2:2': { text: 'End' } },
  };
  setSlideElement(doc, three, table);
  setTableCells(doc, three, 'tbl', {});
  setSlideElement(doc, three, { id: 'cell', type: 'sheetCell', spreadsheetId: 'x', sheetId: 'y', cell: 'A1', label: 'SECRET LABEL', x: 100, y: 600, width: 500, height: 250, z: 2 } as SlideElement);
  setSlideElement(doc, three, { id: 'chart', type: 'sheetChart', spreadsheetId: 'x', sheetId: 'y', chartId: 'c', label: 'SECRET CHART', x: 700, y: 520, width: 900, height: 500, z: 3 } as SlideElement);
  setSlideElement(doc, three, rich('a1', { x: 1200, y: 100, width: 500, height: 100, paragraphs: [{ runs: [{ text: 'Para one' }] }, { runs: [{ text: 'Para two' }] }] }));
  setSlideElement(doc, three, rich('a2', { x: 1200, y: 250, width: 500, height: 100, paragraphs: [{ runs: [{ text: 'Later' }] }] }));
  setElementAnimations(doc, three, ['a1'], { effect: 'fly', direction: 'left', trigger: 'onClick', byParagraph: true });
  setElementAnimations(doc, three, ['a2'], { effect: 'fade', trigger: 'afterPrevious', durationMs: 800 });

  const deck = readDeck(doc);
  doc.destroy();
  return deck;
}

async function unzip(result: PptxExportResult) {
  const zip = await JSZip.loadAsync(result.data);
  return {
    zip,
    text: async (path: string) => {
      const file = zip.file(path);
      if (!file) throw new Error(`missing ${path}`);
      return file.async('string');
    },
    names: Object.keys(zip.files),
  };
}

const live = (el: SlideElement): LiveSnapshot | null => {
  if (el.type === 'sheetCell') return { kind: 'cell', display: '$1,200', caption: 'Revenue · Sales › Q3', isError: false };
  if (el.type === 'sheetChart') {
    return { kind: 'chart', title: 'Revenue', chartKind: 'bar', caption: '', data: { categories: ['Q1', 'Q2'], series: [{ name: 'Sales', values: [3, 5] }] } };
  }
  return null;
};

describe('buildPptx', () => {
  let deck: DeckSnapshot;
  let pkg: Awaited<ReturnType<typeof unzip>>;
  let result: PptxExportResult;

  it('writes a package with the right parts', async () => {
    deck = fixture();
    result = await buildPptx(deck, { title: 'Test deck', assets: assets(live) });
    pkg = await unzip(result);
    // PPTX_DUMP=/some/file.pptx keeps the export, to open it in another program.
    if (process.env.PPTX_DUMP) writeFileSync(process.env.PPTX_DUMP, result.data);
    const slides = pkg.names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
    expect(slides).toHaveLength(3);
    const layouts = pkg.names.filter((n) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(n));
    expect(layouts).toHaveLength(deck.layouts.length);
    expect(pkg.names).toContain('ppt/notesSlides/notesSlide1.xml');
    expect(pkg.names.some((n) => n.startsWith('ppt/charts/chart'))).toBe(true);
    // Every XML part is well formed.
    for (const name of pkg.names.filter((n) => /\.(xml|rels)$/.test(n))) {
      const doc = new DOMParserLike().parse(await pkg.text(name));
      expect(doc, name).toBe(true);
    }
  });

  it('is a consistent package: every relationship, override and shape id resolves', async () => {
    const names = new Set(pkg.names.filter((n) => !n.endsWith('/')));
    const types = await pkg.text('[Content_Types].xml');
    const overridden = new Set([...types.matchAll(/<Override PartName="\/([^"]+)"/g)].map((m) => m[1]));
    for (const part of overridden) expect(names.has(part), `override ${part}`).toBe(true);
    const defaults = new Set([...types.matchAll(/<Default Extension="([^"]+)"/g)].map((m) => m[1]));
    for (const name of names) {
      if (name === '[Content_Types].xml') continue;
      expect(overridden.has(name) || defaults.has(name.split('.').pop()!), `content type of ${name}`).toBe(true);
    }
    for (const rels of [...names].filter((n) => n.endsWith('.rels'))) {
      const owner = rels.replace('_rels/', '').replace(/\.rels$/, '');
      const dir = owner.includes('/') ? owner.slice(0, owner.lastIndexOf('/')) : '';
      for (const m of (await pkg.text(rels)).matchAll(/<Relationship\b[^>]*>/g)) {
        if (m[0].includes('TargetMode="External"')) continue;
        const target = /Target="([^"]+)"/.exec(m[0])![1];
        const resolved: string[] = [];
        for (const part of (target.startsWith('/') ? target.slice(1) : `${dir}/${target}`).split('/')) {
          if (part === '..') resolved.pop();
          else if (part && part !== '.') resolved.push(part);
        }
        expect(names.has(resolved.join('/')), `${rels} -> ${target}`).toBe(true);
      }
    }
    // Relationship ids used in a part exist in its rels.
    for (const name of [...names].filter((n) => /^ppt\/(slides|slideLayouts|slideMasters)\/[^/]+\.xml$/.test(n))) {
      const rels = await pkg.text(name.replace(/([^/]+)$/, '_rels/$1.rels'));
      for (const m of (await pkg.text(name)).matchAll(/r:(?:embed|link|id)="([^"]+)"/g)) expect(rels.includes(`Id="${m[1]}"`), `${name} ${m[1]}`).toBe(true);
    }
    // Shape ids are unique within a slide.
    for (const name of [...names].filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))) {
      const ids = [...(await pkg.text(name)).matchAll(/<p:cNvPr id="(\d+)"/g)].map((m) => m[1]);
      expect(new Set(ids).size, name).toBe(ids.length);
    }
  });

  it('sets the slide size from the deck', async () => {
    const presentation = await pkg.text('ppt/presentation.xml');
    expect(presentation).toContain('<p:sldSz cx="12192000" cy="6858000"');
    expect(presentation.match(/<p:sldId /g)).toHaveLength(3);
  });

  it('writes the theme colors, fonts and color map', async () => {
    const theme = await pkg.text('ppt/theme/theme1.xml');
    expect(theme).toContain('<a:clrScheme name="Midnight">');
    expect(theme).toContain('<a:dk1><a:srgbClr val="0F172A"/></a:dk1>');
    expect(theme).toContain('<a:accent1><a:srgbClr val="38BDF8"/></a:accent1>');
    expect(theme).toMatch(/<a:majorFont><a:latin typeface="Inter"\/>/);
    const master = await pkg.text('ppt/slideMasters/slideMaster1.xml');
    // Midnight swaps text and background.
    expect(master).toContain('<p:clrMap bg1="dk1" tx1="lt1" bg2="dk2" tx2="lt2"');
    expect(master).toContain('<p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill>');
    expect(master.match(/<p:sldLayoutId /g)).toHaveLength(deck.layouts.length);
    expect(master).toContain('type="sldNum"');
  });

  it('writes a layout per deck layout with placeholders', async () => {
    const files = pkg.names.filter((n) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(n));
    const xml = await Promise.all(files.map((f) => pkg.text(f)));
    const title = xml.find((x) => x.includes('<p:cSld name="Title">'))!;
    expect(title).toContain('type="title"');
    expect(title).toContain('<p:ph type="ctrTitle"/>');
    expect(title).toContain('<p:ph type="subTitle" idx="1"/>');
    expect(title).toContain('<p:ph type="ftr" idx="11"/>');
    expect(xml.some((x) => x.includes('<p:cSld name="Two content">') && x.includes('type="twoObj"'))).toBe(true);
    expect(xml.some((x) => x.includes('name="DEFAULT"'))).toBe(false);
  });

  it('ties placeholder text boxes to their layout placeholder and keeps formatting', async () => {
    const slide = await pkg.text('ppt/slides/slide1.xml');
    expect(slide).toContain('<p:ph type="ctrTitle"/>');
    expect(slide).toContain('<p:ph type="subTitle" idx="1"/>');
    expect(slide).toContain('<a:t>Hello </a:t>');
    expect(slide).toMatch(/b="1"[^>]*>(?:<a:solidFill><a:srgbClr val="FF0000"\/>)/);
    const rels = await pkg.text('ppt/slides/_rels/slide1.xml.rels');
    const target = /slideLayouts\/(slideLayout\d+\.xml)/.exec(rels)![1];
    expect(await pkg.text(`ppt/slideLayouts/${target}`)).toContain('<p:cSld name="Title">');
  });

  it('keeps paragraph properties first and single in every paragraph', async () => {
    for (const name of pkg.names.filter((n) => /^ppt\/(slides|slideLayouts|slideMasters)\/[^/]+\.xml$/.test(n))) {
      for (const paragraph of (await pkg.text(name)).match(/<a:p>[\s\S]*?<\/a:p>/g) ?? []) {
        expect((paragraph.match(/<a:pPr\b/g) ?? []).length, name).toBeLessThanOrEqual(1);
        if (paragraph.includes('<a:pPr')) expect(paragraph.indexOf('<a:pPr'), name).toBe(5);
      }
    }
  });

  it('carries run formatting', async () => {
    const slide = await pkg.text('ppt/slides/slide1.xml');
    expect(slide).toMatch(/<a:rPr[^>]*sz="2000"[^>]*>[\s\S]*?<a:t> styled<\/a:t>/);
    expect(slide).toMatch(/<a:rPr[^>]*strike="sngStrike"[^>]*u="sng"/);
    expect(slide).toContain('<a:highlight><a:srgbClr val="FFFF00"/></a:highlight>');
    expect(slide).toContain('<a:latin typeface="Caladea"');
    // A link keeps its & as an entity, once.
    expect(await pkg.text('ppt/slides/_rels/slide1.xml.rels')).toContain('Target="https://example.com/?a=1&amp;b=2"');
  });

  it('puts footer and slide number on the slide as placeholders', async () => {
    const slide = await pkg.text('ppt/slides/slide1.xml');
    expect(slide).toContain('<a:t>Quarterly review</a:t>');
    expect(slide).toContain('<p:ph type="ftr" idx="11"/>');
    expect(slide).toContain('<p:ph type="sldNum" idx="12"/>');
    expect(slide).toContain('type="slidenum"');
  });

  it('keeps theme colors as scheme colors, shades included', async () => {
    const slide = await pkg.text('ppt/slides/slide2.xml');
    expect(slide).toContain('<a:schemeClr val="accent1"><a:lumMod val="60000"/><a:lumOff val="40000"/></a:schemeClr>');
    expect(slide).not.toMatch(/srgbClr val="0E0E0\d"/);
  });

  it('writes speaker notes as paragraphs', async () => {
    const notes = await pkg.text('ppt/notesSlides/notesSlide1.xml');
    expect(notes).toContain('<a:t>First note</a:t>');
    expect(notes).toContain('<a:t>Second note</a:t>');
  });

  it('hides hidden slides and writes transitions', async () => {
    expect(await pkg.text('ppt/slides/slide1.xml')).not.toContain('show="0"');
    const two = await pkg.text('ppt/slides/slide2.xml');
    expect(two).toContain('show="0"');
    expect(two).toContain('<p:push dir="l"/>');
    const one = await pkg.text('ppt/slides/slide1.xml');
    expect(one).toContain('p14:dur="700"');
    expect(one).toContain('<p:fade/>');
    expect(await pkg.text('ppt/slides/slide3.xml')).not.toContain('<p:transition');
  });

  it('writes gradient backgrounds on slides', async () => {
    const two = await pkg.text('ppt/slides/slide2.xml');
    expect(two).toMatch(/<p:bg><p:bgPr><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:srgbClr val="112233"\/><\/a:gs><a:gs pos="100000"><a:schemeClr val="accent2"\/><\/a:gs><\/a:gsLst><a:lin ang="0" scaled="0"\/>/);
  });

  it('shapes, pictures and tables', async () => {
    const two = await pkg.text('ppt/slides/slide2.xml');
    expect(two).toContain('<a:custGeom>');
    expect(two).toMatch(/<a:buChar/);
    expect(two).toContain('type="arabicPeriod"');
    expect(two).toContain('lvl="1"');
    // The wide picture is cropped to fill its box rather than stretched.
    expect(two).toMatch(/<a:srcRect l="\d+" r="\d+"\/>/);
    const three = await pkg.text('ppt/slides/slide3.xml');
    expect(three).toContain('<a:tbl>');
    expect(three).toContain('gridSpan="2"');
    expect(three).toContain('hMerge="1"');
    expect(three).toContain('<a:t>Merged</a:t>');
  });

  it('exports live content as the exporting person sees it and never leaks a label', async () => {
    const three = await pkg.text('ppt/slides/slide3.xml');
    expect(three).toContain('$1,200');
    expect(three).not.toContain('SECRET');
    expect(pkg.names.some((n) => n.startsWith('ppt/charts/chart'))).toBe(true);

    const blocked = await buildPptx(deck, { title: 'x', assets: assets(() => null) });
    const zip = await unzip(blocked);
    const xml = await zip.text('ppt/slides/slide3.xml');
    expect(xml).toContain('is not available');
    expect(xml).not.toContain('$1,200');
    expect(xml).not.toContain('SECRET');
    expect(blocked.report.join(' ')).toContain('cannot access');
  });

  it('writes build animations', async () => {
    const three = await pkg.text('ppt/slides/slide3.xml');
    expect(three).toContain('<p:timing>');
    expect(three).toContain('presetID="2"');
    expect(three).toContain('presetClass="entr"');
    expect(three).toContain('presetSubtype="8"');
    expect(three).toContain('nodeType="clickEffect"');
    expect(three).toContain('nodeType="afterEffect"');
    expect(three).toContain('<p:pRg st="0" end="0"/>');
    expect(three).toContain('<p:pRg st="1" end="1"/>');
    expect(three).toContain('build="p"');
    expect(three).toContain('filter="fade"');
    // Every animation target is a shape on the slide.
    const ids = new Set([...three.matchAll(/<p:cNvPr id="(\d+)"/g)].map((m) => m[1]));
    for (const m of three.matchAll(/<p:spTgt spid="(\d+)"/g)) expect(ids.has(m[1])).toBe(true);
    expect(ids.size).toBe([...three.matchAll(/<p:cNvPr id="(\d+)"/g)].length);
  });

  it('writes master and layout decorations, with showMasterSp from the layout', async () => {
    const doc = new Y.Doc();
    applyStarterTheme(doc, 'default');
    const rect = { id: 'band', type: 'shape', shape: 'rectangle', x: 0, y: 0, width: 1920, height: 60, z: 1, fill: themeColor('accent1') } as SlideElement;
    updateMaster(doc, { elements: [rect] });
    updateLayout(doc, 'titleOnly', { hideMasterElements: true, elements: [{ ...rect, id: 'own', fill: '#00ff00' } as SlideElement], background: { kind: 'color', color: themeColor('background2') } });
    const s = createSlide(doc);
    setSlideLayout(doc, s, 'titleOnly');
    const exported = await buildPptx(readDeck(doc), { title: 'Decor', assets: assets() });
    const out = await unzip(exported);
    const master = await out.text('ppt/slideMasters/slideMaster1.xml');
    expect(master).toContain('<a:schemeClr val="accent1"/>');
    const files = out.names.filter((n) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(n));
    const layout = (await Promise.all(files.map((f) => out.text(f)))).find((x) => x.includes('name="Title only"'))!;
    expect(layout).toContain('showMasterSp="0"');
    expect(layout).toContain('<a:srgbClr val="00FF00"/>');
    expect(layout).toContain('<p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg2"/>');
    const blank = (await Promise.all(files.map((f) => out.text(f)))).find((x) => x.includes('name="Blank"'))!;
    expect(blank).not.toContain('showMasterSp');
    // Throwaway slides are gone.
    expect(out.names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))).toHaveLength(1);
  });

  it('reports what does not survive', () => {
    expect(result.report.some((r) => r.includes('Live content'))).toBe(true);
    expect(result.report.some((r) => r.includes('could not be loaded'))).toBe(true);
  });
});

describe('buildPptx: other decks', () => {
  it('follows a 4:3 deck size and keeps text in step with the deck', async () => {
    const doc = new Y.Doc();
    writeDeckSettings(doc, { size: { width: 1440, height: 1080 } });
    const id = createSlide(doc);
    setSlideElement(doc, id, rich('r', { paragraphs: [{ runs: [{ text: 'Ünïcode & <markup> "quotes"' }] }] }));
    const deck = readDeck(doc);
    const out = await unzip(await buildPptx(deck, { title: 'Four by three', assets: assets() }));
    expect(await out.text('ppt/presentation.xml')).toContain('<p:sldSz cx="9144000" cy="6858000"');
    expect(await out.text('ppt/slides/slide1.xml')).toContain('Ünïcode &amp; &lt;markup&gt; &quot;quotes&quot;');
    // The default theme's fonts and colors are written, not PptxGenJS's own.
    const theme = await out.text('ppt/theme/theme1.xml');
    expect(theme).toContain('<a:accent1><a:srgbClr val="2563EB"/></a:accent1>');
    expect(theme).not.toContain('4472C4');
  });

  it('embeds video and audio PowerPoint can play, and links the rest', async () => {
    const doc = new Y.Doc();
    const id = createSlide(doc);
    setSlideElement(doc, id, { id: 'v', type: 'video', url: '/uploads/clip.mp4', title: 'Clip', x: 0, y: 0, width: 800, height: 450, z: 1 } as SlideElement);
    setSlideElement(doc, id, { id: 'w', type: 'video', url: '/uploads/clip.webm', title: 'Web clip', x: 0, y: 500, width: 800, height: 450, z: 2 } as SlideElement);
    setSlideElement(doc, id, { id: 'e', type: 'embed', url: 'https://example.com/page', title: 'A page', x: 900, y: 0, width: 600, height: 300, z: 3 } as SlideElement);
    const media = { ...assets(), media: async (url: string) => ({ data: Uint8Array.from([0, 0, 0, 24, 102, 116, 121, 112]), ext: url.split('.').pop()! }) };
    const result = await buildPptx(readDeck(doc), { title: 'Media', assets: media });
    const out = await unzip(result);
    expect(out.names.some((n) => n.startsWith('ppt/media/media') && n.endsWith('.mp4'))).toBe(true);
    expect(out.names.some((n) => n.endsWith('.webm'))).toBe(false);
    const slide = await out.text('ppt/slides/slide1.xml');
    expect(slide).toContain('<a:videoFile');
    expect(slide).toContain('Web clip');
    expect(slide).toContain('https://example.com/page');
    expect(result.report.some((r) => r.includes('webm'))).toBe(true);
    expect(result.report.some((r) => r.includes('Embedded web pages'))).toBe(true);
  });

  it('writes live fields in text as they read now, and a dash where the exporter may not see them', async () => {
    const doc = new Y.Doc();
    const id = createSlide(doc);
    const item = '33333333-3333-4333-8333-333333333333';
    setSlideElement(doc, id, rich('r', {
      paragraphs: [
        {
          runs: [
            { text: 'Epic is ' },
            { field: { ref: { kind: 'workItem', itemId: item, part: 'percent' }, label: 'SECRET-LABEL' } },
            { text: ' done; revenue ' },
            { field: { ref: { kind: 'cell', spreadsheetId: item, sheetId: 's', cell: 'B5' }, label: 'SECRET-CELL' } },
          ],
        },
      ],
    }));
    setSlideElement(doc, id, { id: 'p', type: 'workItemProgress', itemId: item, label: 'SECRET-EPIC', x: 0, y: 600, width: 1600, height: 400, z: 2 } as SlideElement);
    const deck = readDeck(doc);
    const seen: ExportAssets = {
      ...assets((el) =>
        el.type === 'workItemProgress'
          ? { kind: 'progress', key: 'PARA-7', title: 'Ship it', statusName: 'In progress', statusColor: '#2563eb', percent: 60, caption: '3 of 5 done', children: [{ key: 'PARA-8', title: 'Docs', statusName: 'Done', done: true }] }
          : null,
      ),
      field: async (field) => (field.kind === 'workItem' ? '60%' : null),
    };
    const result = await buildPptx(deck, { title: 'Fields', assets: seen });
    const xml = await (await unzip(result)).text('ppt/slides/slide1.xml');
    expect(xml).toContain('<a:t>60%</a:t>');
    expect(xml).toContain('—');
    expect(xml).toContain('3 of 5 done');
    expect(xml).toContain('PARA-8');
    expect(xml).not.toContain('SECRET');
    expect(result.report.join(' ')).toContain('as a dash');
  });

  it('never lets a theme-color token reach the file', async () => {
    const deck = fixture();
    const out = await unzip(await buildPptx(deck, { title: 'Tokens', assets: assets(live) }));
    for (const name of out.names.filter((n) => /\.xml$/.test(n))) expect(await out.text(name), name).not.toMatch(/srgbClr val="0E0E0[0-9A-F]"/);
  });
});

/** Parses XML with the platform's parser when there is one, else just checks the tags balance. */
class DOMParserLike {
  parse(xml: string): boolean {
    const stack: string[] = [];
    const body = xml.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '');
    for (const m of body.matchAll(/<(\/?)([A-Za-z_][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g)) {
      const [, closing, name, , selfClosing] = m;
      if (selfClosing) continue;
      if (closing) {
        if (stack.pop() !== name) return false;
      } else stack.push(name);
    }
    return stack.length === 0;
  }
}
