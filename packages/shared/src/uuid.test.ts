import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { createSlide, readDeck } from './slides.js';
import { setSlideLayout } from './slideLayoutEdit.js';
import { randomUuid } from './uuid.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('randomUuid on a page that is not a secure context', () => {
  // Plain HTTP on a LAN address: browsers leave randomUUID out but keep getRandomValues.
  beforeEach(() => {
    const real = globalThis.crypto;
    vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => real.getRandomValues(bytes) });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('still makes version 4 UUIDs', () => {
    const ids = new Set(Array.from({ length: 50 }, randomUuid));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(UUID);
  });

  it('lets a new slide be added with its layout placeholders', () => {
    const doc = new Y.Doc();
    const id = createSlide(doc);
    setSlideLayout(doc, id, 'titleAndContent');
    expect(id).toMatch(UUID);
    expect(readDeck(doc).slides.find((s) => s.id === id)?.elements.length).toBeGreaterThan(0);
  });
});
