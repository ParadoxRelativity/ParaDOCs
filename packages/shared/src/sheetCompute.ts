import { dependencies, parseFormula, type Node } from './formula.js';
import { evaluate, type EvalContext } from './formulaEval.js';
import {
  ERRORS,
  MAIN_SHEET_ID,
  DEFAULT_SHEET_NAME,
  cellKey,
  parseCellKey,
  parseInput,
  type CellValue,
} from './sheet.js';

/**
 * Working out what every cell holds, across every sheet of a spreadsheet.
 *
 * A sheet stores only what people typed, so the values have to be derived, and
 * they have to be derived in dependency order: a cell that reads another must
 * wait for it. That is a topological sort, and the thing a topological sort
 * tells you for free is which cells are in a cycle — they are the ones it can
 * never reach. So the cycle detection is not a separate pass, it is the
 * leftovers, which is both cheaper and harder to get wrong than walking the
 * graph again looking for one.
 *
 * The sort runs over the whole workbook at once rather than sheet by sheet. A
 * formula on one sheet can read another, and a cycle can run through several;
 * sorting each sheet alone would get the order wrong for the first and miss the
 * second entirely.
 *
 * Everything is recomputed on every change rather than only the cells
 * downstream of the edit. For spreadsheets of the size this holds that is a
 * millisecond or two, and it cannot drift out of step with the truth, which an
 * incremental path can.
 */

export interface WorkbookSheetInput {
  id: string;
  name: string;
  /** What is stored: the text of each non-empty cell, keyed "A1". */
  raw: Map<string, string>;
}

export interface ComputedWorkbook {
  /** Every non-empty cell's value, by sheet id and then "A1". */
  values: Map<string, Map<string, CellValue>>;
  /** Parsed formulas, by sheet id and then "A1". */
  formulas: Map<string, Map<string, Node>>;
}

export interface ComputedSheet {
  values: Map<string, CellValue>;
  formulas: Map<string, Node>;
}

interface Entry {
  /** Unique across the workbook: "<sheet id>!A1". */
  id: string;
  sheetId: string;
  key: string;
  formula: Node | null;
  literal: CellValue;
}

const entryId = (sheetId: string, key: string) => `${sheetId}!${key}`;

/** `now` fixes the clock, so every TODAY() in one pass agrees. */
export function computeWorkbook(sheets: WorkbookSheetInput[], now: Date = new Date()): ComputedWorkbook {
  const byName = new Map(sheets.map((sheet) => [sheet.name.toLowerCase(), sheet.id]));
  const entries = new Map<string, Entry>();
  const values = new Map<string, Map<string, CellValue>>();
  const formulas = new Map<string, Map<string, Node>>();

  for (const sheet of sheets) {
    values.set(sheet.id, new Map());
    formulas.set(sheet.id, new Map());
    for (const [key, text] of sheet.raw) {
      if (!parseCellKey(key)) continue;
      const parsed = parseInput(text);
      const id = entryId(sheet.id, key);
      if (parsed.kind === 'literal') {
        entries.set(id, { id, sheetId: sheet.id, key, formula: null, literal: parsed.value });
        continue;
      }
      const tree = parseFormula(parsed.source);
      if (!tree) {
        entries.set(id, { id, sheetId: sheet.id, key, formula: null, literal: ERRORS.parse });
        continue;
      }
      entries.set(id, { id, sheetId: sheet.id, key, formula: tree, literal: null });
      formulas.get(sheet.id)!.set(key, tree);
    }
  }

  for (const entry of entries.values()) {
    if (!entry.formula) values.get(entry.sheetId)!.set(entry.key, entry.literal);
  }

  // Who feeds whom. Only edges between cells that actually hold a formula
  // matter; a formula reading an empty cell simply reads a blank, and one
  // reading a sheet that does not exist gets #REF! when it is evaluated.
  const needs = new Map<string, Set<string>>();
  const feeds = new Map<string, Set<string>>();
  for (const entry of entries.values()) {
    if (!entry.formula) continue;
    const required = new Set<string>();
    for (const dependency of dependencies(entry.formula)) {
      const sheetId = dependency.sheet === null ? entry.sheetId : byName.get(dependency.sheet.toLowerCase());
      if (!sheetId) continue;
      const source = entryId(sheetId, cellKey(dependency.row, dependency.column));
      if (!entries.get(source)?.formula) continue;
      required.add(source);
      const dependents = feeds.get(source) ?? new Set<string>();
      dependents.add(entry.id);
      feeds.set(source, dependents);
    }
    needs.set(entry.id, required);
  }

  // Kahn's algorithm: everything whose inputs are all settled, in waves.
  const remaining = new Map<string, number>();
  const ready: string[] = [];
  for (const [id, required] of needs) {
    remaining.set(id, required.size);
    if (required.size === 0) ready.push(id);
  }

  const settled = new Set<string>();
  while (ready.length > 0) {
    const id = ready.pop()!;
    settled.add(id);
    const entry = entries.get(id)!;
    const context: EvalContext = {
      now,
      hasSheet: (name) => byName.has(name.toLowerCase()),
      cell: (row, column, sheet) => {
        const sheetId = sheet === null ? entry.sheetId : byName.get(sheet.toLowerCase());
        return sheetId ? (values.get(sheetId)?.get(cellKey(row, column)) ?? null) : null;
      },
    };
    const result = evaluate(entry.formula!, context);
    // A formula that lands on a whole range takes its first value, which is
    // what a spreadsheet without array formulas does.
    values.get(entry.sheetId)!.set(entry.key, Array.isArray(result) ? (result[0] ?? null) : result);

    for (const dependent of feeds.get(id) ?? []) {
      const left = (remaining.get(dependent) ?? 1) - 1;
      remaining.set(dependent, left);
      if (left === 0) ready.push(dependent);
    }
  }

  // Whatever the sort could not reach is in a cycle, or downstream of one.
  for (const id of needs.keys()) {
    if (!settled.has(id)) {
      const entry = entries.get(id)!;
      values.get(entry.sheetId)!.set(entry.key, ERRORS.cycle);
    }
  }

  return { values, formulas };
}

/** A spreadsheet with a single sheet, for callers that have only one. */
export function computeSheet(raw: Map<string, string>, now: Date = new Date()): ComputedSheet {
  const workbook = computeWorkbook([{ id: MAIN_SHEET_ID, name: DEFAULT_SHEET_NAME, raw }], now);
  return { values: workbook.values.get(MAIN_SHEET_ID)!, formulas: workbook.formulas.get(MAIN_SHEET_ID)! };
}
