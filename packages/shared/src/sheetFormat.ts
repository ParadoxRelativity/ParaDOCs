import {
  isError,
  serialToDate,
  type CellAlign,
  type CellStyle,
  type CellValue,
} from './sheet.js';

/**
 * Turning a computed value into what the cell shows.
 *
 * `general` is the interesting case: it has to guess, and the guess people
 * expect is "show me what I typed, tidied up" rather than any fixed precision.
 * So a whole number keeps no decimals, a fraction keeps what it has up to the
 * point where floating point starts inventing digits, and a very large or very
 * small number falls back to exponent form rather than printing twenty zeroes.
 */

/** Past this, a decimal expansion is noise from binary floating point. */
const SIGNIFICANT = 10;

export function formatValue(value: CellValue, style: CellStyle | undefined): string {
  if (value === null) return '';
  if (isError(value)) return value;
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';

  const format = style?.format ?? 'general';
  if (format === 'text') return String(value);

  if (typeof value === 'string') return value;

  switch (format) {
    case 'integer':
      return group(value.toFixed(0));
    case 'number':
      return group(value.toFixed(style?.decimals ?? 2));
    case 'currency': {
      const symbol = style?.currency ?? '$';
      const body = group(Math.abs(value).toFixed(style?.decimals ?? 2));
      return value < 0 ? `-${symbol}${body}` : `${symbol}${body}`;
    }
    case 'percent':
      return `${group((value * 100).toFixed(style?.decimals ?? 1))}%`;
    case 'scientific':
      return value.toExponential(style?.decimals ?? 2);
    case 'date':
      return formatDate(value, false, false);
    case 'datetime':
      return formatDate(value, true, false);
    case 'time':
      return formatDate(value, true, true);
    default:
      return general(value);
  }
}

function general(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);
  const magnitude = Math.abs(value);
  if (magnitude !== 0 && (magnitude >= 1e12 || magnitude < 1e-9)) return value.toExponential(6);
  // Round away the tail binary floating point leaves behind, then drop any
  // zeros that rounding introduced.
  const rounded = Number(value.toPrecision(SIGNIFICANT));
  return String(rounded);
}

/** Thousands separators, applied to the part before the point. */
function group(text: string): string {
  const [whole, fraction] = text.split('.');
  const sign = whole.startsWith('-') ? '-' : '';
  const digits = sign ? whole.slice(1) : whole;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction ? `${sign}${grouped}.${fraction}` : `${sign}${grouped}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function formatDate(serial: number, withTime: boolean, timeOnly: boolean): string {
  const date = serialToDate(serial);
  if (Number.isNaN(date.getTime())) return '#VALUE!';
  const time = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
  if (timeOnly) return `${time}:${pad(date.getUTCSeconds())}`;
  const day = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  return withTime ? `${day} ${time}` : day;
}

/**
 * Which way a value sits when nothing has been chosen: numbers right, text
 * left, booleans and errors centred. It is the oldest convention in
 * spreadsheets and it is load-bearing — a number that suddenly sits left is how
 * you notice it was stored as text.
 */
export function defaultAlign(value: CellValue): CellAlign {
  if (value === null) return 'left';
  if (isError(value) || typeof value === 'boolean') return 'center';
  return typeof value === 'number' ? 'right' : 'left';
}

/** What goes back in the editor when a cell is opened: the formula, or the value. */
export function editText(raw: string | undefined): string {
  return raw ?? '';
}
