import { parseFormula, shiftReferences, type LineChange } from './formula.js';
import { isError, rangeName, type CellRange, type CellValue } from './sheet.js';

/**
 * Charts on a sheet.
 *
 * A chart stores the range it draws from as text, the way a formula does, and
 * never the numbers. The values are read from the grid every time it draws, so
 * a chart can never show data the sheet no longer holds, and a row inserted
 * into its range stretches the chart exactly as it stretches a SUM over it.
 */

export type ChartKind = 'bar' | 'line' | 'pie' | 'scatter';

export const CHART_KINDS: ChartKind[] = ['bar', 'line', 'pie', 'scatter'];

export interface SheetChart {
  id: string;
  kind: ChartKind;
  title: string;
  /**
   * The data, as typed: "A1:C10", on the chart's own sheet, or several ranges
   * joined by commas — "A1:A10,C1:C10" — for columns or rows that are not side
   * by side. "#REF!" once it was deleted.
   */
  range: string;
  /** Whether the first row names the series and the first column names the categories. */
  headers: boolean;
  /** Position and size in grid pixels, from the top-left of the first cell. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export const MIN_CHART_WIDTH = 220;
export const MIN_CHART_HEIGHT = 160;

function parseOneRange(text: string): CellRange | null {
  const tree = parseFormula(text.trim());
  if (!tree) return null;
  if (tree.type === 'range' && tree.sheet === null) return tree.range;
  if (tree.type === 'ref' && tree.sheet === null) {
    return { top: tree.ref.row, bottom: tree.ref.row, left: tree.ref.column, right: tree.ref.column };
  }
  return null;
}

/**
 * The ranges a chart's text names, or null when it no longer names any — after
 * the rows it covered were deleted, say. Only ranges on the chart's own sheet
 * count; a chart draws the data beside it.
 */
export function parseChartRanges(text: string): CellRange[] | null {
  const parts = text.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const ranges: CellRange[] = [];
  for (const part of parts) {
    const range = parseOneRange(part);
    if (!range) return null;
    ranges.push(range);
  }
  return ranges;
}

/**
 * A chart's range after rows or columns move on its sheet, or null when nothing
 * moved. Each part moves on its own; a part whose lines were all deleted drops
 * out, and only when every part has gone does the chart lose its data.
 */
export function shiftChartRange(range: string, sheetName: string, change: LineChange): string | null {
  const parts = range.split(',').map((part) => part.trim()).filter(Boolean);
  let changed = false;
  const kept: string[] = [];
  for (const part of parts) {
    const next = shiftReferences(`=${part}`, sheetName, change);
    if (next === null) {
      kept.push(part);
      continue;
    }
    changed = true;
    const text = next.slice(1);
    if (!isError(text)) kept.push(text);
  }
  if (!changed) return null;
  return kept.length > 0 ? kept.join(',') : '#REF!';
}

/**
 * The rows and columns a chart reads, each sorted and once only. A chart is the
 * grid of every chosen row crossed with every chosen column, which is what
 * makes "column A and column C" or "rows 1–4 and 6–10" chart the way people
 * expect without the parts having to touch.
 */
export function chartLines(ranges: CellRange[]): { rows: number[]; columns: number[] } {
  const rows = new Set<number>();
  const columns = new Set<number>();
  for (const range of ranges) {
    for (let row = range.top; row <= range.bottom; row++) rows.add(row);
    for (let column = range.left; column <= range.right; column++) columns.add(column);
  }
  return { rows: [...rows].sort((a, b) => a - b), columns: [...columns].sort((a, b) => a - b) };
}

/** Consecutive indices grouped into [first, last] runs. */
function runs(indices: number[]): [number, number][] {
  const result: [number, number][] = [];
  for (const index of indices) {
    const last = result.at(-1);
    if (last && index === last[1] + 1) last[1] = index;
    else result.push([index, index]);
  }
  return result;
}

/**
 * The range text for a set of rows crossed with a set of columns, as few parts
 * as the gaps allow. Leaving a row out of a chart is written this way — as a
 * gap in its range — so the chart keeps following its data when rows are
 * inserted or deleted, exactly as it did before.
 */
export function chartRangeText(rows: number[], columns: number[]): string {
  const sortedRows = [...new Set(rows)].sort((a, b) => a - b);
  const sortedColumns = [...new Set(columns)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (const [left, right] of runs(sortedColumns)) {
    for (const [top, bottom] of runs(sortedRows)) parts.push(rangeName({ top, bottom, left, right }));
  }
  return parts.join(',');
}

export interface ChartSeries {
  name: string;
  values: (number | null)[];
}

export interface ChartData {
  /** One label per point along the category axis. */
  categories: string[];
  series: ChartSeries[];
}

function label(value: CellValue): string {
  if (value === null) return '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return String(value);
}

function numeric(value: CellValue): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && !isError(value) && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

/**
 * The series a range holds, read column by column: with headers, the first
 * column is the categories and the first row names each series; without, the
 * points are simply numbered. A single column becomes one series either way,
 * which is what someone selecting one column of numbers expects to see.
 */
export function chartData(
  ranges: CellRange | CellRange[],
  headers: boolean,
  valueAt: (row: number, column: number) => CellValue,
): ChartData {
  const { rows, columns } = chartLines(Array.isArray(ranges) ? ranges : [ranges]);
  const hasCategoryColumn = headers && columns.length > 1;
  const dataRows = headers ? rows.slice(1) : rows;
  const seriesColumns = hasCategoryColumn ? columns.slice(1) : columns;

  const categories = dataRows.map((row, index) =>
    hasCategoryColumn ? label(valueAt(row, columns[0])) : String(index + 1),
  );

  const series: ChartSeries[] = seriesColumns.map((column, index) => {
    const name = headers && rows.length > 1 ? label(valueAt(rows[0], column)) : '';
    return { name: name || `Series ${index + 1}`, values: dataRows.map((row) => numeric(valueAt(row, column))) };
  });

  return { categories, series };
}

/** Colours that read on both the light and the dark theme. */
export const CHART_COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#06b6d4', '#a855f7', '#84cc16', '#ec4899'];
