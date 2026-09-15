import * as Y from 'yjs';
import {
  DEFAULT_SHEET_NAME,
  MAIN_SHEET_ID,
  SHEET_INFO,
  cellKey,
  chartData,
  computeWorkbook,
  formatValue,
  isError,
  parseCellKey,
  parseChartRanges,
  sheetCollabName,
  sheetMapName,
  type CellStyle,
  type CellValue,
  type ComputedWorkbook,
  type ResolvedSheetRef,
  type SheetChart,
  type SheetRef,
} from '@paradocs/shared';
import { query } from '../db/pool.js';
import { liveDocument } from './liveDocuments.js';

/**
 * A spreadsheet read and computed on the server, for anything outside the
 * spreadsheet that wants to show what is in it.
 *
 * The grid a person is editing is read in preference to the saved copy, so a
 * reference refreshed a second after someone typed a number shows that number.
 */

export interface WorkbookSheet {
  id: string;
  name: string;
  order: number;
  raw: Map<string, string>;
  styles: Map<string, CellStyle>;
  charts: SheetChart[];
}

export interface Workbook {
  id: string;
  title: string;
  workspaceId: string;
  sheets: WorkbookSheet[];
  computed: ComputedWorkbook;
}

function readSheets(doc: Y.Doc): WorkbookSheet[] {
  const listed: { id: string; name: string; order: number }[] = [];
  doc.getMap<unknown>(SHEET_INFO).forEach((value, id) => {
    if (!(value instanceof Y.Map)) return;
    listed.push({ id, name: String(value.get('name') ?? id), order: Number(value.get('order') ?? 0) });
  });
  if (listed.length === 0) listed.push({ id: MAIN_SHEET_ID, name: DEFAULT_SHEET_NAME, order: 0 });
  listed.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

  return listed.map((sheet) => {
    const raw = new Map<string, string>();
    doc.getMap<unknown>(sheetMapName('cells', sheet.id)).forEach((value, key) => {
      if (typeof value === 'string' && value !== '') raw.set(key, value);
    });
    const styles = new Map<string, CellStyle>();
    doc.getMap<unknown>(sheetMapName('formats', sheet.id)).forEach((value, key) => {
      if (value && typeof value === 'object') styles.set(key, value as CellStyle);
    });
    const charts: SheetChart[] = [];
    doc.getMap<unknown>(sheetMapName('charts', sheet.id)).forEach((value) => {
      if (value && typeof value === 'object' && typeof (value as SheetChart).id === 'string') charts.push(value as SheetChart);
    });
    return { ...sheet, raw, styles, charts };
  });
}

export async function loadWorkbook(spreadsheetId: string): Promise<Workbook | null> {
  const { rows } = await query<{ title: string; workspace_id: string; ydoc: Buffer | null }>(
    'SELECT title, workspace_id, ydoc FROM spreadsheets WHERE id = $1',
    [spreadsheetId],
  );
  const row = rows[0];
  if (!row) return null;

  const live = liveDocument(sheetCollabName(spreadsheetId));
  let doc: Y.Doc;
  let throwaway: Y.Doc | null = null;
  if (live) {
    doc = live;
  } else {
    throwaway = new Y.Doc();
    if (row.ydoc) Y.applyUpdate(throwaway, new Uint8Array(row.ydoc));
    doc = throwaway;
  }

  try {
    const sheets = readSheets(doc);
    const computed = computeWorkbook(sheets.map((sheet) => ({ id: sheet.id, name: sheet.name, raw: sheet.raw })));
    return { id: spreadsheetId, title: row.title, workspaceId: row.workspace_id, sheets, computed };
  } finally {
    // Only a copy made here is destroyed; the live document belongs to the
    // people editing it.
    throwaway?.destroy();
  }
}

/** Resolves one reference against a workbook already loaded. */
export function resolveInWorkbook(workbook: Workbook, ref: SheetRef): ResolvedSheetRef {
  const sheet = workbook.sheets.find((entry) => entry.id === ref.sheetId);
  if (!sheet) return { kind: ref.kind, status: 'missing', problem: 'sheet' };
  const values = workbook.computed.values.get(sheet.id) ?? new Map<string, CellValue>();

  if (ref.kind === 'cell') {
    const address = parseCellKey(ref.cell);
    if (!address) return { kind: 'cell', status: 'missing', problem: 'cell' };
    const key = cellKey(address.row, address.column);
    const value = values.get(key) ?? null;
    return {
      kind: 'cell',
      status: 'ok',
      display: formatValue(value, sheet.styles.get(key)),
      spreadsheetTitle: workbook.title,
      sheetName: sheet.name,
      cell: key,
      isError: isError(value),
    };
  }

  const chart = sheet.charts.find((entry) => entry.id === ref.chartId);
  if (!chart) return { kind: 'chart', status: 'missing', problem: 'chart' };
  const range = parseChartRanges(chart.range);
  return {
    kind: 'chart',
    status: 'ok',
    title: chart.title,
    chartKind: chart.kind,
    data: range
      ? chartData(range, chart.headers, (row, column) => values.get(cellKey(row, column)) ?? null)
      : { categories: [], series: [] },
    spreadsheetTitle: workbook.title,
    sheetName: sheet.name,
  };
}
