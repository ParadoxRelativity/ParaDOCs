/**
 * Slide themes, the slide master and layouts.
 *
 * The model follows PowerPoint's so a .pptx maps into it and back
 * (PARA-95 / PARA-97):
 *
 *   Theme            a:theme       12 color slots (dk1 lt1 dk2 lt2 accent1-6 hlink
 *                                  folHlink), major/minor fonts, and the master's
 *                                  color map (bg1 tx1 bg2 tx2 -> slots)
 *   SlideMaster      p:sldMaster   background, placeholders with position and
 *                                  text style, decorative elements. One per deck.
 *   SlideLayout      p:sldLayout   placeholders that inherit the master's by
 *                                  kind and may override position and style,
 *                                  its own background and decorative elements
 *   slide            p:sld         a layout id, an optional background, and
 *                                  elements; an element with `placeholder` fills
 *                                  that layout placeholder and inherits what it
 *                                  does not set itself
 *
 * Inheritance is resolved when a deck is read (see resolveSlide), never copied
 * into slides, so editing a layout or the master restyles every slide that has
 * not overridden the property, and switching theme recolors everything that
 * names a theme slot instead of a color.
 *
 * Nothing here imports values from slides.ts (which re-exports this file), so
 * the two have no cycle.
 */

import { z } from 'zod';
import type { SlideElement, SlideSize, SlideSnapshot } from './slides.js';
import type { RichAlign } from './slideRichText.js';

// ---------------------------------------------------------------------------
// Theme colors
// ---------------------------------------------------------------------------

/** The twelve slots of a PowerPoint theme. */
export const THEME_COLOR_SLOTS = [
  'dark1',
  'light1',
  'dark2',
  'light2',
  'accent1',
  'accent2',
  'accent3',
  'accent4',
  'accent5',
  'accent6',
  'hyperlink',
  'followedHyperlink',
] as const;
export type ThemeColorSlot = (typeof THEME_COLOR_SLOTS)[number];

/** Names the master maps onto slots (PowerPoint's bg1, tx1, bg2, tx2), so a dark deck can swap text and background. */
export const MAPPED_COLOR_SLOTS = ['background1', 'text1', 'background2', 'text2'] as const;
export type MappedColorSlot = (typeof MAPPED_COLOR_SLOTS)[number];
export type ColorMap = Record<MappedColorSlot, ThemeColorSlot>;

export const DEFAULT_COLOR_MAP: ColorMap = { background1: 'light1', text1: 'dark1', background2: 'light2', text2: 'dark2' };

export interface Theme {
  id: string;
  name: string;
  colors: Record<ThemeColorSlot, string>;
  /** `heading` is the theme's major font, `body` its minor font. */
  fonts: { heading: string; body: string };
  /** The master's color map; the default maps light to background and dark to text. */
  colorMap?: ColorMap;
}

export const DEFAULT_THEME_ID = 'default';

export const DEFAULT_THEME: Theme = {
  id: DEFAULT_THEME_ID,
  name: 'Default',
  colors: {
    dark1: '#111827',
    light1: '#ffffff',
    dark2: '#374151',
    light2: '#f3f4f6',
    accent1: '#2563eb',
    accent2: '#dc2626',
    accent3: '#16a34a',
    accent4: '#d97706',
    accent5: '#7c3aed',
    accent6: '#0891b2',
    hyperlink: '#2563eb',
    followedHyperlink: '#7c3aed',
  },
  fonts: { heading: 'Inter', body: 'Inter' },
};

/** A theme read from a Y.Doc or an import, with whatever it lacks taken from the default. */
export function normalizeTheme(theme: Partial<Theme> & { id: string }): Theme {
  return {
    id: theme.id,
    name: typeof theme.name === 'string' && theme.name ? theme.name : theme.id,
    colors: { ...DEFAULT_THEME.colors, ...(theme.colors ?? {}) },
    fonts: { ...DEFAULT_THEME.fonts, ...(theme.fonts ?? {}) },
    ...(theme.colorMap ? { colorMap: { ...DEFAULT_COLOR_MAP, ...theme.colorMap } } : {}),
  };
}

const THEME_COLOR_PREFIX = 'theme:';
/** `theme:accent1`, `theme:text1`, or either with a lighter (+40) or darker (-25) percentage, as PowerPoint's palette offers. */
const THEME_COLOR = /^theme:([a-zA-Z0-9]+)(?:([+-])(\d{1,3}))?$/;

/** How an element names a theme color slot in a color field, so a theme change restyles it. */
export function themeColor(slot: ThemeColorSlot | MappedColorSlot, adjust?: number): string {
  return `${THEME_COLOR_PREFIX}${slot}${adjust ? `${adjust > 0 ? '+' : '-'}${Math.min(Math.abs(Math.round(adjust)), 100)}` : ''}`;
}

export function themeSlotOf(value: string | undefined): ThemeColorSlot | null {
  const match = value ? THEME_COLOR.exec(value) : null;
  if (!match) return null;
  return (THEME_COLOR_SLOTS as readonly string[]).includes(match[1]) ? (match[1] as ThemeColorSlot) : null;
}

/** Whether a color field names a theme slot (a mapped name or a lighter or darker shade included) rather than a color. */
export function isThemeColor(value: string | undefined): boolean {
  const match = value ? THEME_COLOR.exec(value) : null;
  return !!match && ((THEME_COLOR_SLOTS as readonly string[]).includes(match[1]) || (MAPPED_COLOR_SLOTS as readonly string[]).includes(match[1]));
}

function mixHex(hex: string, toward: 0 | 255, amount: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const channel = (shift: number) => {
    const c = (n >> shift) & 255;
    return Math.round(c + (toward - c) * amount)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${channel(16)}${channel(8)}${channel(0)}`;
}

/** A color field as a concrete color: a slot is looked up in the theme, anything else passes through. */
export function resolveSlideColor(value: string | undefined, theme: Theme): string | undefined {
  if (value === undefined) return undefined;
  const match = THEME_COLOR.exec(value);
  if (!match) return value;
  const name = match[1];
  let slot: ThemeColorSlot | undefined;
  if ((MAPPED_COLOR_SLOTS as readonly string[]).includes(name)) slot = (theme.colorMap ?? DEFAULT_COLOR_MAP)[name as MappedColorSlot];
  else if ((THEME_COLOR_SLOTS as readonly string[]).includes(name)) slot = name as ThemeColorSlot;
  if (!slot) return value;
  const base = theme.colors[slot] ?? DEFAULT_THEME.colors[slot];
  if (!match[2]) return base;
  return mixHex(base, match[2] === '+' ? 255 : 0, Math.min(Number(match[3]), 100) / 100);
}

// ---------------------------------------------------------------------------
// Backgrounds
// ---------------------------------------------------------------------------

export interface GradientStop {
  /** Where along the gradient, 0 to 1. */
  offset: number;
  color: string;
}

export type SlideBackground =
  | { kind: 'color'; color: string }
  /** A linear gradient at `angle` degrees (0 is upward, clockwise), or a radial one from the centre. */
  | { kind: 'gradient'; angle: number; stops: GradientStop[]; radial?: boolean }
  | { kind: 'image'; url: string };

export const slideBackgroundSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('color'), color: z.string().max(64) }),
  z.object({
    kind: z.literal('gradient'),
    angle: z.number().min(-360).max(360),
    stops: z.array(z.object({ offset: z.number().min(0).max(1), color: z.string().max(64) })).min(2).max(12),
    radial: z.boolean().optional(),
  }),
  z.object({ kind: z.literal('image'), url: z.string().max(2000) }),
]);

/** The background with every theme color in it made concrete. */
export function resolveBackground(background: SlideBackground, theme: Theme): SlideBackground {
  if (background.kind === 'color') return { kind: 'color', color: resolveSlideColor(background.color, theme) ?? background.color };
  if (background.kind === 'gradient') {
    return { ...background, stops: background.stops.map((stop) => ({ ...stop, color: resolveSlideColor(stop.color, theme) ?? stop.color })) };
  }
  return background;
}

// ---------------------------------------------------------------------------
// Master and layouts
// ---------------------------------------------------------------------------

export type PlaceholderKind = 'title' | 'subtitle' | 'body' | 'image' | 'footer' | 'slideNumber' | 'date';

/** Footer, slide number and date are drawn from the deck's toggles, not as elements on each slide. */
export const CHROME_KINDS: readonly PlaceholderKind[] = ['footer', 'slideNumber', 'date'];
export const isChromeKind = (kind: PlaceholderKind) => CHROME_KINDS.includes(kind);

/** Text style a placeholder gives the box that fills it; each field is what the box uses unless it sets its own. */
export interface PlaceholderStyle {
  fontSize?: number;
  fontFamily?: string;
  bold?: boolean;
  italic?: boolean;
  /** A color or a theme slot. */
  color?: string;
  align?: RichAlign;
  verticalAlign?: 'top' | 'middle' | 'bottom';
  lineSpacing?: number;
  autofit?: boolean;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
}

export const PLACEHOLDER_STYLE_KEYS = [
  'fontSize',
  'fontFamily',
  'bold',
  'italic',
  'color',
  'align',
  'verticalAlign',
  'lineSpacing',
  'autofit',
  'fill',
  'stroke',
  'strokeWidth',
] as const satisfies readonly (keyof PlaceholderStyle)[];

export interface MasterPlaceholder {
  id: string;
  kind: PlaceholderKind;
  x: number;
  y: number;
  width: number;
  height: number;
  style?: PlaceholderStyle;
  /** What an empty box says. */
  prompt?: string;
}

export interface SlideMaster {
  id: string;
  name: string;
  background: SlideBackground;
  placeholders: MasterPlaceholder[];
  /** Decorative elements drawn under every slide's own (a logo, a band). */
  elements: SlideElement[];
}

/** A layout placeholder: what it sets replaces the master placeholder of the same kind; the rest is inherited. */
export interface LayoutPlaceholder {
  id: string;
  kind: PlaceholderKind;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  style?: PlaceholderStyle;
  prompt?: string;
}

export interface SlideLayout {
  id: string;
  name: string;
  /** PowerPoint's layout type (title, obj, secHead, twoObj, twoTxTwoObj, titleOnly, blank, picTx), kept so an export can round-trip it. */
  type?: string;
  /** Replaces the master's background for slides on this layout. */
  background?: SlideBackground;
  placeholders: LayoutPlaceholder[];
  elements?: SlideElement[];
  /** Leave out the master's decorative elements. */
  hideMasterElements?: boolean;
}

/** A layout placeholder with everything inherited filled in: the box and style a slide's element ends up with. */
export interface ResolvedPlaceholder {
  id: string;
  kind: PlaceholderKind;
  x: number;
  y: number;
  width: number;
  height: number;
  style: PlaceholderStyle;
  prompt: string;
}

export const BLANK_LAYOUT_ID = 'blank';
export const MASTER_ID = 'master';

/** Which master placeholder a kind of layout placeholder inherits from. */
function masterKindOf(kind: PlaceholderKind): PlaceholderKind {
  return kind === 'subtitle' || kind === 'image' ? 'body' : kind;
}

const DEFAULT_PROMPTS: Record<PlaceholderKind, string> = {
  title: 'Click to add title',
  subtitle: 'Click to add subtitle',
  body: 'Click to add text',
  image: 'Click to add picture',
  footer: 'Footer',
  slideNumber: '#',
  date: 'Date',
};

export function placeholderPrompt(kind: PlaceholderKind): string {
  return DEFAULT_PROMPTS[kind];
}

export const PLACEHOLDER_KIND_LABELS: Record<PlaceholderKind, string> = {
  title: 'Title',
  subtitle: 'Subtitle',
  body: 'Text',
  image: 'Picture',
  footer: 'Footer',
  slideNumber: 'Slide number',
  date: 'Date',
};

const FALLBACK_BOX = { x: 120, y: 260, width: 1680, height: 720 };

/** A layout's placeholders with the master's position, style and prompt filled in under what the layout sets. */
export function resolveLayoutPlaceholders(layout: SlideLayout, master: SlideMaster): ResolvedPlaceholder[] {
  return layout.placeholders.map((placeholder) => {
    const base = master.placeholders.find((m) => m.kind === masterKindOf(placeholder.kind));
    const inherited = placeholder.kind === 'image' ? { ...base?.style, fontSize: undefined } : base?.style;
    return {
      id: placeholder.id,
      kind: placeholder.kind,
      x: placeholder.x ?? base?.x ?? FALLBACK_BOX.x,
      y: placeholder.y ?? base?.y ?? FALLBACK_BOX.y,
      width: placeholder.width ?? base?.width ?? FALLBACK_BOX.width,
      height: placeholder.height ?? base?.height ?? FALLBACK_BOX.height,
      style: { ...inherited, ...placeholder.style },
      prompt: placeholder.prompt ?? (placeholder.kind === base?.kind ? base?.prompt : undefined) ?? DEFAULT_PROMPTS[placeholder.kind],
    };
  });
}

/** A change to a placeholder: a value sets a field, null forgets it (so it is inherited again), absent leaves it. */
export interface PlaceholderPatch {
  x?: number | null;
  y?: number | null;
  width?: number | null;
  height?: number | null;
  prompt?: string | null;
  style?: { [K in keyof PlaceholderStyle]?: PlaceholderStyle[K] | null };
}

/** The list with one placeholder changed; its style keeps the fields the patch does not name. */
export function patchPlaceholder<T extends LayoutPlaceholder | MasterPlaceholder>(list: T[], id: string, patch: PlaceholderPatch): T[] {
  return list.map((placeholder) => {
    if (placeholder.id !== id) return placeholder;
    const next = { ...placeholder } as Record<string, unknown>;
    for (const key of ['x', 'y', 'width', 'height', 'prompt'] as const) {
      if (patch[key] === undefined) continue;
      if (patch[key] === null) delete next[key];
      else next[key] = patch[key];
    }
    if (patch.style) {
      const style: Record<string, unknown> = { ...placeholder.style };
      for (const [key, value] of Object.entries(patch.style)) {
        if (value === undefined) continue;
        if (value === null) delete style[key];
        else style[key] = value;
      }
      if (Object.keys(style).length) next.style = style;
      else delete next.style;
    }
    return next as unknown as T;
  });
}

/** A placeholder of a kind for a layout, with a box in the middle of the slide and an id no other has. */
export function newPlaceholder(kind: PlaceholderKind, existingIds: string[], size: SlideSize): LayoutPlaceholder {
  let n = 1;
  let id: string = kind;
  while (existingIds.includes(id)) id = `${kind}${++n}`;
  // Footer, slide number and date take the master's position until moved.
  if (isChromeKind(kind)) return { id, kind };
  const width = Math.round(size.width * 0.5);
  const height = Math.round(size.height * (kind === 'title' || kind === 'subtitle' ? 0.18 : 0.4));
  return { id, kind, x: Math.round((size.width - width) / 2), y: Math.round((size.height - height) / 2), width, height };
}

// ---------------------------------------------------------------------------
// Defaults, scaled to a slide size
// ---------------------------------------------------------------------------

const DESIGN_SIZE: SlideSize = { width: 1920, height: 1080 };

const MASTER_PLACEHOLDERS: MasterPlaceholder[] = [
  {
    id: 'title',
    kind: 'title',
    x: 120,
    y: 80,
    width: 1680,
    height: 140,
    style: { fontSize: 64, bold: true, verticalAlign: 'middle', color: themeColor('text1') },
    prompt: DEFAULT_PROMPTS.title,
  },
  {
    id: 'body',
    kind: 'body',
    x: 120,
    y: 260,
    width: 1680,
    height: 720,
    style: { fontSize: 32, verticalAlign: 'top', color: themeColor('text1') },
    prompt: DEFAULT_PROMPTS.body,
  },
  { id: 'date', kind: 'date', x: 120, y: 1000, width: 400, height: 50, style: { fontSize: 20, color: themeColor('text2'), align: 'left', verticalAlign: 'middle' }, prompt: 'Date' },
  { id: 'footer', kind: 'footer', x: 660, y: 1000, width: 600, height: 50, style: { fontSize: 20, color: themeColor('text2'), align: 'center', verticalAlign: 'middle' }, prompt: 'Footer' },
  { id: 'slideNumber', kind: 'slideNumber', x: 1380, y: 1000, width: 420, height: 50, style: { fontSize: 20, color: themeColor('text2'), align: 'right', verticalAlign: 'middle' }, prompt: '#' },
];

export const DEFAULT_MASTER: SlideMaster = {
  id: MASTER_ID,
  name: 'Master',
  background: { kind: 'color', color: themeColor('background1') },
  placeholders: MASTER_PLACEHOLDERS,
  elements: [],
};

/** Footer, date and slide number: on every layout, inheriting the master's position. */
const CHROME: LayoutPlaceholder[] = [
  { id: 'date', kind: 'date' },
  { id: 'footer', kind: 'footer' },
  { id: 'slideNumber', kind: 'slideNumber' },
];

const TITLE: LayoutPlaceholder = { id: 'title', kind: 'title' };

export const DEFAULT_LAYOUTS: SlideLayout[] = [
  { id: BLANK_LAYOUT_ID, name: 'Blank', type: 'blank', placeholders: [...CHROME] },
  {
    id: 'title',
    name: 'Title',
    type: 'title',
    placeholders: [
      { id: 'title', kind: 'title', x: 160, y: 340, width: 1600, height: 220, style: { fontSize: 64, align: 'center', verticalAlign: 'bottom' } },
      { id: 'subtitle', kind: 'subtitle', x: 160, y: 580, width: 1600, height: 120, style: { fontSize: 36, align: 'center', color: themeColor('text2') }, prompt: DEFAULT_PROMPTS.subtitle },
      ...CHROME,
    ],
  },
  { id: 'titleAndContent', name: 'Title and content', type: 'obj', placeholders: [TITLE, { id: 'body', kind: 'body' }, ...CHROME] },
  {
    id: 'sectionHeader',
    name: 'Section header',
    type: 'secHead',
    placeholders: [
      { id: 'title', kind: 'title', x: 160, y: 300, width: 1600, height: 200, style: { fontSize: 72, verticalAlign: 'bottom' } },
      { id: 'body', kind: 'body', x: 160, y: 520, width: 1600, height: 120, style: { fontSize: 36, color: themeColor('text2') } },
      ...CHROME,
    ],
  },
  {
    id: 'twoContent',
    name: 'Two content',
    type: 'twoObj',
    placeholders: [
      TITLE,
      { id: 'content1', kind: 'body', x: 120, y: 260, width: 820, height: 720 },
      { id: 'content2', kind: 'body', x: 980, y: 260, width: 820, height: 720 },
      ...CHROME,
    ],
  },
  {
    id: 'comparison',
    name: 'Comparison',
    type: 'twoTxTwoObj',
    placeholders: [
      TITLE,
      { id: 'text1', kind: 'body', x: 120, y: 250, width: 820, height: 100, style: { fontSize: 36, bold: true, verticalAlign: 'middle' } },
      { id: 'content1', kind: 'body', x: 120, y: 360, width: 820, height: 620 },
      { id: 'text2', kind: 'body', x: 980, y: 250, width: 820, height: 100, style: { fontSize: 36, bold: true, verticalAlign: 'middle' } },
      { id: 'content2', kind: 'body', x: 980, y: 360, width: 820, height: 620 },
      ...CHROME,
    ],
  },
  { id: 'titleOnly', name: 'Title only', type: 'titleOnly', placeholders: [TITLE, ...CHROME] },
  {
    id: 'pictureWithCaption',
    name: 'Picture with caption',
    type: 'picTx',
    placeholders: [
      { id: 'title', kind: 'title', x: 120, y: 120, width: 640, height: 260, style: { fontSize: 48, verticalAlign: 'bottom' } },
      { id: 'picture', kind: 'image', x: 840, y: 120, width: 960, height: 840 },
      { id: 'caption', kind: 'body', x: 120, y: 400, width: 640, height: 560, style: { fontSize: 28 } },
      ...CHROME,
    ],
  },
];

function scaleStyle(style: PlaceholderStyle | undefined, k: number): PlaceholderStyle | undefined {
  return style?.fontSize === undefined ? style : { ...style, fontSize: Math.round(style.fontSize * k) };
}

function scaleBox<T extends { x?: number; y?: number; width?: number; height?: number }>(box: T, sx: number, sy: number): T {
  const out = { ...box };
  if (box.x !== undefined) out.x = Math.round(box.x * sx);
  if (box.width !== undefined) out.width = Math.round(box.width * sx);
  if (box.y !== undefined) out.y = Math.round(box.y * sy);
  if (box.height !== undefined) out.height = Math.round(box.height * sy);
  return out;
}

/** The default master for a slide size; positions scale with the slide and text with its height. */
export function defaultMaster(size: SlideSize = DESIGN_SIZE): SlideMaster {
  const sx = size.width / DESIGN_SIZE.width;
  const sy = size.height / DESIGN_SIZE.height;
  if (sx === 1 && sy === 1) return structuredClone(DEFAULT_MASTER);
  return {
    ...structuredClone(DEFAULT_MASTER),
    placeholders: DEFAULT_MASTER.placeholders.map((p) => ({ ...scaleBox(p, sx, sy), style: scaleStyle(p.style, sy) })),
  };
}

/** The default layouts for a slide size. */
export function defaultLayouts(size: SlideSize = DESIGN_SIZE): SlideLayout[] {
  const sx = size.width / DESIGN_SIZE.width;
  const sy = size.height / DESIGN_SIZE.height;
  if (sx === 1 && sy === 1) return structuredClone(DEFAULT_LAYOUTS);
  return DEFAULT_LAYOUTS.map((layout) => ({
    ...structuredClone(layout),
    placeholders: layout.placeholders.map((p) => ({ ...scaleBox(p, sx, sy), style: scaleStyle(p.style, sy) })),
  }));
}

// ---------------------------------------------------------------------------
// Starter themes
// ---------------------------------------------------------------------------

export interface StarterTheme {
  theme: Theme;
  description: string;
  /** The master's background when the theme is applied; plain background color when absent. */
  background?: SlideBackground;
}

const DARK_MAP: ColorMap = { background1: 'dark1', text1: 'light1', background2: 'dark2', text2: 'light2' };

export const STARTER_THEMES: StarterTheme[] = [
  { theme: DEFAULT_THEME, description: 'Clean white with a blue accent' },
  {
    theme: {
      id: 'paper',
      name: 'Paper',
      colors: {
        dark1: '#2b2118',
        light1: '#fffaf0',
        dark2: '#5c4a38',
        light2: '#f1e6d3',
        accent1: '#b45309',
        accent2: '#9f1239',
        accent3: '#4d7c0f',
        accent4: '#0f766e',
        accent5: '#6d28d9',
        accent6: '#a16207',
        hyperlink: '#9f1239',
        followedHyperlink: '#6d28d9',
      },
      fonts: { heading: 'Caladea', body: 'Carlito' },
    },
    description: 'Warm cream with serif headings',
  },
  {
    theme: {
      id: 'midnight',
      name: 'Midnight',
      colors: {
        dark1: '#0f172a',
        light1: '#f8fafc',
        dark2: '#1e293b',
        light2: '#cbd5e1',
        accent1: '#38bdf8',
        accent2: '#f472b6',
        accent3: '#4ade80',
        accent4: '#fbbf24',
        accent5: '#a78bfa',
        accent6: '#2dd4bf',
        hyperlink: '#7dd3fc',
        followedHyperlink: '#c4b5fd',
      },
      fonts: { heading: 'Inter', body: 'Inter' },
      colorMap: DARK_MAP,
    },
    description: 'Light text on deep navy',
  },
  {
    theme: {
      id: 'ocean',
      name: 'Ocean',
      colors: {
        dark1: '#082f49',
        light1: '#f0f9ff',
        dark2: '#155e75',
        light2: '#cffafe',
        accent1: '#0284c7',
        accent2: '#0d9488',
        accent3: '#65a30d',
        accent4: '#ea580c',
        accent5: '#7c3aed',
        accent6: '#db2777',
        hyperlink: '#0369a1',
        followedHyperlink: '#6d28d9',
      },
      fonts: { heading: 'Liberation Sans', body: 'Liberation Sans' },
    },
    description: 'Cool blues on a soft gradient',
    background: { kind: 'gradient', angle: 160, stops: [{ offset: 0, color: themeColor('light1') }, { offset: 1, color: themeColor('light2') }] },
  },
  {
    theme: {
      id: 'sunrise',
      name: 'Sunrise',
      colors: {
        dark1: '#fff7ed',
        light1: '#1c1917',
        dark2: '#fed7aa',
        light2: '#431407',
        accent1: '#fb923c',
        accent2: '#f43f5e',
        accent3: '#facc15',
        accent4: '#2dd4bf',
        accent5: '#a78bfa',
        accent6: '#60a5fa',
        hyperlink: '#fdba74',
        followedHyperlink: '#c4b5fd',
      },
      fonts: { heading: 'Impact', body: 'Inter' },
    },
    description: 'Bold type on a warm dusk gradient',
    background: { kind: 'gradient', angle: 135, stops: [{ offset: 0, color: '#431407' }, { offset: 1, color: '#9f1239' }] },
  },
];

export function starterTheme(id: string): StarterTheme | undefined {
  return STARTER_THEMES.find((starter) => starter.theme.id === id);
}

// ---------------------------------------------------------------------------
// Resolving a slide against its layout, master and theme
// ---------------------------------------------------------------------------

/** What a slide draws besides its own elements: the page behind, shared decorations, footer text. */
export interface SlideChrome {
  kind: 'footer' | 'slideNumber' | 'date';
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  style: PlaceholderStyle;
}

export interface SlideFrame {
  /** The slide's own background, else its layout's, else the master's. */
  background: SlideBackground;
  /** Master then layout decorations, to draw under the slide's elements and not edit there. */
  elements: SlideElement[];
  chrome: SlideChrome[];
}

export interface FrameSettings {
  showFooter: boolean;
  showSlideNumber: boolean;
  showDate: boolean;
  footerText: string;
  dateText: string;
}

export interface ResolveContext {
  layouts: SlideLayout[];
  master: SlideMaster;
  settings: FrameSettings;
  /** The slide's place in the running order, counted from 1. */
  number: number;
  today: string;
}

/** The layout a slide names, else the blank one, else any. */
export function findLayout(layouts: SlideLayout[], id: string): SlideLayout {
  return layouts.find((l) => l.id === id) ?? layouts.find((l) => l.id === BLANK_LAYOUT_ID) ?? layouts[0] ?? { id: BLANK_LAYOUT_ID, name: 'Blank', placeholders: [] };
}

type Loose = Record<string, unknown>;

/**
 * An element that fills a placeholder with its geometry and style inherited:
 * what the element sets wins, then the layout's placeholder, then the master's.
 * `placeholderKind` and `prompt` are filled in for renderers; they are derived
 * and never written back.
 */
export function resolvePlaceholderElement<T extends SlideElement>(element: T, placeholders: ResolvedPlaceholder[]): T {
  const raw = element as unknown as Loose;
  const id = raw.placeholder;
  if (typeof id !== 'string') return element;
  const ph = placeholders.find((p) => p.id === id);
  const out: Loose = { ...raw };
  const box = ph ?? { ...FALLBACK_BOX, style: {} as PlaceholderStyle, kind: 'body' as PlaceholderKind, prompt: DEFAULT_PROMPTS.body };
  for (const key of ['x', 'y', 'width', 'height'] as const) if (typeof out[key] !== 'number') out[key] = box[key];
  // An image keeps its own look; text boxes take the placeholder's text style.
  if (raw.type === 'richText') {
    for (const key of PLACEHOLDER_STYLE_KEYS) if (out[key] === undefined && box.style[key] !== undefined) out[key] = box.style[key];
  }
  out.placeholderKind = box.kind;
  out.prompt = box.prompt;
  return out as unknown as T;
}

/** A slide with its placeholders resolved and its frame (background, shared decorations, footer) attached. */
export function resolveSlide(slide: SlideSnapshot, ctx: ResolveContext): SlideSnapshot {
  const layout = findLayout(ctx.layouts, slide.layoutId);
  const placeholders = resolveLayoutPlaceholders(layout, ctx.master);
  const elements = slide.elements.map((element) => resolvePlaceholderElement(element, placeholders));
  const chrome: SlideChrome[] = [];
  const add = (kind: SlideChrome['kind'], shown: boolean, text: string) => {
    const ph = placeholders.find((p) => p.kind === kind);
    if (!shown || !ph || !text) return;
    chrome.push({ kind, text, x: ph.x, y: ph.y, width: ph.width, height: ph.height, style: ph.style });
  };
  add('date', ctx.settings.showDate, ctx.settings.dateText || ctx.today);
  add('footer', ctx.settings.showFooter, ctx.settings.footerText);
  add('slideNumber', ctx.settings.showSlideNumber, String(ctx.number));
  return {
    ...slide,
    elements,
    frame: {
      background: slide.background ?? layout.background ?? ctx.master.background,
      elements: [...(layout.hideMasterElements ? [] : ctx.master.elements), ...(layout.elements ?? [])],
      chrome,
    },
  };
}
