import { badRequest } from './http.js';

/**
 * Cursors for lists read a page at a time, keyed on where the last page
 * ended rather than on how many rows came before it, so rows added or removed
 * while someone scrolls neither repeat nor go missing.
 *
 * A cursor holds the last row's sort value, as Postgres wrote it as text, and
 * a tie-breaker that makes the position unique. It is opaque to clients.
 */

/** What Postgres writes these types as, strictly, so a cursor that does not match is never cast. */
export const CURSOR_TEXT = {
  number: /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i,
  integer: /^-?\d+$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
  timestamp: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
};

export function encodeCursor(value: string, tieBreaker: string | number): string {
  return Buffer.from(JSON.stringify([value, tieBreaker])).toString('base64url');
}

/**
 * The sort value and tie-breaker a cursor holds, once each has been checked,
 * or a 400 for one that is malformed, was made for a different ordering, or
 * did not come from this server.
 */
export function decodeCursor<T extends string | number>(
  cursor: string,
  checkValue: (value: string) => boolean,
  checkTieBreaker: (tie: unknown) => tie is T,
): [string, T] {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Array.isArray(decoded) &&
      decoded.length === 2 &&
      typeof decoded[0] === 'string' &&
      checkValue(decoded[0]) &&
      checkTieBreaker(decoded[1])
    ) {
      return [decoded[0], decoded[1]];
    }
  } catch {
    // Falls through to the same answer as any other cursor that makes no sense.
  }
  throw badRequest('That page is out of date. Reload the list.');
}

export const isInteger = (tie: unknown): tie is number => Number.isInteger(tie);
export const isUuid = (tie: unknown): tie is string => typeof tie === 'string' && CURSOR_TEXT.uuid.test(tie);
