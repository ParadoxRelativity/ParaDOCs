import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import {
  DEFAULT_COLUMN_WIDTH,
  HEADER_HEIGHT,
  MIN_COLUMN_WIDTH,
  ROW_HEADER_WIDTH,
  ROW_HEIGHT,
  cellKey,
  columnName,
  defaultAlign,
  formatValue,
  isError,
  normalizeRange,
  rangeContains,
  type CellRange,
  type CellRef,
} from '@paradocs/shared';
import type { SheetStore } from '../../lib/sheetStore';
import { cx } from '../../lib/util';
import { useFormulaAssist } from './FormulaAssist';

/**
 * The grid.
 *
 * Only the rows and columns on screen are rendered. A sheet is nominally a
 * hundred rows by twenty-six columns but can be resized far past that, and
 * drawing cells nobody can see is the one thing that makes a grid feel slow.
 * The scroll container is sized to the whole sheet so the scrollbar tells the
 * truth; the cells inside it are positioned absolutely at their real offsets.
 */

export interface Selection {
  anchor: CellRef;
  focus: CellRef;
  /**
   * Ranges picked earlier with ⌘ or Ctrl held, so rows or columns that are not
   * side by side can be selected together. The anchor and focus are always the
   * range being made now.
   */
  extra?: CellRange[];
}

/** Every range a selection covers, the one being made last. */
export function selectionRanges(selection: Selection): CellRange[] {
  return [...(selection.extra ?? []), normalizeRange(selection.anchor, selection.focus)];
}

export type GridMenuTarget = 'cell' | 'row' | 'column';

interface Props {
  sheet: SheetStore;
  selection: Selection;
  onSelectionChange: (selection: Selection) => void;
  /**
   * Whether the cell selection is drawn. It is not while a chart is selected:
   * the chart is what keys and commands act on then, and a highlighted cell
   * would say otherwise.
   */
  selectionVisible?: boolean;
  editable: boolean;
  /** The cell being typed into, if any, and what is in the editor. */
  editing: { ref: CellRef; value: string } | null;
  onEditingChange: (editing: { ref: CellRef; value: string } | null) => void;
  onCommit: (ref: CellRef, value: string, move: 'down' | 'right' | 'none') => void;
  /** Sees keys pressed on the grid before it does; returning true keeps them from the grid. */
  interceptKey?: (event: React.KeyboardEvent) => boolean;
  /** A right-click on the grid, after the selection has been moved under the pointer. */
  onOpenMenu?: (menu: { x: number; y: number; target: GridMenuTarget }) => void;
  /**
   * Drawn in the grid's own coordinates, above the cells, so anything placed
   * here — charts — scrolls with the data it sits beside.
   */
  overlay?: React.ReactNode;
}

/** How far past the viewport to draw, so a fast scroll does not show gaps. */
const OVERSCAN = 4;

export interface SheetGridHandle {
  /**
   * Puts the keyboard back on the grid. For whoever commits a cell from
   * outside it — the formula bar — so that finishing there leaves you typing
   * into the sheet rather than into nothing.
   */
  focus: () => void;
}

export default forwardRef<SheetGridHandle, Props>(function SheetGrid(
  {
    sheet,
    selection,
    onSelectionChange,
    selectionVisible = true,
    editable,
    editing,
    onEditingChange,
    onCommit,
    interceptKey,
    onOpenMenu,
    overlay,
  },
  ref,
) {
  const scroller = useRef<HTMLDivElement>(null);
  const editor = useRef<HTMLInputElement>(null);
  // Set when a commit means to carry on in the grid — Enter and Tab — so the
  // focus follows the selection instead of being dropped with the editor.
  const returnFocus = useRef(false);
  const [viewport, setViewport] = useState({ top: 0, left: 0, width: 800, height: 600 });
  const [dragging, setDragging] = useState(false);
  const [lineDrag, setLineDrag] = useState<'row' | 'column' | null>(null);
  const [resizing, setResizing] = useState<{ column: number; startX: number; startWidth: number } | null>(null);
  // Set by a click on a row or column header, whose selection runs off the
  // screen; following its focus there would throw away where you were looking.
  const holdScroll = useRef(false);

  useImperativeHandle(ref, () => ({ focus: () => scroller.current?.focus() }), []);

  const assist = useFormulaAssist(editor, editing ? editing.value : null, (value) => {
    if (editing) onEditingChange({ ref: editing.ref, value });
  });

  const { shape } = sheet;
  const widths = shape.columnWidths ?? {};
  const widthOf = useCallback((column: number) => widths[column] ?? DEFAULT_COLUMN_WIDTH, [widths]);

  // Column offsets, recomputed when a width changes. A prefix sum keeps
  // hit-testing and placement O(1) per cell rather than a walk from column A.
  const offsets = useRef<number[]>([]);
  offsets.current = (() => {
    const result: number[] = [0];
    for (let column = 0; column < shape.columns; column++) result.push(result[column] + widthOf(column));
    return result;
  })();
  const totalWidth = offsets.current[shape.columns];
  const totalHeight = shape.rows * ROW_HEIGHT;

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () =>
      setViewport({
        top: element.scrollTop,
        left: element.scrollLeft,
        width: element.clientWidth,
        height: element.clientHeight,
      });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const ranges = selectionVisible ? selectionRanges(selection) : [];
  const inSelection = (ref: CellRef) => ranges.some((range) => rangeContains(range, ref));
  const columnSelected = (column: number) => ranges.some((range) => column >= range.left && column <= range.right);
  const rowSelected = (row: number) => ranges.some((range) => row >= range.top && row <= range.bottom);

  // Which cells are worth drawing.
  const firstRow = Math.max(0, Math.floor(viewport.top / ROW_HEIGHT) - OVERSCAN);
  const lastRow = Math.min(shape.rows - 1, Math.ceil((viewport.top + viewport.height) / ROW_HEIGHT) + OVERSCAN);
  const firstColumn = Math.max(0, columnAt(offsets.current, viewport.left) - OVERSCAN);
  const lastColumn = Math.min(
    shape.columns - 1,
    columnAt(offsets.current, viewport.left + viewport.width) + OVERSCAN,
  );

  /** Keeps the focused cell in view as the arrows move it. */
  useEffect(() => {
    if (holdScroll.current) {
      holdScroll.current = false;
      return;
    }
    const element = scroller.current;
    if (!element) return;
    const { row, column } = selection.focus;
    const top = row * ROW_HEIGHT;
    const left = offsets.current[column] ?? 0;
    const width = widthOf(column);
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight) {
      element.scrollTop = top + ROW_HEIGHT - element.clientHeight;
    }
    if (left < element.scrollLeft) element.scrollLeft = left;
    else if (left + width > element.scrollLeft + element.clientWidth) {
      element.scrollLeft = left + width - element.clientWidth;
    }
  }, [selection.focus, widthOf]);

  // The editor takes the focus while a cell is open, and gives it back after.
  // Giving it back is what makes the cell Enter or Tab lands on typeable: the
  // editor unmounts on commit, and without this the focus goes to the document
  // and the next keystroke has nowhere to go.
  useEffect(() => {
    if (editing) {
      editor.current?.focus();
      return;
    }
    if (!returnFocus.current) return;
    returnFocus.current = false;
    scroller.current?.focus();
  }, [editing?.ref.row, editing?.ref.column]);

  // --- column resizing -------------------------------------------------------
  useEffect(() => {
    if (!resizing) return;
    const onMove = (event: PointerEvent) => {
      const width = Math.max(MIN_COLUMN_WIDTH, resizing.startWidth + event.clientX - resizing.startX);
      sheet.setColumnWidth(resizing.column, width);
    };
    const onUp = () => setResizing(null);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [resizing, sheet]);

  // A drag across the headers ends wherever the pointer is let go.
  useEffect(() => {
    if (!lineDrag) return;
    const onUp = () => setLineDrag(null);
    window.addEventListener('pointerup', onUp);
    return () => window.removeEventListener('pointerup', onUp);
  }, [lineDrag]);

  function refAt(clientX: number, clientY: number): CellRef | null {
    const element = scroller.current;
    if (!element) return null;
    const box = element.getBoundingClientRect();
    const x = clientX - box.left + element.scrollLeft;
    const y = clientY - box.top + element.scrollTop;
    const row = Math.floor(y / ROW_HEIGHT);
    const column = columnAt(offsets.current, x);
    if (row < 0 || row >= shape.rows || column < 0 || column >= shape.columns) return null;
    return { row, column };
  }

  /**
   * Selects a whole row or column from its header: on its own, stretched from
   * the last one with Shift, or alongside what is already selected with ⌘/Ctrl.
   * The focus goes to its first cell, and the view stays where it is.
   */
  function selectLine(
    axis: 'row' | 'column',
    index: number,
    modifiers: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean },
  ) {
    holdScroll.current = true;
    const lastRowIndex = shape.rows - 1;
    const lastColumnIndex = shape.columns - 1;
    if (modifiers.shiftKey && selectionVisible) {
      onSelectionChange({
        ...selection,
        anchor: axis === 'column' ? { row: lastRowIndex, column: selection.anchor.column } : { row: selection.anchor.row, column: lastColumnIndex },
        focus: axis === 'column' ? { row: 0, column: index } : { row: index, column: 0 },
      });
      return;
    }
    const additive = (modifiers.metaKey || modifiers.ctrlKey) && selectionVisible;
    onSelectionChange({
      anchor: axis === 'column' ? { row: lastRowIndex, column: index } : { row: index, column: lastColumnIndex },
      focus: axis === 'column' ? { row: 0, column: index } : { row: index, column: 0 },
      extra: additive ? selectionRanges(selection) : undefined,
    });
  }

  /** Moves the selection under a right-click unless it is already there. */
  function openMenu(event: React.MouseEvent, target: GridMenuTarget, ref: CellRef) {
    if (!onOpenMenu) return;
    event.preventDefault();
    scroller.current?.focus({ preventScroll: true });
    const full =
      target === 'column'
        ? ranges.some((range) => range.top === 0 && range.bottom === shape.rows - 1 && ref.column >= range.left && ref.column <= range.right)
        : target === 'row'
          ? ranges.some((range) => range.left === 0 && range.right === shape.columns - 1 && ref.row >= range.top && ref.row <= range.bottom)
          : inSelection(ref);
    if (!full) {
      if (target === 'cell') onSelectionChange({ anchor: ref, focus: ref });
      else selectLine(target, target === 'row' ? ref.row : ref.column, { shiftKey: false, metaKey: false, ctrlKey: false });
    }
    onOpenMenu({ x: event.clientX, y: event.clientY, target });
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* Column headers, held still horizontally with the grid. */}
      <div className="flex shrink-0 border-b border-[var(--color-line)] bg-[var(--color-surface)]">
        <div
          className="shrink-0 border-r border-[var(--color-line)]"
          style={{ width: ROW_HEADER_WIDTH, height: HEADER_HEIGHT }}
        />
        <div className="relative min-w-0 flex-1 overflow-hidden" style={{ height: HEADER_HEIGHT }}>
          <div style={{ transform: `translateX(${-viewport.left}px)`, width: totalWidth, height: '100%' }}>
            {columnsIn(firstColumn, lastColumn).map((column) => (
              <div
                key={column}
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  selectLine('column', column, event);
                  setLineDrag('column');
                }}
                onPointerEnter={() => {
                  if (lineDrag !== 'column') return;
                  holdScroll.current = true;
                  onSelectionChange({ ...selection, focus: { row: 0, column } });
                }}
                onContextMenu={(event) => openMenu(event, 'column', { row: 0, column })}
                className={cx(
                  'absolute top-0 flex h-full select-none items-center justify-center border-r border-[var(--color-line)] text-[11px] font-medium',
                  columnSelected(column)
                    ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                    : 'text-[var(--color-muted)]',
                )}
                style={{ left: offsets.current[column], width: widthOf(column) }}
              >
                {columnName(column)}
                <span
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    event.preventDefault();
                    setResizing({ column, startX: event.clientX, startWidth: widthOf(column) });
                  }}
                  title={`Resize column ${columnName(column)}`}
                  className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-[var(--color-accent)]"
                />
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Row headers, held still vertically with the grid. */}
        <div
          className="shrink-0 overflow-hidden border-r border-[var(--color-line)] bg-[var(--color-surface)]"
          style={{ width: ROW_HEADER_WIDTH }}
        >
          <div style={{ transform: `translateY(${-viewport.top}px)`, height: totalHeight }}>
            {rowsIn(firstRow, lastRow).map((row) => (
              <div
                key={row}
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  selectLine('row', row, event);
                  setLineDrag('row');
                }}
                onPointerEnter={() => {
                  if (lineDrag !== 'row') return;
                  holdScroll.current = true;
                  onSelectionChange({ ...selection, focus: { row, column: 0 } });
                }}
                onContextMenu={(event) => openMenu(event, 'row', { row, column: 0 })}
                className={cx(
                  'absolute flex select-none items-center justify-center border-b border-[var(--color-line)] text-[11px]',
                  rowSelected(row)
                    ? 'bg-[var(--color-accent-soft)] font-medium text-[var(--color-accent)]'
                    : 'text-[var(--color-muted)]',
                )}
                style={{ top: row * ROW_HEIGHT, height: ROW_HEIGHT, width: ROW_HEADER_WIDTH }}
              >
                {row + 1}
              </div>
            ))}
          </div>
        </div>

        <div
          ref={scroller}
          tabIndex={0}
          role="grid"
          aria-label="Spreadsheet"
          aria-multiselectable
          onScroll={(event) => {
            const element = event.currentTarget;
            setViewport((current) => ({ ...current, top: element.scrollTop, left: element.scrollLeft }));
          }}
          onKeyDown={(event) => {
            // Keys typed into something on top of the grid — a chart's title,
            // its settings — bubble up through it, and are not the grid's.
            if (event.target !== event.currentTarget) return;
            if (interceptKey?.(event)) return;
            onGridKey(event, sheet, selection, onSelectionChange, onEditingChange, editable);
          }}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            const ref = refAt(event.clientX, event.clientY);
            if (!ref) return;
            scroller.current?.focus();
            if (editing) onEditingChange(null);
            if (event.shiftKey && selectionVisible) onSelectionChange({ ...selection, focus: ref });
            else {
              const additive = (event.metaKey || event.ctrlKey) && selectionVisible;
              onSelectionChange({ anchor: ref, focus: ref, extra: additive ? selectionRanges(selection) : undefined });
              setDragging(true);
            }
          }}
          onPointerMove={(event) => {
            if (!dragging) return;
            const ref = refAt(event.clientX, event.clientY);
            if (ref && (ref.row !== selection.focus.row || ref.column !== selection.focus.column)) {
              onSelectionChange({ ...selection, focus: ref });
            }
          }}
          onPointerUp={() => setDragging(false)}
          onContextMenu={(event) => {
            const ref = refAt(event.clientX, event.clientY);
            if (ref) openMenu(event, 'cell', ref);
          }}
          onDoubleClick={(event) => {
            if (!editable) return;
            const ref = refAt(event.clientX, event.clientY);
            if (ref) onEditingChange({ ref, value: sheet.text(ref.row, ref.column) });
          }}
          className="scroll-thin min-w-0 flex-1 overflow-auto outline-none"
        >
          <div className="relative" style={{ width: totalWidth, height: totalHeight }}>
            {overlay}
            {rowsIn(firstRow, lastRow).map((row) =>
              columnsIn(firstColumn, lastColumn).map((column) => {
                const inRange = inSelection({ row, column });
                const isFocus =
                  selectionVisible && selection.focus.row === row && selection.focus.column === column;
                const value = sheet.value(row, column);
                const style = sheet.style(row, column);
                const beingEdited =
                  editing !== null && editing.ref.row === row && editing.ref.column === column;

                return (
                  <div
                    key={cellKey(row, column)}
                    className={cx(
                      'absolute flex items-center overflow-hidden border-b border-r border-[var(--color-line)] px-1.5 text-xs',
                      inRange && !isFocus && 'bg-[var(--color-accent-soft)]',
                      isFocus && 'z-10 outline outline-2 -outline-offset-1 outline-[var(--color-accent)]',
                      isError(value) && 'text-red-500',
                    )}
                    style={{
                      top: row * ROW_HEIGHT,
                      left: offsets.current[column],
                      width: widthOf(column),
                      height: ROW_HEIGHT,
                      justifyContent: justify(style?.align ?? defaultAlign(value)),
                      fontWeight: style?.bold ? 600 : undefined,
                      fontStyle: style?.italic ? 'italic' : undefined,
                      color: isError(value) ? undefined : style?.color,
                      background: beingEdited ? 'var(--color-canvas)' : (inRange ? undefined : style?.background),
                    }}
                  >
                    {beingEdited ? (
                      <input
                        ref={editor}
                        value={editing.value}
                        onChange={(event) => onEditingChange({ ref: editing.ref, value: event.target.value })}
                        onSelect={assist.onSelect}
                        onBlur={() => onCommit(editing.ref, editing.value, 'none')}
                        onKeyDown={(event) => {
                          if (assist.onKeyDown(event)) return;
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            returnFocus.current = true;
                            onCommit(editing.ref, editing.value, 'down');
                          } else if (event.key === 'Tab') {
                            event.preventDefault();
                            returnFocus.current = true;
                            onCommit(editing.ref, editing.value, 'right');
                          } else if (event.key === 'Escape') {
                            event.preventDefault();
                            onEditingChange(null);
                            scroller.current?.focus();
                          }
                          event.stopPropagation();
                        }}
                        className="h-full w-full bg-transparent text-xs outline-none"
                      />
                    ) : (
                      <span className="truncate">{formatValue(value, style)}</span>
                    )}
                  </div>
                );
              }),
            )}
          </div>
        </div>
      </div>

      {/* Outside the scroller, so a click on a hint is not a click on a cell. */}
      {assist.popup}
    </div>
  );
});

function justify(align: string): string {
  return align === 'right' ? 'flex-end' : align === 'center' ? 'center' : 'flex-start';
}

function rowsIn(first: number, last: number): number[] {
  const rows: number[] = [];
  for (let row = first; row <= last; row++) rows.push(row);
  return rows;
}

function columnsIn(first: number, last: number): number[] {
  const columns: number[] = [];
  for (let column = first; column <= last; column++) columns.push(column);
  return columns;
}

/** Binary search over the prefix sums for the column containing an x offset. */
function columnAt(offsets: number[], x: number): number {
  let low = 0;
  let high = offsets.length - 2;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (x < offsets[middle]) high = middle - 1;
    else if (x >= offsets[middle + 1]) low = middle + 1;
    else return middle;
  }
  return Math.max(0, Math.min(offsets.length - 2, low));
}

/**
 * Keyboard navigation. Typing a printable character opens the cell with that
 * character already in it, which is how a spreadsheet is actually used — you do
 * not double-click first, you just start typing.
 */
function onGridKey(
  event: React.KeyboardEvent,
  sheet: SheetStore,
  selection: Selection,
  onSelectionChange: (selection: Selection) => void,
  onEditingChange: (editing: { ref: CellRef; value: string } | null) => void,
  editable: boolean,
): void {
  const { shape } = sheet;
  const { focus } = selection;
  const clampRef = (ref: CellRef): CellRef => ({
    row: Math.max(0, Math.min(shape.rows - 1, ref.row)),
    column: Math.max(0, Math.min(shape.columns - 1, ref.column)),
  });

  const move = (rowStep: number, columnStep: number) => {
    event.preventDefault();
    const next = clampRef({ row: focus.row + rowStep, column: focus.column + columnStep });
    // Shift stretches the range being made and keeps the others; a plain move starts over.
    onSelectionChange(event.shiftKey ? { ...selection, focus: next } : { anchor: next, focus: next });
  };

  const meta = event.metaKey || event.ctrlKey;

  switch (event.key) {
    case 'ArrowDown':
      return move(meta ? shape.rows : 1, 0);
    case 'ArrowUp':
      return move(meta ? -shape.rows : -1, 0);
    case 'ArrowRight':
      return move(0, meta ? shape.columns : 1);
    case 'ArrowLeft':
      return move(0, meta ? -shape.columns : -1);
    case 'PageDown':
      return move(20, 0);
    case 'PageUp':
      return move(-20, 0);
    case 'Home':
      event.preventDefault();
      return onSelectionChange(single(clampRef({ row: meta ? 0 : focus.row, column: 0 })));
    case 'End':
      event.preventDefault();
      return onSelectionChange(single(clampRef({ row: focus.row, column: shape.columns - 1 })));
    case 'Tab':
      return move(0, event.shiftKey ? -1 : 1);
    case 'Enter':
      if (!editable) return;
      event.preventDefault();
      return onEditingChange({ ref: focus, value: sheet.text(focus.row, focus.column) });
    case 'F2':
      if (!editable) return;
      event.preventDefault();
      return onEditingChange({ ref: focus, value: sheet.text(focus.row, focus.column) });
    case 'Escape':
      if (!selection.extra?.length) return;
      event.preventDefault();
      return onSelectionChange({ anchor: selection.anchor, focus: selection.focus });
    case 'Delete':
    case 'Backspace':
      if (!editable) return;
      event.preventDefault();
      for (const range of selectionRanges(selection)) sheet.clearRange(range);
      return;
    default:
      break;
  }

  // Anything printable starts an edit, replacing what was there.
  if (editable && !meta && !event.altKey && event.key.length === 1) {
    event.preventDefault();
    onEditingChange({ ref: focus, value: event.key });
  }
}

function single(ref: CellRef): Selection {
  return { anchor: ref, focus: ref };
}
