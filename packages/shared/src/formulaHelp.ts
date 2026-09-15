import { FUNCTION_NAMES } from './formulaEval.js';

/**
 * What each function takes and does, for the hints shown while a formula is
 * typed. Arguments in brackets can be left out; one ending in "…" repeats.
 */

export interface FunctionHelp {
  name: string;
  args: string[];
  summary: string;
}

const HELP: Record<string, [args: string[], summary: string]> = {
  // maths
  SUM: [['value1', '[value2, …]'], 'Adds numbers and ranges together.'],
  PRODUCT: [['value1', '[value2, …]'], 'Multiplies numbers and ranges together.'],
  ABS: [['number'], 'The number without its sign.'],
  SQRT: [['number'], 'The square root of a number.'],
  POWER: [['base', 'exponent'], 'A number raised to a power.'],
  EXP: [['number'], 'e raised to a power.'],
  LN: [['number'], 'The natural logarithm of a number.'],
  LOG10: [['number'], 'The base-10 logarithm of a number.'],
  LOG: [['number', '[base]'], 'The logarithm of a number, base 10 unless given.'],
  MOD: [['dividend', 'divisor'], 'The remainder after dividing.'],
  INT: [['number'], 'Rounds down to the nearest whole number.'],
  SIGN: [['number'], '1 for positive, -1 for negative, 0 for zero.'],
  ROUND: [['number', '[places]'], 'Rounds to a number of decimal places.'],
  ROUNDUP: [['number', '[places]'], 'Rounds away from zero.'],
  ROUNDDOWN: [['number', '[places]'], 'Rounds towards zero.'],
  CEILING: [['number', '[step]'], 'Rounds up to the nearest multiple of step.'],
  FLOOR: [['number', '[step]'], 'Rounds down to the nearest multiple of step.'],
  RAND: [[], 'A random number between 0 and 1.'],
  RANDBETWEEN: [['low', 'high'], 'A random whole number between two numbers.'],
  PI: [[], 'The number π.'],
  // statistics
  AVERAGE: [['value1', '[value2, …]'], 'The mean of the numbers.'],
  MEDIAN: [['value1', '[value2, …]'], 'The middle number.'],
  MIN: [['value1', '[value2, …]'], 'The smallest number.'],
  MAX: [['value1', '[value2, …]'], 'The largest number.'],
  STDEV: [['value1', '[value2, …]'], 'Standard deviation of a sample.'],
  STDEVP: [['value1', '[value2, …]'], 'Standard deviation of a whole population.'],
  VAR: [['value1', '[value2, …]'], 'Variance of a sample.'],
  VARP: [['value1', '[value2, …]'], 'Variance of a whole population.'],
  MODE: [['value1', '[value2, …]'], 'The most common number.'],
  PERCENTILE: [['range', 'fraction'], 'The value at a percentile, given as 0 to 1.'],
  QUARTILE: [['range', 'quartile'], 'The value at a quartile, 0 to 4.'],
  CORREL: [['range1', 'range2'], 'How closely two ranges move together, -1 to 1.'],
  COUNT: [['value1', '[value2, …]'], 'How many numbers there are.'],
  COUNTA: [['value1', '[value2, …]'], 'How many cells are not empty.'],
  COUNTBLANK: [['range'], 'How many cells are empty.'],
  // logic
  IF: [['condition', '[if_true]', '[if_false]'], 'One value when a condition holds, another when it does not.'],
  IFS: [['condition1', 'value1', '[condition2, value2, …]'], 'The value for the first condition that holds.'],
  IFERROR: [['value', 'if_error'], 'The value, or a fallback when it is an error.'],
  IFNA: [['value', 'if_na'], 'The value, or a fallback when it is #N/A.'],
  AND: [['logical1', '[logical2, …]'], 'TRUE when every argument is true.'],
  OR: [['logical1', '[logical2, …]'], 'TRUE when any argument is true.'],
  XOR: [['logical1', '[logical2, …]'], 'TRUE when an odd number of arguments are true.'],
  NOT: [['logical'], 'The opposite of a true or false value.'],
  TRUE: [[], 'The value TRUE.'],
  FALSE: [[], 'The value FALSE.'],
  NA: [[], 'The #N/A error, for "no value available".'],
  ISERROR: [['value'], 'TRUE when the value is an error.'],
  ISBLANK: [['value'], 'TRUE when the cell is empty.'],
  ISNUMBER: [['value'], 'TRUE when the value is a number.'],
  ISTEXT: [['value'], 'TRUE when the value is text.'],
  // conditional aggregation
  SUMIF: [['range', 'criterion', '[sum_range]'], 'Adds the cells that meet a condition.'],
  COUNTIF: [['range', 'criterion'], 'Counts the cells that meet a condition.'],
  AVERAGEIF: [['range', 'criterion', '[average_range]'], 'Averages the cells that meet a condition.'],
  SUMIFS: [['sum_range', 'criteria_range1', 'criterion1', '[criteria_range2, criterion2, …]'], 'Adds the cells that meet every condition.'],
  COUNTIFS: [['criteria_range1', 'criterion1', '[criteria_range2, criterion2, …]'], 'Counts the rows that meet every condition.'],
  // lookup
  VLOOKUP: [['search_key', 'range', 'column', '[is_sorted]'], 'Finds a row by its first column and returns a value from it.'],
  HLOOKUP: [['search_key', 'range', 'row', '[is_sorted]'], 'Finds a column by its first row and returns a value from it.'],
  MATCH: [['search_key', 'range', '[match_type]'], 'The position of a value in a range. 0 matches exactly.'],
  INDEX: [['range', 'position'], 'The value at a position in a range.'],
  CHOOSE: [['index', 'choice1', '[choice2, …]'], 'Picks one of the choices by number.'],
  // text
  CONCAT: [['text1', '[text2, …]'], 'Joins text together.'],
  LEN: [['text'], 'The number of characters in text.'],
  LEFT: [['text', '[count]'], 'Characters from the start of text.'],
  RIGHT: [['text', '[count]'], 'Characters from the end of text.'],
  MID: [['text', 'start', 'length'], 'Characters from the middle of text.'],
  UPPER: [['text'], 'Text in capitals.'],
  LOWER: [['text'], 'Text in lower case.'],
  PROPER: [['text'], 'Text With Each Word Capitalised.'],
  TRIM: [['text'], 'Text without extra spaces.'],
  REPT: [['text', 'times'], 'Text repeated a number of times.'],
  SUBSTITUTE: [['text', 'search_for', 'replace_with'], 'Replaces every occurrence of some text.'],
  FIND: [['search_for', 'text', '[start]'], 'Where text first appears, matching case.'],
  SEARCH: [['search_for', 'text', '[start]'], 'Where text first appears, ignoring case.'],
  VALUE: [['text'], 'Text read as a number.'],
  TEXT: [['value'], 'A value as text.'],
  // dates
  TODAY: [[], "Today's date."],
  NOW: [[], 'The date and time right now.'],
  DATE: [['year', 'month', 'day'], 'A date from its parts.'],
  YEAR: [['date'], 'The year of a date.'],
  MONTH: [['date'], 'The month of a date, 1 to 12.'],
  DAY: [['date'], 'The day of the month of a date.'],
  HOUR: [['time'], 'The hour of a time, 0 to 23.'],
  MINUTE: [['time'], 'The minute of a time.'],
  SECOND: [['time'], 'The second of a time.'],
  WEEKDAY: [['date'], 'The day of the week, 1 (Sunday) to 7.'],
  DAYS: [['end_date', 'start_date'], 'The number of days between two dates.'],
};

/** Help for every function the engine knows, including any not described above. */
export const FUNCTION_HELP: FunctionHelp[] = FUNCTION_NAMES.map((name) => {
  const [args, summary] = HELP[name] ?? [[], ''];
  return { name, args, summary };
});

const BY_NAME = new Map(FUNCTION_HELP.map((help) => [help.name, help]));

export function functionHelp(name: string): FunctionHelp | null {
  return BY_NAME.get(name.toUpperCase()) ?? null;
}

/** `SUM(value1, [value2, …])` */
export function functionSignature(help: FunctionHelp): string {
  return `${help.name}(${help.args.join(', ')})`;
}

/**
 * Which argument a position in the call is on, allowing for the repeating
 * last argument: past the end, it stays on the last one.
 */
export function activeArgument(help: FunctionHelp, index: number): number {
  if (help.args.length === 0) return -1;
  return Math.min(index, help.args.length - 1);
}

export interface FormulaContext {
  /** The function name being typed at the caret, if one is. */
  word: { start: number; text: string } | null;
  /** The innermost function call the caret is inside, and which argument it is on. */
  call: { name: string; argument: number } | null;
}

/**
 * What the caret is in the middle of, read from the text before it. Only a
 * formula has a context; a string in quotes has none, so typing prose inside
 * `"…"` does not offer functions.
 */
export function formulaContext(text: string, caret: number): FormulaContext {
  const none: FormulaContext = { word: null, call: null };
  if (!text.startsWith('=')) return none;
  const before = text.slice(0, caret);

  const stack: { name: string | null; argument: number }[] = [];
  let inString = false;
  let identifier = '';
  let identifierStart = -1;
  for (let index = 1; index < before.length; index++) {
    const character = before[index];
    if (inString) {
      if (character === '"') inString = false;
      continue;
    }
    if (/[A-Za-z0-9_.$]/.test(character)) {
      if (!identifier) identifierStart = index;
      identifier += character;
      continue;
    }
    if (character === '(') stack.push({ name: identifier ? identifier.toUpperCase() : null, argument: 0 });
    else if (character === ')') stack.pop();
    else if (character === ',' && stack.length > 0) stack[stack.length - 1].argument++;
    else if (character === '"') inString = true;
    identifier = '';
    identifierStart = -1;
  }
  if (inString) return none;

  const top = [...stack].reverse().find((entry) => entry.name !== null);
  const call = top?.name ? { name: top.name, argument: top.argument } : null;

  // A word is a function name in progress when it starts with a letter and is
  // not part of a sheet-qualified reference like Sheet2!A1.
  const preceding = identifierStart > 0 ? before[identifierStart - 1] : '';
  const word =
    identifier && /^[A-Za-z]/.test(identifier) && !/^\$/.test(identifier) && preceding !== '!' && preceding !== "'"
      ? { start: identifierStart, text: identifier }
      : null;

  return { word, call };
}

/**
 * Functions whose name starts with what has been typed, an exact match first.
 * A function that takes nothing — TRUE, PI — is not offered once its whole
 * name is typed, so Enter still commits `=TRUE` rather than turning it into a call.
 */
export function suggestFunctions(prefix: string, limit = 8): FunctionHelp[] {
  const upper = prefix.toUpperCase();
  if (!upper) return [];
  const exact = BY_NAME.get(upper);
  const rest = FUNCTION_HELP.filter((help) => help.name.startsWith(upper) && help.name !== upper);
  return (exact && exact.args.length > 0 ? [exact, ...rest] : rest).slice(0, limit);
}
