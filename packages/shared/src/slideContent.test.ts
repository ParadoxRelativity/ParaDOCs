import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  coveredCells,
  createSlide,
  deckMentions,
  deleteColumn,
  deleteRow,
  fontStack,
  insertColumn,
  insertRow,
  listNumbers,
  mapOfficeFont,
  mergeCells,
  cellRange,
  plainTextParagraphs,
  readParagraphs,
  readSlide,
  setSlideElement,
  setTableCells,
  shapeGeometry,
  slideElementText,
  tableCellKey,
  unmergeCell,
  writeParagraphs,
  type RichParagraph,
  type RichTextElement,
  type TableElement,
} from './index.js';

const richBox = (extra: Partial<RichTextElement> = {}): RichTextElement => ({ id: 'a', type: 'richText', x: 0, y: 0, width: 400, height: 200, z: 1, ...extra });

describe('rich text bodies', () => {
  const paragraphs: RichParagraph[] = [
    { runs: [{ text: 'Plain ' }, { text: 'bold', marks: { bold: true, color: '#ff0000', fontSize: 40 } }, { text: ' and ' }, { text: 'link', marks: { link: 'https://x.test', underline: true } }] },
    { bullet: 'bullet', level: 2, align: 'center', lineHeight: 1.5, runs: [{ text: 'Item' }, { mention: { userId: '11111111-1111-4111-8111-111111111111', label: 'Ada' } }, { text: '!' }] },
    { runs: [] },
  ];

  it('round-trips paragraphs, marks and mentions through the fragment', () => {
    const doc = new Y.Doc();
    const slide = createSlide(doc);
    setSlideElement(doc, slide, richBox({ paragraphs }));
    const [element] = readSlide(doc, slide).elements as RichTextElement[];
    expect(element.paragraphs).toEqual(paragraphs);
    expect(element.text).toBe('Plain bold and link\nItem@Ada!\n');
    expect(slideElementText(element)).toBe(element.text);
  });

  it('survives a copy to another document, as a reload does', () => {
    const doc = new Y.Doc();
    const slide = createSlide(doc);
    setSlideElement(doc, slide, richBox({ paragraphs }));
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
    expect((readSlide(copy, slide).elements[0] as RichTextElement).paragraphs).toEqual(paragraphs);
  });

  it('does not overwrite an existing body when an element is set again', () => {
    const doc = new Y.Doc();
    const slide = createSlide(doc);
    setSlideElement(doc, slide, richBox({ paragraphs }));
    setSlideElement(doc, slide, richBox({ x: 10, paragraphs: [{ runs: [{ text: 'other' }] }] }));
    const [element] = readSlide(doc, slide).elements as RichTextElement[];
    expect(element.x).toBe(10);
    expect(element.paragraphs).toEqual(paragraphs);
  });

  it('reads the marks the outline writer and the editor both write', () => {
    const doc = new Y.Doc();
    const body = doc.getXmlFragment('body');
    const p = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    p.insert(0, [text]);
    body.insert(0, [p]);
    text.insert(0, 'a', { fontSize: 64 });
    text.insert(1, 'b', { fontSize: { size: 36 }, bold: {} });
    expect(readParagraphs(body)[0].runs).toEqual([
      { text: 'a', marks: { fontSize: 64 } },
      { text: 'b', marks: { fontSize: 36, bold: true } },
    ]);
  });

  it('rewrites a body in place', () => {
    const doc = new Y.Doc();
    const body = doc.getXmlFragment('body');
    writeParagraphs(body, plainTextParagraphs('one\n- two\n  - three'));
    writeParagraphs(body, [{ runs: [{ text: 'only' }] }]);
    expect(readParagraphs(body)).toEqual([{ runs: [{ text: 'only' }] }]);
  });
});

describe('plain text and lists', () => {
  it('turns lines into paragraphs, and dashed lines into list items', () => {
    expect(plainTextParagraphs('Title\n- one\n    - nested')).toEqual([
      { runs: [{ text: 'Title' }] },
      { bullet: 'bullet', level: 0, runs: [{ text: 'one' }] },
      { bullet: 'bullet', level: 2, runs: [{ text: 'nested' }] },
    ]);
  });

  it('numbers items per level and starts over after a break', () => {
    const items = [
      { bullet: 'number' as const },
      { bullet: 'number' as const },
      { bullet: 'number' as const, level: 1 },
      { bullet: 'number' as const, level: 1 },
      { bullet: 'number' as const },
      {},
      { bullet: 'number' as const },
    ];
    expect(listNumbers(items)).toEqual([1, 2, 1, 2, 3, null, 1]);
  });
});

describe('mentions in a deck', () => {
  it('finds tags in rich text and in plain shape text, once each, on the first slide', () => {
    const doc = new Y.Doc();
    const one = createSlide(doc);
    const two = createSlide(doc);
    const ada = '11111111-1111-4111-8111-111111111111';
    const bob = '22222222-2222-4222-8222-222222222222';
    setSlideElement(doc, one, { id: 's', type: 'shape', shape: 'star', x: 0, y: 0, width: 10, height: 10, z: 1, text: `hi <@${bob}>` });
    setSlideElement(doc, two, richBox({ paragraphs: [{ runs: [{ mention: { userId: ada, label: 'Ada' } }] }] }));
    setSlideElement(doc, two, richBox({ id: 'b', paragraphs: [{ runs: [{ mention: { userId: bob, label: 'Bob' } }] }] }));
    expect(deckMentions(doc)).toEqual([
      { userId: bob, slideId: one },
      { userId: ada, slideId: two },
    ]);
  });
});

describe('fonts', () => {
  it('maps Office fonts to the bundled metric-compatible ones', () => {
    expect(mapOfficeFont('Calibri')).toBe('Carlito');
    expect(mapOfficeFont('Cambria')).toBe('Caladea');
    expect(mapOfficeFont('Arial')).toBe('Liberation Sans');
    expect(mapOfficeFont('Times New Roman')).toBe('Liberation Serif');
    expect(mapOfficeFont('Courier New')).toBe('Liberation Mono');
    expect(mapOfficeFont('Carlito')).toBe('Carlito');
    expect(mapOfficeFont('Comic Sans MS')).toBe('Comic Sans MS');
    expect(mapOfficeFont('')).toBe('Inter');
  });

  it('builds a safe font stack', () => {
    expect(fontStack('Carlito')).toContain('Carlito');
    expect(fontStack("Evil'; } body {")).not.toContain(';');
    expect(fontStack('Calibri Light')).toContain('Carlito');
  });
});

describe('shapes', () => {
  it('draws every kind as a path inside its box', () => {
    for (const kind of ['rectangle', 'roundRect', 'ellipse', 'triangle', 'diamond', 'arrowRight', 'arrowLeft', 'arrowUp', 'arrowDown', 'callout', 'star', 'line'] as const) {
      const { d } = shapeGeometry(kind, 300, 200);
      expect(d).toMatch(/^M/);
      expect(d).not.toContain('NaN');
    }
    expect(shapeGeometry('line', 10, 10).open).toBe(true);
  });
});

describe('table structure', () => {
  const table = (): Pick<TableElement, 'rows' | 'columns' | 'cells'> => ({
    rows: 3,
    columns: 3,
    cells: { [tableCellKey(0, 0)]: { text: 'a' }, [tableCellKey(1, 1)]: { text: 'b' }, [tableCellKey(2, 2)]: { text: 'c' } },
  });

  it('inserts and deletes rows and columns, moving cells with them', () => {
    const inserted = insertRow(table(), 1);
    expect(inserted.rows).toBe(4);
    expect(inserted.cells[tableCellKey(2, 1)].text).toBe('b');
    expect(inserted.cells[tableCellKey(0, 0)].text).toBe('a');
    const removed = deleteRow(inserted, 1);
    expect(removed.cells).toEqual(table().cells);
    const wider = insertColumn(table(), 0);
    expect(wider.cells[tableCellKey(0, 1)].text).toBe('a');
    expect(deleteColumn(wider, 0).cells).toEqual(table().cells);
    expect(deleteRow({ ...table(), rows: 1 }, 0).rows).toBe(1);
  });

  it('merges a range into its top-left cell and covers the rest', () => {
    const merged = mergeCells(table(), cellRange(table(), { row: 0, column: 0 }, { row: 1, column: 1 }));
    expect(merged.cells[tableCellKey(0, 0)]).toEqual({ text: 'a\nb', rowSpan: 2, colSpan: 2 });
    expect(merged.cells[tableCellKey(1, 1)]).toBeUndefined();
    expect([...coveredCells(merged)].sort()).toEqual(['0:1', '1:0', '1:1']);
    expect(unmergeCell(merged, 0, 0).cells[tableCellKey(0, 0)]).toEqual({ text: 'a\nb' });
  });

  it('grows a selection to take in the merges it cuts through', () => {
    const merged = mergeCells(table(), cellRange(table(), { row: 0, column: 0 }, { row: 1, column: 1 }));
    expect(cellRange(merged, { row: 1, column: 1 }, { row: 2, column: 2 })).toEqual({ row: 0, column: 0, rows: 3, columns: 3 });
  });

  it('keeps a merge whole when a row is inserted inside it, and shortens it when one is deleted', () => {
    const merged = mergeCells(table(), { row: 0, column: 0, rows: 3, columns: 1 });
    expect(insertRow(merged, 1).cells[tableCellKey(0, 0)].rowSpan).toBe(4);
    expect(deleteRow(merged, 1).cells[tableCellKey(0, 0)].rowSpan).toBe(2);
    // Deleting the row a merge starts in hands it to the row below.
    expect(deleteRow(merged, 0).cells[tableCellKey(0, 0)].rowSpan).toBe(2);
  });

  it('edits single cells in a Y.Doc and survives a reload', () => {
    const doc = new Y.Doc();
    const slide = createSlide(doc);
    setSlideElement(doc, slide, { id: 't', type: 'table', x: 0, y: 0, width: 600, height: 300, z: 1, rows: 2, columns: 2, cells: {} });
    setTableCells(doc, slide, 't', { [tableCellKey(0, 1)]: { text: 'x', bold: true }, [tableCellKey(1, 0)]: { text: 'y' } });
    setTableCells(doc, slide, 't', { [tableCellKey(1, 0)]: null });
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
    expect((readSlide(copy, slide).elements[0] as TableElement).cells).toEqual({ [tableCellKey(0, 1)]: { text: 'x', bold: true } });
  });
});
