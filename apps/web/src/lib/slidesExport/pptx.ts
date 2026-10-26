import JSZip from 'jszip';
import type PptxGenJSType from 'pptxgenjs';
import {
  DEFAULT_COLUMN_GAP,
  buildPlan,
  coveredCells,
  fieldKey,
  findLayout,
  paragraphFields,
  resolveLayoutPlaceholders,
  cardPalette,
  resolveSlideColor,
  shapeGeometry,
  supportsParagraphBuild,
  tableCellKey,
  textColumns,
  textInsets,
  themeColor,
  weightsOf,
  type BuildUnit,
  type ChartData,
  type ChartKind,
  type DeckSnapshot,
  type RichParagraph,
  type RichTextElement,
  type SlideBackground,
  type SlideField,
  type SlideElement,
  type SlideLayout,
  type SlideShapeElement,
  type SlideSnapshot,
  type TableElement,
  type Theme,
} from '@paradocs/shared';
import {
  ColorTokens,
  MASTER_SPECS,
  backgroundXml,
  colorMapXml,
  coverCrop,
  emu,
  layoutXml,
  masterXml,
  patchThemeXml,
  phXml,
  placeholderShapeXml,
  placeholderSpecs,
  points,
  srcRectXml,
  timingXml,
  transitionXml,
  xmlEscape,
  UNITS_PER_INCH,
  type Crop,
  type PlaceholderShape,
  type PlaceholderSpec,
} from './ooxml';
import { toBase64 } from './imageInfo';

/**
 * Deck to .pptx.
 *
 * PptxGenJS writes what it is good at: the slides' text, shapes, pictures,
 * tables, charts, media and speaker notes. What it cannot express it does not
 * get a say in, so the finished package is rewritten with JSZip:
 *
 *  - the theme gets the deck's twelve colors, its heading and body fonts;
 *  - the slide master and a layout per deck layout are written outright, with
 *    placeholders, text styles, backgrounds (gradients and pictures included),
 *    the color map and the decorative shapes of the master and each layout;
 *  - slide shapes that fill a placeholder are tied to it (`<p:ph>`), the
 *    footer/number/date follow the deck's toggles, slide backgrounds, picture
 *    crops, transitions and build animations are added.
 *
 * Theme colors travel through PptxGenJS as made-up hex tokens and come back
 * out as `<a:schemeClr>` (see ColorTokens), so a theme change in PowerPoint
 * restyles the exported deck as it does here.
 *
 * The result is plain OOXML: the PARA-95 importer reads it back.
 */

// ---------------------------------------------------------------------------
// What the exporter is given
// ---------------------------------------------------------------------------

export interface LoadedImage {
  data: Uint8Array;
  ext: 'png' | 'jpeg' | 'gif';
  width: number;
  height: number;
}

export interface LoadedMedia {
  data: Uint8Array;
  /** File extension without the dot, as PowerPoint knows it (mp4, m4v, mov, mp3, wav, m4a). */
  ext: string;
}

/** What a live element shows right now, for the person exporting. */
export type LiveSnapshot =
  | { kind: 'cell'; display: string; caption: string; isError: boolean }
  | { kind: 'chart'; title: string; chartKind: ChartKind; data: ChartData; caption: string }
  | { kind: 'workItem'; key: string; title: string; statusName: string; statusColor: string; done: boolean }
  | { kind: 'document'; title: string; text: string }
  | {
      kind: 'progress';
      key: string;
      title: string;
      statusName: string;
      statusColor: string;
      percent: number;
      /** "3 of 5 done", or the item's own state when nothing is under it. */
      caption: string;
      children: { key: string; title: string; statusName: string; done: boolean }[];
    }
  | { kind: 'person'; name: string; role: string; email: string };

export interface ExportAssets {
  /** A picture by its url as stored on a slide, or null when it cannot be had. */
  image(url: string): Promise<LoadedImage | null>;
  /** A video or audio file, or null when it cannot be had or is too large to embed. */
  media(url: string, kind: 'video' | 'audio'): Promise<LoadedMedia | null>;
  /** The current value of a live element as the exporting person may see it; null when they may not. */
  live(element: SlideElement): Promise<LiveSnapshot | null>;
  /** What a live field in text reads now, as the exporting person may see it; null when they may not. */
  field?(field: SlideField): Promise<string | null>;
}

export interface PptxExportOptions {
  title: string;
  author?: string;
  assets: ExportAssets;
}

export interface PptxExportResult {
  data: Uint8Array;
  /** What did not survive the trip, in words a person can read. */
  report: string[];
}

const SUPPORTED_MEDIA: Record<'video' | 'audio', string[]> = {
  video: ['mp4', 'm4v', 'mov'],
  audio: ['mp3', 'wav', 'm4a'],
};

type PptxInstance = InstanceType<typeof PptxGenJSType>;
type PptxSlide = ReturnType<PptxInstance['addSlide']>;
type Opts = Record<string, unknown>;

interface SlideMeta {
  slide: SlideSnapshot;
  /** Layout this slide uses, as its index among the deck's layouts. */
  layoutIndex: number;
  /** Shape name -> the placeholder it fills. */
  placeholders: Map<string, PlaceholderSpec>;
  crops: Map<string, Crop>;
  /** Shape name -> the `a:bodyPr` attributes that lay its text in columns, which pptxgenjs cannot write. */
  columns: Map<string, string>;
  slideNumberShapes: string[];
  /** Elements that animate, by shape name, with whether they build by paragraph. */
  textBuilds: Map<string, boolean>;
  backgroundImage?: LoadedImage;
}

const nameOf = (id: string) => `el-${id.replace(/[^A-Za-z0-9_-]/g, '_')}`;
const CHROME_NAME = { footer: 'ch-footer', slideNumber: 'ch-slidenum', date: 'ch-date' } as const;
const CHROME_SPEC: Record<keyof typeof CHROME_NAME, PlaceholderSpec> = {
  footer: { type: 'ftr', idx: 11 },
  slideNumber: { type: 'sldNum', idx: 12 },
  date: { type: 'dt', idx: 10 },
};

const MARGIN_PT = 6;
const DEFAULT_TEXT = 32;
const DEFAULT_LINE_HEIGHT = 1.2;
const INK = '18181B';
const MUTED = '71717A';
const CARD_LINE = 'E4E4E7';

/** A card's fill and outline, as PptxGenJS takes colors; null draws none. */
interface CardLook {
  fill: string | null;
  line: string | null;
}

const LIGHT_LOOK: CardLook = { fill: 'FFFFFF', line: CARD_LINE };

function safeUrl(url: string | undefined): string | undefined {
  return url && /^(https?:|mailto:)/i.test(url) ? url : undefined;
}

class Exporter {
  readonly report: string[] = [];
  private readonly reported = new Set<string>();
  readonly tokens: ColorTokens;
  readonly theme: Theme;
  private readonly size: { width: number; height: number };

  constructor(
    private readonly pptx: PptxInstance,
    private readonly deck: DeckSnapshot,
    private readonly assets: ExportAssets,
  ) {
    this.theme = deck.themes.find((t) => t.id === deck.settings.themeId) ?? deck.themes[0];
    this.size = deck.settings.size;
    this.tokens = new ColorTokens(JSON.stringify(deck).toLowerCase());
  }

  note(message: string): void {
    if (this.reported.has(message)) return;
    this.reported.add(message);
    this.report.push(message);
  }

  /** A color field as the hex PptxGenJS takes (a token for theme colors). */
  color(value: string | undefined, fallback?: string): string | undefined {
    return this.tokens.hex(value) ?? fallback;
  }

  private inch(units: number): number {
    return units / UNITS_PER_INCH;
  }

  private box(el: Pick<SlideElement, 'x' | 'y' | 'width' | 'height' | 'rotation'>): Opts {
    return {
      x: this.inch(el.x),
      y: this.inch(el.y),
      w: this.inch(Math.max(el.width, 1)),
      h: this.inch(Math.max(el.height, 1)),
      ...(el.rotation ? { rotate: ((el.rotation % 360) + 360) % 360 } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Slides
  // -------------------------------------------------------------------------

  async addSlide(slide: SlideSnapshot, index: number, layouts: SlideLayout[]): Promise<SlideMeta> {
    const layout = findLayout(layouts, slide.layoutId);
    const layoutIndex = Math.max(0, layouts.findIndex((l) => l.id === layout.id));
    const target = this.pptx.addSlide({ masterName: `L${layoutIndex}` });
    if (slide.hidden) target.hidden = true;
    const meta: SlideMeta = {
      slide,
      layoutIndex,
      placeholders: new Map(),
      crops: new Map(),
      columns: new Map(),
      slideNumberShapes: [],
      textBuilds: new Map(),
    };
    const specs = placeholderSpecs(layout);

    for (const element of slide.elements) {
      try {
        await this.addElement(target, element, meta, specs);
      } catch (err) {
        this.note(`A ${element.type} on slide ${index + 1} could not be exported (${err instanceof Error ? err.message : 'unknown error'}).`);
      }
    }
    this.addChrome(target, slide, meta, layout);

    if (slide.notes.trim()) target.addNotes(slide.notes);

    const background = slide.background;
    if (background?.kind === 'image') {
      const image = await this.assets.image(background.url);
      if (image) meta.backgroundImage = image;
      else this.note(`The background picture of slide ${index + 1} could not be loaded.`);
    }
    return meta;
  }

  private addChrome(target: PptxSlide, slide: SlideSnapshot, meta: SlideMeta, layout: SlideLayout) {
    for (const item of slide.frame?.chrome ?? []) {
      const name = CHROME_NAME[item.kind];
      const style = item.style;
      target.addText(item.text, {
        x: this.inch(item.x),
        y: this.inch(item.y),
        w: this.inch(item.width),
        h: this.inch(item.height),
        fontSize: points(style.fontSize ?? 20),
        bold: style.bold,
        italic: style.italic,
        fontFace: style.fontFamily,
        color: this.color(style.color ?? 'theme:text2', '000000'),
        align: style.align ?? 'left',
        valign: style.verticalAlign ?? 'middle',
        margin: MARGIN_PT,
        fit: 'none',
        objectName: name,
      } as Opts as never);
      const own = layout.placeholders.find((p) => p.kind === item.kind);
      const spec = own ? placeholderSpecs(layout).get(own.id) : undefined;
      meta.placeholders.set(name, spec ?? CHROME_SPEC[item.kind]);
      if (item.kind === 'slideNumber') meta.slideNumberShapes.push(name);
    }
  }

  // -------------------------------------------------------------------------
  // Elements
  // -------------------------------------------------------------------------

  async addElement(slide: PptxSlide, el: SlideElement, meta: SlideMeta, specs: Map<string, PlaceholderSpec>) {
    const name = nameOf(el.id);
    const placeholderId = (el as { placeholder?: string }).placeholder;
    const spec = placeholderId ? specs.get(placeholderId) : undefined;
    if (spec) meta.placeholders.set(name, spec);
    if (el.animation && supportsParagraphBuild(el)) meta.textBuilds.set(name, el.animation.byParagraph === true);

    switch (el.type) {
      case 'richText':
        return await this.addRichText(slide, el, name, meta);
      case 'text':
        slide.addText(el.text, {
          ...this.box(el),
          fontSize: points(el.fontSize ?? 20),
          color: this.color(el.color ?? 'theme:text1', '000000'),
          valign: 'top',
          margin: 0,
          fit: 'none',
          objectName: name,
        } as Opts as never);
        return;
      case 'shape':
        return this.addShape(slide, el as SlideShapeElement, name);
      case 'image':
        return this.addImage(slide, el, name, meta, !!spec);
      case 'table':
        return this.addTable(slide, el, name);
      case 'video':
      case 'audio':
        return this.addMedia(slide, el, name);
      case 'embed':
        return this.card(slide, el, name, LIGHT_LOOK, [
          { text: el.title || 'Embedded content', options: { bold: true, fontSize: 24, color: INK, breakLine: true } },
          { text: el.url, options: { fontSize: 16, color: '2563EB', hyperlink: safeUrl(el.url) ? { url: el.url } : undefined } },
        ], 'Embedded web pages are exported as a link.');
      case 'sheetCell':
      case 'sheetChart':
      case 'workItem':
      case 'workItemProgress':
      case 'person':
      case 'link':
        return this.addLive(slide, el, name);
      default:
        this.note(`${(el as SlideElement).type === 'connector' ? 'Connectors' : 'Some elements'} are not exported.`);
    }
  }

  // --- rich text -----------------------------------------------------------

  private runs(el: RichTextElement, paragraphs: RichParagraph[], fields: Map<string, string | null> = new Map()): Opts[] {
    const base = el.fontSize ?? DEFAULT_TEXT;
    const out: Opts[] = [];
    paragraphs.forEach((p, i) => {
      const last = i === paragraphs.length - 1;
      const size = p.runs.find((r) => r.marks?.fontSize)?.marks?.fontSize ?? base;
      const lineHeight = p.lineHeight ?? el.lineSpacing ?? DEFAULT_LINE_HEIGHT;
      const paragraph: Opts = {
        align: p.align ?? el.align ?? 'left',
        ...(p.bullet ? { bullet: p.bullet === 'number' ? { type: 'number', indent: Math.round(points(size) * 1.4) } : { indent: Math.round(points(size) * 1.1) }, indentLevel: p.level ?? 0 } : {}),
        ...(Math.abs(lineHeight - DEFAULT_LINE_HEIGHT) > 0.01 ? { lineSpacingMultiple: lineHeight / DEFAULT_LINE_HEIGHT } : {}),
        paraSpaceAfter: Math.round(points(size) * 0.3),
      };
      const runs = p.runs.length ? p.runs : [{ text: '' }];
      runs.forEach((run, r) => {
        const marks = run.marks ?? {};
        // A field is written as it reads now; one the exporter may not see, as a dash rather than its label.
        const text = run.mention ? `@${run.mention.label}` : run.field ? (fields.get(fieldKey(run.field.ref)) ?? '—') : (run.text ?? '');
        const linked = safeUrl(marks.link);
        const options: Opts = {
          ...(r === 0 ? paragraph : {}),
          fontSize: points(marks.fontSize ?? base),
          ...(marks.bold || el.bold ? { bold: true } : {}),
          ...(marks.italic || el.italic ? { italic: true } : {}),
          ...(marks.underline ? { underline: { style: 'sng' } } : {}),
          ...(marks.strike ? { strike: 'sngStrike' } : {}),
          ...(marks.color ? { color: this.color(marks.color) } : {}),
          ...(marks.highlight ? { highlight: this.color(marks.highlight) } : {}),
          ...(marks.fontFamily ? { fontFace: marks.fontFamily } : {}),
          ...(linked ? { hyperlink: { url: linked } } : {}),
          ...(r === runs.length - 1 && !last ? { breakLine: true } : {}),
        };
        out.push({ text, options });
      });
    });
    return out;
  }

  private async addRichText(slide: PptxSlide, el: RichTextElement, name: string, meta: SlideMeta) {
    const paragraphs = el.paragraphs?.length ? el.paragraphs : [{ runs: el.text ? [{ text: el.text }] : [] }];
    const fields = new Map<string, string | null>();
    for (const field of paragraphFields(paragraphs)) {
      const key = fieldKey(field);
      if (fields.has(key)) continue;
      fields.set(key, this.assets.field ? await this.assets.field(field).catch(() => null) : null);
    }
    if (fields.size) {
      this.note('Live values in text are exported as they stand now and no longer update.');
      if ([...fields.values()].includes(null)) this.note('Live values in text you cannot access are exported as a dash.');
    }
    const fill = el.fill && el.fill !== 'transparent' ? this.color(el.fill) : undefined;
    const inset = textInsets(el);
    const columns = textColumns(el);
    if (columns > 1) meta.columns.set(name, ` numCol="${columns}" spcCol="${emu(el.columnGap ?? DEFAULT_COLUMN_GAP)}"`);
    slide.addText(this.runs(el, paragraphs, fields) as never, {
      ...this.box(el),
      color: this.color(el.color ?? 'theme:text1', '000000'),
      fontFace: el.fontFamily,
      valign: el.verticalAlign ?? 'top',
      // pptxgenjs reads the sides as left, right, bottom, top, whatever its documentation says.
      margin: [inset.left, inset.right, inset.bottom, inset.top].map(points),
      wrap: el.wrap !== false,
      ...(fill ? { fill: { color: fill } } : {}),
      ...(el.stroke ? { line: { color: this.color(el.stroke), width: points(el.strokeWidth ?? 2) } } : {}),
      fit: el.autofit === false ? 'none' : 'shrink',
      objectName: name,
    } as Opts as never);
  }

  // --- shapes --------------------------------------------------------------

  private addShape(slide: PptxSlide, el: SlideShapeElement, name: string) {
    const geometry = shapeGeometry(el.shape, el.width, el.height);
    const filled = !geometry.open && el.fill && el.fill !== 'transparent';
    const strokeValue = el.stroke ?? (geometry.open ? 'theme:accent1' : undefined);
    const dash = el.dash === 'dashed' ? 'dash' : el.dash === 'dotted' ? 'sysDot' : 'solid';
    const base: Opts = {
      ...this.box(el),
      ...(filled ? { fill: { color: this.color(el.fill) } } : {}),
      line: strokeValue ? { color: this.color(strokeValue), width: points(el.strokeWidth ?? 2), dashType: dash } : { type: 'none' },
      ...(el.shadow ? { shadow: { type: 'outer', color: '000000', opacity: 0.35, blur: 8, offset: 4, angle: 90 } } : {}),
      objectName: name,
    };
    const text = el.text ?? '';

    if (geometry.open) {
      const { x, y, w, h, rotate } = base as { x: number; y: number; w: number; h: number; rotate?: number };
      slide.addShape('line' as never, { ...base, x, y: y + h / 2, w, h: 0, rotate } as never);
      return;
    }

    const presets: Record<string, string> = { rectangle: 'rect', roundRect: 'roundRect', ellipse: 'ellipse', triangle: 'triangle', diamond: 'diamond' };
    const preset = presets[el.shape];
    const shape: Opts = preset
      ? { shape: preset, ...(el.shape === 'roundRect' ? { rectRadius: this.inch(Math.min(el.width, el.height) * 0.18) } : {}) }
      : { shape: 'custGeom', points: this.polygon(el) };

    if (!text) {
      slide.addShape((preset ?? 'custGeom') as never, { ...base, ...shape } as never);
      return;
    }
    const fillColor = filled ? resolveSlideColor(el.fill, this.theme) : undefined;
    const dark = fillColor ? readableIsDark(fillColor) : true;
    slide.addText(text, {
      ...base,
      ...shape,
      fontSize: points(el.fontSize ?? 40),
      color: this.color(el.color ?? themeColor(dark ? 'dark1' : 'light1'), '000000'),
      fontFace: undefined,
      align: 'center',
      valign: 'middle',
      margin: 8,
      fit: 'shrink',
    } as Opts as never);
  }

  /** A shape drawn as a polygon, as the points of its SVG outline in inches from its corner. */
  private polygon(el: SlideShapeElement): Opts[] {
    const { d } = shapeGeometry(el.shape, el.width, el.height);
    const points: Opts[] = [];
    for (const m of d.matchAll(/([ML])(-?[\d.]+) (-?[\d.]+)/g)) {
      points.push({ x: this.inch(Number(m[2])), y: this.inch(Number(m[3])), ...(m[1] === 'M' ? { moveTo: true } : {}) });
    }
    points.push({ close: true });
    return points;
  }

  // --- pictures, media -----------------------------------------------------

  private async addImage(slide: PptxSlide, el: Extract<SlideElement, { type: 'image' }>, name: string, meta: SlideMeta, placeholder: boolean) {
    const fit = (el as { fit?: 'cover' | 'contain' }).fit ?? 'cover';
    const crop = (el as { crop?: { x: number; y: number; width: number; height: number } }).crop;
    const opacity = (el as { opacity?: number }).opacity;
    const image = el.url ? await this.assets.image(el.url) : null;
    if (!image) {
      if (el.url) this.note('Some pictures could not be loaded and were left as empty frames.');
      if (placeholder || !el.url) {
        // An empty picture placeholder stays one: the layout's prompt shows in PowerPoint.
        slide.addText('', { ...this.box(el), objectName: name } as Opts as never);
        return;
      }
      slide.addText(el.alt || 'Picture', {
        ...this.box(el),
        fontSize: 18,
        color: MUTED,
        align: 'center',
        valign: 'middle',
        line: { color: CARD_LINE, width: 1, dashType: 'dash' },
        objectName: name,
      } as Opts as never);
      return;
    }
    let { x, y, width, height } = el;
    let cropBox: Crop | undefined;
    if (crop) {
      cropBox = { l: crop.x, t: crop.y, r: 1 - crop.x - crop.width, b: 1 - crop.y - crop.height };
    } else if (fit === 'contain') {
      const scale = Math.min(width / image.width, height / image.height);
      const w = image.width * scale;
      const h = image.height * scale;
      x += (width - w) / 2;
      y += (height - h) / 2;
      width = w;
      height = h;
    } else {
      cropBox = coverCrop(image, { width, height });
    }
    if (cropBox) meta.crops.set(name, cropBox);
    slide.addImage({
      data: `image/${image.ext};base64,${toBase64(image.data)}`,
      ...this.box({ ...el, x, y, width, height }),
      altText: el.alt || '',
      ...(opacity !== undefined && opacity < 1 ? { transparency: Math.round((1 - opacity) * 100) } : {}),
      objectName: name,
    } as Opts as never);
  }

  private async addMedia(slide: PptxSlide, el: Extract<SlideElement, { type: 'video' | 'audio' }>, name: string) {
    const media = await this.assets.media(el.url, el.type);
    if (media && SUPPORTED_MEDIA[el.type].includes(media.ext.toLowerCase())) {
      const mime = `${el.type}/${media.ext.toLowerCase() === 'm4a' ? 'mp4' : media.ext.toLowerCase()}`;
      slide.addMedia({ type: el.type, data: `${mime};base64,${toBase64(media.data)}`, extn: media.ext.toLowerCase(), ...this.box(el), objectName: name } as Opts as never);
      this.note('Videos and audio are embedded with PowerPoint\'s default poster; poster frames are not exported.');
      return;
    }
    this.note(
      media
        ? `Some ${el.type} files are in a format PowerPoint cannot play (${media.ext}); they are exported as a link.`
        : `Some ${el.type} files could not be embedded (too large or not reachable); they are exported as a link.`,
    );
    this.card(slide, el, name, LIGHT_LOOK, [
      { text: el.title || (el.type === 'video' ? 'Video' : 'Audio'), options: { bold: true, fontSize: 24, color: INK, breakLine: true } },
      { text: el.url, options: { fontSize: 14, color: '2563EB', hyperlink: safeUrl(el.url) ? { url: el.url } : undefined } },
    ]);
  }

  // --- tables --------------------------------------------------------------

  private addTable(slide: PptxSlide, el: TableElement, name: string) {
    const covered = coveredCells(el);
    const widths = weightsOf(el.columnWidths, el.columns);
    const heights = weightsOf(el.rowHeights, el.rows);
    const widthSum = widths.reduce((a, b) => a + b, 0);
    const heightSum = heights.reduce((a, b) => a + b, 0);
    const defaultWidth = el.borderWidth ?? 2;
    const rows: Opts[][] = [];
    for (let r = 0; r < el.rows; r++) {
      const row: Opts[] = [];
      for (let c = 0; c < el.columns; c++) {
        const key = tableCellKey(r, c);
        if (covered.has(key)) continue;
        const cell = el.cells[key];
        const header = el.headerRow && r === 0;
        const borderWidth = cell?.borderWidth ?? defaultWidth;
        const border =
          borderWidth > 0
            ? { type: 'solid', pt: points(borderWidth), color: this.color(cell?.borderColor ?? el.borderColor ?? '#9ca3af') }
            : { type: 'none' };
        const fill = cell?.fill ?? (header ? themeColor('light2') : undefined);
        row.push({
          text: cell?.text ?? '',
          options: {
            fontSize: points(cell?.fontSize ?? el.fontSize ?? 28),
            fontFace: el.fontFamily,
            color: this.color(cell?.color ?? 'theme:text1'),
            bold: cell?.bold || header || undefined,
            italic: cell?.italic || undefined,
            underline: cell?.underline ? { style: 'sng' } : undefined,
            align: cell?.align ?? 'left',
            valign: cell?.verticalAlign ?? 'top',
            ...(fill && fill !== 'transparent' ? { fill: { color: this.color(fill) } } : {}),
            border: [border, border, border, border],
            margin: 5,
            ...((cell?.colSpan ?? 1) > 1 ? { colspan: cell!.colSpan } : {}),
            ...((cell?.rowSpan ?? 1) > 1 ? { rowspan: cell!.rowSpan } : {}),
          },
        });
      }
      rows.push(row);
    }
    slide.addTable(rows as never, {
      ...this.box(el),
      colW: widths.map((w) => (this.inch(el.width) * w) / widthSum),
      rowH: heights.map((h) => (this.inch(el.height) * h) / heightSum),
      objectName: name,
    } as Opts as never);
  }

  // --- live content --------------------------------------------------------

  /** A single rounded shape with text, standing in for content that cannot be drawn natively. */
  private card(slide: PptxSlide, el: SlideElement, name: string, look: CardLook, runs: Opts[], note?: string) {
    if (note) this.note(note);
    slide.addText(runs as never, {
      ...this.box(el),
      shape: 'roundRect',
      rectRadius: 0.12,
      fill: look.fill ? { color: look.fill } : { type: 'none' },
      line: look.line ? { color: look.line, width: 1.5 } : { type: 'none' },
      valign: 'middle',
      margin: 10,
      fit: 'shrink',
      objectName: name,
    } as Opts as never);
  }

  private async addLive(
    slide: PptxSlide,
    el: Extract<SlideElement, { type: 'sheetCell' | 'sheetChart' | 'workItem' | 'workItemProgress' | 'person' | 'link' }>,
    name: string,
  ) {
    const live = await this.assets.live(el).catch(() => null);
    const palette = cardPalette(el.cardStyle, this.theme);
    const hex = (color: string) => color.replace('#', '').toUpperCase();
    const ink = hex(palette.ink);
    const muted = hex(palette.muted);
    const look: CardLook = {
      fill: palette.raised === 'transparent' ? null : hex(palette.raised),
      line: palette.border === 'transparent' ? null : hex(palette.border),
    };
    const what = {
      sheetCell: 'This value',
      sheetChart: 'This chart',
      workItem: 'This work item',
      workItemProgress: 'This work item',
      person: 'This person',
      link: 'This document',
    }[el.type];
    if (!live) {
      // Never the label or title the author gave it: the exporter may not be allowed to know what it was.
      this.note('Live content you cannot access is exported as an empty placeholder.');
      return this.card(slide, el, name, look, [
        { text: `${what} is not available`, options: { bold: true, fontSize: 24, color: ink, align: 'center', breakLine: true } },
        { text: 'You may not have access to its source.', options: { fontSize: 14, color: muted, align: 'center' } },
      ]);
    }
    this.note('Live content (cells, charts, work items, documents) is exported as it stands now and no longer updates.');
    switch (live.kind) {
      case 'cell': {
        const byHeight = el.height * 0.5;
        const byWidth = ((el.width - 80) / Math.max(live.display.length, 1)) * 1.7;
        return this.card(slide, el, name, look, [
          { text: live.display, options: { bold: true, fontSize: points(Math.max(32, Math.min(byHeight, byWidth, 360))), color: live.isError ? 'DC2626' : ink, breakLine: true } },
          { text: live.caption, options: { fontSize: 14, color: muted } },
        ]);
      }
      case 'workItem':
        return this.card(slide, el, name, look, [
          { text: live.key, options: { bold: true, fontSize: 18, color: muted, breakLine: true } },
          { text: live.title, options: { bold: true, fontSize: 32, color: live.done ? muted : ink, strike: live.done ? 'sngStrike' : undefined, breakLine: true } },
          { text: ` ${live.statusName} `, options: { fontSize: 17, color: 'FFFFFF', highlight: this.color(live.statusColor || '#71717a') } },
        ]);
      case 'document':
        return this.card(slide, el, name, look, [
          { text: live.title, options: { bold: true, fontSize: 22, color: ink, breakLine: true } },
          { text: live.text, options: { fontSize: 14, color: ink } },
        ]);
      case 'progress': {
        const runs: Opts[] = [
          { text: `${live.key} · ${live.statusName}`, options: { bold: true, fontSize: 16, color: muted, breakLine: true } },
          { text: live.title, options: { bold: true, fontSize: 28, color: ink, breakLine: true } },
          { text: `${live.percent}%`, options: { bold: true, fontSize: 48, color: ink, breakLine: true } },
          { text: live.caption, options: { fontSize: 16, color: muted, breakLine: live.children.length > 0 } },
        ];
        live.children.slice(0, 12).forEach((child, i, shown) =>
          runs.push({
            text: `${child.key}  ${child.title} — ${child.statusName}`,
            options: { fontSize: 13, color: child.done ? muted : ink, strike: child.done ? 'sngStrike' : undefined, breakLine: i < shown.length - 1 },
          }),
        );
        return this.card(slide, el, name, look, runs);
      }
      case 'person':
        return this.card(slide, el, name, look, [
          { text: live.name, options: { bold: true, fontSize: 32, color: ink, breakLine: true } },
          { text: live.role, options: { fontSize: 18, color: muted, breakLine: true } },
          { text: live.email, options: { fontSize: 16, color: muted } },
        ]);
      case 'chart':
        return this.addChart(slide, el, name, live, look, ink, muted, hex(palette.line));
    }
  }

  private addChart(slide: PptxSlide, el: SlideElement, name: string, live: Extract<LiveSnapshot, { kind: 'chart' }>, look: CardLook, ink: string, muted: string, grid: string) {
    if (live.data.series.length === 0 || live.data.categories.length === 0) {
      return this.card(slide, el, name, look, [{ text: `${live.title || 'Chart'}: no numbers in this chart's range`, options: { fontSize: 20, color: muted, align: 'center' } }]);
    }
    const labels = live.data.categories;
    const series = live.data.series.map((s) => ({ name: s.name || 'Series', labels, values: s.values.map((v) => v ?? 0) }));
    const types = this.pptx.ChartType;
    const colors = [1, 2, 3, 4, 5, 6].map((n) => this.color(`theme:accent${n}`)!);
    const opts: Opts = {
      ...this.box(el),
      showTitle: !!live.title,
      title: live.title,
      titleFontSize: 20,
      titleColor: ink,
      showLegend: live.chartKind === 'pie' || series.length > 1,
      legendPos: 'b',
      legendColor: muted,
      catAxisLabelColor: muted,
      valAxisLabelColor: muted,
      valGridLine: { color: grid, size: 0.75 },
      // The card the chart stands on in the editor, if it has one.
      ...(look.fill ? { chartArea: { fill: { color: look.fill }, ...(look.line ? { border: { color: look.line, pt: 1.5 } } : {}), roundedCorners: true } } : {}),
      chartColors: colors,
      objectName: name,
    };
    switch (live.chartKind) {
      case 'bar':
        slide.addChart(types.bar, series as never, { ...opts, barDir: 'col' } as never);
        break;
      case 'line':
        slide.addChart(types.line, series as never, { ...opts, lineDataSymbolSize: 6 } as never);
        break;
      case 'pie':
        slide.addChart(types.pie, [series[0]] as never, { ...opts, chartColors: labels.map((_, i) => colors[i % colors.length]) } as never);
        break;
      case 'scatter': {
        const xs = labels.map((label, i) => (Number.isFinite(Number(label)) && label.trim() !== '' ? Number(label) : i + 1));
        slide.addChart(types.scatter, [{ name: 'X', values: xs }, ...series.map((s) => ({ name: s.name, values: s.values }))] as never, { ...opts, lineSize: 0 } as never);
        break;
      }
    }
    if (series.some((s, i) => live.data.series[i].values.some((v) => v === null))) this.note('Gaps in a chart\'s data are exported as zeros.');
  }
}

/** Whether dark text is the readable choice on a fill, as the shape renderer decides. */
function readableIsDark(fill: string): boolean {
  const hex = fill.replace('#', '');
  if (hex.length !== 6) return true;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.55;
}

// ---------------------------------------------------------------------------
// The package
// ---------------------------------------------------------------------------

const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const IMAGE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';

interface Rel {
  id: string;
  type: string;
  target: string;
  external: boolean;
}

function parseRels(xml: string): Rel[] {
  return [...xml.matchAll(/<Relationship\b([^>]*?)\/?>/g)].map((m) => {
    const attr = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(m[1])?.[1] ?? '';
    return { id: attr('Id'), type: attr('Type'), target: attr('Target'), external: attr('TargetMode') === 'External' };
  });
}

function relXml(rel: Rel): string {
  return `<Relationship Id="${rel.id}" Type="${rel.type}" Target="${rel.target}"${rel.external ? ' TargetMode="External"' : ''}/>`;
}

function relsPartOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return `${path.slice(0, slash)}/_rels/${path.slice(slash + 1)}.rels`;
}

class Package {
  constructor(readonly zip: JSZip) {}

  async text(path: string): Promise<string> {
    const file = this.zip.file(path);
    if (!file) throw new Error(`Missing part ${path}`);
    return file.async('string');
  }

  has(path: string): boolean {
    return this.zip.file(path) !== null;
  }

  set(path: string, xml: string): void {
    this.zip.file(path, xml);
  }

  async rels(path: string): Promise<Rel[]> {
    const part = relsPartOf(path);
    return this.has(part) ? parseRels(await this.text(part)) : [];
  }

  async setRels(path: string, rels: Rel[]): Promise<void> {
    this.set(relsPartOf(path), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${REL_NS}">${rels.map(relXml).join('')}</Relationships>`);
  }

  async removePart(path: string): Promise<void> {
    this.zip.remove(path);
    this.zip.remove(relsPartOf(path));
    const types = await this.text('[Content_Types].xml');
    this.set('[Content_Types].xml', types.replace(new RegExp(`<Override PartName="/${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*/>`), ''));
  }

  /** Adds a picture to the package and returns its path within it. */
  async addImage(image: LoadedImage, key: string): Promise<string> {
    const path = `ppt/media/${key}.${image.ext}`;
    this.zip.file(path, image.data);
    const types = await this.text('[Content_Types].xml');
    if (!new RegExp(`<Default Extension="${image.ext}"`).test(types)) {
      this.set('[Content_Types].xml', types.replace('<Default Extension="xml"', `<Default Extension="${image.ext}" ContentType="image/${image.ext}"/><Default Extension="xml"`));
    }
    return path;
  }
}

/** Renumbers every shape id in order (the root group keeps 1), returns the name -> id map. */
function renumberShapes(xml: string, start = 2): { xml: string; ids: Map<string, number>; next: number } {
  const ids = new Map<string, number>();
  let next = start;
  const out = xml.replace(/<p:cNvPr id="(\d+)" name="([^"]*)"/g, (whole, id: string, name: string) => {
    if (id === '1' && name === '') return whole;
    const assigned = next++;
    if (!ids.has(name)) ids.set(name, assigned);
    return `<p:cNvPr id="${assigned}" name="${name}"`;
  });
  return { xml: out, ids, next };
}

/** The `<p:sp>`, `<p:pic>` or `<p:graphicFrame>` block holding a named shape, as start and end offsets. */
function blockOf(xml: string, name: string): [number, number] | null {
  const at = xml.indexOf(`name="${name}"`);
  if (at < 0) return null;
  const starts = ['<p:sp>', '<p:pic>', '<p:graphicFrame>'].map((tag) => ({ tag, index: xml.lastIndexOf(tag, at) })).filter((s) => s.index >= 0);
  if (starts.length === 0) return null;
  const start = starts.reduce((a, b) => (b.index > a.index ? b : a));
  const close = start.tag.replace('<', '</');
  const end = xml.indexOf(close, at);
  return end < 0 ? null : [start.index, end + close.length];
}

function patchBlock(xml: string, name: string, patch: (block: string) => string): string {
  const range = blockOf(xml, name);
  if (!range) return xml;
  return xml.slice(0, range[0]) + patch(xml.slice(range[0], range[1])) + xml.slice(range[1]);
}

function tieToPlaceholder(block: string, spec: PlaceholderSpec): string {
  return block
    .replace(/<p:cNvSpPr[^>]*?\/>/, '<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>')
    .replace(/<p:nvPr>\s*<\/p:nvPr>|<p:nvPr\s*\/>/, `<p:nvPr>${phXml(spec)}</p:nvPr>`);
}

/**
 * PptxGenJS repeats a paragraph's `<a:pPr>` before every run of it, which the
 * schema forbids (properties come first, once); keep the first. It also writes
 * `startAt="1"` on every numbered paragraph, which is the default anyway.
 */
export function tidyParagraphs(xml: string): string {
  return xml.replace(/<a:p>[\s\S]*?<\/a:p>/g, (paragraph) => {
    let seen = false;
    return paragraph
      .replace(/<a:pPr\b(?:[^>]*\/>|[^>]*>[\s\S]*?<\/a:pPr>)/g, (props) => (seen ? '' : ((seen = true), props)))
      .replace(/ startAt="1"/g, '');
  });
}

/** The slide number is a field, so PowerPoint keeps it right when slides move. */
function asSlideNumberField(block: string): string {
  return block.replace(/<a:r>(<a:rPr[^>]*?(?:\/>|>[\s\S]*?<\/a:rPr>))<a:t>([^<]*)<\/a:t><\/a:r>/, (_w, rPr: string, text: string) => `<a:fld id="{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}" type="slidenum">${rPr}<a:t>${text}</a:t></a:fld>`);
}

interface DecorJob {
  /** `master` or a layout index. */
  target: 'master' | number;
  slideNo: number;
}

/** Everything in a slide's shape tree after its group properties, plus the relationships those shapes use. */
async function liftShapes(pkg: Package, slideNo: number): Promise<{ shapes: string; rels: Rel[] }> {
  const path = `ppt/slides/slide${slideNo}.xml`;
  const xml = await pkg.text(path);
  const open = xml.indexOf('</p:grpSpPr>');
  const close = xml.lastIndexOf('</p:spTree>');
  const rels = (await pkg.rels(path)).filter((r) => !/\/(slideLayout|notesSlide)$/.test(r.type));
  return { shapes: open < 0 ? '' : tidyParagraphs(xml.slice(open + '</p:grpSpPr>'.length, close)), rels };
}

function remapRels(shapes: string, rels: Rel[], prefix: string): { shapes: string; rels: Rel[] } {
  const mapped = rels.map((rel, i) => ({ ...rel, id: `${prefix}${i + 1}` }));
  let out = shapes;
  rels.forEach((rel, i) => {
    out = out.replace(new RegExp(`(r:(?:embed|link|id|pict)=")${rel.id}"`, 'g'), `$1${prefix}${i + 1}"`);
  });
  return { shapes: out, rels: mapped };
}

export async function buildPptx(deck: DeckSnapshot, options: PptxExportOptions): Promise<PptxExportResult> {
  const { default: PptxGenJS } = await import('pptxgenjs');
  const pptx = new PptxGenJS();
  const { size } = deck.settings;
  pptx.defineLayout({ name: 'ParaDOCs', width: size.width / UNITS_PER_INCH, height: size.height / UNITS_PER_INCH });
  pptx.layout = 'ParaDOCs';
  pptx.title = options.title;
  pptx.author = options.author ?? 'ParaDOCs';
  pptx.company = 'ParaDOCs';

  const exporter = new Exporter(pptx, deck, options.assets);
  const theme = exporter.theme;
  pptx.theme = { headFontFace: theme.fonts.heading, bodyFontFace: theme.fonts.body };

  // One PptxGenJS master per deck layout, only so each gets a layout part and slide relationship; the parts are rewritten below.
  deck.layouts.forEach((_layout, i) => pptx.defineSlideMaster({ title: `L${i}`, objects: [] }));

  const metas: SlideMeta[] = [];
  for (const [i, slide] of deck.slides.entries()) metas.push(await exporter.addSlide(slide, i, deck.layouts));

  // Decorative shapes of the master and of layouts ride on throwaway slides at the end, and are lifted out afterwards.
  const jobs: DecorJob[] = [];
  const addDecor = async (target: DecorJob['target'], elements: SlideElement[]) => {
    const drawable = elements.filter((e) => ['text', 'richText', 'shape', 'image', 'table'].includes(e.type));
    if (drawable.length === 0) return;
    const scratch = pptx.addSlide();
    const meta: SlideMeta = {
      slide: { id: 'decor', layoutId: '', background: null, hidden: false, transition: { kind: 'none' }, elements: [], notes: '' },
      layoutIndex: 0,
      placeholders: new Map(),
      crops: new Map(),
      columns: new Map(),
      slideNumberShapes: [],
      textBuilds: new Map(),
    };
    for (const element of drawable) {
      try {
        await exporter.addElement(scratch, { ...element, animation: undefined } as SlideElement, meta, new Map());
      } catch {
        // A decoration that cannot be drawn is simply left out.
      }
    }
    jobs.push({ target, slideNo: deck.slides.length + jobs.length + 1 });
  };
  await addDecor('master', deck.master.elements);
  for (const [i, layout] of deck.layouts.entries()) await addDecor(i, layout.elements ?? []);

  const raw = (await pptx.write({ outputType: 'uint8array' })) as Uint8Array;
  const pkg = new Package(await JSZip.loadAsync(raw));
  await finish(pkg, deck, exporter, metas, jobs, options.assets);
  const data = await pkg.zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  return { data, report: exporter.report };
}

async function finish(pkg: Package, deck: DeckSnapshot, exporter: Exporter, metas: SlideMeta[], jobs: DecorJob[], assets: ExportAssets) {
  const { theme, tokens } = exporter;
  const slideCount = deck.slides.length;

  // --- scratch slides: lift their shapes, then drop them -------------------
  const lifted = new Map<DecorJob['target'], { shapes: string; rels: Rel[] }>();
  for (const job of jobs) lifted.set(job.target, await liftShapes(pkg, job.slideNo));
  if (jobs.length > 0) await removeSlides(pkg, jobs.map((j) => j.slideNo));

  // --- layouts -------------------------------------------------------------
  const layoutFiles = new Map<number, string>();
  let defaultLayout: string | null = null;
  for (const path of Object.keys(pkg.zip.files).filter((p) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(p))) {
    const name = /<p:cSld name="([^"]*)"/.exec(await pkg.text(path))?.[1] ?? '';
    const index = /^L(\d+)$/.exec(name);
    if (index) layoutFiles.set(Number(index[1]), path);
    else defaultLayout = path;
  }

  const masterPath = 'ppt/slideMasters/slideMaster1.xml';
  const masterRels = await pkg.rels(masterPath);

  const specsByLayout = deck.layouts.map((layout) => placeholderSpecs(layout));
  for (const [i, layout] of deck.layouts.entries()) {
    const path = layoutFiles.get(i);
    if (!path) continue;
    const resolved = resolveLayoutPlaceholders(layout, deck.master);
    const rels = (await pkg.rels(path)).filter((r) => /\/slideMaster$/.test(r.type));
    let decor = '';
    const own = lifted.get(i);
    if (own) {
      const mapped = remapRels(own.shapes, own.rels, 'rIdD');
      decor = mapped.shapes;
      rels.push(...mapped.rels);
    }
    let background: string | undefined;
    if (layout.background) {
      const bg = await backgroundPart(pkg, layout.background, assets, `layoutbg${i}`, rels, deck);
      background = bg;
    }
    const numbered = renumberShapes(decor);
    let id = numbered.next;
    const placeholders = resolved
      .map((ph) => {
        const spec = specsByLayout[i].get(ph.id);
        if (!spec) return '';
        const shape: PlaceholderShape = { id: id++, kind: ph.kind, spec, box: { x: ph.x, y: ph.y, width: ph.width, height: ph.height }, style: ph.style, prompt: ph.prompt };
        return placeholderShapeXml(shape);
      })
      .join('');
    pkg.set(path, tokens.apply(layoutXml({ name: layout.name, type: layout.type, background, decor: numbered.xml, placeholders, showMasterSp: !layout.hideMasterElements })));
    await pkg.setRels(path, rels);
  }

  // The scaffolding layout PptxGenJS always adds is not part of the deck.
  let kept = masterRels;
  if (defaultLayout) {
    const target = `../slideLayouts/${defaultLayout.split('/').pop()}`;
    kept = masterRels.filter((r) => r.target !== target);
    await pkg.removePart(defaultLayout);
  }

  // --- master --------------------------------------------------------------
  const masterDecor = lifted.get('master');
  const mrels = kept.slice();
  let decorXml = '';
  if (masterDecor) {
    const mapped = remapRels(masterDecor.shapes, masterDecor.rels, 'rIdD');
    decorXml = mapped.shapes;
    mrels.push(...mapped.rels);
  }
  const masterBackground = await backgroundPart(pkg, deck.master.background, assets, 'masterbg', mrels, deck);
  const numberedDecor = renumberShapes(decorXml);
  let masterId = numberedDecor.next;
  const masterPlaceholders = deck.master.placeholders
    .map((ph) => {
      const spec = MASTER_SPECS[ph.kind];
      if (!spec) return '';
      return placeholderShapeXml({
        id: masterId++,
        kind: ph.kind,
        spec,
        box: { x: ph.x, y: ph.y, width: ph.width, height: ph.height },
        style: ph.style ?? {},
        prompt: ph.prompt ?? '',
      });
    })
    .join('');
  const layoutRelIds = deck.layouts
    .map((_l, i) => layoutFiles.get(i))
    .filter((p): p is string => !!p)
    .map((p) => mrels.find((r) => r.target === `../slideLayouts/${p.split('/').pop()}`)?.id)
    .filter((id): id is string => !!id);
  pkg.set(
    masterPath,
    tokens.apply(masterXml({
      background: masterBackground,
      decor: numberedDecor.xml,
      placeholders: masterPlaceholders,
      colorMap: colorMapXml(theme.colorMap),
      layoutIds: layoutRelIds.map((rid, i) => `<p:sldLayoutId id="${2147483649 + i}" r:id="${rid}"/>`).join(''),
      title: deck.master.placeholders.find((p) => p.kind === 'title')?.style ?? {},
      body: deck.master.placeholders.find((p) => p.kind === 'body')?.style ?? {},
    })),
  );
  await pkg.setRels(masterPath, mrels);

  // --- theme ---------------------------------------------------------------
  pkg.set('ppt/theme/theme1.xml', patchThemeXml(await pkg.text('ppt/theme/theme1.xml'), theme));

  // --- slides --------------------------------------------------------------
  for (const [i, meta] of metas.entries()) {
    const path = `ppt/slides/slide${i + 1}.xml`;
    let xml = await pkg.text(path);
    const numbered = renumberShapes(xml);
    xml = numbered.xml;
    const rels = await pkg.rels(path);

    for (const [name, spec] of meta.placeholders) xml = patchBlock(xml, name, (b) => tieToPlaceholder(b, spec));
    for (const name of meta.slideNumberShapes) xml = patchBlock(xml, name, asSlideNumberField);
    for (const [name, attrs] of meta.columns) xml = patchBlock(xml, name, (b) => b.replace('<a:bodyPr', `<a:bodyPr${attrs}`));
    for (const [name, crop] of meta.crops) {
      const rect = srcRectXml(crop);
      if (rect) xml = patchBlock(xml, name, (b) => b.replace('<a:stretch>', `${rect}<a:stretch>`));
    }

    if (meta.slide.background) {
      const bg = await backgroundPart(pkg, meta.slide.background, assets, `slide${i + 1}bg`, rels, deck, meta.backgroundImage);
      xml = xml.replace('<p:spTree>', `${bg}<p:spTree>`);
      await pkg.setRels(path, rels);
    }

    const plan = buildPlan(meta.slide.elements);
    const byName = (unit: BuildUnit) => numbered.ids.get(nameOf(unit.elementId));
    const timing = timingXml(
      plan.units,
      (unit) => {
        const spid = byName(unit);
        return spid === undefined ? null : { spid, paragraph: unit.paragraph };
      },
      [...meta.textBuilds].flatMap(([name, byParagraph]) => {
        const spid = numbered.ids.get(name);
        return spid === undefined ? [] : [{ spid, byParagraph }];
      }),
    );
    xml = xml.replace('</p:sld>', `${transitionXml(meta.slide.transition)}${timing}</p:sld>`);
    pkg.set(path, tokens.apply(tidyParagraphs(xml)));
  }

  // Tokens may also sit in charts and other parts PptxGenJS wrote.
  for (const path of Object.keys(pkg.zip.files).filter((p) => /^ppt\/charts\/chart\d+\.xml$/.test(p))) {
    pkg.set(path, tokens.apply(await pkg.text(path)));
  }

  // PptxGenJS declares a slide master part per layout it was given; there is only one.
  const types = await pkg.text('[Content_Types].xml');
  pkg.set('[Content_Types].xml', types.replace(/<Override PartName="\/([^"]+)"[^>]*\/>/g, (whole, part: string) => (pkg.has(part) ? whole : '')));

  // --- notes and the rest --------------------------------------------------
  for (const path of Object.keys(pkg.zip.files).filter((p) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(p))) {
    pkg.set(path, splitNotesParagraphs(await pkg.text(path)));
  }
  const presentation = await pkg.text('ppt/presentation.xml');
  pkg.set('ppt/presentation.xml', presentation.replace(/<p:notesSz [^>]*\/>/, '<p:notesSz cx="6858000" cy="9144000"/>'));
  const notes = deck.slides.filter((s) => s.notes.trim()).length;
  const hidden = deck.slides.filter((s) => s.hidden).length;
  pkg.set(
    'docProps/app.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><TotalTime>0</TotalTime><Application>ParaDOCs</Application><PresentationFormat>Custom</PresentationFormat><Slides>${slideCount}</Slides><Notes>${notes}</Notes><HiddenSlides>${hidden}</HiddenSlides></Properties>`,
  );
}

/** A `<p:bg>` for a master, layout or slide; a picture gets a relationship in `rels` (and is added to the package). */
async function backgroundPart(
  pkg: Package,
  background: SlideBackground,
  assets: ExportAssets,
  key: string,
  rels: Rel[],
  deck: DeckSnapshot,
  preloaded?: LoadedImage,
): Promise<string> {
  void deck;
  if (background.kind !== 'image') return backgroundXml(background);
  const image = preloaded ?? (await assets.image(background.url));
  if (!image) return backgroundXml({ kind: 'color', color: themeColor('background1') });
  const path = await pkg.addImage(image, key);
  const rid = `rIdB${rels.length + 1}`;
  rels.push({ id: rid, type: IMAGE_REL, target: `../media/${path.split('/').pop()}`, external: false });
  const size = deck.settings.size;
  return backgroundXml(background, { rid, crop: coverCrop(image, size) });
}

/** PptxGenJS writes notes as one run; paragraphs stay paragraphs. */
function splitNotesParagraphs(xml: string): string {
  return xml.replace(/(<p:ph type="body"[\s\S]*?<a:lstStyle\/>)<a:p>([\s\S]*?)<\/a:p>(<\/p:txBody>)/, (_w, head: string, body: string, tail: string) => {
    const text = /<a:t>([\s\S]*?)<\/a:t>/.exec(body)?.[1] ?? '';
    const paragraphs = text.split(/\r?\n/).map((line) => `<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${line}</a:t></a:r></a:p>`);
    return head + paragraphs.join('') + tail;
  });
}

/** Removes slides (by their number in the package) from the presentation. */
async function removeSlides(pkg: Package, slideNos: number[]): Promise<void> {
  let presentation = await pkg.text('ppt/presentation.xml');
  let rels = await pkg.rels('ppt/presentation.xml');
  for (const no of slideNos) {
    const target = `slides/slide${no}.xml`;
    const rel = rels.find((r) => r.target === target);
    if (rel) {
      presentation = presentation.replace(new RegExp(`<p:sldId [^>]*r:id="${rel.id}"[^>]*/>`), '');
      rels = rels.filter((r) => r !== rel);
    }
    await pkg.removePart(`ppt/slides/slide${no}.xml`);
  }
  pkg.set('ppt/presentation.xml', presentation);
  await pkg.setRels('ppt/presentation.xml', rels);
}
