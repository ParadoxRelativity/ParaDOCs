import * as Y from 'yjs';
import {
  MAIN_SHEET_ID,
  SHEET_INFO,
  renameSheetReferences,
  sheetMapName,
} from '@paradocs/shared';
import { randomId } from './util';
import type { ImportedSheet, ImportedWorkbook } from './xlsx';

/**
 * Getting an imported file into a spreadsheet.
 *
 * The file is read before the spreadsheet exists, and its grid does not exist
 * until the spreadsheet is opened, so the contents wait here in between. The
 * editor claims them once, as it opens — the same handoff a new document uses
 * to know it should select its title.
 */
const pending = new Map<string, ImportedWorkbook>();

export function rememberImport(spreadsheetId: string, workbook: ImportedWorkbook): void {
  pending.set(spreadsheetId, workbook);
}

/** The file waiting for this spreadsheet, once; null when there is none. */
export function claimImport(spreadsheetId: string): ImportedWorkbook | null {
  const workbook = pending.get(spreadsheetId) ?? null;
  pending.delete(spreadsheetId);
  return workbook;
}

/**
 * Writes imported sheets into a spreadsheet's Y.Doc in one transaction.
 *
 * A sheet whose name had to change to be valid here still has formulas on other
 * sheets that call it by its old name, so those are rewritten to the new one
 * before anything is stored.
 */
export function applyImport(ydoc: Y.Doc, sheets: ImportedSheet[]): void {
  const renamed = sheets.filter((sheet) => sheet.name !== sheet.originalName);

  ydoc.transact(() => {
    const info = ydoc.getMap<unknown>(SHEET_INFO);
    sheets.forEach((sheet, index) => {
      const id = index === 0 ? MAIN_SHEET_ID : randomId();

      const entry = new Y.Map<unknown>();
      entry.set('name', sheet.name);
      entry.set('order', index);
      info.set(id, entry);

      const cells = ydoc.getMap<string>(sheetMapName('cells', id));
      for (const [key, raw] of Object.entries(sheet.cells)) {
        let input = raw;
        for (const change of renamed) input = renameSheetReferences(input, change.originalName, change.name) ?? input;
        cells.set(key, input);
      }

      const formats = ydoc.getMap<unknown>(sheetMapName('formats', id));
      for (const [key, style] of Object.entries(sheet.styles)) formats.set(key, style);

      const meta = ydoc.getMap<unknown>(sheetMapName('meta', id));
      meta.set('rows', sheet.rows);
      meta.set('columns', sheet.columns);
      if (Object.keys(sheet.columnWidths).length > 0) meta.set('columnWidths', sheet.columnWidths);
    });
  });
}
