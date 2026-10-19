import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  DEFAULT_SLIDE_SIZE,
  boardBounds,
  canvasElementsToSlide,
  canvasFramesToSlides,
  readDeck,
  writeFrameSlides,
  type CanvasElement,
} from './index.js';

const base = { z: 1, width: 100, height: 100 };
const frame = (id: string, order: number, x: number, y: number): CanvasElement =>
  ({ ...base, id, type: 'frame', name: id, order, x, y, width: 960, height: 540 }) as CanvasElement;
const note = (id: string, x: number, y: number, text = id): CanvasElement => ({ ...base, id, type: 'note', x, y, text }) as CanvasElement;

describe('canvas frames to slides', () => {
  it('makes one slide per frame, in frame order, holding only what is inside it', () => {
    const board: CanvasElement[] = [
      frame('c', 2, 0, 2000),
      frame('a', 0, 0, 0),
      frame('b', 1, 0, 1000),
      note('in-a', 100, 100),
      note('in-b', 100, 1100),
      note('in-c', 100, 2100),
      note('nowhere', 5000, 5000),
    ];
    const slides = canvasFramesToSlides(board, DEFAULT_SLIDE_SIZE);
    expect(slides.map((s) => s.name)).toEqual(['a', 'b', 'c']);
    expect(slides.map((s) => s.elements.length)).toEqual([1, 1, 1]);
  });

  it('scales the frame to the slide and keeps live references as they are', () => {
    const board: CanvasElement[] = [
      frame('f', 0, 1000, 1000),
      { ...base, id: 'chart', type: 'sheetChart', x: 1000, y: 1000, width: 480, height: 270, spreadsheetId: 's', sheetId: 'main', chartId: 'c', label: 'Revenue' } as CanvasElement,
    ];
    const [slide] = canvasFramesToSlides(board, DEFAULT_SLIDE_SIZE);
    const [chart] = slide.elements;
    // A 960x540 frame is half the slide, so everything doubles.
    expect(chart).toMatchObject({ type: 'sheetChart', x: 0, y: 0, width: 960, height: 540, spreadsheetId: 's', chartId: 'c' });
  });

  it('turns notes, text and mind map nodes into slide shapes and text, and keeps connectors between what came', () => {
    const board: CanvasElement[] = [
      note('n1', 0, 0, 'Hello'),
      { ...base, id: 't', type: 'text', x: 200, y: 0, text: 'One\nTwo' } as CanvasElement,
      { ...base, id: 'root', type: 'node', x: 0, y: 200, text: 'Root' } as CanvasElement,
      { ...base, id: 'kid', type: 'node', x: 200, y: 200, text: 'Kid', parentId: 'root' } as CanvasElement,
      { ...base, id: 'k', type: 'connector', x: 0, y: 0, from: 'n1', to: 't' } as CanvasElement,
      { ...base, id: 'dangling', type: 'connector', x: 0, y: 0, from: 'n1', to: 'gone' } as CanvasElement,
    ];
    const region = boardBounds(board)!;
    const out = canvasElementsToSlide(board, region, DEFAULT_SLIDE_SIZE);
    expect(out.filter((e) => e.type === 'shape').map((e) => (e as { text?: string }).text)).toEqual(['Hello', 'Root', 'Kid']);
    const text = out.find((e) => e.type === 'richText') as unknown as { paragraphs: { runs: { text: string }[] }[] };
    expect(text.paragraphs.map((p) => p.runs[0].text)).toEqual(['One', 'Two']);
    const connectors = out.filter((e) => e.type === 'connector') as unknown as { from: string; to: string }[];
    expect(connectors).toHaveLength(2);
    const ids = new Set(out.map((e) => e.id));
    for (const c of connectors) expect(ids.has(c.from) && ids.has(c.to)).toBe(true);
  });

  it('writes the slides into a deck in order', () => {
    const board = [frame('a', 0, 0, 0), frame('b', 1, 0, 1000), note('x', 10, 10, 'first'), note('y', 10, 1010, 'second')];
    const doc = new Y.Doc();
    writeFrameSlides(doc, canvasFramesToSlides(board, DEFAULT_SLIDE_SIZE));
    const deck = readDeck(doc);
    expect(deck.slides).toHaveLength(2);
    expect(deck.slides.map((s) => (s.elements[0] as { text?: string }).text)).toEqual(['first', 'second']);
  });

  it('does not enlarge a small pasted selection past a few times its size', () => {
    const lone = [note('n', 500, 500)];
    const [el] = canvasElementsToSlide(lone, boardBounds(lone)!, DEFAULT_SLIDE_SIZE, { limitScale: true });
    expect(el.width).toBe(300);
  });
});
