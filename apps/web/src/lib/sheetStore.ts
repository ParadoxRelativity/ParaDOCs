import { useCallback, useEffect, useMemo, useState } from 'react';
import * as Y from 'yjs';
import {
  DEFAULT_META,
  DEFAULT_SHEET_NAME,
  MAIN_SHEET_ID,
  MAX_COLUMNS,
  MAX_ROWS,
  SHEET_INFO,
  cellKey,
  computeWorkbook,
  dropSheetReferences,
  nextSheetName,
  parseCellKey,
  renameSheetReferences,
  sheetMapName,
  sheetNameProblem,
  shiftChartRange,
  shiftReferences,
  type CellRange,
  type SheetChart,
  type CellStyle,
  type CellValue,
  type SheetInfo,
  type SheetMeta,
} from '@paradocs/shared';

/**
 * React's view of a spreadsheet's Y.Doc: every sheet in it, and one of them
 * brought forward for the grid to draw.
 *
 * Each sheet keeps three maps rather than one object: its cells' text, its
 * cells' styles, and its own shape each change for different reasons and by
 * different people, and keeping them apart is what stops formatting a column
 * from colliding with someone typing in it. The first sheet's maps keep the
 * names a single-sheet spreadsheet always used, so older spreadsheets are
 * simply workbooks with one sheet.
 *
 * The whole workbook is re-read and recomputed on every change. A formula on
 * one sheet can read another, so recomputing only the sheet on screen would
 * leave it showing stale numbers the moment someone edited a sheet it depends
 * on. For spreadsheets of this size that is still a millisecond or two.
 */

interface SheetSnapshot extends SheetInfo {
  raw: Map<string, string>;
  styles: Map<string, CellStyle>;
  meta: SheetMeta;
  charts: SheetChart[];
}

/** The sheets in their tab order. A spreadsheet with no list has one sheet. */
function readSheets(ydoc: Y.Doc): SheetInfo[] {
  const sheets: SheetInfo[] = [];
  ydoc.getMap<unknown>(SHEET_INFO).forEach((value, id) => {
    if (!(value instanceof Y.Map)) return;
    sheets.push({ id, name: String(value.get('name') ?? id), order: Number(value.get('order') ?? 0) });
  });
  if (sheets.length === 0) return [{ id: MAIN_SHEET_ID, name: DEFAULT_SHEET_NAME, order: 0 }];
  return sheets.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

function readSnapshot(ydoc: Y.Doc): SheetSnapshot[] {
  return readSheets(ydoc).map((sheet) => {
    const raw = new Map<string, string>();
    ydoc.getMap<string>(sheetMapName('cells', sheet.id)).forEach((value, key) => {
      if (typeof value === 'string' && value !== '') raw.set(key, value);
    });
    const styles = new Map<string, CellStyle>();
    ydoc.getMap<CellStyle>(sheetMapName('formats', sheet.id)).forEach((value, key) => {
      if (value && typeof value === 'object') styles.set(key, value);
    });
    const stored = ydoc.getMap<unknown>(sheetMapName('meta', sheet.id)).toJSON() as Partial<SheetMeta>;
    const meta: SheetMeta = {
      rows: clamp(stored.rows ?? DEFAULT_META.rows, 1, MAX_ROWS),
      columns: clamp(stored.columns ?? DEFAULT_META.columns, 1, MAX_COLUMNS),
      columnWidths: stored.columnWidths ?? {},
      frozenRows: stored.frozenRows ?? 0,
      frozenColumns: stored.frozenColumns ?? 0,
    };
    const charts: SheetChart[] = [];
    ydoc.getMap<SheetChart>(sheetMapName('charts', sheet.id)).forEach((value) => {
      if (value && typeof value === 'object' && typeof value.id === 'string') charts.push(value);
    });
    return { ...sheet, raw, styles, meta, charts };
  });
}

export function useSheet(ydoc: Y.Doc, requestedSheetId: string) {
  // Any change anywhere re-reads the workbook; see the note above for why.
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion((n) => n + 1);
    ydoc.on('update', bump);
    return () => ydoc.off('update', bump);
  }, [ydoc]);

  const snapshot = useMemo(() => readSnapshot(ydoc), [ydoc, version]);
  const computed = useMemo(
    () => computeWorkbook(snapshot.map((sheet) => ({ id: sheet.id, name: sheet.name, raw: sheet.raw }))),
    [snapshot],
  );

  // The sheet asked for may have been deleted by someone else in the meantime;
  // the first sheet stands in rather than the grid drawing nothing.
  const current = snapshot.find((sheet) => sheet.id === requestedSheetId) ?? snapshot[0];
  const sheetId = current.id;
  const cells = useMemo(() => ydoc.getMap<string>(sheetMapName('cells', sheetId)), [ydoc, sheetId]);
  const formats = useMemo(() => ydoc.getMap<CellStyle>(sheetMapName('formats', sheetId)), [ydoc, sheetId]);
  const meta = useMemo(() => ydoc.getMap<unknown>(sheetMapName('meta', sheetId)), [ydoc, sheetId]);
  const chartMap = useMemo(() => ydoc.getMap<SheetChart>(sheetMapName('charts', sheetId)), [ydoc, sheetId]);

  const values = computed.values.get(sheetId) ?? new Map<string, CellValue>();
  const raw = current.raw;
  const styles = current.styles;
  const shape = current.meta;

  const value = useCallback(
    (row: number, column: number): CellValue => values.get(cellKey(row, column)) ?? null,
    [values],
  );
  const text = useCallback((row: number, column: number): string => raw.get(cellKey(row, column)) ?? '', [raw]);
  const style = useCallback(
    (row: number, column: number): CellStyle | undefined => styles.get(cellKey(row, column)),
    [styles],
  );

  // --- the sheets themselves ------------------------------------------------

  /**
   * The first time a second sheet is added, the implicit first sheet has to be
   * written into the list too, or it would vanish from the tabs the moment the
   * list stopped being empty.
   */
  const ensureListed = useCallback(() => {
    const info = ydoc.getMap<unknown>(SHEET_INFO);
    if (info.size > 0) return;
    const main = new Y.Map<unknown>();
    main.set('name', DEFAULT_SHEET_NAME);
    main.set('order', 0);
    info.set(MAIN_SHEET_ID, main);
  }, [ydoc]);

  /** Rewrites every formula in the workbook through `change`, in the current transaction. */
  const rewriteFormulas = useCallback(
    (change: (input: string, homeSheet: string) => string | null, except?: string) => {
      for (const sheet of readSheets(ydoc)) {
        if (sheet.id === except) continue;
        const map = ydoc.getMap<string>(sheetMapName('cells', sheet.id));
        const updates: [string, string][] = [];
        map.forEach((input, key) => {
          if (typeof input !== 'string') return;
          const next = change(input, sheet.name);
          if (next !== null) updates.push([key, next]);
        });
        for (const [key, next] of updates) map.set(key, next);
      }
    },
    [ydoc],
  );

  /** Adds a sheet after the last one and returns its id. */
  const addSheet = useCallback((): string => {
    const id = crypto.randomUUID();
    ydoc.transact(() => {
      ensureListed();
      const existing = readSheets(ydoc);
      const entry = new Y.Map<unknown>();
      entry.set('name', nextSheetName(existing.map((sheet) => sheet.name)));
      entry.set('order', (existing.at(-1)?.order ?? 0) + 1);
      ydoc.getMap<unknown>(SHEET_INFO).set(id, entry);
    });
    return id;
  }, [ensureListed, ydoc]);

  /**
   * Renames a sheet, and every formula that named it follows. Returns why it
   * could not be renamed, or null when it was.
   */
  const renameSheet = useCallback(
    (id: string, name: string): string | null => {
      const sheets = readSheets(ydoc);
      const target = sheets.find((sheet) => sheet.id === id);
      if (!target) return 'That sheet no longer exists.';
      const trimmed = name.trim();
      if (trimmed === target.name) return null;
      const problem = sheetNameProblem(
        trimmed,
        sheets.filter((sheet) => sheet.id !== id).map((sheet) => sheet.name),
      );
      if (problem) return problem;
      ydoc.transact(() => {
        ensureListed();
        (ydoc.getMap<unknown>(SHEET_INFO).get(id) as Y.Map<unknown>).set('name', trimmed);
        rewriteFormulas((input) => renameSheetReferences(input, target.name, trimmed));
      });
      return null;
    },
    [ensureListed, rewriteFormulas, ydoc],
  );

  /**
   * Deletes a sheet and everything on it. Formulas elsewhere that read it show
   * #REF!, which is what a reference to something gone should say rather than
   * quietly reading blanks. The last sheet cannot go.
   */
  const deleteSheet = useCallback(
    (id: string): string | null => {
      const sheets = readSheets(ydoc);
      if (sheets.length <= 1) return 'A spreadsheet needs at least one sheet.';
      const target = sheets.find((sheet) => sheet.id === id);
      if (!target) return null;
      ydoc.transact(() => {
        ensureListed();
        ydoc.getMap<unknown>(SHEET_INFO).delete(id);
        for (const kind of ['cells', 'formats', 'meta', 'charts'] as const) ydoc.getMap(sheetMapName(kind, id)).clear();
        rewriteFormulas((input) => dropSheetReferences(input, target.name), id);
      });
      return null;
    },
    [ensureListed, rewriteFormulas, ydoc],
  );

  /** Moves a sheet's tab to `index` in the tab order. */
  const moveSheet = useCallback(
    (id: string, index: number) => {
      const others = readSheets(ydoc).filter((sheet) => sheet.id !== id);
      const clamped = Math.max(0, Math.min(others.length, index));
      const before = others[clamped - 1]?.order;
      const after = others[clamped]?.order;
      // A position between its new neighbours, so nobody else's tab moves.
      const order =
        before === undefined ? (after ?? 0) - 1 : after === undefined ? before + 1 : (before + after) / 2;
      ydoc.transact(() => {
        ensureListed();
        (ydoc.getMap<unknown>(SHEET_INFO).get(id) as Y.Map<unknown> | undefined)?.set('order', order);
      });
    },
    [ensureListed, ydoc],
  );

  // --- cells on the sheet in front --------------------------------------------

  /** Writes one cell. An empty string removes it, so blanks cost nothing. */
  const setCell = useCallback(
    (row: number, column: number, input: string) => {
      const key = cellKey(row, column);
      ydoc.transact(() => {
        if (input === '') cells.delete(key);
        else cells.set(key, input);
      });
    },
    [cells, ydoc],
  );

  /** A block of cells in one transaction, so a paste is one undoable change. */
  const setCells = useCallback(
    (entries: { row: number; column: number; input: string }[]) => {
      ydoc.transact(() => {
        for (const { row, column, input } of entries) {
          const key = cellKey(row, column);
          if (input === '') cells.delete(key);
          else cells.set(key, input);
        }
      });
    },
    [cells, ydoc],
  );

  const clearRange = useCallback(
    (range: CellRange) => {
      ydoc.transact(() => {
        for (let row = range.top; row <= range.bottom; row++) {
          for (let column = range.left; column <= range.right; column++) cells.delete(cellKey(row, column));
        }
      });
    },
    [cells, ydoc],
  );

  /** Merges style onto every cell in a range; an undefined field clears it. */
  const styleRange = useCallback(
    (range: CellRange, patch: CellStyle) => {
      ydoc.transact(() => {
        for (let row = range.top; row <= range.bottom; row++) {
          for (let column = range.left; column <= range.right; column++) {
            const key = cellKey(row, column);
            const next: CellStyle = { ...(formats.get(key) ?? {}), ...patch };
            for (const field of Object.keys(next) as (keyof CellStyle)[]) {
              if (next[field] === undefined) delete next[field];
            }
            if (Object.keys(next).length === 0) formats.delete(key);
            else formats.set(key, next);
          }
        }
      });
    },
    [formats, ydoc],
  );

  const setMeta = useCallback(
    (patch: Partial<SheetMeta>) => {
      ydoc.transact(() => {
        for (const [key, entry] of Object.entries(patch)) {
          if (entry !== undefined) meta.set(key, entry);
        }
      });
    },
    [meta, ydoc],
  );

  const setColumnWidth = useCallback(
    (column: number, width: number) => {
      ydoc.transact(() => {
        const widths = { ...((meta.get('columnWidths') as Record<number, number>) ?? {}) };
        widths[column] = Math.round(width);
        meta.set('columnWidths', widths);
      });
    },
    [meta, ydoc],
  );

  /**
   * Inserts (`count` > 0) or removes (`count` < 0) rows or columns at `at` on
   * the sheet in front.
   *
   * The cells past the cut move, and every formula in the workbook that points
   * at this sheet is rewritten to keep pointing at the same data: a SUM over a
   * column stretches when a row goes into the middle of it, and a reference to
   * a removed cell becomes #REF! rather than silently reading its neighbour.
   * A formula is only reprinted if one of its references actually moved, so
   * the ones that did not keep exactly the text they were typed with.
   */
  const spliceLine = useCallback(
    (axis: 'row' | 'column', at: number, count: number) => {
      if (count === 0) return;
      const change = { sheet: current.name, axis, at, count };

      const entries: { row: number; column: number; input: string }[] = [];
      cells.forEach((input, key) => {
        const ref = parseCellKey(key);
        if (ref && typeof input === 'string') entries.push({ ...ref, input });
      });
      const styleEntries: { row: number; column: number; style: CellStyle }[] = [];
      formats.forEach((entry, key) => {
        const ref = parseCellKey(key);
        if (ref && entry) styleEntries.push({ ...ref, style: entry });
      });

      const moved = (entry: { row: number; column: number }) => {
        const index = axis === 'row' ? entry.row : entry.column;
        if (index < at) return entry;
        // Removing takes the cells in the cut with it.
        if (count < 0 && index < at - count) return null;
        const shifted = index + count;
        return axis === 'row' ? { row: shifted, column: entry.column } : { row: entry.row, column: shifted };
      };

      ydoc.transact(() => {
        cells.clear();
        for (const entry of entries) {
          const target = moved(entry);
          if (!target) continue;
          const input = shiftReferences(entry.input, current.name, change) ?? entry.input;
          cells.set(cellKey(target.row, target.column), input);
        }
        formats.clear();
        for (const entry of styleEntries) {
          const target = moved(entry);
          if (target) formats.set(cellKey(target.row, target.column), entry.style);
        }
        const size = axis === 'row' ? 'rows' : 'columns';
        const limit = axis === 'row' ? MAX_ROWS : MAX_COLUMNS;
        const currentSize = Number(meta.get(size) ?? DEFAULT_META[size]);
        meta.set(size, clamp(currentSize + count, 1, limit));
        // Formulas on the other sheets that read this one.
        rewriteFormulas((input, homeSheet) => shiftReferences(input, homeSheet, change), sheetId);
        // A chart's range is a reference too, and follows its data the same way.
        chartMap.forEach((chart, id) => {
          const range = shiftChartRange(chart.range, current.name, change);
          if (range !== null) chartMap.set(id, { ...chart, range });
        });
      });
    },
    [cells, chartMap, current.name, formats, meta, rewriteFormulas, sheetId, ydoc],
  );

  // --- charts on the sheet in front -------------------------------------------

  /** Adds a chart and returns its id. */
  const addChart = useCallback(
    (chart: Omit<SheetChart, 'id'>): string => {
      const id = crypto.randomUUID();
      ydoc.transact(() => chartMap.set(id, { ...chart, id }));
      return id;
    },
    [chartMap, ydoc],
  );

  const updateChart = useCallback(
    (id: string, patch: Partial<SheetChart>) => {
      const existing = chartMap.get(id);
      if (!existing) return;
      ydoc.transact(() => chartMap.set(id, { ...existing, ...patch, id }));
    },
    [chartMap, ydoc],
  );

  const deleteChart = useCallback(
    (id: string) => {
      ydoc.transact(() => chartMap.delete(id));
    },
    [chartMap, ydoc],
  );

  /**
   * Sorts a range's rows by one of its columns, carrying whole rows along.
   *
   * Formatting travels with the row, not with the cell. A column of money that
   * stayed behind while its numbers moved would leave the wrong ones wearing
   * the currency, which looks like the sort corrupted the data.
   */
  const sortRange = useCallback(
    (range: CellRange, column: number, direction: 'asc' | 'desc') => {
      const rows: { values: string[]; styles: (CellStyle | undefined)[]; sortBy: CellValue }[] = [];
      for (let row = range.top; row <= range.bottom; row++) {
        const line: string[] = [];
        const lineStyles: (CellStyle | undefined)[] = [];
        for (let c = range.left; c <= range.right; c++) {
          line.push(raw.get(cellKey(row, c)) ?? '');
          lineStyles.push(styles.get(cellKey(row, c)));
        }
        rows.push({ values: line, styles: lineStyles, sortBy: values.get(cellKey(row, column)) ?? null });
      }

      const order = direction === 'asc' ? 1 : -1;
      rows.sort((a, b) => {
        const x = a.sortBy;
        const y = b.sortBy;
        // Blanks always sink, whichever way the sort runs: an empty cell is
        // missing data, not the smallest value.
        if (x === null || x === '') return y === null || y === '' ? 0 : 1;
        if (y === null || y === '') return -1;
        if (typeof x === 'number' && typeof y === 'number') return (x - y) * order;
        return String(x).localeCompare(String(y)) * order;
      });

      ydoc.transact(() => {
        rows.forEach((line, index) => {
          const row = range.top + index;
          line.values.forEach((input, offset) => {
            const key = cellKey(row, range.left + offset);
            if (input === '') cells.delete(key);
            else cells.set(key, input);
            const entry = line.styles[offset];
            if (entry) formats.set(key, entry);
            else formats.delete(key);
          });
        });
      });
    },
    [cells, formats, raw, styles, values, ydoc],
  );

  return {
    /** Every sheet, in tab order. */
    sheets: snapshot.map(({ id, name, order }) => ({ id, name, order })),
    /** The sheet the grid is drawing, which may differ from the one asked for. */
    sheetId,
    sheetName: current.name,
    /** Computed values for any sheet, for charts and export. */
    workbookValues: computed.values,
    /** What was typed on every sheet, for export. */
    workbookRaw: new Map(snapshot.map((sheet) => [sheet.id, sheet.raw])),
    workbookStyles: new Map(snapshot.map((sheet) => [sheet.id, sheet.styles])),
    workbookMeta: new Map(snapshot.map((sheet) => [sheet.id, sheet.meta])),
    charts: current.charts,
    addChart,
    updateChart,
    deleteChart,
    shape,
    raw,
    values,
    value,
    text,
    style,
    setCell,
    setCells,
    clearRange,
    styleRange,
    setMeta,
    setColumnWidth,
    spliceLine,
    sortRange,
    addSheet,
    renameSheet,
    deleteSheet,
    moveSheet,
  };
}

export type SheetStore = ReturnType<typeof useSheet>;

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, Math.round(value)));
}
