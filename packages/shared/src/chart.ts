import { parseFormula, shiftReferences, type LineChange } from './formula.js';
import { isError, type CellRange, type CellValue } from './sheet.js';

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
  /** The data, as typed: "A1:C10", on the chart's own sheet. "#REF!" once it was deleted. */
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

/**
 * The range a chart's text names, or null when it no longer names one — after
 * the rows it covered were deleted, say. Only a range on the chart's own sheet
 * counts; a chart draws the data beside it.
 */
export function parseChartRange(text: string): CellRange | null {
  const tree = parseFormula(text.trim());
  if (!tree) return null;
  if (tree.type === 'range' && tree.sheet === null) return tree.range;
  if (tree.type === 'ref' && tree.sheet === null) {
    return { top: tree.ref.row, bottom: tree.ref.row, left: tree.ref.column, right: tree.ref.column };
  }
  return null;
}

/** A chart's range after rows or columns move on its sheet, or null when nothing moved. */
export function shiftChartRange(range: string, sheetName: string, change: LineChange): string | null {
  const next = shiftReferences(`=${range}`, sheetName, change);
  return next === null ? null : next.slice(1);
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
  range: CellRange,
  headers: boolean,
  valueAt: (row: number, column: number) => CellValue,
): ChartData {
  const width = range.right - range.left + 1;
  const height = range.bottom - range.top + 1;
  const hasCategoryColumn = headers && width > 1;
  const firstDataRow = headers ? range.top + 1 : range.top;
  const firstSeriesColumn = hasCategoryColumn ? range.left + 1 : range.left;

  const categories: string[] = [];
  for (let row = firstDataRow; row <= range.bottom; row++) {
    categories.push(hasCategoryColumn ? label(valueAt(row, range.left)) : String(row - firstDataRow + 1));
  }

  const series: ChartSeries[] = [];
  for (let column = firstSeriesColumn; column <= range.right; column++) {
    const values: (number | null)[] = [];
    for (let row = firstDataRow; row <= range.bottom; row++) values.push(numeric(valueAt(row, column)));
    const name = headers && height > 1 ? label(valueAt(range.top, column)) : `Series ${series.length + 1}`;
    series.push({ name: name || `Series ${series.length + 1}`, values });
  }

  return { categories, series };
}

/** Colours that read on both the light and the dark theme. */
export const CHART_COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#06b6d4', '#a855f7', '#84cc16', '#ec4899'];
