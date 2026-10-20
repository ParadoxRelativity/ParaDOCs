import {
  MAX_LIST_LEVEL,
  mapOfficeFont,
  resolveSlideColor,
  type PlaceholderStyle,
  type RichAlign,
  type RichMarks,
  type RichParagraph,
  type RichRun,
  type Theme,
} from '@paradocs/shared';
import { attr, boolAttr, child, firstColor, kids, numAttr, type Rel } from './ooxml';
import type { ReportBuilder } from './slideImportTypes';

/**
 * DrawingML text bodies (`a:txBody`) as rich paragraphs, and the text styles
 * that placeholders pass down (`a:lstStyle`, the master's title and body
 * styles) as the few properties a placeholder style holds.
 */

export interface TextScope {
  /** Size of one hundredth of a point, in slide units. */
  ptUnits: (hundredths: number) => number;
  /** Slide units for a length in EMU. */
  emuUnits: (emu: number) => number;
  theme: Theme;
  report: ReportBuilder;
  slideNo: number;
  rels: Map<string, Rel>;
}

const ALIGN: Record<string, RichAlign> = { l: 'left', ctr: 'center', r: 'right', just: 'justify', justLow: 'justify', dist: 'justify' };

/** PowerPoint's "single" line spacing is about 1.2 times the font size. */
const SINGLE_SPACING = 1.2;

/** A color as a concrete one, since marks on a run do not follow the theme. */
export function concreteColor(value: string, theme: Theme): string {
  return resolveSlideColor(value, theme) ?? value;
}

const levelPr = (lst: Element | null, level: number) => child(lst, `lvl${level + 1}pPr`);

function bulletOf(pPr: Element | null): 'none' | 'bullet' | 'number' | undefined {
  if (!pPr) return undefined;
  for (const c of kids(pPr)) {
    const name = c.localName || c.nodeName.split(':').pop();
    if (name === 'buNone') return 'none';
    if (name === 'buChar' || name === 'buBlip') return 'bullet';
    if (name === 'buAutoNum') return 'number';
  }
  return undefined;
}

/**
 * The family a `a:latin` names. The theme's own fonts (+mn-lt, +mj-lt) are left
 * to the theme, so changing it restyles the text; a run that asks for the
 * heading font outside a title is the one place the name is written out.
 */
function fontOf(el: Element | null, theme: Theme, run = false): string | undefined {
  const face = attr(child(el, 'latin'), 'typeface');
  if (!face || face === '+mn-lt') return undefined;
  if (face === '+mj-lt') return run ? theme.fonts.heading : undefined;
  if (face.startsWith('+')) return undefined;
  return mapOfficeFont(face);
}

/** Properties of a text style level (`a:lvl1pPr` with its `a:defRPr`) a placeholder style can hold. */
export function levelStyle(scope: TextScope, pPr: Element | null): PlaceholderStyle {
  const style: PlaceholderStyle = {};
  if (!pPr) return style;
  const algn = ALIGN[attr(pPr, 'algn') ?? ''];
  if (algn) style.align = algn;
  const spacing = numAttr(child(pPr, 'lnSpc', 'spcPct'), 'val');
  if (spacing) style.lineSpacing = Math.round((spacing / 100000) * SINGLE_SPACING * 100) / 100;
  const def = child(pPr, 'defRPr');
  if (def) {
    const sz = numAttr(def, 'sz');
    if (sz) style.fontSize = scope.ptUnits(sz);
    if (boolAttr(def, 'b')) style.bold = true;
    if (boolAttr(def, 'i')) style.italic = true;
    const color = firstColor(child(def, 'solidFill'));
    if (color) style.color = color.color;
    const family = fontOf(def, scope.theme);
    if (family) style.fontFamily = family;
  }
  return style;
}

function linkOf(scope: TextScope, rPr: Element | null): string | undefined {
  const link = child(rPr, 'hlinkClick');
  if (!link) return undefined;
  const id = attr(link, 'id');
  const rel = id ? scope.rels.get(id) : undefined;
  if (rel?.external && /^(https?:|mailto:|tel:)/i.test(rel.target)) return rel.target;
  scope.report.dropped('Links to slides, files and actions', scope.slideNo, 'only web and mail links are kept');
  return undefined;
}

function marksOf(scope: TextScope, sources: (Element | null)[]): RichMarks | undefined {
  const marks: RichMarks = {};
  const first = <T>(read: (el: Element) => T | undefined): T | undefined => {
    for (const el of sources) {
      if (!el) continue;
      const value = read(el);
      if (value !== undefined) return value;
    }
    return undefined;
  };
  if (first((el) => boolAttr(el, 'b'))) marks.bold = true;
  if (first((el) => boolAttr(el, 'i'))) marks.italic = true;
  const underline = first((el) => attr(el, 'u'));
  if (underline && underline !== 'none') marks.underline = true;
  const strike = first((el) => attr(el, 'strike'));
  if (strike && strike !== 'noStrike') marks.strike = true;
  const sz = first((el) => numAttr(el, 'sz'));
  if (sz) marks.fontSize = scope.ptUnits(sz);
  const fill = first((el) => child(el, 'solidFill') ?? undefined);
  const color = fill ? firstColor(fill) : null;
  if (color) marks.color = concreteColor(color.color, scope.theme);
  if (color?.alpha !== undefined) scope.report.approximated('Transparent text', scope.slideNo, 'drawn solid');
  const highlight = firstColor(child(sources[0], 'highlight'));
  if (highlight) marks.highlight = concreteColor(highlight.color, scope.theme);
  const family = first((el) => fontOf(el, scope.theme, true));
  if (family) marks.fontFamily = family;
  const link = linkOf(scope, sources[0]);
  if (link) marks.link = link;
  const baseline = numAttr(sources[0], 'baseline');
  if (baseline) scope.report.approximated('Superscript and subscript text', scope.slideNo, 'drawn at normal height');
  if (first((el) => (child(el, 'gradFill') || child(el, 'effectLst') || child(el, 'ln') ? true : undefined))) {
    scope.report.approximated('Text effects (outline, gradient, glow, shadow)', scope.slideNo, 'plain text kept');
  }
  return Object.keys(marks).length ? marks : undefined;
}

export interface TextOptions {
  /** `a:lstStyle` elements whose character and paragraph formats apply, most specific first. */
  formatChain: (Element | null)[];
  /** The longer chain (layout, master, master text styles) that bullets are inherited through. */
  bulletChain: (Element | null)[];
  /** Whether paragraphs have a bullet when nothing says (a body placeholder: no; PowerPoint writes it on the master). */
}

const sameMarks = (a?: RichMarks, b?: RichMarks) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** A text body as paragraphs. Empty runs are dropped; adjacent runs that look alike are joined. */
export function readParagraphs(scope: TextScope, txBody: Element | null, options: TextOptions): RichParagraph[] {
  const paragraphs: RichParagraph[] = [];
  for (const p of kids(txBody, 'p')) {
    const pPr = child(p, 'pPr');
    const level = Math.min(Math.max(numAttr(pPr, 'lvl') ?? 0, 0), MAX_LIST_LEVEL);
    const paragraph: RichParagraph = { runs: [] };

    const lstFor = (chain: (Element | null)[]) => chain.map((lst) => levelPr(lst, level));
    const fmtLevels = lstFor(options.formatChain);
    const algn = [pPr, ...fmtLevels].map((el) => ALIGN[attr(el, 'algn') ?? '']).find(Boolean);
    if (algn && algn !== 'left') paragraph.align = algn;

    const bullet = [pPr, ...lstFor(options.bulletChain)].map(bulletOf).find((b) => b !== undefined);
    if (bullet === 'bullet' || bullet === 'number') {
      paragraph.bullet = bullet;
      if (level > 0) paragraph.level = level;
    }
    if (level > 0 && paragraph.bullet) scope.report.approximated('Indented list levels', scope.slideNo, 'drawn with the first level text size');

    const spacing = numAttr(child(pPr, 'lnSpc', 'spcPct'), 'val');
    if (spacing && spacing !== 100000) paragraph.lineHeight = Math.round((spacing / 100000) * SINGLE_SPACING * 100) / 100;
    else if (child(pPr, 'lnSpc', 'spcPts')) scope.report.approximated('Exact line spacing', scope.slideNo, 'normal line spacing used');
    if (child(pPr, 'spcBef') || child(pPr, 'spcAft')) scope.report.approximated('Space before and after paragraphs', scope.slideNo, 'default spacing used');

    const defaults = fmtLevels.map((el) => child(el, 'defRPr'));
    const push = (text: string, marks: RichMarks | undefined) => {
      if (!text) return;
      const last = paragraph.runs[paragraph.runs.length - 1];
      if (last && !last.mention && sameMarks(last.marks, marks)) last.text = `${last.text ?? ''}${text}`;
      else paragraph.runs.push(marks ? { text, marks } : { text });
    };
    for (const node of kids(p)) {
      const name = node.localName || node.nodeName.split(':').pop();
      if (name === 'r' || name === 'fld') {
        const text = child(node, 't')?.textContent ?? '';
        push(text, marksOf(scope, [child(node, 'rPr'), ...defaults]));
      } else if (name === 'br') {
        push('\n', marksOf(scope, [child(node, 'rPr'), ...defaults]));
      }
    }
    paragraphs.push(paragraph);
  }
  return paragraphs;
}

export const paragraphsHaveText = (paragraphs: RichParagraph[]): boolean => paragraphs.some((p) => p.runs.some((run: RichRun) => (run.text ?? '').trim() !== ''));

export const plainParagraphs = (paragraphs: RichParagraph[]): string[] => paragraphs.map((p) => p.runs.map((run) => run.text ?? '').join(''));
