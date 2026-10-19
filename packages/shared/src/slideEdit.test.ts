import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  RESIZE_HANDLES,
  createSlide,
  duplicateSlide,
  duplicateSlideElements,
  moveSlides,
  normalizeRotation,
  patchSlideElements,
  readDeck,
  readSlide,
  readSlideOrder,
  reorderZ,
  resizeBox,
  rotationToward,
  setSlideElement,
  setSlidesHidden,
  visibleBounds,
  type SlideElement,
} from './index.js';

const shape = (id: string, props: Partial<SlideElement> = {}): SlideElement =>
  ({ id, type: 'shape', shape: 'rectangle', x: 100, y: 100, width: 200, height: 100, z: 1, ...props }) as SlideElement;

/** Two docs that have exchanged everything so far. */
function pair() {
  const a = new Y.Doc();
  const b = new Y.Doc();
  const sync = () => {
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
  };
  return { a, b, sync };
}

describe('resizeBox', () => {
  it('grows an unturned box from the opposite corner', () => {
    const box = resizeBox({ x: 100, y: 100, width: 200, height: 100 }, 'se', 50, 20);
    expect(box).toMatchObject({ x: 100, y: 100, width: 250, height: 120 });
    const west = resizeBox({ x: 100, y: 100, width: 200, height: 100 }, 'nw', -30, -10);
    expect(west).toMatchObject({ x: 70, y: 90, width: 230, height: 110 });
  });

  it('keeps the far corner fixed on screen when the box is turned', () => {
    const start = { x: 100, y: 100, width: 200, height: 100, rotation: 30 };
    const corner = (b: typeof start, lx: number, ly: number) => {
      const r = (b.rotation * Math.PI) / 180;
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      return { x: cx + lx * Math.cos(r) - ly * Math.sin(r), y: cy + lx * Math.sin(r) + ly * Math.cos(r) };
    };
    const before = corner(start, -start.width / 2, -start.height / 2);
    const next = resizeBox(start, 'se', 40, 25) as typeof start;
    const after = corner(next, -next.width / 2, -next.height / 2);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
    expect(next.width).not.toBe(start.width);
  });

  it('holds the aspect ratio on corners and never goes below the minimum', () => {
    const box = resizeBox({ x: 0, y: 0, width: 200, height: 100 }, 'se', 100, 0, { keepAspect: true });
    expect(box.width / box.height).toBeCloseTo(2);
    for (const handle of RESIZE_HANDLES) {
      const tiny = resizeBox({ x: 0, y: 0, width: 200, height: 100 }, handle, -5000, -5000);
      expect(tiny.width).toBeGreaterThanOrEqual(24);
      expect(tiny.height).toBeGreaterThanOrEqual(24);
    }
  });
});

describe('rotation', () => {
  it('points the top of the box at the pointer, and snaps in steps', () => {
    const box = { x: 0, y: 0, width: 100, height: 100 };
    expect(rotationToward(box, { x: 50, y: -100 })).toBe(0);
    expect(rotationToward(box, { x: 200, y: 50 })).toBe(90);
    expect(rotationToward(box, { x: 200, y: 40 }, 15)).toBe(90);
    expect(normalizeRotation(-90)).toBe(270);
  });

  it('measures a turned box by what is seen', () => {
    const bounds = visibleBounds({ x: 0, y: 0, width: 200, height: 100, rotation: 90 });
    expect(bounds.width).toBeCloseTo(100);
    expect(bounds.height).toBeCloseTo(200);
  });
});

describe('reorderZ', () => {
  const els = [
    { id: 'a', z: 0 },
    { id: 'b', z: 1 },
    { id: 'c', z: 2 },
  ];
  const apply = (changes: { id: string; z: number }[]) => {
    const z = new Map(els.map((e) => [e.id, e.z]));
    changes.forEach((c) => z.set(c.id, c.z));
    return [...z.entries()].sort((x, y) => x[1] - y[1]).map(([id]) => id);
  };
  it('brings to front, sends to back and steps', () => {
    expect(apply(reorderZ(els, new Set(['a']), 'front'))).toEqual(['b', 'c', 'a']);
    expect(apply(reorderZ(els, new Set(['c']), 'back'))).toEqual(['c', 'a', 'b']);
    expect(apply(reorderZ(els, new Set(['a']), 'forward'))).toEqual(['b', 'a', 'c']);
    expect(apply(reorderZ(els, new Set(['c']), 'backward'))).toEqual(['a', 'c', 'b']);
    expect(reorderZ(els, new Set(['c']), 'front')).toEqual([]);
  });
});

describe('editing a deck', () => {
  it('two people changing different elements, or properties, both keep their change', () => {
    const { a, b, sync } = pair();
    const slide = createSlide(a, { id: 's1' });
    setSlideElement(a, slide, shape('one'));
    setSlideElement(a, slide, shape('two'));
    sync();
    patchSlideElements(a, slide, [{ id: 'one', patch: { x: 500 } }]);
    patchSlideElements(b, slide, [
      { id: 'one', patch: { y: 700 } },
      { id: 'two', patch: { x: 900 } },
    ]);
    sync();
    for (const doc of [a, b]) {
      const els = readSlide(doc, slide).elements;
      expect(els.find((e) => e.id === 'one')).toMatchObject({ x: 500, y: 700 });
      expect(els.find((e) => e.id === 'two')).toMatchObject({ x: 900 });
    }
  });

  it('does not resurrect an element another person deleted', () => {
    const doc = new Y.Doc();
    const slide = createSlide(doc);
    patchSlideElements(doc, slide, [{ id: 'gone', patch: { x: 1 } }]);
    expect(readSlide(doc, slide).elements).toEqual([]);
  });

  it('undo reverts only the local origin', () => {
    const { a, b, sync } = pair();
    const slide = createSlide(a, { id: 's1' });
    setSlideElement(a, slide, shape('one'));
    sync();
    const mine = { local: true };
    const undo = new Y.UndoManager(a, { trackedOrigins: new Set([mine]), captureTimeout: 0 });
    a.transact(() => patchSlideElements(a, slide, [{ id: 'one', patch: { x: 500 } }]), mine);
    patchSlideElements(b, slide, [{ id: 'one', patch: { y: 700 } }]);
    sync();
    a.transact(() => createSlide(a, { id: 's2' }), mine);
    undo.undo();
    expect(readSlideOrder(a)).toEqual(['s1']);
    undo.undo();
    expect(readSlide(a, slide).elements[0]).toMatchObject({ x: 100, y: 700 });
    expect(undo.canUndo()).toBe(false);
  });

  it('duplicates a slide with its elements and notes, after the original', () => {
    const doc = new Y.Doc();
    const first = createSlide(doc, { id: 'a' });
    createSlide(doc, { id: 'z' });
    setSlideElement(doc, first, shape('one', { x: 5 }));
    const paragraph = new Y.XmlElement('paragraph');
    paragraph.insert(0, [new Y.XmlText('remember this')]);
    doc.getXmlFragment('notes:a').insert(0, [paragraph]);
    const copy = duplicateSlide(doc, first, () => 'b')!;
    expect(readSlideOrder(doc)).toEqual(['a', 'b', 'z']);
    const snapshot = readSlide(doc, copy);
    expect(snapshot.elements[0]).toMatchObject({ id: 'one', x: 5 });
    expect(snapshot.notes).toBe('remember this');
    patchSlideElements(doc, copy, [{ id: 'one', patch: { x: 9 } }]);
    expect(readSlide(doc, first).elements[0].x).toBe(5);
  });

  it('copies elements within a slide under new ids, offset and on top', () => {
    const doc = new Y.Doc();
    const slide = createSlide(doc);
    setSlideElement(doc, slide, shape('one', { z: 3 }));
    const ids = duplicateSlideElements(doc, slide, ['one', 'missing'], slide, { offset: 20, makeId: () => 'copy' });
    expect(ids).toEqual(['copy']);
    expect(readSlide(doc, slide).elements.find((e) => e.id === 'copy')).toMatchObject({ x: 120, y: 120, z: 4 });
  });

  it('hides slides and moves a group of them together', () => {
    const doc = new Y.Doc();
    for (const id of ['a', 'b', 'c', 'd']) createSlide(doc, { id });
    setSlidesHidden(doc, ['b'], true);
    expect(readDeck(doc).slides.map((s) => s.hidden)).toEqual([false, true, false, false]);
    moveSlides(doc, ['a', 'b'], 2);
    expect(readSlideOrder(doc)).toEqual(['c', 'd', 'a', 'b']);
    moveSlides(doc, ['d'], 0);
    expect(readSlideOrder(doc)).toEqual(['d', 'c', 'a', 'b']);
  });

  it('keeps a remote edit on the right slide when slides are reordered', () => {
    const { a, b, sync } = pair();
    for (const id of ['a', 'b', 'c']) createSlide(a, { id });
    setSlideElement(a, 'c', shape('one'));
    sync();
    moveSlides(a, ['c'], 0);
    patchSlideElements(b, 'c', [{ id: 'one', patch: { x: 777 } }]);
    sync();
    expect(readSlideOrder(a)).toEqual(['c', 'a', 'b']);
    expect(readSlide(b, 'c').elements[0].x).toBe(777);
  });
});
