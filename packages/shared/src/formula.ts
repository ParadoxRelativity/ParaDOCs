import {
  ERRORS,
  columnIndex,
  columnName,
  isError,
  quoteSheetName,
  type CellRange,
  type CellRef,
  type SheetError,
} from './sheet.js';

/**
 * The formula language: a tokenizer, a recursive-descent parser, a printer that
 * turns a tree back into text, and the rewrites that keep references pointing
 * at the right cells when rows, columns and sheets move.
 *
 * Parsing is separate from evaluation on purpose. A formula's text changes only
 * when someone edits it, while its value changes whenever anything it points at
 * does, so the tree is worth keeping and the walk is worth repeating. It also
 * means the references a formula depends on can be read off the tree without
 * evaluating anything, which is what the dependency order is built from.
 *
 * The tree keeps what a person typed that evaluation does not need — which
 * sheet a reference named, and which parts were marked `$` absolute — because
 * rewriting a formula has to give back text that still reads the way it was
 * written.
 *
 * Errors are values, not exceptions — `#DIV/0!` propagates through arithmetic
 * the way a spreadsheet's does, and only IFERROR stops it.
 */

// --- tokens -----------------------------------------------------------------

type TokenType = 'number' | 'string' | 'identifier' | 'sheet' | 'error' | 'operator' | 'punctuation';

interface Token {
  type: TokenType;
  value: string;
}

const OPERATORS = ['<=', '>=', '<>', '+', '-', '*', '/', '^', '&', '=', '<', '>', '%'];

/** Longest first, so `#N/A` is not read as a shorter error that happens to prefix it. */
const ERROR_LITERALS = Object.values(ERRORS).sort((a, b) => b.length - a.length);

function tokenize(source: string): Token[] | null {
  const tokens: Token[] = [];
  let index = 0;

  while (index < source.length) {
    const character = source[index];

    if (/\s/.test(character)) {
      index++;
      continue;
    }

    if (character === '"') {
      // Doubled quotes are an escaped quote, as in every spreadsheet.
      let value = '';
      index++;
      while (index < source.length) {
        if (source[index] === '"') {
          if (source[index + 1] === '"') {
            value += '"';
            index += 2;
            continue;
          }
          break;
        }
        value += source[index++];
      }
      if (source[index] !== '"') return null; // unterminated
      index++;
      tokens.push({ type: 'string', value });
      continue;
    }

    // A quoted sheet name, for names with spaces or punctuation: 'Q3 data'!A1.
    if (character === "'") {
      let value = '';
      index++;
      while (index < source.length) {
        if (source[index] === "'") {
          if (source[index + 1] === "'") {
            value += "'";
            index += 2;
            continue;
          }
          break;
        }
        value += source[index++];
      }
      if (source[index] !== "'" || source[index + 1] !== '!' || value === '') return null;
      index += 2;
      tokens.push({ type: 'sheet', value });
      continue;
    }

    // An error written into a formula, which is what a reference to deleted
    // cells becomes once it has been rewritten.
    if (character === '#') {
      const literal = ERROR_LITERALS.find((candidate) => source.toUpperCase().startsWith(candidate, index));
      if (!literal) return null;
      tokens.push({ type: 'error', value: literal });
      index += literal.length;
      continue;
    }

    if (/[0-9]/.test(character) || (character === '.' && /[0-9]/.test(source[index + 1] ?? ''))) {
      const match = /^(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(source.slice(index));
      if (!match) return null;
      tokens.push({ type: 'number', value: match[0] });
      index += match[0].length;
      continue;
    }

    // A name: a function, a cell reference, a bare TRUE/FALSE, or — when an
    // exclamation mark follows it — the name of a sheet.
    if (/[A-Za-z_$]/.test(character)) {
      const match = /^[A-Za-z_$][A-Za-z0-9_.$]*/.exec(source.slice(index));
      if (!match) return null;
      index += match[0].length;
      if (source[index] === '!') {
        index++;
        tokens.push({ type: 'sheet', value: match[0] });
      } else {
        tokens.push({ type: 'identifier', value: match[0] });
      }
      continue;
    }

    const operator = OPERATORS.find((candidate) => source.startsWith(candidate, index));
    if (operator) {
      tokens.push({ type: 'operator', value: operator });
      index += operator.length;
      continue;
    }

    if ('(),:;'.includes(character)) {
      tokens.push({ type: 'punctuation', value: character });
      index++;
      continue;
    }

    return null;
  }

  return tokens;
}

// --- the tree ---------------------------------------------------------------

/** Which parts of a reference were written `$` absolute. */
export interface Absolute {
  row: boolean;
  column: boolean;
}

export type Node =
  | { type: 'number'; value: number }
  | { type: 'string'; value: string }
  | { type: 'boolean'; value: boolean }
  /** `sheet` is the name as written, or null for the sheet the formula is on. */
  | { type: 'ref'; sheet: string | null; ref: CellRef; abs: Absolute }
  | { type: 'range'; sheet: string | null; range: CellRange; absStart: Absolute; absEnd: Absolute }
  | { type: 'unary'; operator: string; operand: Node }
  | { type: 'binary'; operator: string; left: Node; right: Node }
  | { type: 'call'; name: string; args: Node[] }
  | { type: 'error'; value: SheetError };

/** Binding power, loosest first. Comparison binds loosest so `A1+1=2` reads as people expect. */
const PRECEDENCE: Record<string, number> = {
  '=': 1,
  '<': 1,
  '>': 1,
  '<=': 1,
  '>=': 1,
  '<>': 1,
  '&': 2,
  '+': 3,
  '-': 3,
  '*': 4,
  '/': 4,
  '^': 5,
};

/** A reference as typed: "B7", "$B7", "B$7", "$B$7". */
function readReference(text: string): { ref: CellRef; abs: Absolute } | null {
  const match = /^(\$?)([A-Za-z]+)(\$?)([0-9]+)$/.exec(text);
  if (!match) return null;
  const column = columnIndex(match[2]);
  const row = Number(match[4]) - 1;
  if (column < 0 || row < 0 || !Number.isFinite(row)) return null;
  return { ref: { row, column }, abs: { column: match[1] === '$', row: match[3] === '$' } };
}

class Parser {
  private index = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): Node | null {
    const node = this.expression(0);
    if (!node || this.index < this.tokens.length) return null;
    return node;
  }

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.index + offset];
  }

  private expression(minimum: number): Node | null {
    let left = this.unary();
    if (!left) return null;

    for (;;) {
      const token = this.peek();
      if (!token || token.type !== 'operator') break;
      const precedence = PRECEDENCE[token.value];
      if (precedence === undefined || precedence < minimum) break;
      this.index++;
      // `^` is right-associative, so 2^3^2 is 2^(3^2) as in Excel.
      const right = this.expression(token.value === '^' ? precedence : precedence + 1);
      if (!right) return null;
      left = { type: 'binary', operator: token.value, left, right };
    }

    return left;
  }

  private unary(): Node | null {
    const token = this.peek();
    if (token?.type === 'operator' && (token.value === '-' || token.value === '+')) {
      this.index++;
      const operand = this.unary();
      return operand ? { type: 'unary', operator: token.value, operand } : null;
    }
    return this.postfix();
  }

  /** Trailing `%`, which divides what came before it by a hundred. */
  private postfix(): Node | null {
    let node = this.primary();
    if (!node) return null;
    while (this.peek()?.type === 'operator' && this.peek()?.value === '%') {
      this.index++;
      node = { type: 'unary', operator: '%', operand: node };
    }
    return node;
  }

  /** A reference or a range, optionally on a named sheet. */
  private reference(sheet: string | null): Node | null {
    const first = this.peek();
    if (first?.type !== 'identifier') return null;
    const start = readReference(first.value);
    if (!start) return null;
    this.index++;

    if (this.peek()?.type === 'punctuation' && this.peek()?.value === ':') {
      // Excel also accepts the sheet repeated after the colon; it has to agree.
      let offset = 1;
      const repeated = this.peek(1);
      if (repeated?.type === 'sheet') {
        if (!sheet || repeated.value.toLowerCase() !== sheet.toLowerCase()) return null;
        offset = 2;
      }
      const endToken = this.peek(offset);
      const end = endToken?.type === 'identifier' ? readReference(endToken.value) : null;
      if (!end) return null;
      this.index += offset + 1;
      const topFirst = start.ref.row <= end.ref.row;
      const leftFirst = start.ref.column <= end.ref.column;
      return {
        type: 'range',
        sheet,
        range: {
          top: Math.min(start.ref.row, end.ref.row),
          bottom: Math.max(start.ref.row, end.ref.row),
          left: Math.min(start.ref.column, end.ref.column),
          right: Math.max(start.ref.column, end.ref.column),
        },
        // Normalising the corners carries each corner's `$` markers with it.
        absStart: {
          row: topFirst ? start.abs.row : end.abs.row,
          column: leftFirst ? start.abs.column : end.abs.column,
        },
        absEnd: {
          row: topFirst ? end.abs.row : start.abs.row,
          column: leftFirst ? end.abs.column : start.abs.column,
        },
      };
    }

    return { type: 'ref', sheet, ref: start.ref, abs: start.abs };
  }

  private primary(): Node | null {
    const token = this.peek();
    if (!token) return null;

    if (token.type === 'number') {
      this.index++;
      return { type: 'number', value: Number(token.value) };
    }

    if (token.type === 'string') {
      this.index++;
      return { type: 'string', value: token.value };
    }

    if (token.type === 'error') {
      this.index++;
      return { type: 'error', value: token.value as SheetError };
    }

    if (token.type === 'sheet') {
      this.index++;
      return this.reference(token.value);
    }

    if (token.type === 'punctuation' && token.value === '(') {
      this.index++;
      const inner = this.expression(0);
      if (!inner || this.peek()?.value !== ')') return null;
      this.index++;
      return inner;
    }

    if (token.type === 'identifier') {
      const next = this.peek(1);

      if (next?.type === 'punctuation' && next.value === '(') {
        this.index += 2;
        const name = token.value.toUpperCase();
        const args: Node[] = [];
        if (this.peek()?.value === ')') {
          this.index++;
          return { type: 'call', name, args };
        }
        for (;;) {
          const argument = this.expression(0);
          if (!argument) return null;
          args.push(argument);
          const separator = this.peek();
          // Semicolons are accepted alongside commas, for people whose other
          // spreadsheet uses them.
          if (separator?.type === 'punctuation' && (separator.value === ',' || separator.value === ';')) {
            this.index++;
            continue;
          }
          break;
        }
        if (this.peek()?.value !== ')') return null;
        this.index++;
        return { type: 'call', name, args };
      }

      if (readReference(token.value)) return this.reference(null);

      this.index++;
      const upper = token.value.toUpperCase();
      if (upper === 'TRUE') return { type: 'boolean', value: true };
      if (upper === 'FALSE') return { type: 'boolean', value: false };
      return { type: 'error', value: ERRORS.name };
    }

    return null;
  }
}

export function parseFormula(source: string): Node | null {
  const tokens = tokenize(source);
  if (!tokens || tokens.length === 0) return null;
  return new Parser(tokens).parse();
}

// --- reading references off the tree ----------------------------------------

export interface Dependency {
  /** The sheet as written, or null for the formula's own sheet. */
  sheet: string | null;
  row: number;
  column: number;
}

/** Every cell a formula reads, for working out what has to be computed first. */
export function dependencies(node: Node, into: Dependency[] = []): Dependency[] {
  switch (node.type) {
    case 'ref':
      into.push({ sheet: node.sheet, row: node.ref.row, column: node.ref.column });
      break;
    case 'range':
      for (let row = node.range.top; row <= node.range.bottom; row++) {
        for (let column = node.range.left; column <= node.range.right; column++) {
          into.push({ sheet: node.sheet, row, column });
        }
      }
      break;
    case 'unary':
      dependencies(node.operand, into);
      break;
    case 'binary':
      dependencies(node.left, into);
      dependencies(node.right, into);
      break;
    case 'call':
      for (const argument of node.args) dependencies(argument, into);
      break;
    default:
      break;
  }
  return into;
}

// --- printing ---------------------------------------------------------------

function printCell(ref: CellRef, abs: Absolute): string {
  return `${abs.column ? '$' : ''}${columnName(ref.column)}${abs.row ? '$' : ''}${ref.row + 1}`;
}

function printNumber(value: number): string {
  // Integers and ordinary decimals print as themselves; anything JavaScript
  // would write with an exponent keeps it, which the tokenizer reads back.
  return Number.isFinite(value) ? String(value) : ERRORS.num;
}

/** Whether a child needs parentheses to keep its meaning under a binary parent. */
function needsParens(child: Node, parent: string, side: 'left' | 'right'): boolean {
  if (child.type !== 'binary') return false;
  const inner = PRECEDENCE[child.operator];
  const outer = PRECEDENCE[parent];
  if (inner < outer) return true;
  if (inner > outer) return false;
  // Equal binding: `^` groups to the right, everything else to the left, so the
  // side that would otherwise regroup is the one that keeps its brackets.
  return parent === '^' ? side === 'left' : side === 'right';
}

/**
 * A tree back to formula text, without the leading `=`. Spacing is not kept —
 * which is why the rewrites below only reprint formulas they actually changed.
 */
export function formulaToString(node: Node): string {
  switch (node.type) {
    case 'number':
      return printNumber(node.value);
    case 'string':
      return `"${node.value.replace(/"/g, '""')}"`;
    case 'boolean':
      return node.value ? 'TRUE' : 'FALSE';
    case 'error':
      return node.value;
    case 'ref':
      return `${node.sheet ? `${quoteSheetName(node.sheet)}!` : ''}${printCell(node.ref, node.abs)}`;
    case 'range': {
      const start = printCell({ row: node.range.top, column: node.range.left }, node.absStart);
      const end = printCell({ row: node.range.bottom, column: node.range.right }, node.absEnd);
      return `${node.sheet ? `${quoteSheetName(node.sheet)}!` : ''}${start}:${end}`;
    }
    case 'unary': {
      const inner = formulaToString(node.operand);
      const wrapped = node.operand.type === 'binary' ? `(${inner})` : inner;
      return node.operator === '%' ? `${wrapped}%` : `${node.operator}${wrapped}`;
    }
    case 'binary': {
      const left = formulaToString(node.left);
      const right = formulaToString(node.right);
      return `${needsParens(node.left, node.operator, 'left') ? `(${left})` : left}${node.operator}${
        needsParens(node.right, node.operator, 'right') ? `(${right})` : right
      }`;
    }
    case 'call':
      return `${node.name}(${node.args.map(formulaToString).join(',')})`;
    default:
      return ERRORS.value;
  }
}

// --- rewriting references ---------------------------------------------------

/**
 * Rows or columns added to or taken out of one sheet. A positive `count`
 * inserts that many before index `at`; a negative one removes that many
 * starting at `at`.
 */
export interface LineChange {
  sheet: string;
  axis: 'row' | 'column';
  at: number;
  count: number;
}

/** Where one index lands after the change, or null when its line was removed. */
function shiftIndex(index: number, at: number, count: number): number | null {
  if (count > 0) return index >= at ? index + count : index;
  const removed = -count;
  if (index < at) return index;
  if (index >= at + removed) return index - removed;
  return null;
}

/**
 * Where a span lands. Inserting inside a span stretches it; removing lines
 * from it shrinks it; removing every line it covered leaves nothing to point
 * at. That is how Excel treats a range, and it is what keeps `SUM(B2:B10)`
 * adding up the same column after a row goes in the middle.
 */
function shiftSpan(start: number, end: number, at: number, count: number): [number, number] | null {
  if (count > 0) return [start >= at ? start + count : start, end >= at ? end + count : end];
  const removed = -count;
  const last = at + removed - 1;
  const newStart = start < at ? start : start > last ? start - removed : at;
  const newEnd = end < at ? end : end > last ? end - removed : at - 1;
  return newStart <= newEnd ? [newStart, newEnd] : null;
}

/** Applies `visit` to every reference in a tree, rebuilding only what changed. */
function mapReferences(node: Node, visit: (ref: Extract<Node, { type: 'ref' | 'range' }>) => Node): Node {
  switch (node.type) {
    case 'ref':
    case 'range':
      return visit(node);
    case 'unary': {
      const operand = mapReferences(node.operand, visit);
      return operand === node.operand ? node : { ...node, operand };
    }
    case 'binary': {
      const left = mapReferences(node.left, visit);
      const right = mapReferences(node.right, visit);
      return left === node.left && right === node.right ? node : { ...node, left, right };
    }
    case 'call': {
      const args = node.args.map((argument) => mapReferences(argument, visit));
      return args.every((argument, index) => argument === node.args[index]) ? node : { ...node, args };
    }
    default:
      return node;
  }
}

/** Parses a stored cell's formula, rewrites it, and returns new text only if something moved. */
function rewrite(input: string, visit: (ref: Extract<Node, { type: 'ref' | 'range' }>) => Node): string | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('=')) return null;
  const tree = parseFormula(trimmed.slice(1));
  if (!tree) return null;
  const next = mapReferences(tree, visit);
  return next === tree ? null : `=${formulaToString(next)}`;
}

function sameSheet(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * A cell's input after rows or columns change on `change.sheet`, or null when
 * nothing in it moved. `homeSheet` is the sheet the cell itself is on, which is
 * what an unqualified reference like `A1` means.
 *
 * Absolute references move too. `$` only says a reference stays put when a
 * formula is copied somewhere else; when the cells themselves move, every
 * reference to them follows, as in Excel.
 */
export function shiftReferences(input: string, homeSheet: string, change: LineChange): string | null {
  const refError: Node = { type: 'error', value: ERRORS.ref };
  return rewrite(input, (node) => {
    const target = node.sheet ?? homeSheet;
    if (!sameSheet(target, change.sheet)) return node;

    if (node.type === 'ref') {
      const index = change.axis === 'row' ? node.ref.row : node.ref.column;
      const moved = shiftIndex(index, change.at, change.count);
      if (moved === null) return refError;
      if (moved === index) return node;
      const ref = change.axis === 'row' ? { ...node.ref, row: moved } : { ...node.ref, column: moved };
      return { ...node, ref };
    }

    const [start, end] =
      change.axis === 'row' ? [node.range.top, node.range.bottom] : [node.range.left, node.range.right];
    const span = shiftSpan(start, end, change.at, change.count);
    if (!span) return refError;
    if (span[0] === start && span[1] === end) return node;
    const range =
      change.axis === 'row'
        ? { ...node.range, top: span[0], bottom: span[1] }
        : { ...node.range, left: span[0], right: span[1] };
    return { ...node, range };
  });
}

/** A cell's input after a sheet is renamed, or null when it never named that sheet. */
export function renameSheetReferences(input: string, oldName: string, newName: string): string | null {
  return rewrite(input, (node) => (node.sheet && sameSheet(node.sheet, oldName) ? { ...node, sheet: newName } : node));
}

/** A cell's input after a sheet is deleted: references to it become #REF!. */
export function dropSheetReferences(input: string, removed: string): string | null {
  return rewrite(input, (node) =>
    node.sheet && sameSheet(node.sheet, removed) ? { type: 'error', value: ERRORS.ref } : node,
  );
}

export { isError };
