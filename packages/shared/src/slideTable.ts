/**
 * Table structure edits, as pure functions from a table to the properties that
 * change, so the editor applies each as one patch and the rules (what a merge
 * covers, what deleting a row does to a span) are tested away from the UI.
 */

import { tableCellKey, type TableCell, type TableElement } from './slides.js';

type Structure = Pick<TableElement, 'rows' | 'columns' | 'cells' | 'columnWidths' | 'rowHeights'>;

export const MAX_TABLE_ROWS = 50;
export const MAX_TABLE_COLUMNS = 20;

export interface TableCellRange {
  row: number;
  column: number;
  rows: number;
  columns: number;
}

/** The smallest range that holds both cells, and every merged cell it cuts through. */
export function cellRange(table: Structure, a: { row: number; column: number }, b: { row: number; column: number }): TableCellRange {
  let top = Math.min(a.row, b.row);
  let left = Math.min(a.column, b.column);
  let bottom = Math.max(a.row, b.row);
  let right = Math.max(a.column, b.column);
  // Growing to swallow a merge can reach another, so repeat until nothing moves.
  for (let again = true; again; ) {
    again = false;
    for (const [key, cell] of Object.entries(table.cells)) {
      const [r, c] = key.split(':').map(Number);
      const r2 = r + (cell.rowSpan ?? 1) - 1;
      const c2 = c + (cell.colSpan ?? 1) - 1;
      if (r > bottom || r2 < top || c > right || c2 < left) continue;
      if (r < top || c < left || r2 > bottom || c2 > right) {
        top = Math.min(top, r);
        left = Math.min(left, c);
        bottom = Math.max(bottom, r2);
        right = Math.max(right, c2);
        again = true;
      }
    }
  }
  return { row: top, column: left, rows: bottom - top + 1, columns: right - left + 1 };
}

/** Keys of cells hidden under another cell's merge. */
export function coveredCells(table: Pick<TableElement, 'cells'>): Set<string> {
  const covered = new Set<string>();
  for (const [key, cell] of Object.entries(table.cells)) {
    const rowSpan = cell.rowSpan ?? 1;
    const colSpan = cell.colSpan ?? 1;
    if (rowSpan === 1 && colSpan === 1) continue;
    const [r, c] = key.split(':').map(Number);
    for (let dr = 0; dr < rowSpan; dr++) for (let dc = 0; dc < colSpan; dc++) if (dr || dc) covered.add(tableCellKey(r + dr, c + dc));
  }
  return covered;
}

/** The merged cell a cell belongs to (the cell itself when it is not merged): its key and the cell. */
export function anchorOf(table: Pick<TableElement, 'cells'>, row: number, column: number): { key: string; row: number; column: number } {
  for (const [key, cell] of Object.entries(table.cells)) {
    const [r, c] = key.split(':').map(Number);
    if (row >= r && row < r + (cell.rowSpan ?? 1) && column >= c && column < c + (cell.colSpan ?? 1)) return { key, row: r, column: c };
  }
  return { key: tableCellKey(row, column), row, column };
}

function evenly(count: number): number[] {
  return Array.from({ length: count }, () => 1);
}

/** Row or column weights, one per line, as the table has them or evenly. */
export function weightsOf(weights: number[] | undefined, count: number): number[] {
  return weights && weights.length === count && weights.every((w) => w > 0) ? weights : evenly(count);
}

function shifted(cells: Record<string, TableCell>, move: (row: number, column: number, cell: TableCell) => [number, number, TableCell] | null) {
  const next: Record<string, TableCell> = {};
  for (const [key, cell] of Object.entries(cells)) {
    const [r, c] = key.split(':').map(Number);
    const moved = move(r, c, cell);
    if (moved) next[tableCellKey(moved[0], moved[1])] = moved[2];
  }
  return next;
}

function withSpan(cell: TableCell, rowSpan: number, colSpan: number): TableCell {
  const { rowSpan: _r, colSpan: _c, ...rest } = cell;
  return { ...rest, ...(rowSpan > 1 ? { rowSpan } : {}), ...(colSpan > 1 ? { colSpan } : {}) };
}

/** Adds an empty row so it becomes row `at` (0 to rows). A merge it cuts through grows to include it. */
export function insertRow(table: Structure, at: number): Structure {
  const row = Math.min(Math.max(at, 0), table.rows);
  const heights = weightsOf(table.rowHeights, table.rows);
  return {
    rows: table.rows + 1,
    columns: table.columns,
    rowHeights: [...heights.slice(0, row), heights[Math.min(row, heights.length - 1)] ?? 1, ...heights.slice(row)],
    columnWidths: table.columnWidths,
    cells: shifted(table.cells, (r, c, cell) => {
      const span = cell.rowSpan ?? 1;
      if (r >= row) return [r + 1, c, cell];
      return [r, c, r + span > row ? withSpan(cell, span + 1, cell.colSpan ?? 1) : cell];
    }),
  };
}

/** Removes row `at`. A merge that started in it now starts in the row below, one row shorter. */
export function deleteRow(table: Structure, at: number): Structure {
  if (table.rows <= 1 || at < 0 || at >= table.rows) return table;
  const heights = weightsOf(table.rowHeights, table.rows);
  return {
    rows: table.rows - 1,
    columns: table.columns,
    rowHeights: heights.filter((_, i) => i !== at),
    columnWidths: table.columnWidths,
    cells: shifted(table.cells, (r, c, cell) => {
      const span = cell.rowSpan ?? 1;
      if (r === at) return span > 1 ? [r, c, withSpan(cell, span - 1, cell.colSpan ?? 1)] : null;
      if (r > at) return [r - 1, c, cell];
      return [r, c, r + span > at ? withSpan(cell, span - 1, cell.colSpan ?? 1) : cell];
    }),
  };
}

export function insertColumn(table: Structure, at: number): Structure {
  const column = Math.min(Math.max(at, 0), table.columns);
  const widths = weightsOf(table.columnWidths, table.columns);
  return {
    rows: table.rows,
    columns: table.columns + 1,
    columnWidths: [...widths.slice(0, column), widths[Math.min(column, widths.length - 1)] ?? 1, ...widths.slice(column)],
    rowHeights: table.rowHeights,
    cells: shifted(table.cells, (r, c, cell) => {
      const span = cell.colSpan ?? 1;
      if (c >= column) return [r, c + 1, cell];
      return [r, c, c + span > column ? withSpan(cell, cell.rowSpan ?? 1, span + 1) : cell];
    }),
  };
}

export function deleteColumn(table: Structure, at: number): Structure {
  if (table.columns <= 1 || at < 0 || at >= table.columns) return table;
  const widths = weightsOf(table.columnWidths, table.columns);
  return {
    rows: table.rows,
    columns: table.columns - 1,
    columnWidths: widths.filter((_, i) => i !== at),
    rowHeights: table.rowHeights,
    cells: shifted(table.cells, (r, c, cell) => {
      const span = cell.colSpan ?? 1;
      if (c === at) return span > 1 ? [r, c, withSpan(cell, cell.rowSpan ?? 1, span - 1)] : null;
      if (c > at) return [r, c - 1, cell];
      return [r, c, c + span > at ? withSpan(cell, cell.rowSpan ?? 1, span - 1) : cell];
    }),
  };
}

/**
 * Merges a range into its top-left cell. The text of the cells it covers is
 * joined into it, a line each, and their own cells are dropped.
 */
export function mergeCells(table: Structure, range: TableCellRange): Structure {
  if (range.rows * range.columns < 2) return table;
  const cells = { ...table.cells };
  const texts: string[] = [];
  let anchor: TableCell = cells[tableCellKey(range.row, range.column)] ?? { text: '' };
  for (let r = range.row; r < range.row + range.rows; r++) {
    for (let c = range.column; c < range.column + range.columns; c++) {
      const key = tableCellKey(r, c);
      const cell = cells[key];
      if (cell?.text) texts.push(cell.text);
      if (r !== range.row || c !== range.column) delete cells[key];
    }
  }
  anchor = withSpan({ ...anchor, text: texts.join('\n') }, range.rows, range.columns);
  cells[tableCellKey(range.row, range.column)] = anchor;
  return { ...table, cells };
}

/** Splits a merged cell back into single cells; the text stays in the top-left one. */
export function unmergeCell(table: Structure, row: number, column: number): Structure {
  const key = tableCellKey(row, column);
  const cell = table.cells[key];
  if (!cell || ((cell.rowSpan ?? 1) === 1 && (cell.colSpan ?? 1) === 1)) return table;
  return { ...table, cells: { ...table.cells, [key]: withSpan(cell, 1, 1) } };
}

/** A new table's cells: `rows` x `columns`, with the first row of text when given. */
export function emptyTable(rows: number, columns: number): Pick<TableElement, 'rows' | 'columns' | 'cells'> {
  return { rows: Math.min(Math.max(rows, 1), MAX_TABLE_ROWS), columns: Math.min(Math.max(columns, 1), MAX_TABLE_COLUMNS), cells: {} };
}
