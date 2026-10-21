import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';
import * as Y from 'yjs';
import {
  applyTemplate,
  createStyledDeck,
  readDeck,
  templateDeckFrom,
  templatePreview,
  templateStyleOf,
  type RichTextElement,
} from '@paradocs/shared';
import { encodeTemplateImport as encodeTemplate } from '../src/lib/slideImport';
import { parseSlideFile } from '../src/lib/slideImportParse';
import { isTemplateImportFile, templateNameOf } from '../src/lib/slideImportTypes';
import { fixturePath, importFixture } from './helpers';

const open = (update: Uint8Array) => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  return doc;
};

describe('presentation templates from PowerPoint', () => {
  it('reads only the look of a .pptx imported as a template', async () => {
    const deck = await importFixture('powerpoint-quarterly.pptx', { template: true });
    expect(deck.slides).toEqual([]);
    expect(deck.theme?.name).toBe('Office Theme');
    expect(deck.layouts?.map((l) => l.name)).toHaveLength(11);
    expect(deck.layouts?.[0].name).toBe('Title Slide');
  });

  it('round-trips a .pptx through a template and into a new deck with one Title slide', async () => {
    const deck = await importFixture('powerpoint-quarterly.pptx', { template: true });
    // The server rebuilds what it is sent, so this is what a template holds.
    const stored = templateDeckFrom(open(encodeTemplate(deck)));
    // A deck made from it is a copy of it.
    const made = readDeck(open(stored));
    expect(made.settings.size).toEqual({ width: 1440, height: 1080 });
    expect(made.themes).toHaveLength(1);
    expect(made.themes[0]).toMatchObject({ name: 'Office Theme', fonts: { heading: 'Carlito', body: 'Carlito' } });
    expect(made.themes[0].colors.accent1).toBe('#4f81bd');
    expect(made.layouts.map((l) => l.name)).toEqual(deck.layouts!.map((l) => l.name));
    expect(made.master.placeholders.map((p) => p.kind)).toEqual(['title', 'body', 'date', 'footer', 'slideNumber']);
    expect(made.slides).toHaveLength(1);
    expect(made.layouts.find((l) => l.id === made.slides[0].layoutId)?.name).toBe('Title Slide');
    expect(made.slides[0].elements.map((e) => (e as RichTextElement).placeholderKind)).toEqual(['title', 'subtitle']);

    const preview = templatePreview(open(stored))!;
    expect(preview.samples.map((s) => s.text)).toEqual(['Presentation title', 'Subtitle']);
  });

  it('puts an imported template’s layouts on a deck, moving each slide to the layout of its kind', async () => {
    const deck = await importFixture('powerpoint-quarterly.pptx', { template: true });
    const style = templateStyleOf(readDeck(open(templateDeckFrom(open(encodeTemplate(deck))))));
    const target = open(createStyledDeck('midnight'));
    applyTemplate(target, style);
    const after = readDeck(target);
    expect(after.settings.size).toEqual({ width: 1920, height: 1080 });
    expect(after.layouts.map((l) => l.name)).toEqual(deck.layouts!.map((l) => l.name));
    expect(after.layouts.find((l) => l.id === after.slides[0].layoutId)?.name).toBe('Title Slide');
    expect(after.themes.find((t) => t.id === after.settings.themeId)?.name).toBe('Office Theme');
  });

  it('imports a .thmx as a theme on the default master and layouts', async () => {
    // A theme file is the theme part of a presentation, packaged on its own.
    const pptx = await JSZip.loadAsync(readFileSync(fixturePath('powerpoint-quarterly.pptx')));
    const theme = await pptx.file('ppt/theme/theme1.xml')!.async('string');
    const thmx = new JSZip();
    thmx.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
    thmx.file(
      '_rels/.rels',
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="theme/theme/theme1.xml"/></Relationships>',
    );
    thmx.file('theme/theme/theme1.xml', theme);
    const bytes = await thmx.generateAsync({ type: 'uint8array' });

    const deck = await parseSlideFile(bytes, 'Office.thmx', {
      parseXml: (text) => new DOMParser().parseFromString(text, 'text/xml') as unknown as Document,
      template: true,
    });
    expect(deck.title).toBe('Office');
    expect(deck.theme).toMatchObject({ name: 'Office Theme', fonts: { heading: 'Carlito', body: 'Carlito' } });
    expect(deck.layouts).toBeUndefined();

    const made = readDeck(open(templateDeckFrom(open(encodeTemplate(deck)))));
    expect(made.themes[0].colors.accent1).toBe('#4f81bd');
    expect(made.layouts).toHaveLength(8);
    expect(made.slides[0].layoutId).toBe('title');
  });

  it('accepts .potx, .pptx and .thmx, and names a template after its file', () => {
    expect(['a.potx', 'b.PPTX', 'c.thmx'].every(isTemplateImportFile)).toBe(true);
    expect(isTemplateImportFile('d.odp')).toBe(false);
    expect(templateNameOf('Board 2026.potx')).toBe('Board 2026');
  });
});
