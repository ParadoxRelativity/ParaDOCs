import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  animationKeyframes,
  buildPlan,
  describeNextBuild,
  readAnimation,
  slideBuildSteps,
  unitShown,
  type ElementAnimation,
} from './slideBuilds.js';
import { moveElementAnimation, setElementAnimations } from './slideEdit.js';
import { createSlide, readSlide, setSlideElement, type SlideElement } from './slides.js';
import { initialShowState, showPlaylist, showReducer } from './slideShow.js';

const text = (id: string, body: string, animation?: Partial<ElementAnimation> & { order?: number }, z = 0): SlideElement =>
  ({
    id,
    type: 'richText',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    z,
    text: body,
    ...(animation ? { animation: { effect: 'fade', trigger: 'onClick', order: 0, ...animation } } : {}),
  }) as SlideElement;

describe('build plan', () => {
  it('is empty for a slide with no animations', () => {
    expect(buildPlan([text('a', 'x')])).toEqual({ units: [], steps: 0 });
  });

  it('gives each on-click animation its own step, in order', () => {
    const plan = buildPlan([text('b', 'b', { order: 1 }), text('a', 'a', { order: 0 }), text('c', 'c', { order: 2 })]);
    expect(plan.units.map((u) => [u.elementId, u.step])).toEqual([['a', 1], ['b', 2], ['c', 3]]);
    expect(plan.steps).toBe(3);
  });

  it('chains with-previous and after-previous onto the click before them', () => {
    const plan = buildPlan([
      text('a', 'a', { order: 0 }),
      text('b', 'b', { order: 1, trigger: 'withPrevious', delayMs: 200 }),
      text('c', 'c', { order: 2, trigger: 'afterPrevious', durationMs: 400 }),
      text('d', 'd', { order: 3 }),
    ]);
    expect(plan.steps).toBe(2);
    const by = Object.fromEntries(plan.units.map((u) => [u.elementId, u]));
    expect([by.a.step, by.b.step, by.c.step, by.d.step]).toEqual([1, 1, 1, 2]);
    expect(by.b.startMs).toBe(200);
    // after the previous unit (b: starts 200, 500ms fade) finishes
    expect(by.c.startMs).toBe(700);
  });

  it('plays animations before the first click as the slide appears', () => {
    const plan = buildPlan([text('a', 'a', { trigger: 'afterPrevious', order: 0 }), text('b', 'b', { order: 1 })]);
    expect(plan.units.map((u) => u.step)).toEqual([0, 1]);
    expect(plan.steps).toBe(1);
  });

  it('builds a text box by paragraph, one click each', () => {
    const plan = buildPlan([text('list', 'one\ntwo\nthree', { byParagraph: true })]);
    expect(plan.units.map((u) => [u.paragraph, u.step])).toEqual([[0, 1], [1, 2], [2, 3]]);
    expect(slideBuildSteps({ elements: [text('list', 'one\ntwo\nthree', { byParagraph: true })] })).toBe(3);
  });

  it('ignores by-paragraph on elements that are not text, and invalid animations', () => {
    const image = { id: 'i', type: 'image', x: 0, y: 0, width: 1, height: 1, z: 0, url: 'u', animation: { effect: 'fade', trigger: 'onClick', order: 0, byParagraph: true } } as unknown as SlideElement;
    expect(buildPlan([image]).units).toHaveLength(1);
    expect(readAnimation({ effect: 'spin', trigger: 'onClick', order: 0 })).toBeNull();
    expect(buildPlan([{ ...text('a', 'a'), animation: { effect: 'nope' } } as unknown as SlideElement]).steps).toBe(0);
  });

  it('reveals entrances and removes exits as clicks pass their step', () => {
    const plan = buildPlan([text('a', 'a', { order: 0 }), text('b', 'b', { order: 1, phase: 'exit' })]);
    const [a, b] = plan.units;
    expect([0, 1, 2].map((s) => unitShown(a, s))).toEqual([false, true, true]);
    expect([0, 1, 2].map((s) => unitShown(b, s))).toEqual([true, true, false]);
  });

  it('describes the next click for a presenter', () => {
    const elements = [text('list', 'Alpha\nBeta', { byParagraph: true, effect: 'fly' })];
    expect(describeNextBuild({ elements }, 0)).toEqual(['Fly in: Alpha (paragraph 1)']);
    expect(describeNextBuild({ elements }, 1)).toEqual(['Fly in: Alpha (paragraph 2)']);
    expect(describeNextBuild({ elements }, 2)).toEqual([]);
  });

  it('reverses keyframes for an exit', () => {
    const enter = animationKeyframes({ effect: 'fade', trigger: 'onClick', order: 0 });
    const exit = animationKeyframes({ effect: 'fade', trigger: 'onClick', order: 0, phase: 'exit' });
    expect(exit).toEqual([...enter].reverse());
  });
});

describe('slideshow stepping', () => {
  const elements = [text('list', 'one\ntwo\nthree', { byParagraph: true })];
  const playlist = showPlaylist([{ id: 's', hidden: false, elements } as never, { id: 't', hidden: false, elements: [] } as never], slideBuildSteps);

  it('reveals one bullet per press, then moves on', () => {
    let s = initialShowState(playlist);
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      s = showReducer(s, { type: 'next' }, playlist);
      seen.push(s.step);
    }
    expect(seen).toEqual([1, 2, 3, 0]);
    expect(s.slideId).toBe('t');
  });

  it('un-builds in reverse going back, and lands fully built', () => {
    let s = showReducer(initialShowState(playlist), { type: 'goto', index: 1 }, playlist);
    s = showReducer(s, { type: 'prev' }, playlist);
    expect(s).toMatchObject({ slideId: 's', step: 3 });
    s = showReducer(s, { type: 'prev' }, playlist);
    expect(s.step).toBe(2);
  });
});

describe('editing animations', () => {
  const setup = () => {
    const doc = new Y.Doc();
    const slide = createSlide(doc, { id: 's' });
    for (const id of ['a', 'b', 'c']) setSlideElement(doc, slide, text(id, id));
    return doc;
  };
  const order = (doc: Y.Doc) => Object.fromEntries(readSlide(doc, 's').elements.map((e) => [e.id, (e as { animation?: ElementAnimation }).animation?.order]));

  it('appends new animations to the order and keeps an existing one in place when changed', () => {
    const doc = setup();
    setElementAnimations(doc, 's', ['b'], {});
    setElementAnimations(doc, 's', ['a', 'c'], { effect: 'zoom' });
    expect(order(doc)).toEqual({ a: 1, b: 0, c: 2 });
    setElementAnimations(doc, 's', ['b'], { effect: 'wipe', direction: 'top' });
    expect(readSlide(doc, 's').elements.find((e) => e.id === 'b')).toMatchObject({ animation: { effect: 'wipe', direction: 'top', order: 0, trigger: 'onClick' } });
  });

  it('closes the gap when one is removed, and reorders', () => {
    const doc = setup();
    setElementAnimations(doc, 's', ['a', 'b', 'c'], {});
    setElementAnimations(doc, 's', ['a'], null);
    expect(order(doc)).toEqual({ a: undefined, b: 0, c: 1 });
    moveElementAnimation(doc, 's', 'c', 0);
    expect(order(doc)).toEqual({ a: undefined, b: 1, c: 0 });
  });

  it('drops appear durations and by-paragraph on non-text elements', () => {
    const doc = setup();
    setSlideElement(doc, 's', { id: 'img', type: 'image', url: 'u', x: 0, y: 0, width: 1, height: 1, z: 9 } as unknown as SlideElement);
    setElementAnimations(doc, 's', ['img'], { effect: 'appear', durationMs: 900, byParagraph: true });
    expect((readSlide(doc, 's').elements.find((e) => e.id === 'img') as { animation: ElementAnimation }).animation).toEqual({ effect: 'appear', trigger: 'onClick', order: 0 });
  });
});
