import { memo, useContext, useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
  anchorOf,
  cellRange,
  coveredCells,
  deleteColumn,
  deleteRow,
  fontStack,
  insertColumn,
  insertRow,
  mergeCells,
  resolveSlideColor,
  tableCellKey,
  unmergeCell,
  weightsOf,
  type TableCell,
  type TableElement,
  type Theme,
} from '@paradocs/shared';
import { Button } from '../ui';
import { ColorInput, Field, Group, NumberInput, SelectInput, ToolButton } from './inspectorParts';
import { SlideDocContext, registerSlideElementRenderer, registerSlideInspectorSection, type SlideEditorContext, type SlideElementRendererProps } from './slideExtensions';
import { clearTableSelection, setTableSelection, useTableSelection } from './tableSession';

const DEFAULT_SIZE = 28;
const DEFAULT_BORDER = 2;
const PADDING = 10;

function cellStyle(table: TableElement, cell: TableCell | undefined, row: number, theme: Theme): CSSProperties {
  const header = table.headerRow && row === 0;
  const borderWidth = cell?.borderWidth ?? table.borderWidth ?? DEFAULT_BORDER;
  const borderColor = resolveSlideColor(cell?.borderColor ?? table.borderColor ?? '#9ca3af', theme);
  const fill = cell?.fill ?? (header ? theme.colors.light2 : undefined);
  return {
    border: borderWidth > 0 ? `${borderWidth}px solid ${borderColor}` : 'none',
    background: fill ? resolveSlideColor(fill, theme) : undefined,
    color: resolveSlideColor(cell?.color ?? 'theme:text1', theme),
    fontSize: cell?.fontSize ?? table.fontSize ?? DEFAULT_SIZE,
    fontWeight: cell?.bold || header ? 700 : 400,
    fontStyle: cell?.italic ? 'italic' : undefined,
    textDecoration: cell?.underline ? 'underline' : undefined,
    textAlign: cell?.align ?? 'left',
    verticalAlign: cell?.verticalAlign === 'bottom' ? 'bottom' : cell?.verticalAlign === 'middle' ? 'middle' : 'top',
    padding: PADDING,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    position: 'relative',
  };
}

/**
 * A table: merged cells, fills, borders and per-cell text formatting. Cells
 * are plain text with formatting on the cell, stored a key per cell so two
 * people typing in different cells merge. Rows are as tall as their weight of
 * the box, and grow to fit their text.
 */
const TableRenderer = memo(function TableRenderer({ element, theme, selected, editing, readOnly, onStopEditing }: SlideElementRendererProps) {
  const table = element as TableElement;
  const doc = useContext(SlideDocContext);
  const selection = useTableSelection();
  const mine = selection?.elementId === table.id ? selection : null;
  const covered = coveredCells(table);
  const widths = weightsOf(table.columnWidths, table.columns);
  const heights = weightsOf(table.rowHeights, table.rows);
  const widthSum = widths.reduce((a, b) => a + b, 0);
  const heightSum = heights.reduce((a, b) => a + b, 0);
  const range = mine ? cellRange(table, mine.anchor, mine.focus) : null;
  const inRange = (r: number, c: number) => !!range && r >= range.row && r < range.row + range.rows && c >= range.column && c < range.column + range.columns;

  // A table that is no longer selected gives up its cell selection.
  useEffect(() => {
    if (!selected) clearTableSelection(table.id);
    return () => clearTableSelection(table.id);
  }, [selected, table.id]);

  const pick = (e: React.PointerEvent, row: number, column: number) => {
    if (readOnly) return;
    const start = mine && (e.shiftKey || e.metaKey || e.ctrlKey) ? mine.anchor : { row, column };
    setTableSelection({ elementId: table.id, anchor: start, focus: { row, column } });
  };

  const move = (row: number, column: number, dr: number, dc: number) => {
    let r = row;
    let c = column + dc;
    if (dc !== 0) {
      if (c >= table.columns) {
        c = 0;
        r += 1;
      } else if (c < 0) {
        c = table.columns - 1;
        r -= 1;
      }
    } else r += dr;
    if (r < 0 || r >= table.rows) return false;
    const a = anchorOf(table, r, c);
    setTableSelection({ elementId: table.id, anchor: { row: a.row, column: a.column }, focus: { row: a.row, column: a.column } });
    return true;
  };

  const commit = (key: string, text: string) => {
    const existing = table.cells[key];
    if ((existing?.text ?? '') === text) return;
    if (!doc) return;
    const next = { ...(existing ?? { text: '' }), text };
    doc.actions.setTableCells(doc.slideId, table.id, { [key]: next.text === '' && Object.keys(next).length === 1 ? null : next });
  };

  const editingCell = editing && !readOnly ? (mine?.anchor ?? { row: 0, column: 0 }) : null;

  return (
    <table
      style={{
        width: '100%',
        borderCollapse: 'collapse',
        tableLayout: 'fixed',
        fontFamily: fontStack(table.fontFamily ?? theme.fonts.body),
        background: 'transparent',
      }}
    >
      <colgroup>
        {widths.map((w, i) => (
          <col key={i} style={{ width: `${(w / widthSum) * 100}%` }} />
        ))}
      </colgroup>
      <tbody>
        {Array.from({ length: table.rows }, (_, r) => (
          <tr key={r} style={{ height: (heights[r] / heightSum) * table.height }}>
            {Array.from({ length: table.columns }, (_, c) => {
              const key = tableCellKey(r, c);
              if (covered.has(key)) return null;
              const cell = table.cells[key];
              const isEditing = !!editingCell && editingCell.row === r && editingCell.column === c;
              const chosen = inRange(r, c);
              return (
                <td
                  key={c}
                  rowSpan={cell?.rowSpan}
                  colSpan={cell?.colSpan}
                  style={cellStyle(table, cell, r, theme)}
                  onPointerDown={(e) => pick(e, r, c)}
                >
                  {isEditing ? (
                    <CellEditor
                      key={key}
                      value={cell?.text ?? ''}
                      onCommit={(text) => commit(key, text)}
                      onMove={(dr, dc) => move(r, c, dr, dc)}
                      onStop={() => onStopEditing(table.id)}
                    />
                  ) : (
                    (cell?.text ?? '') || ' '
                  )}
                  {chosen && !readOnly && <span aria-hidden style={{ position: 'absolute', inset: 0, boxShadow: 'inset 0 0 0 4px var(--color-accent)', background: 'rgb(37 99 235 / 0.08)', pointerEvents: 'none' }} />}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
});

function CellEditor({ value, onCommit, onMove, onStop }: { value: string; onCommit: (text: string) => void; onMove: (dr: number, dc: number) => boolean; onStop: () => void }) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const latest = useRef(draft);
  latest.current = draft;

  useEffect(() => {
    const el = ref.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
    return () => clearTimeout(timer.current);
  }, []);

  const flush = () => {
    clearTimeout(timer.current);
    onCommit(latest.current);
  };

  return (
    <textarea
      ref={ref}
      aria-label="Cell text"
      value={draft}
      rows={1}
      onChange={(e) => {
        setDraft(e.target.value);
        latest.current = e.target.value;
        clearTimeout(timer.current);
        timer.current = setTimeout(flush, 250);
      }}
      onBlur={flush}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          flush();
          onStop();
        } else if (e.key === 'Tab') {
          e.preventDefault();
          flush();
          if (!onMove(0, e.shiftKey ? -1 : 1)) onStop();
        } else if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          flush();
          if (!onMove(1, 0)) onStop();
        }
      }}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', resize: 'none', border: 'none', outline: 'none', background: 'rgb(255 255 255 / 0.85)', font: 'inherit', color: 'inherit', textAlign: 'inherit', padding: PADDING }}
    />
  );
}

registerSlideElementRenderer('table', TableRenderer);

// ---------------------------------------------------------------------------
// Inspector
// ---------------------------------------------------------------------------

function TableInspector({ ctx }: { ctx: SlideEditorContext }) {
  const { slide, selection, actions, canEdit, theme } = ctx;
  const chosen = useTableSelection();
  const table = selection.length === 1 && selection[0].type === 'table' ? (selection[0] as TableElement) : null;
  if (!slide || !table) return null;

  const at = chosen?.elementId === table.id ? chosen : null;
  const anchor = at?.anchor ?? { row: 0, column: 0 };
  const range = cellRange(table, anchor, at?.focus ?? anchor);
  const first = table.cells[tableCellKey(range.row, range.column)];
  const disabled = !canEdit;

  const rewrite = (next: ReturnType<typeof insertRow>) => actions.setTableStructure(slide.id, table.id, next);
  const keep = (a: { row: number; column: number }) => setTableSelection({ elementId: table.id, anchor: a, focus: a });
  const patchTable = (changes: Record<string, unknown>) => actions.updateElements(slide.id, [{ id: table.id, patch: changes }]);

  /** Applies cell properties to every cell the selection covers (a merged cell once, through its top-left cell). */
  const format = (changes: Partial<TableCell>) => {
    const covered = coveredCells(table);
    const edits: Record<string, TableCell> = {};
    for (let r = range.row; r < range.row + range.rows; r++) {
      for (let c = range.column; c < range.column + range.columns; c++) {
        const key = tableCellKey(r, c);
        if (covered.has(key)) continue;
        const merged = { ...(table.cells[key] ?? { text: '' }), ...changes };
        for (const k of Object.keys(merged) as (keyof TableCell)[]) if (merged[k] === undefined) delete merged[k];
        edits[key] = merged;
      }
    }
    actions.setTableCells(slide.id, table.id, edits);
  };

  const merged = (first?.rowSpan ?? 1) > 1 || (first?.colSpan ?? 1) > 1;

  return (
    <div className="space-y-4 text-sm">
      <Group title="Table">
        <div className="grid grid-cols-2 gap-1">
          <Button variant="subtle" className="!px-2 !py-1 text-xs" disabled={disabled || table.rows >= MAX_TABLE_ROWS} onClick={() => rewrite(insertRow(table, range.row))}>
            Row above
          </Button>
          <Button variant="subtle" className="!px-2 !py-1 text-xs" disabled={disabled || table.rows >= MAX_TABLE_ROWS} onClick={() => rewrite(insertRow(table, range.row + range.rows))}>
            Row below
          </Button>
          <Button variant="subtle" className="!px-2 !py-1 text-xs" disabled={disabled || table.columns >= MAX_TABLE_COLUMNS} onClick={() => rewrite(insertColumn(table, range.column))}>
            Column left
          </Button>
          <Button variant="subtle" className="!px-2 !py-1 text-xs" disabled={disabled || table.columns >= MAX_TABLE_COLUMNS} onClick={() => rewrite(insertColumn(table, range.column + range.columns))}>
            Column right
          </Button>
          <Button
            variant="subtle"
            className="!px-2 !py-1 text-xs"
            disabled={disabled || table.rows <= range.rows}
            onClick={() => {
              let next: ReturnType<typeof insertRow> = table;
              for (let i = range.rows - 1; i >= 0; i--) next = deleteRow(next, range.row + i);
              rewrite(next);
              keep({ row: Math.min(range.row, next.rows - 1), column: range.column });
            }}
          >
            Delete row
          </Button>
          <Button
            variant="subtle"
            className="!px-2 !py-1 text-xs"
            disabled={disabled || table.columns <= range.columns}
            onClick={() => {
              let next: ReturnType<typeof insertRow> = table;
              for (let i = range.columns - 1; i >= 0; i--) next = deleteColumn(next, range.column + i);
              rewrite(next);
              keep({ row: range.row, column: Math.min(range.column, next.columns - 1) });
            }}
          >
            Delete column
          </Button>
          <Button variant="subtle" className="!px-2 !py-1 text-xs" disabled={disabled || range.rows * range.columns < 2} onClick={() => rewrite(mergeCells(table, range))}>
            Merge cells
          </Button>
          <Button variant="subtle" className="!px-2 !py-1 text-xs" disabled={disabled || !merged} onClick={() => rewrite(unmergeCell(table, range.row, range.column))}>
            Split cell
          </Button>
        </div>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={table.headerRow === true} disabled={disabled} onChange={(e) => patchTable({ headerRow: e.target.checked ? true : undefined })} />
          <span>Header row</span>
        </label>
        <Field label="Text size">
          <NumberInput label="Table text size" value={table.fontSize ?? DEFAULT_SIZE} min={8} max={200} disabled={disabled} onCommit={(value) => patchTable({ fontSize: value })} />
        </Field>
        <Field label="Borders">
          <span className="flex items-center gap-1">
            <ColorInput label="Border color" value={resolveHex(table.borderColor, theme)} fallback="#9ca3af" disabled={disabled} onChange={(color) => patchTable({ borderColor: color })} />
            <NumberInput label="Border width" value={table.borderWidth ?? DEFAULT_BORDER} min={0} max={20} disabled={disabled} onCommit={(value) => patchTable({ borderWidth: value })} />
          </span>
        </Field>
      </Group>

      <Group title={range.rows * range.columns > 1 ? `Cells (${range.rows * range.columns})` : 'Cell'}>
        <div className="flex flex-wrap items-center gap-0.5">
          <ToolButton label="Bold" icon="type-bold" active={first?.bold === true} disabled={disabled} onClick={() => format({ bold: first?.bold ? undefined : true })} />
          <ToolButton label="Italic" icon="type-italic" active={first?.italic === true} disabled={disabled} onClick={() => format({ italic: first?.italic ? undefined : true })} />
          <ToolButton label="Underline" icon="type-underline" active={first?.underline === true} disabled={disabled} onClick={() => format({ underline: first?.underline ? undefined : true })} />
          <ToolButton label="Align left" icon="text-left" active={(first?.align ?? 'left') === 'left'} disabled={disabled} onClick={() => format({ align: undefined })} />
          <ToolButton label="Align center" icon="text-center" active={first?.align === 'center'} disabled={disabled} onClick={() => format({ align: 'center' })} />
          <ToolButton label="Align right" icon="text-right" active={first?.align === 'right'} disabled={disabled} onClick={() => format({ align: 'right' })} />
        </div>
        <Field label="Vertical">
          <SelectInput
            label="Vertical alignment"
            value={first?.verticalAlign ?? 'top'}
            disabled={disabled}
            options={[
              { value: 'top', label: 'Top' },
              { value: 'middle', label: 'Middle' },
              { value: 'bottom', label: 'Bottom' },
            ]}
            onChange={(value) => format({ verticalAlign: value === 'top' || value === '' ? undefined : value })}
          />
        </Field>
        <Field label="Text color">
          <ColorInput label="Cell text color" value={resolveHex(first?.color, theme)} fallback="#111827" disabled={disabled} onChange={(color) => format({ color })} />
        </Field>
        <Field label="Fill">
          <span className="flex items-center gap-1">
            <ColorInput label="Cell fill" value={resolveHex(first?.fill, theme)} fallback="#ffffff" disabled={disabled} onChange={(color) => format({ fill: color })} />
            {first?.fill && (
              <button type="button" className="text-xs text-[var(--color-muted)] hover:text-[var(--color-ink)]" disabled={disabled} onClick={() => format({ fill: undefined })}>
                Clear
              </button>
            )}
          </span>
        </Field>
        <Field label="Text size">
          <NumberInput label="Cell text size" value={first?.fontSize ?? table.fontSize ?? DEFAULT_SIZE} min={8} max={200} disabled={disabled} onCommit={(value) => format({ fontSize: value })} />
        </Field>
        <Field label="Border">
          <span className="flex items-center gap-1">
            <ColorInput label="Cell border color" value={resolveHex(first?.borderColor, theme)} fallback="#9ca3af" disabled={disabled} onChange={(color) => format({ borderColor: color })} />
            <NumberInput label="Cell border width" value={first?.borderWidth ?? table.borderWidth ?? DEFAULT_BORDER} min={0} max={20} disabled={disabled} onCommit={(value) => format({ borderWidth: value })} />
          </span>
        </Field>
      </Group>
    </div>
  );
}

const resolveHex = (value: string | undefined, theme: Theme) => resolveSlideColor(value, theme);

registerSlideInspectorSection({
  id: 'table',
  order: 10,
  applies: (ctx, scope) => scope === 'elements' && ctx.selection.length === 1 && ctx.selection[0].type === 'table',
  render: (ctx) => <TableInspector ctx={ctx} />,
});
