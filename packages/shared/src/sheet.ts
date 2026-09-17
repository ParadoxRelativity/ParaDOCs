/**
 * Spreadsheet data model.
 *
 * A spreadsheet is its own record with its own Y.Doc, not a document wearing a
 * different hat. What it borrows from documents is the collaboration machinery
 * and nothing else. Inside that Y.Doc it uses three root maps rather than one,
 * and that split is the whole design:
 *
 * - `sheet-cells` holds what people typed, keyed by "A1". One key per cell
 *   means two people editing different cells merge without either one seeing
 *   the other's write, which a single blob of rows would not give.
 * - `sheet-formats` holds how each cell is drawn, keyed the same way, so
 *   changing a number's format never races with changing its value.
 * - `sheet-meta` holds what belongs to the grid rather than to any cell:
 *   its size, column widths, and the frozen edges.
 *
 * Only what was typed is stored. Computed values are derived on the client
 * from the formulas, because a stored result is a second source of truth that
 * goes stale the moment someone else edits a cell it depended on.
 */

import type { AccessMode, Permission } from './types.js';

/**
 * The collaboration server serves documents and spreadsheets over one socket,
 * and tells them apart by this prefix on the name. Neither app has to know the
 * other exists; the prefix is the whole of the contract between them.
 */
export const SHEET_COLLAB_PREFIX = 'sheet:';

export function sheetCollabName(id: string): string {
  return `${SHEET_COLLAB_PREFIX}${id}`;
}

/** The spreadsheet a collaboration name refers to, or null for a document. */
export function sheetIdFromCollabName(name: string): string | null {
  return name.startsWith(SHEET_COLLAB_PREFIX) ? name.slice(SHEET_COLLAB_PREFIX.length) : null;
}

/** A spreadsheet as a list shows it. */
export interface SpreadsheetSummary {
  id: string;
  workspaceId: string;
  /** The spreadsheets folder it is filed in, or null for none. */
  folderId: string | null;
  title: string;
  icon: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  /** Its own setting; see AccessMode. */
  access: AccessMode;
  /** What the signed-in person may do with it: `view` or `edit`. */
  permission: Permission;
}

export const SHEET_CELLS = 'sheet-cells';
export const SHEET_FORMATS = 'sheet-formats';
export const SHEET_META = 'sheet-meta';
export const SHEET_CHARTS = 'sheet-charts';

// --- sheets within a spreadsheet ---------------------------------------------

/**
 * The sheets a spreadsheet has, keyed by id, each a Y.Map holding its name and
 * its position. Position is a number rather than an index into an array so two
 * people reordering at once each move their own sheet instead of one person's
 * reorder rewriting the whole list over the other's.
 */
export const SHEET_INFO = 'sheet-info';

/**
 * The first sheet. Its maps keep the names a single-sheet spreadsheet has
 * always used, so a spreadsheet made before there were several sheets is
 * simply a workbook with one — nothing to migrate, nothing to lose.
 */
export const MAIN_SHEET_ID = 'main';
export const DEFAULT_SHEET_NAME = 'Sheet1';

export interface SheetInfo {
  id: string;
  name: string;
  /** Sorts the tabs; fractional, so a sheet can be dropped between two others. */
  order: number;
}

export type SheetMapKind = 'cells' | 'formats' | 'meta' | 'charts';

const MAP_BASE: Record<SheetMapKind, string> = {
  cells: SHEET_CELLS,
  formats: SHEET_FORMATS,
  meta: SHEET_META,
  charts: SHEET_CHARTS,
};

/** The Y.Doc root map holding one kind of data for one sheet. */
export function sheetMapName(kind: SheetMapKind, sheetId: string): string {
  return sheetId === MAIN_SHEET_ID ? MAP_BASE[kind] : `${MAP_BASE[kind]}:${sheetId}`;
}

/** Excel's own limits, so a workbook exported from here opens there. */
export const MAX_SHEET_NAME = 31;

/** Why a sheet name cannot be used, or null when it can. */
export function sheetNameProblem(name: string, taken: string[]): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'A sheet needs a name.';
  if (trimmed.length > MAX_SHEET_NAME) return `Sheet names can be at most ${MAX_SHEET_NAME} characters.`;
  if (/[\\/?*[\]:]/.test(trimmed)) return 'Sheet names cannot contain \\ / ? * [ ] or :';
  if (trimmed.startsWith("'") || trimmed.endsWith("'")) return 'Sheet names cannot start or end with an apostrophe.';
  if (taken.some((other) => other.toLowerCase() === trimmed.toLowerCase())) return 'Another sheet already has that name.';
  return null;
}

/**
 * A sheet name as a formula writes it. Plain names go bare; anything with a
 * space, punctuation, or that could be mistaken for a cell reference is quoted,
 * with apostrophes doubled.
 */
export function quoteSheetName(name: string): string {
  const plain = /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) && !/^[A-Za-z]{1,3}[0-9]+$/.test(name);
  return plain ? name : `'${name.replace(/'/g, "''")}'`;
}

/** The first "SheetN" nobody is using yet. */
export function nextSheetName(taken: string[]): string {
  const lower = new Set(taken.map((name) => name.toLowerCase()));
  for (let n = taken.length + 1; ; n++) {
    const candidate = `Sheet${n}`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
}

export const DEFAULT_COLUMNS = 26;
export const DEFAULT_ROWS = 100;
/** Big enough for real data, small enough that a typo in a range cannot hang the tab. */
export const MAX_COLUMNS = 702; // through ZZ
export const MAX_ROWS = 50_000;

export const DEFAULT_COLUMN_WIDTH = 104;
export const MIN_COLUMN_WIDTH = 40;
export const ROW_HEIGHT = 26;
export const HEADER_HEIGHT = 26;
export const ROW_HEADER_WIDTH = 52;

/** How a cell's value is drawn. `general` guesses from the value itself. */
export type CellFormat =
  | 'general'
  | 'number'
  | 'integer'
  | 'currency'
  | 'percent'
  | 'scientific'
  | 'date'
  | 'datetime'
  | 'time'
  | 'text';

export type CellAlign = 'left' | 'center' | 'right';

export interface CellStyle {
  format?: CellFormat;
  /** Decimal places, for the numeric formats. */
  decimals?: number;
  align?: CellAlign;
  bold?: boolean;
  italic?: boolean;
  /** A CSS colour for the text, and one for the fill behind it. */
  color?: string;
  background?: string;
  /** Currency symbol for the currency format. */
  currency?: string;
}

export interface SheetMeta {
  rows: number;
  columns: number;
  /** Widths by column index, for the ones that have been resized. */
  columnWidths?: Record<number, number>;
  /** Rows and columns held still while the rest scrolls. */
  frozenRows?: number;
  frozenColumns?: number;
}

export const DEFAULT_META: SheetMeta = { rows: DEFAULT_ROWS, columns: DEFAULT_COLUMNS };

// --- addressing -------------------------------------------------------------

/** 0 -> "A", 25 -> "Z", 26 -> "AA". */
export function columnName(index: number): string {
  let name = '';
  let n = index;
  while (n >= 0) {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  }
  return name;
}

/** "A" -> 0, "AA" -> 26. Returns -1 for anything that is not a column name. */
export function columnIndex(name: string): number {
  if (!/^[A-Za-z]+$/.test(name)) return -1;
  let index = 0;
  for (const character of name.toUpperCase()) {
    index = index * 26 + (character.charCodeAt(0) - 64);
  }
  return index - 1;
}

export interface CellRef {
  row: number;
  column: number;
}

export function cellKey(row: number, column: number): string {
  return `${columnName(column)}${row + 1}`;
}

/** "B7" -> { row: 6, column: 1 }. Null for anything that is not a reference. */
export function parseCellKey(key: string): CellRef | null {
  const match = /^\$?([A-Za-z]+)\$?([0-9]+)$/.exec(key.trim());
  if (!match) return null;
  const column = columnIndex(match[1]);
  const row = Number(match[2]) - 1;
  if (column < 0 || row < 0 || !Number.isFinite(row)) return null;
  return { row, column };
}

export interface CellRange {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/** The rectangle two corners describe, in whichever order they were given. */
export function normalizeRange(a: CellRef, b: CellRef): CellRange {
  return {
    top: Math.min(a.row, b.row),
    bottom: Math.max(a.row, b.row),
    left: Math.min(a.column, b.column),
    right: Math.max(a.column, b.column),
  };
}

export function rangeContains(range: CellRange, ref: CellRef): boolean {
  return (
    ref.row >= range.top && ref.row <= range.bottom && ref.column >= range.left && ref.column <= range.right
  );
}

export function rangeCells(range: CellRange): CellRef[] {
  const cells: CellRef[] = [];
  for (let row = range.top; row <= range.bottom; row++) {
    for (let column = range.left; column <= range.right; column++) cells.push({ row, column });
  }
  return cells;
}

/** "A1:C9" as people write it, for the formula bar and the name box. */
export function rangeName(range: CellRange): string {
  const start = cellKey(range.top, range.left);
  if (range.top === range.bottom && range.left === range.right) return start;
  return `${start}:${cellKey(range.bottom, range.right)}`;
}

// --- values -----------------------------------------------------------------

/** The error kinds a formula can produce, spelled the way spreadsheets spell them. */
export const ERRORS = {
  div0: '#DIV/0!',
  value: '#VALUE!',
  ref: '#REF!',
  name: '#NAME?',
  na: '#N/A',
  num: '#NUM!',
  cycle: '#CYCLE!',
  parse: '#ERROR!',
} as const;

export type SheetError = (typeof ERRORS)[keyof typeof ERRORS];

const ERROR_VALUES = new Set<string>(Object.values(ERRORS));

export function isError(value: unknown): value is SheetError {
  return typeof value === 'string' && ERROR_VALUES.has(value);
}

/** What a cell evaluates to. Dates are numbers; the format decides how they read. */
export type CellValue = number | string | boolean | null;

/**
 * Spreadsheets count days from 1899-12-30, which is what makes a date and a
 * number the same thing to a formula. Kept here so the engine and the
 * formatter agree.
 */
export const EPOCH = Date.UTC(1899, 11, 30);
export const MS_PER_DAY = 86_400_000;

export function serialToDate(serial: number): Date {
  return new Date(EPOCH + Math.round(serial * MS_PER_DAY));
}

export function dateToSerial(date: Date): number {
  return (date.getTime() - EPOCH) / MS_PER_DAY;
}

/**
 * What typing something means. A leading `=` is a formula; otherwise the input
 * is read as a number, a boolean, a date or plain text, in that order — the
 * same guess a spreadsheet makes when you type into an empty cell.
 */
export function parseInput(raw: string): { kind: 'formula'; source: string } | { kind: 'literal'; value: CellValue } {
  const trimmed = raw.trim();
  if (trimmed.startsWith('=')) return { kind: 'formula', source: trimmed.slice(1) };
  if (trimmed === '') return { kind: 'literal', value: null };

  const upper = trimmed.toUpperCase();
  if (upper === 'TRUE') return { kind: 'literal', value: true };
  if (upper === 'FALSE') return { kind: 'literal', value: false };

  const number = toNumberLiteral(trimmed);
  if (number !== null) return { kind: 'literal', value: number };

  const date = toDateLiteral(trimmed);
  if (date !== null) return { kind: 'literal', value: date };

  return { kind: 'literal', value: raw };
}

/** Plain numbers, and the ones people type with separators, a percent or a currency. */
function toNumberLiteral(text: string): number | null {
  const percent = text.endsWith('%');
  const body = (percent ? text.slice(0, -1) : text).replace(/[,\s]/g, '').replace(/^[$£€¥]/, '');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(body)) return null;
  const value = Number(body);
  if (!Number.isFinite(value)) return null;
  return percent ? value / 100 : value;
}

/** ISO dates and the common slashed forms, as a serial number. */
function toDateLiteral(text: string): number | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (iso) {
    const [, y, m, d, hh = '0', mm = '0', ss = '0'] = iso;
    const time = Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss));
    return Number.isNaN(time) ? null : (time - EPOCH) / MS_PER_DAY;
  }
  const slashed = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (slashed) {
    // Month first, as the spreadsheets people are coming from assume.
    const time = Date.UTC(Number(slashed[3]), Number(slashed[1]) - 1, Number(slashed[2]));
    return Number.isNaN(time) ? null : (time - EPOCH) / MS_PER_DAY;
  }
  return null;
}

// --- search -----------------------------------------------------------------

/**
 * Text a whole workbook contributes to search: each sheet's cells under its
 * name, so a match on a later sheet still shows which sheet it came from.
 */
export function workbookSearchText(sheets: { name: string; cells: Record<string, string> }[]): string {
  if (sheets.length === 1) return sheetSearchText(sheets[0].cells);
  return sheets
    .map((sheet) => {
      const text = sheetSearchText(sheet.cells);
      return text ? `${sheet.name}\n${text}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Text a sheet contributes to search. Formulas are indexed as what they say
 * rather than what they work out to: the computed value is not stored, and a
 * sheet full of `=SUM(...)` should still be findable by the words around it.
 */
export function sheetSearchText(cells: Record<string, string>): string {
  const rows = new Map<number, { column: number; text: string }[]>();
  for (const [key, raw] of Object.entries(cells)) {
    const text = String(raw ?? '').trim();
    if (!text) continue;
    const ref = parseCellKey(key);
    if (!ref) continue;
    const line = rows.get(ref.row) ?? [];
    line.push({ column: ref.column, text });
    rows.set(ref.row, line);
  }

  return [...rows.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, line]) =>
      line
        .sort((a, b) => a.column - b.column)
        .map((cell) => cell.text)
        .join('\t'),
    )
    .join('\n');
}
