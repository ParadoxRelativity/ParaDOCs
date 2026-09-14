import { dependencies, parseFormula, type Node } from './formula.js';
import {
  ERRORS,
  EPOCH,
  MS_PER_DAY,
  dateToSerial,
  isError,
  serialToDate,
  type CellRange,
  type CellValue,
  type SheetError,
} from './sheet.js';

/**
 * Evaluating a parsed formula.
 *
 * Values are read through a resolver rather than from a sheet the evaluator
 * owns, so the same engine works for the grid, for a preview of a formula being
 * typed, and for a test. A range evaluates to an array, which only the
 * functions that take ranges know what to do with — arithmetic on one is an
 * error, as it should be.
 */

/** A range flattened in reading order, kept apart from a single value. */
export type EvalValue = CellValue | CellValue[];

export interface EvalContext {
  /**
   * What one cell holds, already computed. `sheet` is the name a reference
   * gave, or null for the sheet the formula is on.
   */
  cell: (row: number, column: number, sheet: string | null) => CellValue;
  /** Whether a named sheet exists; a reference to one that does not is #REF!. */
  hasSheet?: (name: string) => boolean;
  /** Today, so TODAY() and NOW() are stable within one recalculation. */
  now: Date;
}

const { div0, value: valueError, name: nameError, na, num, parse: parseError } = ERRORS;

// --- coercion ---------------------------------------------------------------

function toNumber(value: EvalValue): number | SheetError {
  if (Array.isArray(value)) return valueError;
  if (isError(value)) return value;
  if (value === null || value === '') return 0;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value;
  const parsed = Number(String(value).trim().replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : valueError;
}

function toText(value: EvalValue): string | SheetError {
  if (Array.isArray(value)) return valueError;
  if (isError(value)) return value;
  if (value === null) return '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return String(value);
}

function toBoolean(value: EvalValue): boolean | SheetError {
  if (Array.isArray(value)) return valueError;
  if (isError(value)) return value;
  if (typeof value === 'boolean') return value;
  if (value === null) return false;
  if (typeof value === 'number') return value !== 0;
  const upper = String(value).trim().toUpperCase();
  if (upper === 'TRUE') return true;
  if (upper === 'FALSE' || upper === '') return false;
  return valueError;
}

/** Everything in a range or a single value, as one list. Blanks are kept. */
function flatten(values: EvalValue[]): CellValue[] {
  const out: CellValue[] = [];
  for (const value of values) {
    if (Array.isArray(value)) out.push(...value);
    else out.push(value);
  }
  return out;
}

/** The numbers in a list, ignoring blanks and text the way SUM and AVERAGE do. */
function numbersIn(values: EvalValue[]): number[] | SheetError {
  const out: number[] = [];
  for (const item of flatten(values)) {
    if (isError(item)) return item;
    if (item === null || item === '') continue;
    if (typeof item === 'boolean') continue; // booleans are not counted, as in Excel ranges
    if (typeof item === 'number') {
      out.push(item);
      continue;
    }
    const parsed = Number(String(item).trim());
    if (Number.isFinite(parsed)) out.push(parsed);
  }
  return out;
}

function firstError(values: EvalValue[]): SheetError | null {
  for (const item of flatten(values)) if (isError(item)) return item;
  return null;
}

// --- comparison and criteria -------------------------------------------------

function compare(left: CellValue, right: CellValue): number {
  const leftBlank = left === null || left === '';
  const rightBlank = right === null || right === '';
  if (leftBlank && rightBlank) return 0;
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  if (typeof left === 'boolean' || typeof right === 'boolean') {
    return (left ? 1 : 0) - (right ? 1 : 0);
  }
  const a = String(left ?? '').toLowerCase();
  const b = String(right ?? '').toLowerCase();
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The criteria SUMIF and COUNTIF take: a bare value to match, or a comparison
 * written as text such as ">=10" or "<>done". Wildcards are not supported;
 * they are the one part of the syntax people most often get wrong anyway.
 */
function matches(item: CellValue, criteria: CellValue): boolean {
  if (typeof criteria === 'string') {
    const operator = /^(<=|>=|<>|=|<|>)(.*)$/.exec(criteria.trim());
    if (operator) {
      const [, symbol, rest] = operator;
      const target: CellValue = rest.trim() === '' ? null : (Number.isFinite(Number(rest)) && rest.trim() !== '' ? Number(rest) : rest.trim());
      const order = compare(item, target);
      switch (symbol) {
        case '=':
          return order === 0;
        case '<>':
          return order !== 0;
        case '<':
          return order < 0;
        case '<=':
          return order <= 0;
        case '>':
          return order > 0;
        default:
          return order >= 0;
      }
    }
  }
  return compare(item, criteria) === 0;
}

// --- the function library ----------------------------------------------------

type Fn = (args: EvalValue[], context: EvalContext) => EvalValue;

function numeric(fn: (...numbers: number[]) => number, arity?: number): Fn {
  return (args) => {
    if (arity !== undefined && args.length !== arity) return valueError;
    const numbers: number[] = [];
    for (const argument of args) {
      const number = toNumber(argument);
      if (isError(number)) return number;
      numbers.push(number);
    }
    const result = fn(...numbers);
    return Number.isFinite(result) ? result : num;
  };
}

function aggregate(fn: (numbers: number[]) => number): Fn {
  return (args) => {
    const numbers = numbersIn(args);
    if (isError(numbers)) return numbers;
    if (numbers.length === 0) return div0;
    const result = fn(numbers);
    return Number.isFinite(result) ? result : num;
  };
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 1) return sorted[0];
  const position = fraction * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function variance(numbers: number[], sample: boolean): number {
  const n = numbers.length;
  if (sample && n < 2) return NaN;
  const mean = numbers.reduce((a, b) => a + b, 0) / n;
  const total = numbers.reduce((sum, x) => sum + (x - mean) ** 2, 0);
  return total / (sample ? n - 1 : n);
}

/** Pairs a value range with a criteria range, for the *IF family. */
function conditionalTotals(
  testRange: EvalValue,
  criteria: EvalValue,
  valueRange: EvalValue | undefined,
): { total: number; count: number } | SheetError {
  const tests = Array.isArray(testRange) ? testRange : [testRange];
  const values = valueRange === undefined ? tests : Array.isArray(valueRange) ? valueRange : [valueRange];
  if (isError(criteria)) return criteria;

  let total = 0;
  let count = 0;
  for (let index = 0; index < tests.length; index++) {
    const test = tests[index];
    if (isError(test)) return test;
    if (!matches(test, Array.isArray(criteria) ? (criteria[0] ?? null) : criteria)) continue;
    count++;
    const candidate = values[index];
    if (isError(candidate)) return candidate;
    if (typeof candidate === 'number') total += candidate;
    else if (typeof candidate === 'string' && candidate.trim() !== '' && Number.isFinite(Number(candidate))) {
      total += Number(candidate);
    }
  }
  return { total, count };
}

/** Every (range, criteria) pair in SUMIFS/COUNTIFS, as the rows that satisfy all of them. */
function multiCriteriaRows(pairs: EvalValue[], length: number): number[] | SheetError {
  const rows: number[] = [];
  for (let index = 0; index < length; index++) {
    let ok = true;
    for (let pair = 0; pair + 1 < pairs.length; pair += 2) {
      const range = pairs[pair];
      const criteria = pairs[pair + 1];
      const list = Array.isArray(range) ? range : [range];
      const item = list[index] ?? null;
      if (isError(item)) return item;
      if (isError(criteria)) return criteria;
      if (!matches(item, Array.isArray(criteria) ? (criteria[0] ?? null) : criteria)) {
        ok = false;
        break;
      }
    }
    if (ok) rows.push(index);
  }
  return rows;
}

const FUNCTIONS: Record<string, Fn> = {
  // --- maths ---------------------------------------------------------------
  SUM: (args) => {
    const numbers = numbersIn(args);
    return isError(numbers) ? numbers : numbers.reduce((a, b) => a + b, 0);
  },
  PRODUCT: (args) => {
    const numbers = numbersIn(args);
    if (isError(numbers)) return numbers;
    return numbers.length === 0 ? 0 : numbers.reduce((a, b) => a * b, 1);
  },
  ABS: numeric(Math.abs, 1),
  SQRT: numeric((x) => (x < 0 ? NaN : Math.sqrt(x)), 1),
  POWER: numeric((base, exponent) => base ** exponent, 2),
  EXP: numeric(Math.exp, 1),
  LN: numeric((x) => (x <= 0 ? NaN : Math.log(x)), 1),
  LOG10: numeric((x) => (x <= 0 ? NaN : Math.log10(x)), 1),
  LOG: (args) => {
    const x = toNumber(args[0] ?? null);
    if (isError(x)) return x;
    const base = args.length > 1 ? toNumber(args[1]) : 10;
    if (isError(base)) return base;
    if (x <= 0 || base <= 0 || base === 1) return num;
    return Math.log(x) / Math.log(base);
  },
  MOD: numeric((a, b) => (b === 0 ? NaN : a - b * Math.floor(a / b)), 2),
  INT: numeric(Math.floor, 1),
  SIGN: numeric(Math.sign, 1),
  ROUND: (args) => {
    const x = toNumber(args[0] ?? null);
    if (isError(x)) return x;
    const places = args.length > 1 ? toNumber(args[1]) : 0;
    if (isError(places)) return places;
    const factor = 10 ** places;
    return Math.round((x + Number.EPSILON * Math.sign(x)) * factor) / factor;
  },
  ROUNDUP: (args) => {
    const x = toNumber(args[0] ?? null);
    if (isError(x)) return x;
    const places = args.length > 1 ? toNumber(args[1]) : 0;
    if (isError(places)) return places;
    const factor = 10 ** places;
    return (x < 0 ? -Math.ceil(-x * factor) : Math.ceil(x * factor)) / factor;
  },
  ROUNDDOWN: (args) => {
    const x = toNumber(args[0] ?? null);
    if (isError(x)) return x;
    const places = args.length > 1 ? toNumber(args[1]) : 0;
    if (isError(places)) return places;
    const factor = 10 ** places;
    return (x < 0 ? -Math.floor(-x * factor) : Math.floor(x * factor)) / factor;
  },
  CEILING: numeric((x, step = 1) => (step === 0 ? 0 : Math.ceil(x / step) * step)),
  FLOOR: numeric((x, step = 1) => (step === 0 ? 0 : Math.floor(x / step) * step)),
  RAND: () => Math.random(),
  RANDBETWEEN: numeric((low, high) => Math.floor(Math.random() * (high - low + 1)) + low, 2),
  PI: () => Math.PI,

  // --- statistics ----------------------------------------------------------
  AVERAGE: aggregate((numbers) => numbers.reduce((a, b) => a + b, 0) / numbers.length),
  MEDIAN: aggregate((numbers) => {
    const sorted = [...numbers].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }),
  MIN: aggregate((numbers) => Math.min(...numbers)),
  MAX: aggregate((numbers) => Math.max(...numbers)),
  STDEV: aggregate((numbers) => Math.sqrt(variance(numbers, true))),
  STDEVP: aggregate((numbers) => Math.sqrt(variance(numbers, false))),
  VAR: aggregate((numbers) => variance(numbers, true)),
  VARP: aggregate((numbers) => variance(numbers, false)),
  MODE: aggregate((numbers) => {
    const counts = new Map<number, number>();
    for (const n of numbers) counts.set(n, (counts.get(n) ?? 0) + 1);
    let best = NaN;
    let bestCount = 1;
    for (const [n, count] of counts) {
      if (count > bestCount) {
        best = n;
        bestCount = count;
      }
    }
    return best;
  }),
  PERCENTILE: (args) => {
    const numbers = numbersIn([args[0] ?? null]);
    if (isError(numbers)) return numbers;
    const fraction = toNumber(args[1] ?? null);
    if (isError(fraction)) return fraction;
    if (numbers.length === 0 || fraction < 0 || fraction > 1) return num;
    return percentile([...numbers].sort((a, b) => a - b), fraction);
  },
  QUARTILE: (args) => {
    const numbers = numbersIn([args[0] ?? null]);
    if (isError(numbers)) return numbers;
    const quarter = toNumber(args[1] ?? null);
    if (isError(quarter)) return quarter;
    if (numbers.length === 0 || quarter < 0 || quarter > 4) return num;
    return percentile([...numbers].sort((a, b) => a - b), quarter / 4);
  },
  CORREL: (args) => {
    const xs = numbersIn([args[0] ?? null]);
    const ys = numbersIn([args[1] ?? null]);
    if (isError(xs)) return xs;
    if (isError(ys)) return ys;
    const n = Math.min(xs.length, ys.length);
    if (n < 2) return div0;
    const meanX = xs.slice(0, n).reduce((a, b) => a + b, 0) / n;
    const meanY = ys.slice(0, n).reduce((a, b) => a + b, 0) / n;
    let top = 0;
    let leftSum = 0;
    let rightSum = 0;
    for (let i = 0; i < n; i++) {
      const dx = xs[i] - meanX;
      const dy = ys[i] - meanY;
      top += dx * dy;
      leftSum += dx * dx;
      rightSum += dy * dy;
    }
    const bottom = Math.sqrt(leftSum * rightSum);
    return bottom === 0 ? div0 : top / bottom;
  },
  COUNT: (args) => {
    const numbers = numbersIn(args);
    return isError(numbers) ? numbers : numbers.length;
  },
  COUNTA: (args) => flatten(args).filter((item) => item !== null && item !== '').length,
  COUNTBLANK: (args) => flatten(args).filter((item) => item === null || item === '').length,

  // --- logic ---------------------------------------------------------------
  IF: (args) => {
    const condition = toBoolean(args[0] ?? null);
    if (isError(condition)) return condition;
    if (condition) return args[1] ?? true;
    return args.length > 2 ? args[2] : false;
  },
  IFS: (args) => {
    for (let index = 0; index + 1 < args.length; index += 2) {
      const condition = toBoolean(args[index]);
      if (isError(condition)) return condition;
      if (condition) return args[index + 1];
    }
    return na;
  },
  IFERROR: (args) => {
    const first = args[0] ?? null;
    if (Array.isArray(first)) return first;
    return isError(first) ? (args[1] ?? null) : first;
  },
  IFNA: (args) => (args[0] === na ? (args[1] ?? null) : (args[0] ?? null)),
  AND: (args) => {
    const items = flatten(args);
    for (const item of items) {
      const bool = toBoolean(item);
      if (isError(bool)) return bool;
      if (!bool) return false;
    }
    return items.length > 0;
  },
  OR: (args) => {
    for (const item of flatten(args)) {
      const bool = toBoolean(item);
      if (isError(bool)) return bool;
      if (bool) return true;
    }
    return false;
  },
  XOR: (args) => {
    let count = 0;
    for (const item of flatten(args)) {
      const bool = toBoolean(item);
      if (isError(bool)) return bool;
      if (bool) count++;
    }
    return count % 2 === 1;
  },
  NOT: (args) => {
    const bool = toBoolean(args[0] ?? null);
    return isError(bool) ? bool : !bool;
  },
  TRUE: () => true,
  FALSE: () => false,
  NA: () => na,
  ISERROR: (args) => isError(args[0] ?? null),
  ISBLANK: (args) => (args[0] ?? null) === null,
  ISNUMBER: (args) => typeof args[0] === 'number',
  ISTEXT: (args) => typeof args[0] === 'string' && !isError(args[0]),

  // --- conditional aggregation ---------------------------------------------
  SUMIF: (args) => {
    const result = conditionalTotals(args[0] ?? null, args[1] ?? null, args[2]);
    return isError(result) ? result : result.total;
  },
  COUNTIF: (args) => {
    const result = conditionalTotals(args[0] ?? null, args[1] ?? null, undefined);
    return isError(result) ? result : result.count;
  },
  AVERAGEIF: (args) => {
    const result = conditionalTotals(args[0] ?? null, args[1] ?? null, args[2]);
    if (isError(result)) return result;
    return result.count === 0 ? div0 : result.total / result.count;
  },
  SUMIFS: (args) => {
    const values = Array.isArray(args[0]) ? args[0] : [args[0] ?? null];
    const rows = multiCriteriaRows(args.slice(1), values.length);
    if (isError(rows)) return rows;
    let total = 0;
    for (const row of rows) {
      const item = values[row];
      if (isError(item)) return item;
      if (typeof item === 'number') total += item;
    }
    return total;
  },
  COUNTIFS: (args) => {
    const first = Array.isArray(args[0]) ? args[0] : [args[0] ?? null];
    const rows = multiCriteriaRows(args, first.length);
    return isError(rows) ? rows : rows.length;
  },

  // --- lookup --------------------------------------------------------------
  VLOOKUP: (args, context) => lookup(args, context, 'v'),
  HLOOKUP: (args, context) => lookup(args, context, 'h'),
  MATCH: (args) => {
    const needle = args[0] ?? null;
    const haystack = Array.isArray(args[1]) ? args[1] : [args[1] ?? null];
    const type = args.length > 2 ? toNumber(args[2]) : 1;
    if (isError(type)) return type;
    if (type === 0) {
      const index = haystack.findIndex((item) => compare(item, needle as CellValue) === 0);
      return index === -1 ? na : index + 1;
    }
    // Sorted search: the last value not past the needle (or not before it, for -1).
    let best = -1;
    for (let index = 0; index < haystack.length; index++) {
      const order = compare(haystack[index], needle as CellValue);
      if (type === 1 ? order <= 0 : order >= 0) best = index;
      else break;
    }
    return best === -1 ? na : best + 1;
  },
  INDEX: (args) => {
    const list = Array.isArray(args[0]) ? args[0] : [args[0] ?? null];
    const position = toNumber(args[1] ?? null);
    if (isError(position)) return position;
    const item = list[position - 1];
    return item === undefined ? ERRORS.ref : item;
  },
  CHOOSE: (args) => {
    const position = toNumber(args[0] ?? null);
    if (isError(position)) return position;
    const choice = args[position];
    return choice === undefined ? valueError : choice;
  },

  // --- text ----------------------------------------------------------------
  CONCAT: (args) => {
    let out = '';
    for (const item of flatten(args)) {
      const text = toText(item);
      if (isError(text)) return text;
      out += text;
    }
    return out;
  },
  LEN: (args) => {
    const text = toText(args[0] ?? null);
    return isError(text) ? text : text.length;
  },
  LEFT: (args) => textSlice(args, 'left'),
  RIGHT: (args) => textSlice(args, 'right'),
  MID: (args) => {
    const text = toText(args[0] ?? null);
    if (isError(text)) return text;
    const start = toNumber(args[1] ?? null);
    if (isError(start)) return start;
    const length = toNumber(args[2] ?? null);
    if (isError(length)) return length;
    if (start < 1 || length < 0) return valueError;
    return text.slice(start - 1, start - 1 + length);
  },
  UPPER: (args) => mapText(args, (text) => text.toUpperCase()),
  LOWER: (args) => mapText(args, (text) => text.toLowerCase()),
  PROPER: (args) => mapText(args, (text) => text.replace(/\w\S*/g, (word) => word[0].toUpperCase() + word.slice(1).toLowerCase())),
  TRIM: (args) => mapText(args, (text) => text.trim().replace(/\s+/g, ' ')),
  REPT: (args) => {
    const text = toText(args[0] ?? null);
    if (isError(text)) return text;
    const times = toNumber(args[1] ?? null);
    if (isError(times)) return times;
    if (times < 0 || times * text.length > 32_000) return valueError;
    return text.repeat(Math.floor(times));
  },
  SUBSTITUTE: (args) => {
    const text = toText(args[0] ?? null);
    if (isError(text)) return text;
    const find = toText(args[1] ?? null);
    if (isError(find)) return find;
    const replacement = toText(args[2] ?? null);
    if (isError(replacement)) return replacement;
    return find === '' ? text : text.split(find).join(replacement);
  },
  FIND: (args) => textSearch(args, true),
  SEARCH: (args) => textSearch(args, false),
  VALUE: (args) => {
    const text = toText(args[0] ?? null);
    if (isError(text)) return text;
    const parsed = Number(text.replace(/[,\s$£€¥]/g, ''));
    return Number.isFinite(parsed) ? parsed : valueError;
  },
  TEXT: (args) => {
    const text = toText(args[0] ?? null);
    return isError(text) ? text : text;
  },

  // --- dates ---------------------------------------------------------------
  TODAY: (_args, context) => {
    const now = context.now;
    return dateToSerial(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())));
  },
  NOW: (_args, context) => (context.now.getTime() - EPOCH) / MS_PER_DAY,
  DATE: (args) => {
    const [y, m, d] = args.map(toNumber);
    if (isError(y)) return y;
    if (isError(m)) return m;
    if (isError(d)) return d;
    return dateToSerial(new Date(Date.UTC(y, m - 1, d)));
  },
  YEAR: (args) => datePart(args, (date) => date.getUTCFullYear()),
  MONTH: (args) => datePart(args, (date) => date.getUTCMonth() + 1),
  DAY: (args) => datePart(args, (date) => date.getUTCDate()),
  HOUR: (args) => datePart(args, (date) => date.getUTCHours()),
  MINUTE: (args) => datePart(args, (date) => date.getUTCMinutes()),
  SECOND: (args) => datePart(args, (date) => date.getUTCSeconds()),
  WEEKDAY: (args) => datePart(args, (date) => date.getUTCDay() + 1),
  DAYS: (args) => {
    const end = toNumber(args[0] ?? null);
    if (isError(end)) return end;
    const start = toNumber(args[1] ?? null);
    if (isError(start)) return start;
    return Math.round(end - start);
  },
};

function textSlice(args: EvalValue[], side: 'left' | 'right'): EvalValue {
  const text = toText(args[0] ?? null);
  if (isError(text)) return text;
  const count = args.length > 1 ? toNumber(args[1]) : 1;
  if (isError(count)) return count;
  if (count < 0) return valueError;
  return side === 'left' ? text.slice(0, count) : (count === 0 ? '' : text.slice(-count));
}

function mapText(args: EvalValue[], fn: (text: string) => string): EvalValue {
  const text = toText(args[0] ?? null);
  return isError(text) ? text : fn(text);
}

function textSearch(args: EvalValue[], caseSensitive: boolean): EvalValue {
  const needle = toText(args[0] ?? null);
  if (isError(needle)) return needle;
  const haystack = toText(args[1] ?? null);
  if (isError(haystack)) return haystack;
  const start = args.length > 2 ? toNumber(args[2]) : 1;
  if (isError(start)) return start;
  const index = caseSensitive
    ? haystack.indexOf(needle, start - 1)
    : haystack.toLowerCase().indexOf(needle.toLowerCase(), start - 1);
  return index === -1 ? valueError : index + 1;
}

function datePart(args: EvalValue[], fn: (date: Date) => number): EvalValue {
  const serial = toNumber(args[0] ?? null);
  if (isError(serial)) return serial;
  return fn(serialToDate(serial));
}

/**
 * VLOOKUP and HLOOKUP over a rectangular range.
 *
 * The evaluator flattens a range in reading order, so the width has to come
 * back from the range itself to turn that list into rows again; `__shape` on
 * the array is how the evaluator carries it.
 */
function lookup(args: EvalValue[], _context: EvalContext, direction: 'v' | 'h'): EvalValue {
  const needle = args[0] ?? null;
  const table = args[1];
  if (!Array.isArray(table)) return valueError;
  const shape = shapeOf(table);
  if (!shape) return valueError;
  const index = toNumber(args[2] ?? null);
  if (isError(index)) return index;
  const exact = args.length > 3 ? toBoolean(args[3]) === false : false;

  const { rows, columns } = shape;
  const at = (row: number, column: number): CellValue => table[row * columns + column] ?? null;

  const outer = direction === 'v' ? rows : columns;
  for (let position = 0; position < outer; position++) {
    const key = direction === 'v' ? at(position, 0) : at(0, position);
    const hit = exact ? compare(key, needle as CellValue) === 0 : compare(key, needle as CellValue) === 0;
    if (!hit) continue;
    const result = direction === 'v' ? at(position, index - 1) : at(index - 1, position);
    return result ?? null;
  }
  return na;
}

/** Ranges carry their shape so the two-dimensional functions can recover it. */
interface Shaped extends Array<CellValue> {
  __shape?: { rows: number; columns: number };
}

export function shapeRange(values: CellValue[], range: CellRange): CellValue[] {
  const shaped = values as Shaped;
  shaped.__shape = {
    rows: range.bottom - range.top + 1,
    columns: range.right - range.left + 1,
  };
  return shaped;
}

function shapeOf(values: CellValue[]): { rows: number; columns: number } | null {
  return (values as Shaped).__shape ?? null;
}

/** Every function this engine knows, for the editor's autocomplete. */
export const FUNCTION_NAMES = Object.keys(FUNCTIONS).sort();

// --- evaluation --------------------------------------------------------------

export function evaluate(node: Node, context: EvalContext): EvalValue {
  switch (node.type) {
    case 'number':
    case 'string':
    case 'boolean':
      return node.value;
    case 'error':
      return node.value;

    case 'ref':
      if (node.sheet && context.hasSheet && !context.hasSheet(node.sheet)) return ERRORS.ref;
      return context.cell(node.ref.row, node.ref.column, node.sheet);

    case 'range': {
      if (node.sheet && context.hasSheet && !context.hasSheet(node.sheet)) return ERRORS.ref;
      const values: CellValue[] = [];
      for (let row = node.range.top; row <= node.range.bottom; row++) {
        for (let column = node.range.left; column <= node.range.right; column++) {
          values.push(context.cell(row, column, node.sheet));
        }
      }
      return shapeRange(values, node.range);
    }

    case 'unary': {
      const operand = evaluate(node.operand, context);
      if (node.operator === '%') {
        const number = toNumber(operand);
        return isError(number) ? number : number / 100;
      }
      const number = toNumber(operand);
      if (isError(number)) return number;
      return node.operator === '-' ? -number : number;
    }

    case 'binary': {
      const left = evaluate(node.left, context);
      const right = evaluate(node.right, context);
      const failed = firstError([left, right]);
      if (failed) return failed;

      if (node.operator === '&') {
        const a = toText(left);
        if (isError(a)) return a;
        const b = toText(right);
        return isError(b) ? b : a + b;
      }

      if (['=', '<>', '<', '<=', '>', '>='].includes(node.operator)) {
        if (Array.isArray(left) || Array.isArray(right)) return valueError;
        const order = compare(left, right);
        switch (node.operator) {
          case '=':
            return order === 0;
          case '<>':
            return order !== 0;
          case '<':
            return order < 0;
          case '<=':
            return order <= 0;
          case '>':
            return order > 0;
          default:
            return order >= 0;
        }
      }

      const a = toNumber(left);
      if (isError(a)) return a;
      const b = toNumber(right);
      if (isError(b)) return b;
      switch (node.operator) {
        case '+':
          return a + b;
        case '-':
          return a - b;
        case '*':
          return a * b;
        case '/':
          return b === 0 ? div0 : a / b;
        case '^': {
          const result = a ** b;
          return Number.isFinite(result) ? result : num;
        }
        default:
          return valueError;
      }
    }

    case 'call': {
      const fn = FUNCTIONS[node.name];
      if (!fn) return nameError;
      // IFERROR and IFNA have to see an error rather than be short-circuited by
      // it, so arguments are passed through as they come.
      const args = node.args.map((argument) => evaluate(argument, context));
      if (node.name !== 'IFERROR' && node.name !== 'IFNA' && node.name !== 'ISERROR') {
        const failed = firstError(args);
        if (failed) return failed;
      }
      try {
        return fn(args, context);
      } catch {
        return valueError;
      }
    }

    default:
      return valueError;
  }
}

/** A formula's value, from its text. Used for one-off evaluation such as a preview. */
export function evaluateSource(source: string, context: EvalContext): CellValue {
  const tree = parseFormula(source);
  if (!tree) return parseError;
  const result = evaluate(tree, context);
  return Array.isArray(result) ? (result[0] ?? null) : result;
}

export { dependencies, parseFormula };
