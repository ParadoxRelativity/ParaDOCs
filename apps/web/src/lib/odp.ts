import {
  mapOfficeFont,
  type AnimationDirection,
  type AnimationEffect,
  type ElementAnimation,
  type GradientStop,
  type RichMarks,
  type RichParagraph,
  type SlideBackground,
  type SlideElement,
  type SlideShapeKind,
  type SlideTransition,
  type TableCell,
} from '@paradocs/shared';
import { PackageError, attr, child, descendants, extensionOf, kids, localName, mimeOf, numAttr, type XmlParser, type ZipFiles } from './ooxml';
import { ReportBuilder, mediaUrl, type ImportProgress, type ImportedDeck, type ImportedMedia, type ImportedSlide } from './slideImportTypes';

/**
 * OpenDocument Presentation (.odp, as written by LibreOffice and others) into
 * an {@link ImportedDeck}: the same target as the .pptx reader (pptx.ts).
 *
 * ODF has no placeholder inheritance to carry: every frame states its own
 * position, so slides come in with explicit geometry and the deck keeps its
 * default layouts. Master pages contribute the background and any decorative
 * shapes; styles are looked up by name (automatic styles, then named ones,
 * following `style:parent-style-name`).
 */

export interface OdpOptions {
  parseXml: XmlParser;
  fileName: string;
  onProgress?: (progress: ImportProgress) => void;
}

const CM_PER: Record<string, number> = { cm: 1, mm: 0.1, in: 2.54, pt: 2.54 / 72, pc: 2.54 / 6, px: 2.54 / 96 };

/** A length such as `2.5cm` in centimetres; null when it is not one. */
function lengthCm(value: string | undefined): number | null {
  const match = value ? /^(-?[\d.]+)\s*(cm|mm|in|pt|pc|px)$/.exec(value.trim()) : null;
  return match ? Number(match[1]) * CM_PER[match[2]] : null;
}

const ODF_SHAPES: Record<string, SlideShapeKind> = {
  rectangle: 'rectangle',
  'ooxml-rect': 'rectangle',
  'round-rectangle': 'roundRect',
  'ooxml-roundRect': 'roundRect',
  ellipse: 'ellipse',
  'ooxml-ellipse': 'ellipse',
  diamond: 'diamond',
  'ooxml-diamond': 'diamond',
  'isosceles-triangle': 'triangle',
  'ooxml-triangle': 'triangle',
  'right-triangle': 'triangle',
  'right-arrow': 'arrowRight',
  'ooxml-rightArrow': 'arrowRight',
  'left-arrow': 'arrowLeft',
  'ooxml-leftArrow': 'arrowLeft',
  'up-arrow': 'arrowUp',
  'ooxml-upArrow': 'arrowUp',
  'down-arrow': 'arrowDown',
  'ooxml-downArrow': 'arrowDown',
  'round-callout': 'callout',
  'rectangular-callout': 'callout',
  'round-rectangular-callout': 'callout',
  'star5': 'star',
  'star4': 'star',
  'star6': 'star',
  'star8': 'star',
};

interface Ctx {
  zip: ZipFiles;
  report: ReportBuilder;
  k: number;
  styles: Map<string, Element>;
  listStyles: Map<string, Element>;
  gradients: Map<string, Element>;
  media: ImportedMedia[];
  mediaByPath: Map<string, string | null>;
  slideNo: number;
  /** `draw:id` / `xml:id` of shapes to the elements made from them, for animations. */
  shapes: Map<string, string[]>;
  defaultFontSize: number;
}

const units = (ctx: Ctx, cm: number | null) => Math.round((cm ?? 0) * ctx.k);
const newId = () => crypto.randomUUID();

// --- styles -----------------------------------------------------------------

function indexStyles(ctx: Ctx, roots: (Element | null)[]) {
  for (const root of roots) {
    for (const group of [child(root, 'styles'), child(root, 'automatic-styles'), child(root, 'master-styles')]) {
      for (const style of kids(group, 'style')) {
        const name = attr(style, 'name');
        if (name) ctx.styles.set(`${attr(style, 'family') ?? ''}:${name}`, style);
      }
      for (const style of kids(group, 'list-style')) {
        const name = attr(style, 'name');
        if (name) ctx.listStyles.set(name, style);
      }
      for (const gradient of kids(group, 'gradient')) {
        const name = attr(gradient, 'name');
        if (name) ctx.gradients.set(name, gradient);
      }
    }
  }
}

/** A property group (`text-properties`, ...) merged along the style's parents, nearest winning. */
function props(ctx: Ctx, family: string, name: string | undefined, group: string): Record<string, string> {
  const merged: Record<string, string> = {};
  const chain: Element[] = [];
  for (let n = name, guard = 0; n && guard < 12; guard++) {
    const style = ctx.styles.get(`${family}:${n}`);
    if (!style) break;
    chain.unshift(style);
    n = attr(style, 'parent-style-name');
  }
  for (const style of chain) {
    const el = child(style, group);
    if (!el) continue;
    for (let i = 0; i < el.attributes.length; i++) {
      const a = el.attributes[i];
      merged[a.localName || a.name.split(':').pop() || a.name] = a.value;
    }
  }
  return merged;
}

const colorOf = (value: string | undefined): string | undefined => (value && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : undefined);

// --- media ------------------------------------------------------------------

async function addMedia(ctx: Ctx, href: string): Promise<string | null> {
  const known = ctx.mediaByPath.get(href);
  if (known !== undefined) return known;
  const mimeType = mimeOf(href);
  const fail = (feature: string) => {
    ctx.report.dropped(feature, ctx.slideNo);
    ctx.mediaByPath.set(href, null);
    return null;
  };
  if (!mimeType) return fail(`Pictures and media in .${extensionOf(href) || 'unknown'} format`);
  const data = await ctx.zip.bytes(href.replace(/^\.\//, ''));
  if (!data) return fail('Pictures and media missing from the file');
  const key = `m${ctx.media.length + 1}`;
  ctx.media.push({ key, name: href.split('/').pop() ?? key, mimeType, data });
  const url = mediaUrl(key);
  ctx.mediaByPath.set(href, url);
  return url;
}

// --- text -------------------------------------------------------------------

function marksFor(ctx: Ctx, styleNames: { family: string; name?: string }[]): RichMarks | undefined {
  const merged: Record<string, string> = {};
  for (const { family, name } of styleNames) Object.assign(merged, props(ctx, family, name, 'text-properties'));
  const marks: RichMarks = {};
  if (merged['font-weight'] === 'bold' || Number(merged['font-weight']) >= 600) marks.bold = true;
  if (merged['font-style'] === 'italic' || merged['font-style'] === 'oblique') marks.italic = true;
  if (merged['text-underline-style'] && merged['text-underline-style'] !== 'none') marks.underline = true;
  if (merged['text-line-through-style'] && merged['text-line-through-style'] !== 'none') marks.strike = true;
  const size = lengthCm(merged['font-size']);
  if (size) marks.fontSize = Math.round(size * ctx.k * 10) / 10;
  const color = colorOf(merged.color);
  if (color) marks.color = color;
  const highlight = colorOf(merged['background-color']);
  if (highlight) marks.highlight = highlight;
  const family = merged['font-name'] || merged['font-family'];
  if (family) marks.fontFamily = mapOfficeFont(family.replace(/^'|'$/g, ''));
  if (merged['text-position'] && !/^0%/.test(merged['text-position'])) ctx.report.approximated('Superscript and subscript text', ctx.slideNo, 'drawn at normal height');
  return Object.keys(marks).length ? marks : undefined;
}

const sameMarks = (a?: RichMarks, b?: RichMarks) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function readInline(ctx: Ctx, node: Element, base: { family: string; name?: string }[], paragraph: RichParagraph) {
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 3) {
      push(paragraph, c.nodeValue ?? '', marksFor(ctx, base));
      continue;
    }
    if (c.nodeType !== 1) continue;
    const el = c as Element;
    const name = localName(el);
    if (name === 'span') readInline(ctx, el, [...base, { family: 'text', name: el.getAttribute('text:style-name') ?? undefined }], paragraph);
    else if (name === 'a') {
      const href = attr(el, 'href');
      const inner: RichParagraph = { runs: [] };
      readInline(ctx, el, base, inner);
      for (const run of inner.runs) {
        const marks: RichMarks = { ...(run.marks ?? {}) };
        if (href && /^(https?:|mailto:|tel:)/i.test(href)) marks.link = href;
        push(paragraph, run.text ?? '', Object.keys(marks).length ? marks : undefined);
      }
    } else if (name === 'line-break') push(paragraph, '\n', marksFor(ctx, base));
    else if (name === 'tab') push(paragraph, '\t', marksFor(ctx, base));
    else if (name === 's') push(paragraph, ' '.repeat(numAttr(el, 'c') ?? 1), marksFor(ctx, base));
    else if (['page-number', 'date', 'time', 'page-count', 'file-name'].includes(name) || name === 'meta-field') readInline(ctx, el, base, paragraph);
  }
}

function push(paragraph: RichParagraph, text: string, marks: RichMarks | undefined) {
  if (!text) return;
  const last = paragraph.runs[paragraph.runs.length - 1];
  if (last && sameMarks(last.marks, marks)) last.text = `${last.text ?? ''}${text}`;
  else paragraph.runs.push(marks ? { text, marks } : { text });
}

function readParagraph(ctx: Ctx, p: Element, frameStyle: string | undefined, bullet: RichParagraph['bullet'], level: number): RichParagraph {
  const styleName = p.getAttribute('text:style-name') ?? undefined;
  const paragraph: RichParagraph = { runs: [] };
  readInline(ctx, p, [{ family: 'graphic', name: frameStyle }, { family: 'paragraph', name: styleName }], paragraph);
  const pp = props(ctx, 'paragraph', styleName, 'paragraph-properties');
  const align = pp['text-align'];
  if (align === 'center' || align === 'end' || align === 'right' || align === 'justify') paragraph.align = align === 'end' ? 'right' : (align as 'center' | 'right' | 'justify');
  const lh = /^(\d+(?:\.\d+)?)%$/.exec(pp['line-height'] ?? '');
  if (lh && Number(lh[1]) !== 100) paragraph.lineHeight = Math.round((Number(lh[1]) / 100) * 1.2 * 100) / 100;
  if (bullet) {
    paragraph.bullet = bullet;
    if (level > 0) paragraph.level = Math.min(level, 5);
  }
  return paragraph;
}

function readList(ctx: Ctx, list: Element, frameStyle: string | undefined, out: RichParagraph[], level: number, inheritedStyle?: string) {
  const styleName = list.getAttribute('text:style-name') ?? inheritedStyle;
  const style = styleName ? ctx.listStyles.get(styleName) : undefined;
  const levelStyle = style ? kids(style).find((l) => (numAttr(l, 'level') ?? 1) === level + 1) : undefined;
  const bullet: RichParagraph['bullet'] = levelStyle && localName(levelStyle) === 'list-level-style-number' ? 'number' : 'bullet';
  for (const item of kids(list, 'list-item')) {
    for (const c of kids(item)) {
      if (localName(c) === 'p' || localName(c) === 'h') out.push(readParagraph(ctx, c, frameStyle, bullet, level));
      else if (localName(c) === 'list') readList(ctx, c, frameStyle, out, level + 1, styleName);
    }
  }
}

function readText(ctx: Ctx, container: Element, frameStyle: string | undefined): RichParagraph[] {
  const out: RichParagraph[] = [];
  for (const c of kids(container)) {
    const name = localName(c);
    if (name === 'p' || name === 'h') out.push(readParagraph(ctx, c, frameStyle, undefined, 0));
    else if (name === 'list') readList(ctx, c, frameStyle, out, 0);
  }
  return out;
}

const hasText = (paragraphs: RichParagraph[]) => paragraphs.some((p) => p.runs.some((r) => (r.text ?? '').trim() !== ''));

// --- shapes -----------------------------------------------------------------

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
}

function boxOf(ctx: Ctx, el: Element): Box | null {
  let x = lengthCm(attr(el, 'x'));
  let y = lengthCm(attr(el, 'y'));
  const w = lengthCm(attr(el, 'width'));
  const h = lengthCm(attr(el, 'height'));
  let rotation: number | undefined;
  const transform = attr(el, 'transform');
  if (transform) {
    const rotate = /rotate\s*\(\s*(-?[\d.eE+-]+)\s*\)/.exec(transform);
    const translate = /translate\s*\(\s*(-?[\d.]+\w*)\s+(-?[\d.]+\w*)\s*\)/.exec(transform);
    if (rotate) {
      rotation = ((-Number(rotate[1]) * 180) / Math.PI + 360) % 360;
      ctx.report.approximated('Rotated shapes', ctx.slideNo, 'position approximated');
    }
    if (translate) {
      x = lengthCm(translate[1]);
      y = lengthCm(translate[2]);
    }
  }
  if (x === null || y === null || w === null || h === null) return null;
  return { x: units(ctx, x), y: units(ctx, y), width: units(ctx, w), height: units(ctx, h), ...(rotation ? { rotation: Math.round(rotation * 100) / 100 } : {}) };
}

interface Paint {
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  dash?: 'dashed' | 'dotted';
}

function paintOf(ctx: Ctx, styleName: string | undefined): Paint {
  const g = props(ctx, 'graphic', styleName, 'graphic-properties');
  const paint: Paint = {};
  if (g.fill === 'none') paint.fill = 'transparent';
  else if (g.fill === 'solid') paint.fill = colorOf(g['fill-color']);
  else if (g.fill === 'gradient') {
    const gradient = ctx.gradients.get(g['fill-gradient-name'] ?? '');
    paint.fill = colorOf(attr(gradient, 'start-color'));
    ctx.report.approximated('Gradient fills in shapes', ctx.slideNo, 'the start color is used');
  } else if (g.fill === 'bitmap' || g.fill === 'hatch') ctx.report.dropped('Picture and hatch fills in shapes', ctx.slideNo);
  if (g.stroke === 'none') paint.stroke = 'transparent';
  else if (g.stroke === 'solid' || g.stroke === 'dash') {
    paint.stroke = colorOf(g['stroke-color']) ?? '#000000';
    paint.strokeWidth = Math.max(1, units(ctx, lengthCm(g['stroke-width']) ?? 0.02));
    if (g.stroke === 'dash') paint.dash = 'dashed';
  }
  return paint;
}

function shapeFields(paint: Paint): Record<string, unknown> {
  return {
    fill: paint.fill ?? 'transparent',
    stroke: paint.stroke ?? 'transparent',
    ...(paint.strokeWidth ? { strokeWidth: paint.strokeWidth } : {}),
    ...(paint.dash ? { dash: paint.dash } : {}),
  };
}

const anchorOf = (a: string | undefined): 'top' | 'middle' | 'bottom' => (a === 'middle' ? 'middle' : a === 'bottom' ? 'bottom' : 'top');

type Out = SlideElement[];

function register(ctx: Ctx, el: Element, ids: string[]) {
  const key = attr(el, 'id');
  if (key && ids.length) ctx.shapes.set(key, [...(ctx.shapes.get(key) ?? []), ...ids]);
}

function readTable(ctx: Ctx, table: Element, box: Box, out: Out): SlideElement {
  const columns: number[] = [];
  for (const col of kids(table, 'table-column')) {
    const width = lengthCm(props(ctx, 'table-column', col.getAttribute('table:style-name') ?? undefined, 'table-column-properties')['column-width']) ?? 1;
    for (let i = 0; i < (numAttr(col, 'number-columns-repeated') ?? 1); i++) columns.push(width);
  }
  const rows = kids(table, 'table-row');
  const cells: Record<string, TableCell> = {};
  const rowHeights: number[] = [];
  rows.forEach((tr, r) => {
    rowHeights.push(lengthCm(props(ctx, 'table-row', tr.getAttribute('table:style-name') ?? undefined, 'table-row-properties')['row-height']) ?? 1);
    let c = 0;
    for (const tc of kids(tr)) {
      const name = localName(tc);
      if (name !== 'table-cell' && name !== 'covered-table-cell') continue;
      const repeat = numAttr(tc, 'number-columns-repeated') ?? 1;
      if (name === 'table-cell') {
        const paragraphs = readText(ctx, tc, undefined);
        const text = paragraphs.map((p) => p.runs.map((run) => run.text ?? '').join('')).join('\n');
        const first = paragraphs.flatMap((p) => p.runs).find((run) => (run.text ?? '') !== '')?.marks;
        const cell: TableCell = { text };
        if (first?.bold) cell.bold = true;
        if (first?.italic) cell.italic = true;
        if (first?.underline) cell.underline = true;
        if (first?.color) cell.color = first.color;
        if (first?.fontSize) cell.fontSize = first.fontSize;
        const tcp = props(ctx, 'table-cell', tc.getAttribute('table:style-name') ?? undefined, 'table-cell-properties');
        const fill = colorOf(tcp['background-color']);
        if (fill) cell.fill = fill;
        if (tcp['vertical-align'] === 'middle') cell.verticalAlign = 'middle';
        const cols = numAttr(tc, 'number-columns-spanned') ?? 1;
        const rowsSpanned = numAttr(tc, 'number-rows-spanned') ?? 1;
        if (cols > 1) cell.colSpan = cols;
        if (rowsSpanned > 1) cell.rowSpan = rowsSpanned;
        if (text || fill || cols > 1 || rowsSpanned > 1) cells[`${r}:${c}`] = cell;
      }
      c += repeat;
    }
  });
  void out;
  return {
    id: newId(),
    type: 'table',
    ...box,
    z: 0,
    rows: rows.length,
    columns: columns.length || 1,
    columnWidths: columns.length ? columns : undefined,
    rowHeights,
    cells,
    fontSize: ctx.defaultFontSize,
  } as unknown as SlideElement;
}

async function readFrame(ctx: Ctx, frame: Element, out: Out): Promise<void> {
  const box = boxOf(ctx, frame);
  if (!box) return;
  const styleName = frame.getAttribute('draw:style-name') ?? undefined;
  const klass = attr(frame, 'class');
  const ids: string[] = [];
  const add = (element: SlideElement) => {
    element.z = out.length + 1;
    out.push(element);
    ids.push(element.id);
  };

  const textBox = child(frame, 'text-box');
  const image = child(frame, 'image');
  const table = descendants(frame, 'table')[0];
  const plugin = child(frame, 'plugin');
  const object = child(frame, 'object') ?? child(frame, 'object-ole');

  if (table) {
    add(readTable(ctx, table, box, out));
  } else if (plugin) {
    const href = attr(plugin, 'href') ?? '';
    const mime = attr(plugin, 'mime-type') ?? mimeOf(href) ?? '';
    const type = mime.startsWith('audio/') ? 'audio' : 'video';
    const external = /^https?:/i.test(href);
    const url = external ? href : href ? await addMedia(ctx, href) : null;
    if (url) {
      add({ id: newId(), type, url, ...box, z: 0 } as unknown as SlideElement);
      if (external) ctx.report.approximated('Linked media', ctx.slideNo, 'kept as a link to the original address');
    } else ctx.report.dropped('Videos and sounds that are not in the file', ctx.slideNo);
  } else if (image && !object) {
    const href = attr(image, 'href');
    const url = href && !/^https?:/i.test(href) ? await addMedia(ctx, href) : null;
    if (url) {
      const g = props(ctx, 'graphic', styleName, 'graphic-properties');
      if (g.clip && g.clip !== 'rect(0cm, 0cm, 0cm, 0cm)') ctx.report.approximated('Cropped pictures', ctx.slideNo, 'shown uncropped');
      add({ id: newId(), type: 'image', url, fit: 'cover', alt: child(frame, 'desc')?.textContent || undefined, ...box, z: 0 } as unknown as SlideElement);
    } else if (!href || /^https?:/i.test(href)) ctx.report.dropped('Pictures linked from other files', ctx.slideNo);
  } else if (object) {
    // Charts and embedded objects: the replacement picture the file keeps of them.
    const replacement = child(frame, 'image');
    const href = attr(replacement, 'href');
    const url = href ? await addMedia(ctx, href) : null;
    if (url) {
      add({ id: newId(), type: 'image', url, fit: 'contain', ...box, z: 0 } as unknown as SlideElement);
      ctx.report.approximated('Charts and embedded objects', ctx.slideNo, 'kept as a picture; no longer editable');
    } else {
      ctx.report.dropped('Charts and embedded objects', ctx.slideNo, 'the file carries no picture of them');
    }
  } else if (textBox) {
    const paragraphs = readText(ctx, textBox, styleName);
    if (hasText(paragraphs) && klass !== 'page-number' && klass !== 'date-time' && klass !== 'footer' && klass !== 'header') {
      const g = props(ctx, 'graphic', styleName, 'graphic-properties');
      const paint = paintOf(ctx, styleName);
      add({
        id: newId(),
        type: 'richText',
        ...box,
        z: 0,
        paragraphs,
        fontSize: ctx.defaultFontSize,
        verticalAlign: anchorOf(g['textarea-vertical-align']),
        autofit: g['fit-to-size'] === 'true' || g.autogrow_height === 'false' ? true : false,
        ...(paint.fill && paint.fill !== 'transparent' ? { fill: paint.fill } : {}),
        ...(paint.stroke && paint.stroke !== 'transparent' ? { stroke: paint.stroke, strokeWidth: paint.strokeWidth ?? 2 } : {}),
      } as unknown as SlideElement);
    }
  }
  register(ctx, frame, ids);
}

async function readShape(ctx: Ctx, el: Element, out: Out): Promise<void> {
  const name = localName(el);
  const styleName = el.getAttribute('draw:style-name') ?? undefined;
  const paint = paintOf(ctx, styleName);
  const ids: string[] = [];
  const add = (element: SlideElement) => {
    element.z = out.length + 1;
    out.push(element);
    ids.push(element.id);
  };

  if (name === 'line' || name === 'connector') {
    const [x1, y1, x2, y2] = ['x1', 'y1', 'x2', 'y2'].map((a) => lengthCm(attr(el, a)));
    if (x1 === null || y1 === null || x2 === null || y2 === null) return;
    const [ax, ay, bx, by] = [units(ctx, x1), units(ctx, y1), units(ctx, x2), units(ctx, y2)];
    const length = Math.hypot(bx - ax, by - ay);
    const thickness = Math.max(paint.strokeWidth ?? 2, 2);
    add({
      id: newId(),
      type: 'shape',
      shape: 'line',
      x: Math.round((ax + bx) / 2 - length / 2),
      y: Math.round((ay + by) / 2 - thickness / 2),
      width: Math.round(length),
      height: Math.round(thickness),
      z: 0,
      rotation: Math.round((((Math.atan2(by - ay, bx - ax) * 180) / Math.PI + 360) % 360) * 100) / 100,
      stroke: paint.stroke && paint.stroke !== 'transparent' ? paint.stroke : '#000000',
      strokeWidth: paint.strokeWidth ?? 2,
      ...(paint.dash ? { dash: paint.dash } : {}),
    } as unknown as SlideElement);
    register(ctx, el, ids);
    return;
  }

  const box = boxOf(ctx, el);
  if (!box) {
    if (name === 'polygon' || name === 'polyline' || name === 'path') ctx.report.approximated('Freeform shapes', ctx.slideNo, 'those without a frame are left out');
    return;
  }

  let kind: SlideShapeKind = 'rectangle';
  if (name === 'ellipse' || name === 'circle') kind = 'ellipse';
  else if (name === 'rect') kind = numAttr(el, 'corner-radius') || attr(el, 'corner-radius') ? 'roundRect' : 'rectangle';
  else if (name === 'custom-shape') {
    const type = attr(child(el, 'enhanced-geometry'), 'type') ?? 'rectangle';
    if (ODF_SHAPES[type]) kind = ODF_SHAPES[type];
    else ctx.report.approximated('Shapes without an equivalent', ctx.slideNo, `drawn as a rectangle (for example ${type})`);
  } else if (name === 'polygon' || name === 'polyline' || name === 'path') {
    ctx.report.approximated('Freeform shapes', ctx.slideNo, 'drawn as a rectangle');
  }

  const paragraphs = readText(ctx, el, styleName);
  const text = hasText(paragraphs);
  const g = props(ctx, 'graphic', styleName, 'graphic-properties');
  const textFields = {
    id: newId(),
    type: 'richText',
    ...box,
    z: 0,
    paragraphs,
    fontSize: ctx.defaultFontSize,
    verticalAlign: anchorOf(g['textarea-vertical-align'] ?? 'middle'),
    autofit: false,
  };
  const visible = (paint.fill && paint.fill !== 'transparent') || (paint.stroke && paint.stroke !== 'transparent');
  if (text && kind === 'rectangle' && name !== 'custom-shape') {
    add({ ...textFields, ...(paint.fill && paint.fill !== 'transparent' ? { fill: paint.fill } : {}), ...(paint.stroke && paint.stroke !== 'transparent' ? { stroke: paint.stroke, strokeWidth: paint.strokeWidth ?? 2 } : {}) } as unknown as SlideElement);
  } else {
    if (visible || !text) add({ id: newId(), type: 'shape', shape: kind, ...box, z: 0, ...shapeFields(paint) } as unknown as SlideElement);
    if (text) add(textFields as unknown as SlideElement);
  }
  register(ctx, el, ids);
}

async function readShapes(ctx: Ctx, container: Element, out: Out): Promise<void> {
  for (const node of kids(container)) {
    const name = localName(node);
    if (name === 'frame') await readFrame(ctx, node, out);
    else if (name === 'g') {
      const before = out.length;
      await readShapes(ctx, node, out);
      register(ctx, node, out.slice(before).map((e) => e.id));
    } else if (['custom-shape', 'rect', 'ellipse', 'circle', 'line', 'connector', 'polygon', 'polyline', 'path'].includes(name)) await readShape(ctx, node, out);
  }
}

// --- slide pieces -----------------------------------------------------------

function backgroundOf(ctx: Ctx, styleName: string | undefined): Promise<SlideBackground | undefined> | SlideBackground | undefined {
  const d = props(ctx, 'drawing-page', styleName, 'drawing-page-properties');
  if (d.fill === 'solid') {
    const color = colorOf(d['fill-color']);
    return color ? { kind: 'color', color } : undefined;
  }
  if (d.fill === 'gradient') {
    const gradient = ctx.gradients.get(d['fill-gradient-name'] ?? '');
    const start = colorOf(attr(gradient, 'start-color'));
    const end = colorOf(attr(gradient, 'end-color'));
    if (!start || !end) return undefined;
    const odfAngle = (numAttr(gradient, 'angle') ?? 0) / 10;
    const stops: GradientStop[] = [
      { offset: 0, color: start },
      { offset: 1, color: end },
    ];
    ctx.report.approximated('Gradient backgrounds', ctx.slideNo, 'angle and style approximated');
    return { kind: 'gradient', angle: (((180 - odfAngle) % 360) + 360) % 360, stops, ...(attr(gradient, 'style') === 'radial' ? { radial: true } : {}) };
  }
  if (d.fill === 'bitmap') {
    ctx.report.dropped('Picture backgrounds', ctx.slideNo, 'the bitmap fill is not read');
  }
  return undefined;
}

const TRANSITION_TYPES: [RegExp, SlideTransition['kind']][] = [
  [/fade/i, 'fade'],
  [/push|slide/i, 'push'],
  [/wipe|bar|blinds|barn/i, 'wipe'],
  [/zoom|iris|circle|diamond/i, 'zoom'],
];

function transitionOf(ctx: Ctx, styleName: string | undefined): SlideTransition | undefined {
  const d = props(ctx, 'drawing-page', styleName, 'drawing-page-properties');
  const type = d.type ?? d['transition-style'];
  if (!type && !d['transition-type']) return undefined;
  if (!type || type === 'none') return undefined;
  const match = TRANSITION_TYPES.find(([re]) => re.test(type));
  if (!match) ctx.report.approximated('Slide transitions without an equivalent', ctx.slideNo, `shown as fade (for example ${type})`);
  const speed = d['transition-speed'];
  return { kind: match?.[1] ?? 'fade', durationMs: speed === 'slow' ? 1000 : speed === 'fast' ? 400 : 700 };
}

function readNotes(ctx: Ctx, page: Element): string[] {
  const notes = child(page, 'notes');
  if (!notes) return [];
  const lines: string[] = [];
  for (const frame of descendants(notes, 'frame')) {
    if (attr(frame, 'class') !== 'notes') continue;
    const box = child(frame, 'text-box');
    if (box) for (const p of readText(ctx, box, undefined)) lines.push(p.runs.map((r) => r.text ?? '').join(''));
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines;
}

const EFFECT_NAMES: [RegExp, AnimationEffect][] = [
  [/appear/, 'appear'],
  [/fade/, 'fade'],
  [/fly/, 'fly'],
  [/zoom|grow/, 'zoom'],
  [/wipe/, 'wipe'],
];
const SUBTYPE_DIRECTION: [RegExp, AnimationDirection][] = [
  [/left/, 'left'],
  [/right/, 'right'],
  [/top|up/, 'top'],
  [/bottom|down/, 'bottom'],
];
const NODE_TRIGGER: Record<string, ElementAnimation['trigger']> = { 'on-click': 'onClick', 'with-previous': 'withPrevious', 'after-previous': 'afterPrevious' };

function readAnimations(ctx: Ctx, page: Element): Map<string, ElementAnimation> {
  const result = new Map<string, ElementAnimation>();
  let order = 0;
  for (const par of descendants(page, 'par')) {
    const presetId = attr(par, 'preset-id');
    const nodeType = attr(par, 'node-type');
    if (!presetId || !nodeType || !NODE_TRIGGER[nodeType]) continue;
    const phase = attr(par, 'preset-class');
    const effect = EFFECT_NAMES.find(([re]) => re.test(presetId))?.[1];
    if ((phase !== 'entrance' && phase !== 'exit') || !effect) {
      ctx.report.dropped('Animation effects without an equivalent', ctx.slideNo, 'only appear, fade, fly in, zoom and wipe are kept');
      continue;
    }
    const target = descendants(par, 'set').map((s) => attr(s, 'targetElement')).find(Boolean) ?? descendants(par, 'animate').map((s) => attr(s, 'targetElement')).find(Boolean);
    const ids = target ? ctx.shapes.get(target) : undefined;
    if (!ids) continue;
    const sub = attr(par, 'preset-sub-type') ?? '';
    const direction = effect === 'fly' || effect === 'wipe' ? SUBTYPE_DIRECTION.find(([re]) => re.test(sub))?.[1] : undefined;
    ids.forEach((id, index) => {
      if (result.has(id)) return;
      result.set(id, {
        effect,
        trigger: index === 0 ? NODE_TRIGGER[nodeType] : 'withPrevious',
        order: order++,
        ...(phase === 'exit' ? { phase: 'exit' as const } : {}),
        ...(direction ? { direction } : {}),
      });
    });
  }
  [...result.values()].sort((a, b) => a.order - b.order).forEach((a, i) => (a.order = i));
  return result;
}

// --- the deck ---------------------------------------------------------------

export async function parseOdp(zip: ZipFiles, options: OdpOptions): Promise<ImportedDeck> {
  const { parseXml, fileName } = options;
  const contentText = await zip.text('content.xml');
  if (!contentText) throw new PackageError('That file is not an OpenDocument presentation (.odp).');
  const content = parseXml(contentText).documentElement;
  const stylesText = await zip.text('styles.xml');
  const stylesRoot = stylesText ? parseXml(stylesText).documentElement : null;
  const metaText = await zip.text('meta.xml');
  const title = metaText?.match(/<dc:title>([^<]*)<\/dc:title>/)?.[1]?.trim();

  const body = child(content, 'body', 'presentation');
  if (!body) throw new PackageError('That file is not an OpenDocument presentation (.odp).');

  const report = new ReportBuilder();
  const ctx: Ctx = {
    zip,
    report,
    k: 0,
    styles: new Map(),
    listStyles: new Map(),
    gradients: new Map(),
    media: [],
    mediaByPath: new Map(),
    slideNo: 0,
    shapes: new Map(),
    defaultFontSize: 36,
  };
  indexStyles(ctx, [stylesRoot, content]);

  // Slide size: the page layout of the master page the first slide uses.
  const pages = kids(body, 'page');
  const masters = new Map<string, Element>();
  for (const m of descendants(child(stylesRoot, 'master-styles'), 'master-page')) masters.set(attr(m, 'name') ?? '', m);
  const firstMaster = masters.get(attr(pages[0], 'master-page-name') ?? '') ?? [...masters.values()][0];
  const layoutName = attr(firstMaster, 'page-layout-name');
  let layout: Element | undefined;
  for (const group of [child(stylesRoot, 'automatic-styles'), child(content, 'automatic-styles')]) {
    layout = layout ?? kids(group, 'page-layout').find((l) => attr(l, 'name') === layoutName);
  }
  const lp = child(layout, 'page-layout-properties');
  const widthCm = lengthCm(attr(lp, 'page-width')) ?? 28;
  const heightCm = lengthCm(attr(lp, 'page-height')) ?? 15.75;
  const ratio = widthCm / heightCm;
  const size =
    Math.abs(ratio - 16 / 9) < 0.02 ? { width: 1920, height: 1080 } : Math.abs(ratio - 4 / 3) < 0.02 ? { width: 1440, height: 1080 } : ratio >= 1 ? { width: 1920, height: Math.max(160, Math.round(1920 / ratio)) } : { width: Math.max(160, Math.round(1920 * ratio)), height: 1920 };
  ctx.k = size.width / widthCm;
  ctx.defaultFontSize = Math.round(18 * (2.54 / 72) * ctx.k * 10) / 10;

  // The first master's background and decoration style the deck.
  const masterElements: SlideElement[] = [];
  let masterBackground: SlideBackground | undefined;
  if (firstMaster) {
    masterBackground = (await backgroundOf(ctx, firstMaster?.getAttribute('draw:style-name') ?? undefined)) ?? undefined;
    await readShapes(ctx, firstMaster, masterElements);
  }
  if (masters.size > 1) report.approximated('Several master pages', null, 'the first master page styles the deck; each slide keeps its own background');

  const slides: ImportedSlide[] = [];
  for (let i = 0; i < pages.length; i++) {
    options.onProgress?.({ stage: 'parsing', done: i, total: pages.length, message: `Converting slide ${i + 1} of ${pages.length}` });
    const page = pages[i];
    ctx.slideNo = i + 1;
    ctx.shapes = new Map();
    const elements: SlideElement[] = [];
    await readShapes(ctx, page, elements);
    const pageStyle = page.getAttribute('draw:style-name') ?? undefined;
    const background = await backgroundOf(ctx, pageStyle);
    const pageMaster = masters.get(attr(page, 'master-page-name') ?? '');
    const sameAsDeck = pageMaster === firstMaster;
    const ownBackground = background ?? (!sameAsDeck && pageMaster ? await backgroundOf(ctx, pageMaster.getAttribute('draw:style-name') ?? undefined) : undefined);
    const transition = transitionOf(ctx, pageStyle);
    const animations = readAnimations(ctx, page);
    for (const element of elements) {
      const animation = animations.get(element.id);
      if (animation) (element as { animation?: ElementAnimation }).animation = animation;
    }
    const hidden = props(ctx, 'drawing-page', pageStyle, 'drawing-page-properties').visibility === 'hidden' || attr(page, 'visibility') === 'hidden';
    slides.push({
      layout: null,
      ...(ownBackground ? { background: ownBackground } : {}),
      hidden,
      ...(transition ? { transition } : {}),
      elements,
      notes: readNotes(ctx, page),
    });
    if (i % 10 === 9) await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return {
    fileName,
    title: title || fileName.replace(/\.[^.]+$/, '') || 'Imported presentation',
    format: 'odp',
    size,
    settings: {},
    master: { ...(masterBackground ? { background: masterBackground } : {}), elements: masterElements },
    slides,
    media: ctx.media,
    report: report.build(),
  };
}
