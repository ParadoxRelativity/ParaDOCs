import { describe, expect, it } from 'vitest';
import { buildPlan, type SlideElement } from '@paradocs/shared';
import {
  ColorTokens,
  colorMapXml,
  colorXml,
  coverCrop,
  emu,
  gradientAngle,
  hexOf,
  parseThemeColor,
  placeholderSpecs,
  srcRectXml,
  timingXml,
  transitionXml,
} from './ooxml';
import { sniffImage } from './imageInfo';
import { HANDOUT_COUNTS, chunk, handoutGrid, handoutSlideWidth, sheetFor } from './printLayout';

describe('colors', () => {
  it('reads literal colors in every form a slide stores them', () => {
    expect(hexOf('#2563eb')).toBe('2563EB');
    expect(hexOf('abc')).toBe('AABBCC');
    expect(hexOf('#11223380')).toBe('112233');
    expect(hexOf('transparent')).toBeNull();
    expect(hexOf(undefined)).toBeNull();
  });

  it('writes theme colors as scheme colors, with PowerPoint shade math', () => {
    expect(colorXml('theme:accent1')).toBe('<a:schemeClr val="accent1"/>');
    expect(colorXml('theme:text1')).toBe('<a:schemeClr val="tx1"/>');
    expect(colorXml('theme:dark2')).toBe('<a:schemeClr val="dk2"/>');
    expect(colorXml('theme:hyperlink')).toBe('<a:schemeClr val="hlink"/>');
    expect(colorXml('theme:accent3+25')).toBe('<a:schemeClr val="accent3"><a:lumMod val="75000"/><a:lumOff val="25000"/></a:schemeClr>');
    expect(colorXml('theme:accent3-25')).toBe('<a:schemeClr val="accent3"><a:lumMod val="75000"/></a:schemeClr>');
    expect(colorXml('#ff0000')).toBe('<a:srgbClr val="FF0000"/>');
    expect(parseThemeColor('theme:nonsense')).toBeNull();
  });

  it('round-trips theme colors through hex tokens that never collide with the deck', () => {
    const tokens = new ColorTokens('"#0e0e00" "#0e0e01"');
    const a = tokens.hex('theme:accent1')!;
    expect(a).toBe('0E0E02');
    expect(tokens.hex('theme:accent1')).toBe(a);
    const b = tokens.hex('theme:accent1+40')!;
    expect(b).not.toBe(a);
    expect(tokens.hex('#abcdef')).toBe('ABCDEF');
    const xml = `<a:solidFill><a:srgbClr val="${a}"/></a:solidFill><a:srgbClr val="${b}"><a:alpha val="50000"/></a:srgbClr><a:srgbClr val="ABCDEF"/>`;
    expect(tokens.apply(xml)).toBe(
      '<a:solidFill><a:schemeClr val="accent1"/></a:solidFill><a:schemeClr val="accent1"><a:lumMod val="60000"/><a:lumOff val="40000"/><a:alpha val="50000"/></a:schemeClr><a:srgbClr val="ABCDEF"/>',
    );
  });

  it('writes the color map from the theme', () => {
    expect(colorMapXml(undefined)).toContain('bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2"');
    expect(colorMapXml({ background1: 'dark1', text1: 'light1', background2: 'dark2', text2: 'light2' })).toContain('bg1="dk1" tx1="lt1" bg2="dk2" tx2="lt2"');
  });
});

describe('geometry', () => {
  it('converts slide units to EMU at 144 units an inch', () => {
    expect(emu(1920)).toBe(12192000);
    expect(emu(1080)).toBe(6858000);
    expect(emu(144)).toBe(914400);
  });

  it('turns the slide gradient angle (0 is upward) into the OOXML one (0 is rightward)', () => {
    expect(gradientAngle(90)).toBe(0);
    expect(gradientAngle(180)).toBe(90 * 60000);
    expect(gradientAngle(0)).toBe(270 * 60000);
    expect(gradientAngle(-90)).toBe(180 * 60000);
  });

  it('crops a picture to fill its box without stretching', () => {
    expect(coverCrop({ width: 800, height: 400 }, { width: 600, height: 400 })).toEqual({ l: 0.125, r: 0.125, t: 0, b: 0 });
    const tall = coverCrop({ width: 400, height: 800 }, { width: 600, height: 400 })!;
    expect(tall.t).toBeCloseTo(1 / 3);
    expect(tall.b).toBeCloseTo(1 / 3);
    expect(coverCrop({ width: 600, height: 400 }, { width: 300, height: 200 })).toBeUndefined();
    expect(srcRectXml({ l: 0.125, r: 0.125, t: 0, b: 0 })).toBe('<a:srcRect l="12500" r="12500"/>');
  });
});

describe('transitions', () => {
  it('writes each kind with its duration', () => {
    expect(transitionXml({ kind: 'none' })).toBe('');
    expect(transitionXml({ kind: 'fade' })).toContain('p14:dur="500"');
    expect(transitionXml({ kind: 'zoom', durationMs: 1200 })).toContain('<p:zoom dir="in"/>');
    expect(transitionXml({ kind: 'wipe', durationMs: 200 })).toContain('spd="fast"');
    expect(transitionXml({ kind: 'push', durationMs: 5000 })).toContain('p14:dur="3000"');
  });
});

describe('placeholders', () => {
  it('gives each layout placeholder a type and index a slide can name', () => {
    const specs = placeholderSpecs({
      type: 'title',
      placeholders: [
        { id: 'title', kind: 'title' },
        { id: 'subtitle', kind: 'subtitle' },
        { id: 'pic', kind: 'image' },
        { id: 'date', kind: 'date' },
        { id: 'footer', kind: 'footer' },
        { id: 'slideNumber', kind: 'slideNumber' },
      ],
    });
    expect(specs.get('title')).toEqual({ type: 'ctrTitle' });
    expect(specs.get('subtitle')).toEqual({ type: 'subTitle', idx: 1 });
    expect(specs.get('pic')).toEqual({ type: 'pic', idx: 2 });
    expect(specs.get('date')).toEqual({ type: 'dt', idx: 10 });
    expect(specs.get('footer')).toEqual({ type: 'ftr', idx: 11 });
    expect(specs.get('slideNumber')).toEqual({ type: 'sldNum', idx: 12 });
  });
});

describe('build animations', () => {
  const box = (id: string, animation: SlideElement['animation']): SlideElement =>
    ({ id, type: 'shape', shape: 'rectangle', x: 0, y: 0, width: 10, height: 10, z: 0, animation }) as SlideElement;
  const ids = (unit: { elementId: string }) => ({ a: 11, b: 12, c: 13 })[unit.elementId as 'a'] ?? null;
  const timing = (elements: SlideElement[]) => timingXml(buildPlan(elements).units, (u) => (ids(u) ? { spid: ids(u)!, paragraph: u.paragraph } : null), []);

  it('returns nothing for a slide with no animations', () => {
    expect(timing([box('a', undefined)])).toBe('');
  });

  it('chains with-previous into one group and after-previous into the next, delayed by the first', () => {
    const xml = timing([
      box('a', { effect: 'appear', trigger: 'onClick', order: 0 }),
      box('b', { effect: 'fade', trigger: 'withPrevious', order: 1, durationMs: 400 }),
      box('c', { effect: 'wipe', direction: 'top', trigger: 'afterPrevious', order: 2, durationMs: 300 }),
    ]);
    expect(xml.match(/nodeType="clickEffect"/g)).toHaveLength(1);
    expect(xml.match(/nodeType="withEffect"/g)).toHaveLength(1);
    expect(xml.match(/nodeType="afterEffect"/g)).toHaveLength(1);
    expect(xml).toContain('presetID="22" presetClass="entr" presetSubtype="1"');
    expect(xml).toContain('filter="wipe(up)"');
    // The after-previous group starts when the 400 ms fade ends.
    expect(xml).toMatch(/<p:cond delay="400"\/><\/p:stCondLst><p:childTnLst><p:par><p:cTn id="\d+" presetID="22"/);
  });

  it('plays animations before the first click as the slide appears', () => {
    const xml = timing([box('a', { effect: 'fade', trigger: 'withPrevious', order: 0 })]);
    expect(xml).toContain('<p:cond evt="onBegin" delay="0"><p:tn val="2"/></p:cond>');
  });

  it('writes exits as hiding at the end', () => {
    const xml = timing([box('a', { effect: 'fade', trigger: 'onClick', phase: 'exit', order: 0, durationMs: 600 })]);
    expect(xml).toContain('presetClass="exit"');
    expect(xml).toContain('<p:animEffect transition="out" filter="fade">');
    expect(xml).toContain('<p:cond delay="600"/>');
    expect(xml).toContain('<p:strVal val="hidden"/>');
  });

  it('gives every timing node a unique id and lists text builds', () => {
    const xml = timingXml(
      buildPlan([box('a', { effect: 'fly', direction: 'bottom', trigger: 'onClick', order: 0 }), box('b', { effect: 'zoom', trigger: 'onClick', order: 1 })]).units,
      (u) => ({ spid: ids(u)!, paragraph: null }),
      [{ spid: 11, byParagraph: false }],
    );
    const nodeIds = [...xml.matchAll(/<p:cTn id="(\d+)"/g)].map((m) => m[1]);
    expect(new Set(nodeIds).size).toBe(nodeIds.length);
    expect(xml).toContain('presetSubtype="4"');
    expect(xml).toContain('1+#ppt_h/2');
    expect(xml).toContain('presetID="53"');
    expect(xml).toContain('<p:bldP spid="11" grpId="0" animBg="1"/>');
  });
});

describe('images', () => {
  it('reads the size and format of what the browser hands over', () => {
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
    expect(sniffImage(png)).toEqual({ ext: 'png', width: 1, height: 1 });
    const gif = Uint8Array.from([...'GIF89a'].map((c) => c.charCodeAt(0)).concat([5, 0, 7, 0], new Array(20).fill(0)));
    expect(sniffImage(gif)).toEqual({ ext: 'gif', width: 5, height: 7 });
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 20, 0, 30, 3, 0, 0, 0, 0, 0, 0]);
    expect(sniffImage(jpeg)).toEqual({ ext: 'jpeg', width: 30, height: 20 });
    expect(sniffImage(new Uint8Array(40))).toBeNull();
  });
});

describe('print layouts', () => {
  const size = { width: 1920, height: 1080 };

  it('prints a slide per page at the slide shape, and paper for everything else', () => {
    expect(sheetFor({ kind: 'slides' }, size)).toEqual({ width: 1280, height: 720 });
    expect(sheetFor({ kind: 'slides' }, { width: 1440, height: 1080 })).toEqual({ width: 1280, height: 960 });
    expect(sheetFor({ kind: 'notes' }, size)).toEqual({ width: 816, height: 1056 });
  });

  it('fits every handout on its page', () => {
    for (const perPage of HANDOUT_COUNTS) {
      const { columns, rows } = handoutGrid(perPage);
      expect(columns * rows).toBe(perPage);
      const width = handoutSlideWidth(perPage, size);
      expect(width).toBeGreaterThan(100);
      expect(width * columns + 24 * (columns - 1)).toBeLessThanOrEqual(816 - 96);
      expect((width / (16 / 9) + 28) * rows + 24 * (rows - 1)).toBeLessThanOrEqual(1056 - 96);
    }
  });

  it('splits slides across pages', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});
