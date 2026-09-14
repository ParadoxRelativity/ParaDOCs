import {
  DEFAULT_COLUMNS,
  DEFAULT_COLUMN_WIDTH,
  DEFAULT_ROWS,
  MAX_COLUMNS,
  MAX_ROWS,
  MAX_SHEET_NAME,
  cellKey,
  dateToSerial,
  isError,
  parseCellKey,
  parseInput,
  type CellFormat,
  type CellStyle,
  type CellValue,
  type SheetMeta,
} from '@paradocs/shared';

/**
 * Excel files in and out.
 *
 * ExcelJS is large, so it is loaded only when someone actually imports or
 * exports; opening a spreadsheet never pays for it.
 *
 * Formulas travel as formulas. On the way out each one carries its computed
 * value too, so Excel shows the right numbers before it has recalculated; on
 * the way in, a formula whose text the file does not carry comes in as its last
 * value rather than being dropped.
 */

type ExcelModule = typeof import('exceljs');

async function loadExcel(): Promise<ExcelModule> {
  const module = await import('exceljs');
  return ((module as unknown as { default?: ExcelModule }).default ?? module) as ExcelModule;
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Excel measures columns in characters; roughly seven pixels each at its default font. */
const PX_PER_CHAR = 7;

const NUMBER_FORMATS: Partial<Record<CellFormat, (decimals: number, currency: string) => string>> = {
  number: (d) => `#,##0${d > 0 ? `.${'0'.repeat(d)}` : ''}`,
  integer: () => '#,##0',
  currency: (d, c) => `"${c}"#,##0${d > 0 ? `.${'0'.repeat(d)}` : ''}`,
  percent: (d) => `0${d > 0 ? `.${'0'.repeat(d)}` : ''}%`,
  scientific: (d) => `0${d > 0 ? `.${'0'.repeat(d)}` : ''}E+00`,
  date: () => 'yyyy-mm-dd',
  datetime: () => 'yyyy-mm-dd hh:mm',
  time: () => 'hh:mm:ss',
  text: () => '@',
};

// --- export -----------------------------------------------------------------

export interface ExportSheet {
  name: string;
  raw: Map<string, string>;
  values: Map<string, CellValue>;
  styles: Map<string, CellStyle>;
  meta: SheetMeta;
}

export async function exportXlsx(input: { title: string; sheets: ExportSheet[] }): Promise<Blob> {
  const ExcelJS = await loadExcel();
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'ParaDOCs';
  workbook.title = input.title;

  for (const sheet of input.sheets) {
    const worksheet = workbook.addWorksheet(sheet.name);

    for (const [column, px] of Object.entries(sheet.meta.columnWidths ?? {})) {
      worksheet.getColumn(Number(column) + 1).width = Math.max(1, Math.round((px / PX_PER_CHAR) * 10) / 10);
    }

    const keys = new Set([...sheet.raw.keys(), ...sheet.styles.keys()]);
    for (const key of keys) {
      const ref = parseCellKey(key);
      if (!ref) continue;
      const cell = worksheet.getCell(ref.row + 1, ref.column + 1);
      const text = sheet.raw.get(key);

      if (text !== undefined) {
        const parsed = parseInput(text);
        const computed = sheet.values.get(key) ?? null;
        if (parsed.kind === 'formula') {
          cell.value = {
            formula: parsed.source,
            // An error has no cached value worth carrying; Excel recomputes it.
            result: computed === null || isError(computed) ? undefined : computed,
          } as import('exceljs').CellFormulaValue;
        } else {
          cell.value = parsed.value;
        }
      }

      const style = sheet.styles.get(key);
      if (style) applyStyle(cell, style);
    }
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return new Blob([buffer], { type: XLSX_MIME });
}

function applyStyle(cell: import('exceljs').Cell, style: CellStyle): void {
  const format = style.format && NUMBER_FORMATS[style.format];
  if (format) cell.numFmt = format(style.decimals ?? 2, style.currency ?? '$');
  if (style.bold || style.italic || style.color) {
    cell.font = {
      bold: style.bold || undefined,
      italic: style.italic || undefined,
      ...(style.color?.startsWith('#') ? { color: { argb: `FF${style.color.slice(1).toUpperCase()}` } } : {}),
    };
  }
  if (style.align) cell.alignment = { horizontal: style.align };
  if (style.background?.startsWith('#')) {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${style.background.slice(1).toUpperCase()}` } };
  }
}

/** Offers a file to save, the way the app's other exports do. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// --- import -----------------------------------------------------------------

export interface ImportedSheet {
  name: string;
  /** The name the file used, when it had to change to be valid here. */
  originalName: string;
  cells: Record<string, string>;
  styles: Record<string, CellStyle>;
  columnWidths: Record<number, number>;
  rows: number;
  columns: number;
}

export interface ImportedWorkbook {
  title: string;
  fileName: string;
  sheets: ImportedSheet[];
  /** Whether cells past the grid's size limits were left out. */
  truncated: boolean;
  /** Formulas brought in as their last value because the file did not carry their text. */
  flattenedFormulas: number;
}

export async function importXlsx(file: File): Promise<ImportedWorkbook> {
  const ExcelJS = await loadExcel();
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(await file.arrayBuffer());
  } catch {
    throw new Error(`${file.name} could not be read as an Excel workbook.`);
  }

  const sheets: ImportedSheet[] = [];
  const taken: string[] = [];
  let truncated = false;
  let flattenedFormulas = 0;

  workbook.eachSheet((worksheet) => {
    const name = uniqueName(validName(worksheet.name), taken);
    taken.push(name);
    const cells: Record<string, string> = {};
    const styles: Record<string, CellStyle> = {};
    let maxRow = 0;
    let maxColumn = 0;

    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
        const r = rowNumber - 1;
        const c = columnNumber - 1;
        if (r >= MAX_ROWS || c >= MAX_COLUMNS) {
          truncated = true;
          return;
        }
        const key = cellKey(r, c);
        const read = inputFor(cell);
        if (read.flattened) flattenedFormulas++;
        if (read.input !== '') cells[key] = read.input;
        const style = styleFor(cell, read.isDate);
        if (style) styles[key] = style;
        if (read.input !== '' || style) {
          maxRow = Math.max(maxRow, r);
          maxColumn = Math.max(maxColumn, c);
        }
      });
    });

    const columnWidths: Record<number, number> = {};
    (worksheet.columns ?? []).forEach((column, index) => {
      if (column?.width && index < MAX_COLUMNS) {
        const px = Math.round(column.width * PX_PER_CHAR);
        if (px !== DEFAULT_COLUMN_WIDTH) columnWidths[index] = Math.max(40, px);
      }
    });

    sheets.push({
      name,
      originalName: worksheet.name,
      cells,
      styles,
      columnWidths,
      rows: Math.min(MAX_ROWS, Math.max(DEFAULT_ROWS, maxRow + 1)),
      columns: Math.min(MAX_COLUMNS, Math.max(DEFAULT_COLUMNS, maxColumn + 1)),
    });
  });

  if (sheets.length === 0) throw new Error(`${file.name} has no sheets in it.`);

  return {
    title: file.name.replace(/\.xlsx$/i, '').trim() || 'Imported spreadsheet',
    fileName: file.name,
    sheets,
    truncated,
    flattenedFormulas,
  };
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** What to store for one Excel cell: the text someone would have typed to get it. */
function inputFor(cell: import('exceljs').Cell): { input: string; isDate: boolean; flattened: boolean } {
  const formula = (cell as unknown as { formula?: string }).formula;
  if (typeof formula === 'string' && formula.trim() !== '') {
    return { input: `=${formula.replace(/^=/, '')}`, isDate: false, flattened: false };
  }

  const value = cell.value as unknown;
  if (value === null || value === undefined) return { input: '', isDate: false, flattened: false };

  if (value instanceof Date) {
    const hasTime = value.getUTCHours() + value.getUTCMinutes() + value.getUTCSeconds() > 0;
    const day = `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
    const input = hasTime ? `${day} ${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}` : day;
    return { input, isDate: true, flattened: false };
  }
  if (typeof value === 'number') return { input: String(value), isDate: false, flattened: false };
  if (typeof value === 'boolean') return { input: value ? 'TRUE' : 'FALSE', isDate: false, flattened: false };
  if (typeof value === 'string') return { input: value, isDate: false, flattened: false };

  if (typeof value === 'object') {
    const shaped = value as {
      richText?: { text: string }[];
      text?: string;
      error?: string;
      result?: unknown;
      sharedFormula?: string;
    };
    if (Array.isArray(shaped.richText)) {
      return { input: shaped.richText.map((part) => part.text).join(''), isDate: false, flattened: false };
    }
    if (typeof shaped.error === 'string') return { input: shaped.error, isDate: false, flattened: false };
    if ('result' in shaped || 'sharedFormula' in shaped) {
      const result = shaped.result;
      const input =
        result instanceof Date
          ? `${result.getUTCFullYear()}-${pad(result.getUTCMonth() + 1)}-${pad(result.getUTCDate())}`
          : result === undefined || result === null
            ? ''
            : typeof result === 'object' && result && 'error' in result
              ? String((result as { error: unknown }).error)
              : String(result);
      return { input, isDate: result instanceof Date, flattened: true };
    }
    if (typeof shaped.text === 'string') return { input: shaped.text, isDate: false, flattened: false };
  }
  return { input: String(value), isDate: false, flattened: false };
}

/** The formats this app can draw, read back from Excel's number format strings. */
function formatFor(numFmt: string | undefined, isDate: boolean): { format: CellFormat; decimals?: number; currency?: string } | null {
  if (!numFmt || numFmt === 'General') return isDate ? { format: 'date' } : null;
  const decimals = /\.(0+)/.exec(numFmt)?.[1].length ?? 0;
  if (numFmt === '@') return { format: 'text' };
  if (/E\+/i.test(numFmt)) return { format: 'scientific', decimals };
  if (numFmt.includes('%')) return { format: 'percent', decimals };
  if (/[yd]/i.test(numFmt) && /h/i.test(numFmt)) return { format: 'datetime' };
  if (/[yd]/i.test(numFmt)) return { format: 'date' };
  if (/h/i.test(numFmt) && /[ms]/i.test(numFmt)) return { format: 'time' };
  const currency = /[$£€¥]/.exec(numFmt)?.[0];
  if (currency) return { format: 'currency', decimals, currency };
  if (/0/.test(numFmt)) return decimals > 0 ? { format: 'number', decimals } : { format: 'integer' };
  return isDate ? { format: 'date' } : null;
}

function styleFor(cell: import('exceljs').Cell, isDate: boolean): CellStyle | null {
  const style: CellStyle = {};
  const format = formatFor(cell.numFmt, isDate);
  if (format) Object.assign(style, format);
  if (cell.font?.bold) style.bold = true;
  if (cell.font?.italic) style.italic = true;
  const horizontal = cell.alignment?.horizontal;
  if (horizontal === 'left' || horizontal === 'center' || horizontal === 'right') style.align = horizontal;
  const fill = cell.fill as { type?: string; fgColor?: { argb?: string } } | undefined;
  if (fill?.type === 'pattern' && fill.fgColor?.argb && fill.fgColor.argb.length === 8) {
    style.background = `#${fill.fgColor.argb.slice(2)}`;
  }
  return Object.keys(style).length > 0 ? style : null;
}

function validName(name: string): string {
  const cleaned = name.replace(/[\\/?*[\]:]/g, ' ').replace(/^'+|'+$/g, '').trim().slice(0, MAX_SHEET_NAME);
  return cleaned || 'Sheet';
}

function uniqueName(name: string, taken: string[]): string {
  const lower = new Set(taken.map((entry) => entry.toLowerCase()));
  if (!lower.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) {
    const suffix = ` (${n})`;
    const candidate = `${name.slice(0, MAX_SHEET_NAME - suffix.length)}${suffix}`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
}

export { dateToSerial };
