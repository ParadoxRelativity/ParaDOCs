import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import {
  BLANK_LAYOUT_ID,
  DEFAULT_SIZE,
  createSlide,
  deleteSlide,
  duplicateSlide,
  duplicateSlideElements,
  moveSlides,
  patchSlideElements,
  readDeck,
  removeSlideElement,
  reorderZ,
  setSlideElement,
  setSlidesHidden,
  slideMapName,
  type DeckSnapshot,
  type SlideBackground,
  type SlideElement,
  type SlideSnapshot,
  type ZOrder,
} from '@paradocs/shared';
import { randomId } from './util';

/** Changes made closer together than this undo as one step, so typing is not undone a letter at a time. */
const UNDO_CAPTURE_MS = 400;

/** A snapshot with the previous one's objects reused wherever nothing changed, so memoised views skip what did not move. */
function share(previous: DeckSnapshot | null, next: DeckSnapshot): DeckSnapshot {
  if (!previous) return next;
  const before = new Map(previous.slides.map((slide) => [slide.id, slide]));
  const slides = next.slides.map((slide) => {
    const old = before.get(slide.id);
    if (!old) return slide;
    const oldElements = new Map(old.elements.map((element) => [element.id, element]));
    const elements = slide.elements.map((element) => {
      const o = oldElements.get(element.id);
      return o && JSON.stringify(o) === JSON.stringify(element) ? o : element;
    });
    const same =
      elements.length === old.elements.length &&
      elements.every((element, i) => element === old.elements[i]) &&
      old.layoutId === slide.layoutId &&
      old.hidden === slide.hidden &&
      old.notes === slide.notes &&
      JSON.stringify(old.background) === JSON.stringify(slide.background) &&
      JSON.stringify(old.transition) === JSON.stringify(slide.transition);
    return same ? old : { ...slide, elements };
  });
  const themes = JSON.stringify(previous.themes) === JSON.stringify(next.themes) ? previous.themes : next.themes;
  const layouts = JSON.stringify(previous.layouts) === JSON.stringify(next.layouts) ? previous.layouts : next.layouts;
  const settings = JSON.stringify(previous.settings) === JSON.stringify(next.settings) ? previous.settings : next.settings;
  return { settings, slides, themes, layouts };
}

/**
 * React view over a presentation's Y.Doc, and every edit the slide editor
 * makes to it.
 *
 * Every write is tagged with an origin private to this hook and the undo
 * manager tracks only that origin, so undo and redo step back through this
 * person's own changes and never through a collaborator's. The manager's scope
 * is the whole document: slides come and go, and a manager scoped to a list of
 * slide maps would miss the ones created later.
 */
export function useSlidesDeck(ydoc: Y.Doc) {
  const origin = useMemo(() => ({ slides: 'local' }), []);
  const undoManager = useRef<Y.UndoManager | null>(null);
  const [deck, setDeck] = useState<DeckSnapshot>(() => readDeck(ydoc));
  const [history, setHistory] = useState({ canUndo: false, canRedo: false });
  const latest = useRef(deck);
  latest.current = deck;

  useEffect(() => {
    // Remote and local changes arrive in bursts (a drag, a paste); one read per frame is plenty.
    let frame = 0;
    const read = () => {
      frame = 0;
      setDeck((previous) => share(previous, readDeck(ydoc)));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    ydoc.on('afterTransaction', schedule);
    setDeck((previous) => share(previous, readDeck(ydoc)));
    return () => {
      ydoc.off('afterTransaction', schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [ydoc]);

  useEffect(() => {
    // Made in an effect rather than a memo: a destroyed manager stops tracking,
    // and a remount (StrictMode does one) must get a live one back.
    const manager = new Y.UndoManager(ydoc, { trackedOrigins: new Set([origin]), captureTimeout: UNDO_CAPTURE_MS });
    undoManager.current = manager;
    const sync = () => setHistory({ canUndo: manager.undoStack.length > 0, canRedo: manager.redoStack.length > 0 });
    manager.on('stack-item-added', sync);
    manager.on('stack-item-popped', sync);
    manager.on('stack-cleared', sync);
    sync();
    return () => {
      manager.destroy();
      if (undoManager.current === manager) undoManager.current = null;
    };
  }, [ydoc, origin]);

  const transact = useCallback((fn: () => void) => ydoc.transact(fn, origin), [ydoc, origin]);

  const actions = useMemo(() => {
    const slide = (id: string): SlideSnapshot | undefined => latest.current.slides.find((s) => s.id === id);
    const topZ = (slideId: string) => Math.max(0, ...(slide(slideId)?.elements.map((e) => e.z) ?? [0]));
    return {
      undo: () => undoManager.current?.undo(),
      redo: () => undoManager.current?.redo(),
      /** Ends the current undo step, so what comes next is its own (the start and end of a drag). */
      checkpoint: () => undoManager.current?.stopCapturing(),

      addSlide: (afterId?: string | null, layoutId: string = BLANK_LAYOUT_ID): string => {
        const order = latest.current.slides.map((s) => s.id);
        const at = afterId ? order.indexOf(afterId) : -1;
        let id = '';
        transact(() => {
          id = createSlide(ydoc, { layoutId, index: at >= 0 ? at + 1 : order.length });
        });
        return id;
      },
      /** Copies each slide to just after itself. Returns the new ids. */
      duplicateSlides: (ids: string[]): string[] => {
        const created: string[] = [];
        transact(() => {
          for (const id of ids) {
            const copy = duplicateSlide(ydoc, id, randomId);
            if (copy) created.push(copy);
          }
        });
        return created;
      },
      deleteSlides: (ids: string[]) =>
        transact(() => {
          for (const id of ids) deleteSlide(ydoc, id);
        }),
      moveSlides: (ids: string[], toIndex: number) => transact(() => moveSlides(ydoc, ids, toIndex)),
      setHidden: (ids: string[], hidden: boolean) => transact(() => setSlidesHidden(ydoc, ids, hidden)),
      setBackground: (slideId: string, background: SlideBackground | null) =>
        transact(() => {
          const map = ydoc.getMap<unknown>(slideMapName(slideId));
          if (background) map.set('background', background);
          else map.delete('background');
        }),

      /** Puts a new element on top of a slide, sized by its type unless `props` says otherwise. */
      createElement: (slideId: string, props: Record<string, unknown> & { type: SlideElement['type']; x: number; y: number }): string => {
        const id = randomId();
        const size = (DEFAULT_SIZE as Record<string, { width: number; height: number }>)[props.type] ?? { width: 320, height: 200 };
        transact(() =>
          setSlideElement(ydoc, slideId, { width: size.width, height: size.height, ...props, id, z: topZ(slideId) + 1 } as unknown as SlideElement),
        );
        return id;
      },
      updateElements: (slideId: string, patches: { id: string; patch: Record<string, unknown> }[]) =>
        transact(() => patchSlideElements(ydoc, slideId, patches)),
      deleteElements: (slideId: string, ids: string[]) =>
        transact(() => {
          for (const id of ids) removeSlideElement(ydoc, slideId, id);
        }),
      /** Copies elements on one slide (a duplicate in place), nudged so the copy is visible. */
      duplicateElements: (slideId: string, ids: string[]): string[] => {
        let created: string[] = [];
        transact(() => {
          created = duplicateSlideElements(ydoc, slideId, ids, slideId, { offset: 40, makeId: randomId });
        });
        return created;
      },
      /** Pastes element snapshots (from this or another presentation) on top of a slide, under new ids. */
      pasteElements: (slideId: string, elements: SlideElement[], offset: number): string[] => {
        const created: string[] = [];
        let z = topZ(slideId);
        transact(() => {
          for (const element of elements) {
            const id = randomId();
            z += 1;
            setSlideElement(ydoc, slideId, { ...element, id, x: element.x + offset, y: element.y + offset, z });
            created.push(id);
          }
        });
        return created;
      },
      reorder: (slideId: string, ids: Set<string>, how: ZOrder) => {
        const elements = slide(slideId)?.elements ?? [];
        const changes = reorderZ(elements, ids, how);
        if (changes.length) transact(() => patchSlideElements(ydoc, slideId, changes.map(({ id, z }) => ({ id, patch: { z } }))));
      },
    };
  }, [ydoc, transact]);

  return { deck, history, actions };
}

export type SlidesActions = ReturnType<typeof useSlidesDeck>['actions'];
