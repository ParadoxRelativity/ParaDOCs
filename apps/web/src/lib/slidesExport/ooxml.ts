import {
  DEFAULT_COLUMN_GAP,
  MAPPED_COLOR_SLOTS,
  THEME_COLOR_SLOTS,
  animationDelay,
  animationDuration,
  isThemeColor,
  textColumns,
  textInsets,
  type BuildUnit,
  type ColorMap,
  type LayoutPlaceholder,
  type MasterPlaceholder,
  type PlaceholderKind,
  type PlaceholderStyle,
  type SlideBackground,
  type SlideLayout,
  type SlideTransition,
  type Theme,
} from '@paradocs/shared';
import { transitionDuration } from '@paradocs/shared';

/**
 * The OOXML the exporter writes itself, because PptxGenJS cannot: the theme,
 * the slide master and its layouts, backgrounds with gradients, transitions and
 * build animations. Everything here is a pure string function so it can be
 * tested without a browser.
 */

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

export const EMU_PER_INCH = 914400;
/** Slide units per inch: 1920 units are 13.333 in, the width of PowerPoint's 16:9 slide. */
export const UNITS_PER_INCH = 144;
export const emu = (units: number): number => Math.round((units * EMU_PER_INCH) / UNITS_PER_INCH);
/** Slide units as points (1/72 in). */
export const points = (units: number): number => units / 2;
/** Hundredths of a point, the unit of `sz`. */
export const sz = (units: number): number => Math.max(100, Math.round(points(units) * 100));

export function xmlEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

/** Our slot names as OOXML's scheme color names. */
export const SCHEME_NAME: Record<string, string> = {
  dark1: 'dk1',
  light1: 'lt1',
  dark2: 'dk2',
  light2: 'lt2',
  accent1: 'accent1',
  accent2: 'accent2',
  accent3: 'accent3',
  accent4: 'accent4',
  accent5: 'accent5',
  accent6: 'accent6',
  hyperlink: 'hlink',
  followedHyperlink: 'folHlink',
  background1: 'bg1',
  text1: 'tx1',
  background2: 'bg2',
  text2: 'tx2',
};

const THEME_COLOR = /^theme:([a-zA-Z0-9]+)(?:([+-])(\d{1,3}))?$/;

export interface ParsedThemeColor {
  scheme: string;
  /** `lighter` mixes toward white by `amount` percent, `darker` toward black. */
  mode?: 'lighter' | 'darker';
  amount?: number;
}

export function parseThemeColor(value: string | undefined): ParsedThemeColor | null {
  if (!value || !isThemeColor(value)) return null;
  const match = THEME_COLOR.exec(value);
  if (!match) return null;
  const scheme = SCHEME_NAME[match[1]];
  if (!scheme) return null;
  if (!match[2]) return { scheme };
  return { scheme, mode: match[2] === '+' ? 'lighter' : 'darker', amount: Math.min(Number(match[3]), 100) };
}

/** `<a:schemeClr>` for a theme color, lighter and darker shades as PowerPoint's palette writes them (lumMod and lumOff). */
export function schemeColorXml(color: ParsedThemeColor, inner = ''): string {
  let adjust = '';
  if (color.mode === 'lighter') adjust = `<a:lumMod val="${(100 - color.amount!) * 1000}"/><a:lumOff val="${color.amount! * 1000}"/>`;
  else if (color.mode === 'darker') adjust = `<a:lumMod val="${(100 - color.amount!) * 1000}"/>`;
  return adjust || inner ? `<a:schemeClr val="${color.scheme}">${adjust}${inner}</a:schemeClr>` : `<a:schemeClr val="${color.scheme}"/>`;
}

/** A literal color as six hex digits (upper case), or null for `transparent`, empty and anything not a hex color. */
export function hexOf(value: string | undefined): string | null {
  if (!value) return null;
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim());
  if (!m) return null;
  let hex = m[1];
  if (hex.length === 3) hex = [...hex].map((c) => c + c).join('');
  return hex.slice(0, 6).toUpperCase();
}

/** A color field as a DrawingML color element; a theme slot stays a scheme color. */
export function colorXml(value: string | undefined, fallback = '000000'): string {
  const theme = parseThemeColor(value);
  if (theme) return schemeColorXml(theme);
  return `<a:srgbClr val="${hexOf(value) ?? fallback}"/>`;
}

/**
 * PptxGenJS only writes literal colors, so a theme color goes through it as a
 * made-up hex "token" that is swapped for the real `<a:schemeClr>` in the
 * finished XML. Tokens are picked so none appears anywhere in the deck.
 */
export class ColorTokens {
  private readonly tokens = new Map<string, string>();
  private readonly byToken = new Map<string, string>();
  private next = 0;

  constructor(private readonly avoid: string) {}

  /** The six hex digits to hand PptxGenJS for a color field, or undefined when there is no color to draw. */
  hex(value: string | undefined): string | undefined {
    if (!value) return undefined;
    if (!parseThemeColor(value)) return hexOf(value) ?? undefined;
    const known = this.tokens.get(value);
    if (known) return known;
    let token: string;
    do {
      token = (0x0e0e00 + this.next++).toString(16).toUpperCase().padStart(6, '0');
    } while (this.avoid.includes(token.toLowerCase()));
    this.tokens.set(value, token);
    this.byToken.set(token, value);
    return token;
  }

  /** The XML with every token turned back into a theme color. */
  apply(xml: string): string {
    if (this.byToken.size === 0) return xml;
    return xml.replace(/<a:srgbClr val="([0-9A-F]{6})"(?:\s*\/>|>([\s\S]*?)<\/a:srgbClr>)/g, (whole, token: string, inner?: string) => {
      const value = this.byToken.get(token);
      const parsed = value ? parseThemeColor(value) : null;
      return parsed ? schemeColorXml(parsed, inner ?? '') : whole;
    });
  }
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

const THEME_XML_ORDER: [string, (typeof THEME_COLOR_SLOTS)[number]][] = [
  ['dk1', 'dark1'],
  ['lt1', 'light1'],
  ['dk2', 'dark2'],
  ['lt2', 'light2'],
  ['accent1', 'accent1'],
  ['accent2', 'accent2'],
  ['accent3', 'accent3'],
  ['accent4', 'accent4'],
  ['accent5', 'accent5'],
  ['accent6', 'accent6'],
  ['hlink', 'hyperlink'],
  ['folHlink', 'followedHyperlink'],
];

export function colorSchemeXml(theme: Theme): string {
  const slots = THEME_XML_ORDER.map(([tag, slot]) => `<a:${tag}><a:srgbClr val="${hexOf(theme.colors[slot]) ?? '000000'}"/></a:${tag}>`).join('');
  return `<a:clrScheme name="${xmlEscape(theme.name)}">${slots}</a:clrScheme>`;
}

/**
 * PptxGenJS's own theme with the deck's colors, fonts and name put in; its
 * format scheme (fills, lines, effects) is kept as it is.
 */
export function patchThemeXml(xml: string, theme: Theme): string {
  let out = xml.replace(/<a:clrScheme[\s\S]*?<\/a:clrScheme>/, colorSchemeXml(theme));
  const font = (tag: 'majorFont' | 'minorFont', face: string) => {
    out = out.replace(new RegExp(`(<a:${tag}>\\s*)<a:latin[^>]*/>`), `$1<a:latin typeface="${xmlEscape(face)}"/>`);
  };
  font('majorFont', theme.fonts.heading);
  font('minorFont', theme.fonts.body);
  out = out.replace(/(<a:theme\b[^>]*\bname=")[^"]*(")/, `$1${xmlEscape(theme.name)}$2`);
  out = out.replace(/<a:fontScheme name="[^"]*"/, `<a:fontScheme name="${xmlEscape(theme.name)}"`);
  return out;
}

/** The master's color map: which theme slot each of background, text, background 2 and text 2 stands for. */
export function colorMapXml(map: ColorMap | undefined): string {
  const m = map ?? { background1: 'light1', text1: 'dark1', background2: 'light2', text2: 'dark2' };
  const name = (key: (typeof MAPPED_COLOR_SLOTS)[number]) => SCHEME_NAME[m[key]];
  return `<p:clrMap bg1="${name('background1')}" tx1="${name('text1')}" bg2="${name('background2')}" tx2="${name('text2')}" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>`;
}

// ---------------------------------------------------------------------------
// Backgrounds
// ---------------------------------------------------------------------------

/** The fraction of a picture to cut away on each side so it fills a box of another shape (CSS `cover`). */
export interface Crop {
  l: number;
  t: number;
  r: number;
  b: number;
}

export function coverCrop(image: { width: number; height: number } | undefined, box: { width: number; height: number }): Crop | undefined {
  if (!image || !image.width || !image.height || !box.width || !box.height) return undefined;
  const imageRatio = image.width / image.height;
  const boxRatio = box.width / box.height;
  if (Math.abs(imageRatio - boxRatio) < 0.001) return undefined;
  if (imageRatio > boxRatio) {
    const keep = boxRatio / imageRatio;
    return { l: (1 - keep) / 2, r: (1 - keep) / 2, t: 0, b: 0 };
  }
  const keep = imageRatio / boxRatio;
  return { l: 0, r: 0, t: (1 - keep) / 2, b: (1 - keep) / 2 };
}

export function srcRectXml(crop: Crop | undefined): string {
  if (!crop) return '';
  // A negative inset shows a margin around the picture.
  const part = (name: string, v: number) => (Math.abs(v) > 0.0005 ? ` ${name}="${Math.round(v * 100000)}"` : '');
  const attrs = part('l', crop.l) + part('t', crop.t) + part('r', crop.r) + part('b', crop.b);
  return attrs ? `<a:srcRect${attrs}/>` : '';
}

/** Our gradient angle (0 is upward, clockwise) as OOXML's (0 is left to right, clockwise), in 60000ths of a degree. */
export function gradientAngle(angle: number): number {
  return Math.round((((angle - 90) % 360) + 360) % 360) * 60000;
}

export function gradientFillXml(background: Extract<SlideBackground, { kind: 'gradient' }>): string {
  const stops = background.stops
    .slice()
    .sort((a, b) => a.offset - b.offset)
    .map((stop) => `<a:gs pos="${Math.round(stop.offset * 100000)}">${colorXml(stop.color, 'FFFFFF')}</a:gs>`)
    .join('');
  const shape = background.radial
    ? '<a:path path="circle"><a:fillToRect l="50000" t="50000" r="50000" b="50000"/></a:path>'
    : `<a:lin ang="${gradientAngle(background.angle)}" scaled="0"/>`;
  return `<a:gradFill rotWithShape="1"><a:gsLst>${stops}</a:gsLst>${shape}</a:gradFill>`;
}

/**
 * A `<p:bg>` for a color or gradient, or for a picture whose relationship is
 * `imageRid` (pass `crop` to fill the slide without stretching it).
 */
export function backgroundXml(background: SlideBackground, image?: { rid: string; crop?: Crop }): string {
  let fill: string;
  if (background.kind === 'color') fill = `<a:solidFill>${colorXml(background.color, 'FFFFFF')}</a:solidFill>`;
  else if (background.kind === 'gradient') fill = gradientFillXml(background);
  else if (image) fill = `<a:blipFill dpi="0" rotWithShape="1"><a:blip r:embed="${image.rid}"/>${srcRectXml(image.crop)}<a:stretch><a:fillRect/></a:stretch></a:blipFill>`;
  else fill = '<a:solidFill><a:schemeClr val="bg1"/></a:solidFill>';
  return `<p:bg><p:bgPr>${fill}<a:effectLst/></p:bgPr></p:bg>`;
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/** A `<p:transition>` (with its p14 duration, which older readers fall back from), or '' for none. */
export function transitionXml(transition: SlideTransition | undefined): string {
  if (!transition || transition.kind === 'none') return '';
  const ms = transitionDuration(transition);
  const body = {
    fade: '<p:fade/>',
    push: '<p:push dir="l"/>',
    wipe: '<p:wipe dir="l"/>',
    zoom: '<p:zoom dir="in"/>',
  }[transition.kind];
  const speed = ms <= 400 ? 'fast' : ms >= 1000 ? 'slow' : 'med';
  return (
    `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">` +
    `<mc:Choice xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" Requires="p14"><p:transition spd="${speed}" p14:dur="${ms}">${body}</p:transition></mc:Choice>` +
    `<mc:Fallback><p:transition spd="${speed}">${body}</p:transition></mc:Fallback></mc:AlternateContent>`
  );
}

// ---------------------------------------------------------------------------
// Placeholders: master, layouts
// ---------------------------------------------------------------------------

export interface PlaceholderSpec {
  /** The `type` attribute of `<p:ph>`, none for a title on a content layout (the default type). */
  type: string;
  idx?: number;
}

/**
 * The `<p:ph>` identity of each placeholder of a layout. A slide's shape names
 * the same type and idx to fill it, so the layout writer and the slide patcher
 * both go through here.
 */
export function placeholderSpecs(layout: Pick<SlideLayout, 'type' | 'placeholders'>): Map<string, PlaceholderSpec> {
  const specs = new Map<string, PlaceholderSpec>();
  let content = 0;
  for (const ph of layout.placeholders) {
    switch (ph.kind) {
      case 'title':
        specs.set(ph.id, { type: layout.type === 'title' ? 'ctrTitle' : 'title' });
        break;
      case 'subtitle':
        specs.set(ph.id, { type: 'subTitle', idx: ++content });
        break;
      case 'body':
        specs.set(ph.id, { type: 'body', idx: ++content });
        break;
      case 'image':
        specs.set(ph.id, { type: 'pic', idx: ++content });
        break;
      case 'date':
        specs.set(ph.id, { type: 'dt', idx: 10 });
        break;
      case 'footer':
        specs.set(ph.id, { type: 'ftr', idx: 11 });
        break;
      case 'slideNumber':
        specs.set(ph.id, { type: 'sldNum', idx: 12 });
        break;
    }
  }
  return specs;
}

export function phXml(spec: PlaceholderSpec): string {
  return `<p:ph type="${spec.type}"${spec.idx !== undefined ? ` idx="${spec.idx}"` : ''}/>`;
}

const ANCHOR = { top: 't', middle: 'ctr', bottom: 'b' } as const;

function defRPr(style: PlaceholderStyle, extra = ''): string {
  const attrs =
    (style.fontSize !== undefined ? ` sz="${sz(style.fontSize)}"` : '') +
    (style.bold !== undefined ? ` b="${style.bold ? 1 : 0}"` : '') +
    (style.italic !== undefined ? ` i="${style.italic ? 1 : 0}"` : '');
  const fill = style.color ? `<a:solidFill>${colorXml(style.color)}</a:solidFill>` : '';
  const latin = style.fontFamily ? `<a:latin typeface="${xmlEscape(style.fontFamily)}"/>` : '';
  return `<a:defRPr lang="en-US"${attrs} dirty="0">${fill}${latin}${extra}</a:defRPr>`;
}

function bodyPrXml(style: PlaceholderStyle): string {
  const anchor = ANCHOR[style.verticalAlign ?? 'top'];
  const fit = style.autofit === false ? '<a:noAutofit/>' : '<a:normAutofit/>';
  const inset = textInsets(style);
  const columns = textColumns(style);
  const layout = (style.wrap === false ? ' wrap="none"' : '') + (columns > 1 ? ` numCol="${columns}" spcCol="${emu(style.columnGap ?? DEFAULT_COLUMN_GAP)}"` : '');
  return `<a:bodyPr vert="horz"${layout} lIns="${emu(inset.left)}" tIns="${emu(inset.top)}" rIns="${emu(inset.right)}" bIns="${emu(inset.bottom)}" rtlCol="0" anchor="${anchor}">${fit}</a:bodyPr>`;
}

function shapeFillXml(style: PlaceholderStyle): string {
  const fill = style.fill && style.fill !== 'transparent' ? `<a:solidFill>${colorXml(style.fill)}</a:solidFill>` : '';
  const line = style.stroke ? `<a:ln w="${emu(style.strokeWidth ?? 2)}"><a:solidFill>${colorXml(style.stroke)}</a:solidFill></a:ln>` : '';
  return fill + line;
}

const PROMPT_NAME: Record<PlaceholderKind, string> = {
  title: 'Title',
  subtitle: 'Subtitle',
  body: 'Text Placeholder',
  image: 'Picture Placeholder',
  footer: 'Footer Placeholder',
  slideNumber: 'Slide Number Placeholder',
  date: 'Date Placeholder',
};

export interface PlaceholderShape {
  id: number;
  kind: PlaceholderKind;
  spec: PlaceholderSpec;
  box?: { x: number; y: number; width: number; height: number };
  style: PlaceholderStyle;
  prompt: string;
}

/** A `<p:sp>` placeholder as a master or layout holds it. */
export function placeholderShapeXml(ph: PlaceholderShape): string {
  const xfrm = ph.box
    ? `<a:xfrm><a:off x="${emu(ph.box.x)}" y="${emu(ph.box.y)}"/><a:ext cx="${emu(ph.box.width)}" cy="${emu(ph.box.height)}"/></a:xfrm>`
    : '';
  const algn = ph.style.align ? ` algn="${{ left: 'l', center: 'ctr', right: 'r', justify: 'just' }[ph.style.align]}"` : '';
  const lstStyle = `<a:lstStyle><a:lvl1pPr marL="0" indent="0"${algn}><a:buNone/>${defRPr(ph.style)}</a:lvl1pPr></a:lstStyle>`;
  const text =
    ph.kind === 'slideNumber'
      ? `<a:fld id="{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}" type="slidenum"><a:rPr lang="en-US"/><a:t>‹#›</a:t></a:fld>`
      : `<a:r><a:rPr lang="en-US"/><a:t>${xmlEscape(ph.prompt)}</a:t></a:r>`;
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${ph.id}" name="${PROMPT_NAME[ph.kind]} ${ph.id - 1}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${phXml(ph.spec)}</p:nvPr></p:nvSpPr>` +
    `<p:spPr>${xfrm}${shapeFillXml(ph.style)}</p:spPr>` +
    `<p:txBody>${bodyPrXml(ph.style)}${lstStyle}<a:p>${text}<a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>`
  );
}

const GROUP_PROPS =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

const NAMESPACES =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

export interface LayoutXmlInput {
  name: string;
  type?: string;
  background?: string;
  /** Lifted decorative shapes, already numbered. */
  decor: string;
  placeholders: string;
  showMasterSp: boolean;
}

/** The layout types PowerPoint knows; anything else (an importer's own label) is left off rather than make the file unreadable. */
const LAYOUT_TYPES = new Set(
  'title tx twoColTx tbl txAndChart chartAndTx dgm chart txAndClipArt clipArtAndTx titleOnly blank txAndObj objAndTx objOnly obj txAndMedia mediaAndTx objOverTx txOverObj txAndTwoObj twoObjAndTx twoObjOverTx fourObj vertTx clipArtAndVertTx vertTitleAndTx vertTitleAndTxOverChart twoObj objAndTwoObj twoObjAndObj cust secHead twoTxTwoObj objTx picTx'.split(' '),
);

export function layoutXml(input: LayoutXmlInput): string {
  const type = input.type && LAYOUT_TYPES.has(input.type) ? input.type : undefined;
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<p:sldLayout ${NAMESPACES}${type ? ` type="${type}"` : ''}${input.showMasterSp ? '' : ' showMasterSp="0"'} preserve="1">` +
    `<p:cSld name="${xmlEscape(input.name)}">${input.background ?? ''}<p:spTree>${GROUP_PROPS}${input.decor}${input.placeholders}</p:spTree></p:cSld>` +
    `<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`
  );
}

/** One level of the body text style: bullet, indent and size shrinking as the level deepens. */
function bodyLevel(level: number, style: PlaceholderStyle): string {
  const base = style.fontSize ?? 32;
  const size = Math.max(12, Math.round(base * Math.pow(0.875, level)));
  const marL = 342900 + level * 400050;
  const bullets = ['•', '–', '•', '–', '»', '•', '•', '•', '•'];
  const color = style.color ? `<a:solidFill>${colorXml(style.color)}</a:solidFill>` : '<a:solidFill><a:schemeClr val="tx1"/></a:solidFill>';
  return (
    `<a:lvl${level + 1}pPr marL="${marL}" indent="-342900" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1">` +
    `<a:spcBef><a:spcPct val="20000"/></a:spcBef><a:buFont typeface="Arial"/><a:buChar char="${bullets[level]}"/>` +
    `<a:defRPr sz="${sz(size)}" kern="1200">${color}<a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl${level + 1}pPr>`
  );
}

export function textStylesXml(title: PlaceholderStyle, body: PlaceholderStyle): string {
  const algn = title.align ? { left: 'l', center: 'ctr', right: 'r', justify: 'just' }[title.align] : 'l';
  const titleColor = title.color ? `<a:solidFill>${colorXml(title.color)}</a:solidFill>` : '<a:solidFill><a:schemeClr val="tx1"/></a:solidFill>';
  const titleStyle =
    `<p:titleStyle><a:lvl1pPr algn="${algn}" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:spcBef><a:spcPct val="0"/></a:spcBef><a:buNone/>` +
    `<a:defRPr sz="${sz(title.fontSize ?? 64)}" b="${title.bold ? 1 : 0}" i="${title.italic ? 1 : 0}" kern="1200">${titleColor}<a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/><a:cs typeface="+mj-cs"/></a:defRPr></a:lvl1pPr></p:titleStyle>`;
  const bodyStyle = `<p:bodyStyle>${[0, 1, 2, 3, 4, 5, 6, 7, 8].map((level) => bodyLevel(level, body)).join('')}</p:bodyStyle>`;
  const other =
    '<p:otherStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr>' +
    [0, 1, 2, 3, 4, 5, 6, 7, 8]
      .map(
        (i) =>
          `<a:lvl${i + 1}pPr marL="${i * 457200}" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl${i + 1}pPr>`,
      )
      .join('') +
    '</p:otherStyle>';
  return `<p:txStyles>${titleStyle}${bodyStyle}${other}</p:txStyles>`;
}

export interface MasterXmlInput {
  background: string;
  decor: string;
  placeholders: string;
  colorMap: string;
  layoutIds: string;
  title: PlaceholderStyle;
  body: PlaceholderStyle;
}

export function masterXml(input: MasterXmlInput): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<p:sldMaster ${NAMESPACES}><p:cSld>${input.background}<p:spTree>${GROUP_PROPS}${input.decor}${input.placeholders}</p:spTree></p:cSld>` +
    `${input.colorMap}<p:sldLayoutIdLst>${input.layoutIds}</p:sldLayoutIdLst>${textStylesXml(input.title, input.body)}</p:sldMaster>`
  );
}

/** The master placeholder kinds in the order PowerPoint writes them, with the spec each is given. */
export const MASTER_SPECS: Record<PlaceholderKind, PlaceholderSpec | null> = {
  title: { type: 'title' },
  body: { type: 'body', idx: 1 },
  date: { type: 'dt', idx: 2 },
  footer: { type: 'ftr', idx: 3 },
  slideNumber: { type: 'sldNum', idx: 4 },
  subtitle: null,
  image: null,
};

export type AnyPlaceholder = LayoutPlaceholder | MasterPlaceholder;

// ---------------------------------------------------------------------------
// Build animations
// ---------------------------------------------------------------------------

const FLY_SUBTYPE = { top: 1, right: 2, bottom: 4, left: 8 } as const;
const WIPE_FILTER = { left: 'wipe(left)', right: 'wipe(right)', top: 'wipe(up)', bottom: 'wipe(down)' } as const;
const PRESET_ID = { appear: 1, fade: 10, fly: 2, zoom: 53, wipe: 22 } as const;

export interface TimingTarget {
  spid: number;
  /** Paragraph index for a build by paragraph. */
  paragraph: number | null;
}

class Ids {
  private n = 2; // 1 is the root, 2 the main sequence
  next(): number {
    return ++this.n;
  }
}

function targetXml(target: TimingTarget): string {
  const text = target.paragraph === null ? '' : `<p:txEl><p:pRg st="${target.paragraph}" end="${target.paragraph}"/></p:txEl>`;
  return `<p:tgtEl><p:spTgt spid="${target.spid}">${text}</p:spTgt></p:tgtEl>`;
}

function setVisibility(ids: Ids, target: TimingTarget, visible: boolean, delay: number): string {
  return (
    `<p:set><p:cBhvr><p:cTn id="${ids.next()}" dur="1" fill="hold"><p:stCondLst><p:cond delay="${delay}"/></p:stCondLst></p:cTn>${targetXml(target)}` +
    `<p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="${visible ? 'visible' : 'hidden'}"/></p:to></p:set>`
  );
}

function animEffect(ids: Ids, target: TimingTarget, filter: string, dur: number, exit: boolean): string {
  return `<p:animEffect transition="${exit ? 'out' : 'in'}" filter="${filter}"><p:cBhvr><p:cTn id="${ids.next()}" dur="${dur}"/>${targetXml(target)}</p:cBhvr></p:animEffect>`;
}

function animValue(ids: Ids, target: TimingTarget, attr: string, from: string, to: string, dur: number): string {
  return (
    `<p:anim calcmode="lin" valueType="num"><p:cBhvr additive="base"><p:cTn id="${ids.next()}" dur="${dur}" fill="hold"/>${targetXml(target)}` +
    `<p:attrNameLst><p:attrName>${attr}</p:attrName></p:attrNameLst></p:cBhvr>` +
    `<p:tavLst><p:tav tm="0"><p:val><p:strVal val="${from}"/></p:val></p:tav><p:tav tm="100000"><p:val><p:strVal val="${to}"/></p:val></p:tav></p:tavLst></p:anim>`
  );
}

function effectBody(ids: Ids, unit: BuildUnit, target: TimingTarget): string {
  const a = unit.animation;
  const exit = a.phase === 'exit';
  const dur = animationDuration(a);
  const direction = a.direction ?? 'left';
  const behaviours: string[] = [];
  if (!exit) behaviours.push(setVisibility(ids, target, true, 0));
  switch (a.effect) {
    case 'fade':
      behaviours.push(animEffect(ids, target, 'fade', dur, exit));
      break;
    case 'fly': {
      const horizontal = direction === 'left' || direction === 'right';
      const away = { left: '0-#ppt_w/2', right: '1+#ppt_w/2', top: '0-#ppt_h/2', bottom: '1+#ppt_h/2' }[direction];
      const [x0, x1, y0, y1] = horizontal ? [away, '#ppt_x', '#ppt_y', '#ppt_y'] : ['#ppt_x', '#ppt_x', away, '#ppt_y'];
      behaviours.push(exit ? animValue(ids, target, 'ppt_x', x1, x0, dur) : animValue(ids, target, 'ppt_x', x0, x1, dur));
      behaviours.push(exit ? animValue(ids, target, 'ppt_y', y1, y0, dur) : animValue(ids, target, 'ppt_y', y0, y1, dur));
      break;
    }
    case 'zoom':
      behaviours.push(exit ? animValue(ids, target, 'ppt_w', '#ppt_w', '0', dur) : animValue(ids, target, 'ppt_w', '0', '#ppt_w', dur));
      behaviours.push(exit ? animValue(ids, target, 'ppt_h', '#ppt_h', '0', dur) : animValue(ids, target, 'ppt_h', '0', '#ppt_h', dur));
      behaviours.push(animEffect(ids, target, 'fade', dur, exit));
      break;
    case 'wipe':
      behaviours.push(animEffect(ids, target, WIPE_FILTER[direction], dur, exit));
      break;
    case 'appear':
    default:
      break;
  }
  if (exit) behaviours.push(setVisibility(ids, target, false, a.effect === 'appear' ? 0 : dur));
  return behaviours.join('');
}

function effectSubtype(unit: BuildUnit): number {
  const a = unit.animation;
  if (a.effect === 'fly' || a.effect === 'wipe') return FLY_SUBTYPE[a.direction ?? 'left'];
  if (a.effect === 'zoom') return 16;
  return 0;
}

const NODE_TYPE = { onClick: 'clickEffect', withPrevious: 'withEffect', afterPrevious: 'afterEffect' } as const;

/**
 * The `<p:timing>` of a slide from its build plan. Click steps become the
 * main sequence's click groups, "after previous" starts a group when the one
 * before has finished, and "with previous" joins the current group, which is
 * how PowerPoint nests them. `targets` gives each unit its shape (and the
 * paragraph for a build by paragraph); a unit with none is left out.
 * `buildTexts` lists the shapes with text that PowerPoint needs a build entry for.
 */
export function timingXml(
  units: BuildUnit[],
  targets: (unit: BuildUnit) => TimingTarget | null,
  buildTexts: { spid: number; byParagraph: boolean }[],
): string {
  const ids = new Ids();
  const items = units.map((unit) => ({ unit, target: targets(unit) })).filter((i): i is { unit: BuildUnit; target: TimingTarget } => i.target !== null);
  if (items.length === 0) return '';

  const steps = new Map<number, typeof items>();
  for (const item of items) steps.set(item.unit.step, [...(steps.get(item.unit.step) ?? []), item]);

  let clicks = '';
  for (const step of [...steps.keys()].sort((a, b) => a - b)) {
    const stepItems = steps.get(step)!;
    // Groups within the step: a click or an "after previous" starts one.
    const groups: { start: number; items: typeof items }[] = [];
    let end = 0;
    for (const item of stepItems) {
      const t = item.unit.animation.trigger;
      const effectEnd = animationDelay(item.unit.animation) + animationDuration(item.unit.animation);
      if (groups.length === 0 || t === 'afterPrevious') {
        groups.push({ start: groups.length === 0 ? 0 : end, items: [item] });
        end = groups[groups.length - 1].start + effectEnd;
      } else {
        groups[groups.length - 1].items.push(item);
        end = Math.max(end, groups[groups.length - 1].start + effectEnd);
      }
    }
    const outerId = ids.next();
    const conds = step === 0 ? '<p:cond delay="indefinite"/><p:cond evt="onBegin" delay="0"><p:tn val="2"/></p:cond>' : '<p:cond delay="indefinite"/>';
    let inner = '';
    for (const group of groups) {
      const groupId = ids.next();
      let effects = '';
      for (const { unit, target } of group.items) {
        const effectId = ids.next();
        const exit = unit.animation.phase === 'exit';
        const body = effectBody(ids, unit, target);
        effects +=
          `<p:par><p:cTn id="${effectId}" presetID="${PRESET_ID[unit.animation.effect]}" presetClass="${exit ? 'exit' : 'entr'}" presetSubtype="${effectSubtype(unit)}" fill="hold" grpId="0" nodeType="${NODE_TYPE[unit.animation.trigger]}">` +
          `<p:stCondLst><p:cond delay="${animationDelay(unit.animation)}"/></p:stCondLst><p:childTnLst>${body}</p:childTnLst></p:cTn></p:par>`;
      }
      inner += `<p:par><p:cTn id="${groupId}" fill="hold"><p:stCondLst><p:cond delay="${group.start}"/></p:stCondLst><p:childTnLst>${effects}</p:childTnLst></p:cTn></p:par>`;
    }
    clicks += `<p:par><p:cTn id="${outerId}" fill="hold"><p:stCondLst>${conds}</p:stCondLst><p:childTnLst>${inner}</p:childTnLst></p:cTn></p:par>`;
  }

  const seen = new Set<number>();
  const builds = buildTexts
    .filter((b) => items.some((i) => i.target.spid === b.spid) && !seen.has(b.spid) && seen.add(b.spid))
    .map((b) => `<p:bldP spid="${b.spid}" grpId="0"${b.byParagraph ? ' build="p"' : ' animBg="1"'}/>`)
    .join('');

  return (
    `<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>` +
    `<p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>${clicks}</p:childTnLst></p:cTn>` +
    `<p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst>` +
    `<p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq>` +
    `</p:childTnLst></p:cTn></p:par></p:tnLst>${builds ? `<p:bldLst>${builds}</p:bldLst>` : ''}</p:timing>`
  );
}
