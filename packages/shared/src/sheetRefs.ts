import type { ChartData, ChartKind } from './chart.js';

/**
 * Pointing at a spreadsheet from somewhere else.
 *
 * A document or a canvas can show one cell's value or one chart from a
 * spreadsheet. What it stores is the address — which spreadsheet, which sheet,
 * which cell or chart — and never the value, because the whole point is that
 * the value is whatever the spreadsheet says now. The server works that out on
 * request, from the spreadsheet's live grid if someone has it open and from its
 * saved copy otherwise, so a document opened a week later shows this week's
 * numbers.
 *
 * A reference names the sheet by id, not by name, so renaming a tab does not
 * break it. It names the cell by address, so — as with a link into any
 * spreadsheet from outside it — inserting rows above that cell moves the data
 * out from under the reference.
 */

export interface SheetCellRef {
  spreadsheetId: string;
  sheetId: string;
  /** "B5". */
  cell: string;
}

export interface SheetChartRef {
  spreadsheetId: string;
  sheetId: string;
  chartId: string;
}

export type SheetRef = ({ kind: 'cell' } & SheetCellRef) | ({ kind: 'chart' } & SheetChartRef);

/** Why a reference could not be shown. None of these say whether the thing exists for someone else. */
export type SheetRefProblem = 'unavailable' | 'sheet' | 'cell' | 'chart';

export type ResolvedSheetRef =
  | {
      kind: 'cell';
      status: 'ok';
      /** The value as the spreadsheet draws it, format and all. */
      display: string;
      spreadsheetTitle: string;
      sheetName: string;
      cell: string;
      isError: boolean;
    }
  | {
      kind: 'chart';
      status: 'ok';
      title: string;
      chartKind: ChartKind;
      data: ChartData;
      spreadsheetTitle: string;
      sheetName: string;
    }
  | { kind: 'cell' | 'chart'; status: 'missing'; problem: SheetRefProblem };

const ID = /^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|main)$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const CELL = /^[A-Za-z]{1,3}[0-9]{1,6}$/;

/** Whether a reference is well-formed, before anything is looked up. */
export function isValidSheetRef(ref: SheetRef): boolean {
  if (!UUID.test(ref.spreadsheetId) || !ID.test(ref.sheetId)) return false;
  return ref.kind === 'cell' ? CELL.test(ref.cell) : UUID.test(ref.chartId);
}

/** One string per distinct reference, for caches and for matching answers to questions. */
export function sheetRefKey(ref: SheetRef): string {
  return ref.kind === 'cell'
    ? `cell:${ref.spreadsheetId}:${ref.sheetId}:${ref.cell.toUpperCase()}`
    : `chart:${ref.spreadsheetId}:${ref.sheetId}:${ref.chartId}`;
}

// --- placeholders in stored text --------------------------------------------------

/**
 * How a reference is written into text that is stored rather than drawn — the
 * markdown derived from a document for search and export. It is a link to a
 * scheme nothing else uses, so it survives any markdown tooling untouched and
 * can be found again and replaced with the current value when the text is
 * actually handed to someone.
 */
export const SHEET_REF_SCHEME = 'paradocs-sheet://';

export function sheetRefUrl(ref: SheetRef): string {
  return ref.kind === 'cell'
    ? `${SHEET_REF_SCHEME}cell/${ref.spreadsheetId}/${ref.sheetId}/${ref.cell.toUpperCase()}`
    : `${SHEET_REF_SCHEME}chart/${ref.spreadsheetId}/${ref.sheetId}/${ref.chartId}`;
}

export function parseSheetRefUrl(url: string): SheetRef | null {
  if (!url.startsWith(SHEET_REF_SCHEME)) return null;
  const [kind, spreadsheetId, sheetId, target] = url.slice(SHEET_REF_SCHEME.length).split('/');
  const ref: SheetRef | null =
    kind === 'cell'
      ? { kind, spreadsheetId, sheetId, cell: (target ?? '').toUpperCase() }
      : kind === 'chart'
        ? { kind, spreadsheetId, sheetId, chartId: target ?? '' }
        : null;
  return ref && isValidSheetRef(ref) ? ref : null;
}

/** A placeholder as markdown: a link whose text says what it is, for anyone reading raw. */
export function sheetRefMarkdown(ref: SheetRef, label: string): string {
  const text = (label || (ref.kind === 'cell' ? ref.cell : 'Chart')).replace(/[[\]]/g, '');
  return `[${text}](${sheetRefUrl(ref)})`;
}

const PLACEHOLDER = /\[([^\]]*)\]\((paradocs-sheet:\/\/[^)\s]+)\)/g;

/** Every reference a piece of markdown carries, in order, without duplicates. */
export function sheetRefsInMarkdown(markdown: string): SheetRef[] {
  const found = new Map<string, SheetRef>();
  for (const match of markdown.matchAll(PLACEHOLDER)) {
    const ref = parseSheetRefUrl(match[2]);
    if (ref) found.set(sheetRefKey(ref), ref);
  }
  return [...found.values()];
}

/** Cells in a markdown table must not break it. */
function tableCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** A chart's data as a markdown table: markdown has no charts, but it has the numbers. */
export function chartMarkdownTable(title: string, data: ChartData): string {
  const lines: string[] = [];
  if (title) lines.push(`**${title}**`, '');
  const header = ['', ...data.series.map((series) => series.name)];
  lines.push(`| ${header.map(tableCell).join(' | ')} |`);
  lines.push(`| ${header.map(() => '---').join(' | ')} |`);
  data.categories.forEach((category, index) => {
    const row = [category, ...data.series.map((series) => (series.values[index] === null ? '' : String(series.values[index])))];
    lines.push(`| ${row.map(tableCell).join(' | ')} |`);
  });
  return lines.join('\n');
}

/**
 * Markdown with every reference replaced by what it shows now. A cell becomes
 * its value in the middle of the sentence it was in; a chart becomes a table
 * of its data on lines of its own. A reference that can no longer be shown
 * keeps its label and says so, rather than vanishing from the text.
 */
export function replaceSheetRefs(markdown: string, resolved: Map<string, ResolvedSheetRef>): string {
  return markdown.replace(PLACEHOLDER, (whole, label: string, url: string) => {
    const ref = parseSheetRefUrl(url);
    if (!ref) return whole;
    const result = resolved.get(sheetRefKey(ref));
    if (!result || result.status !== 'ok') {
      return `${label || (ref.kind === 'cell' ? ref.cell : 'Chart')} (unavailable)`;
    }
    if (result.kind === 'cell') return result.display;
    return `\n\n${chartMarkdownTable(result.title || label, result.data)}\n\n`;
  })
    .replace(/\n{3,}/g, '\n\n');
}

// --- editor types -------------------------------------------------------------------

/**
 * The document editor's types for references, shared so the browser's editor
 * and the server's agree on exactly what is stored. The server re-reads every
 * document when it saves; a node type it did not recognise would be dropped
 * from the document on the next save, which is why both sides register these.
 */
export const SHEET_CELL_INLINE = {
  type: 'sheetCell',
  propSchema: {
    spreadsheetId: { default: '' },
    sheetId: { default: '' },
    cell: { default: '' },
    /** What to call it where a value cannot be fetched, and in the raw markdown. */
    label: { default: '' },
  },
  content: 'none',
} as const;

export const SHEET_CHART_BLOCK = {
  type: 'sheetChart',
  propSchema: {
    spreadsheetId: { default: '' },
    sheetId: { default: '' },
    chartId: { default: '' },
    label: { default: '' },
  },
  content: 'none',
} as const;
