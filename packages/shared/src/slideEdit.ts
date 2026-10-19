/**
 * Edits the slide editor makes to a deck's Y.Doc, beyond the create/move/delete
 * helpers in slides.ts. Each is one transaction, so it is one undo step and one
 * message to collaborators; the caller supplies the transaction origin through
 * `doc.transact` so undo can tell this person's changes from everyone else's.
 */

import * as Y from 'yjs';
import { ELEMENT_BODY_KEY, SLIDE_ELEMENTS_KEY, SLIDE_ORDER, notesFragmentName, slideMapName, type SlideElement } from './slides.js';

function elementsOf(doc: Y.Doc, slideId: string): Y.Map<Y.Map<unknown>> | null {
  const elements = doc.getMap<unknown>(slideMapName(slideId)).get(SLIDE_ELEMENTS_KEY);
  return elements instanceof Y.Map ? (elements as Y.Map<Y.Map<unknown>>) : null;
}

/** Copies a Y value: nested types are cloned, everything else is plain data. */
function copyValue(value: unknown): unknown {
  return value instanceof Y.AbstractType ? value.clone() : value;
}

/**
 * Changes some properties of some elements. Each property is written on its
 * own, so two people changing different properties of one element both keep
 * their change. An element someone else has deleted meanwhile is left alone
 * rather than brought back as a half-empty shell.
 */
export function patchSlideElements(
  doc: Y.Doc,
  slideId: string,
  patches: { id: string; patch: Partial<SlideElement> | Record<string, unknown> }[],
): void {
  doc.transact(() => {
    const elements = elementsOf(doc, slideId);
    if (!elements) return;
    for (const { id, patch } of patches) {
      const map = elements.get(id);
      if (!map) continue;
      for (const [key, value] of Object.entries(patch)) {
        // Identity and the rich text body are not changed by a patch.
        if (key === 'id' || key === 'type' || key === ELEMENT_BODY_KEY) continue;
        if (value === undefined) map.delete(key);
        else map.set(key, value);
      }
    }
  });
}

/** A copy of an element's Y.Map, nested types (a rich text body, table cells) cloned along. */
export function cloneElementMap(source: Y.Map<unknown>, patch: Record<string, unknown> = {}): Y.Map<unknown> {
  const copy = new Y.Map<unknown>();
  source.forEach((value, key) => copy.set(key, copyValue(value)));
  for (const [key, value] of Object.entries(patch)) copy.set(key, value);
  return copy;
}

/**
 * Copies elements to a slide, each under a new id (and offset, so a copy on the
 * same slide does not hide its original). Returns the new ids in order.
 * `makeId` is injected so the caller owns id generation.
 */
export function duplicateSlideElements(
  doc: Y.Doc,
  fromSlideId: string,
  ids: string[],
  toSlideId: string,
  { offset = 0, makeId }: { offset?: number; makeId: () => string },
): string[] {
  const created: string[] = [];
  doc.transact(() => {
    const from = elementsOf(doc, fromSlideId);
    const to = elementsOf(doc, toSlideId);
    if (!from || !to) return;
    let top = 0;
    to.forEach((map) => {
      top = Math.max(top, Number(map.get('z') ?? 0));
    });
    for (const id of ids) {
      const source = from.get(id);
      if (!source) continue;
      const newId = makeId();
      top += 1;
      const x = Number(source.get('x') ?? 0) + offset;
      const y = Number(source.get('y') ?? 0) + offset;
      to.set(newId, cloneElementMap(source, { id: newId, x, y, z: top }));
      created.push(newId);
    }
  });
  return created;
}

/**
 * A new slide that is a copy of another, placed after it: its background,
 * layout, transition, every element and the speaker notes. Returns its id, or
 * null when the source slide does not exist.
 */
export function duplicateSlide(doc: Y.Doc, slideId: string, makeId: () => string): string | null {
  const order = doc.getArray<string>(SLIDE_ORDER);
  const at = order.toArray().indexOf(slideId);
  const sourceElements = elementsOf(doc, slideId);
  if (at < 0 || !sourceElements) return null;
  const id = makeId();
  doc.transact(() => {
    const source = doc.getMap<unknown>(slideMapName(slideId));
    const target = doc.getMap<unknown>(slideMapName(id));
    source.forEach((value, key) => {
      if (key !== SLIDE_ELEMENTS_KEY) target.set(key, copyValue(value));
    });
    const elements = new Y.Map<Y.Map<unknown>>();
    // Elements keep their ids: ids only need to be unique within a slide.
    sourceElements.forEach((map, elementId) => elements.set(elementId, cloneElementMap(map) as Y.Map<unknown>));
    target.set(SLIDE_ELEMENTS_KEY, elements);
    const notes = doc.getXmlFragment(notesFragmentName(slideId));
    if (notes.length > 0) doc.getXmlFragment(notesFragmentName(id)).insert(0, notes.toArray().map((node) => node.clone() as Y.XmlElement | Y.XmlText));
    order.insert(at + 1, [id]);
  });
  return id;
}

/** Sets or clears `hidden` on slides. */
export function setSlidesHidden(doc: Y.Doc, slideIds: string[], hidden: boolean): void {
  doc.transact(() => {
    for (const id of slideIds) {
      if (elementsOf(doc, id)) doc.getMap<unknown>(slideMapName(id)).set('hidden', hidden);
    }
  });
}

/**
 * Moves several slides to sit together at `toIndex`, counted among the slides
 * that are not moving, keeping their order relative to one another.
 */
export function moveSlides(doc: Y.Doc, slideIds: string[], toIndex: number): void {
  doc.transact(() => {
    const order = doc.getArray<string>(SLIDE_ORDER);
    const current = order.toArray();
    const moving = current.filter((id) => slideIds.includes(id));
    if (moving.length === 0) return;
    const rest = current.filter((id) => !slideIds.includes(id));
    const at = Math.min(Math.max(toIndex, 0), rest.length);
    const next = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
    if (next.every((id, i) => id === current[i])) return;
    // Only the moved ids are deleted and re-inserted, so everyone else's slides stay where concurrent edits expect them.
    for (let i = current.length - 1; i >= 0; i--) if (slideIds.includes(current[i])) order.delete(i, 1);
    const kept = order.toArray();
    // Reinsert after the slide that now precedes the group.
    const before = at === 0 ? -1 : kept.indexOf(rest[at - 1]);
    order.insert(before + 1, moving);
  });
}
