import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_COLUMN_WIDTH,
  MAIN_SHEET_ID,
  ROW_HEIGHT,
  cellKey,
  chartLines,
  columnName,
  formatValue,
  isError,
  normalizeRange,
  parseCellKey,
  rangeName,
  type CellFormat,
  type CellRange,
  type CellRef,
  type CellStyle,
  type SpreadsheetSummary,
} from '@paradocs/shared';
import type { CollabSession, Peer } from '../../lib/collaboration';
import { useSheet } from '../../lib/sheetStore';
import { cx, useAutosave } from '../../lib/util';
import { claimNewDocument } from '../../lib/newDocuments';
import { useToast } from '../Toast';
import { Tooltip } from '../ui';
import Icon, { type IconName } from '../Icon';
import SheetGrid, { selectionRanges, type GridMenuTarget, type Selection } from './SheetGrid';
import SheetTabs from './SheetTabs';
import SheetChartView from './SheetChartView';
import SheetContextMenu, { type SheetMenuItem } from './SheetContextMenu';
import { useFormulaAssist } from './FormulaAssist';
import { applyImport, claimImport } from '../../lib/sheetImport';
import { downloadBlob, exportXlsx } from '../../lib/xlsx';

interface Props {
  sheet: SpreadsheetSummary;
  canEdit: boolean;
  session: CollabSession;
  peers: Peer[];
  onRename: (title: string) => void;
}

const FORMATS: { id: CellFormat; label: string; icon?: IconName }[] = [
  { id: 'general', label: 'Automatic' },
  { id: 'number', label: 'Number' },
  { id: 'integer', label: 'Whole number' },
  { id: 'currency', label: 'Currency' },
  { id: 'percent', label: 'Percent' },
  { id: 'scientific', label: 'Scientific' },
  { id: 'date', label: 'Date' },
  { id: 'datetime', label: 'Date and time' },
  { id: 'time', label: 'Time' },
  { id: 'text', label: 'Plain text' },
];

/**
 * A spreadsheet.
 *
 * Its own record in its own application, sharing only the collaboration
 * machinery with documents. What is particular to it is above the grid: the
 * name box and formula bar that say where you are and what is really in the
 * cell, and a toolbar of the things people reach for while looking at data
 * rather than writing it.
 */
export default function SheetEditor({ sheet: record, canEdit, session, peers, onRename }: Props) {
  const [activeSheetId, setActiveSheetId] = useState(MAIN_SHEET_ID);
  const sheet = useSheet(session.ydoc, activeSheetId);
  const toast = useToast();
  const [exporting, setExporting] = useState(false);
  const [selectedChartId, setSelectedChartId] = useState<string | null>(null);
  const [title, setTitle] = useState(record.title);
  const [selection, setSelection] = useState<Selection>({
    anchor: { row: 0, column: 0 },
    focus: { row: 0, column: 0 },
  });
  const [editing, setEditing] = useState<{ ref: CellRef; value: string } | null>(null);
  const [formulaDraft, setFormulaDraft] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; target: GridMenuTarget } | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const formulaInput = useRef<HTMLInputElement>(null);
  const formulaAssist = useFormulaAssist(formulaInput, formulaDraft, setFormulaDraft);

  useEffect(() => setTitle(record.title), [record.id, record.title]);

  const titleSave = useAutosave<string>((value) => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== record.title) onRename(trimmed);
  }, 600);

  // A sheet made a moment ago opens on its name, the way a new document does.
  useEffect(() => {
    if (!canEdit || !claimNewDocument(record.id)) return;
    titleRef.current?.focus();
    titleRef.current?.select();
  }, [record.id, canEdit]);

  // A spreadsheet made by importing a file arrives empty, with the file's
  // contents waiting to be written into it once its grid exists.
  useEffect(() => {
    const pending = claimImport(record.id);
    if (!pending || !canEdit) return;
    applyImport(session.ydoc, pending.sheets);
    const first = pending.sheets[0];
    toast(
      pending.truncated
        ? `Imported ${pending.sheets.length} sheet(s). Some cells past the size limit were left out.`
        : `Imported ${pending.sheets.length} sheet${pending.sheets.length === 1 ? '' : 's'}${first ? ` from ${pending.fileName}` : ''}`,
    );
    // Claiming consumes it, so this runs once per imported spreadsheet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.id]);

  // Moving to another sheet starts at its top-left; a selection from the last
  // sheet would point at cells that mean something else here.
  useEffect(() => {
    setSelection({ anchor: { row: 0, column: 0 }, focus: { row: 0, column: 0 } });
    setEditing(null);
    setFormulaDraft(null);
    setSelectedChartId(null);
    setMenu(null);
  }, [sheet.sheetId]);

  /** The range being made now; toolbar commands that need one place act on it. */
  const range = normalizeRange(selection.anchor, selection.focus);
  /** Every range selected, including ones picked earlier with ⌘/Ctrl. */
  const ranges = useMemo(() => selectionRanges(selection), [selection]);
  const focus = selection.focus;
  const focusText = sheet.text(focus.row, focus.column);
  const focusValue = sheet.value(focus.row, focus.column);
  const focusStyle = sheet.style(focus.row, focus.column);
  const selectedChart = sheet.charts.find((chart) => chart.id === selectedChartId) ?? null;

  /**
   * What to chart from the selection. A whole column selected reads down to
   * its last filled row rather than the foot of the sheet, and a whole row
   * across to its last filled column, so the chart is not mostly blanks.
   */
  function chartSource(): CellRange[] {
    const { rows, columns } = chartLines(ranges);
    const rowSet = new Set(rows);
    const columnSet = new Set(columns);
    let lastRow = -1;
    let lastColumn = -1;
    for (const key of sheet.raw.keys()) {
      const ref = parseCellKey(key);
      if (!ref) continue;
      if (columnSet.has(ref.column)) lastRow = Math.max(lastRow, ref.row);
      if (rowSet.has(ref.row)) lastColumn = Math.max(lastColumn, ref.column);
    }
    return ranges.map((entry) => ({
      ...entry,
      bottom: entry.bottom === sheet.shape.rows - 1 && lastRow >= entry.top ? Math.min(entry.bottom, lastRow) : entry.bottom,
      right: entry.right === sheet.shape.columns - 1 && lastColumn >= entry.left ? Math.min(entry.right, lastColumn) : entry.right,
    }));
  }

  /**
   * Charts the selected range, placed just to the right of it so the chart and
   * its data can be read side by side, which is where people look for it.
   */
  function insertChart() {
    const source = chartSource();
    const { rows, columns } = chartLines(source);
    if (rows.length * columns.length <= 1) {
      toast('Select the data to chart first — a column of numbers, or a table with headers.', 'error');
      return;
    }
    const widths = sheet.shape.columnWidths ?? {};
    const right = columns[columns.length - 1];
    let x = 0;
    for (let column = 0; column <= right; column++) x += widths[column] ?? DEFAULT_COLUMN_WIDTH;
    const id = sheet.addChart({
      kind: 'bar',
      title: '',
      range: source.map(rangeName).join(','),
      headers: true,
      x: x + 16,
      y: rows[0] * ROW_HEIGHT,
      width: 440,
      height: 290,
    });
    setSelectedChartId(id);
  }

  async function exportFile() {
    setExporting(true);
    try {
      const blob = await exportXlsx({
        title: record.title,
        sheets: sheet.sheets.map((entry) => ({
          name: entry.name,
          raw: sheet.workbookRaw.get(entry.id) ?? new Map(),
          values: sheet.workbookValues.get(entry.id) ?? new Map(),
          styles: sheet.workbookStyles.get(entry.id) ?? new Map(),
          meta: sheet.workbookMeta.get(entry.id)!,
        })),
      });
      downloadBlob(blob, `${record.title.replace(/[\\/:*?"<>|]/g, '').trim() || 'spreadsheet'}.xlsx`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not export the spreadsheet', 'error');
    } finally {
      setExporting(false);
    }
  }

  const commit = useCallback(
    (ref: CellRef, value: string, move: 'down' | 'right' | 'none') => {
      if (canEdit) sheet.setCell(ref.row, ref.column, value);
      setEditing(null);
      setFormulaDraft(null);
      if (move === 'none') return;
      const next: CellRef =
        move === 'down'
          ? { row: Math.min(sheet.shape.rows - 1, ref.row + 1), column: ref.column }
          : { row: ref.row, column: Math.min(sheet.shape.columns - 1, ref.column + 1) };
      setSelection({ anchor: next, focus: next });
    },
    [canEdit, sheet],
  );

  /**
   * What the selection adds up to, shown along the bottom. It is the one thing
   * a spreadsheet offers without being asked, because "what do these add up
   * to" is the question people select a range in order to answer.
   */
  const summary = useMemo(() => {
    const numbers: number[] = [];
    let filled = 0;
    // Ranges picked separately can overlap; a cell in two of them counts once.
    const seen = ranges.length > 1 ? new Set<string>() : null;
    for (const entry of ranges) {
      for (let row = entry.top; row <= entry.bottom; row++) {
        for (let column = entry.left; column <= entry.right; column++) {
          if (seen) {
            const key = cellKey(row, column);
            if (seen.has(key)) continue;
            seen.add(key);
          }
          const value = sheet.value(row, column);
          if (value === null || value === '') continue;
          filled++;
          if (typeof value === 'number') numbers.push(value);
        }
      }
    }
    if (numbers.length === 0) return filled > 0 ? `Count ${filled}` : null;
    const total = numbers.reduce((a, b) => a + b, 0);
    return `Sum ${trim(total)} · Average ${trim(total / numbers.length)} · Count ${numbers.length}`;
  }, [ranges, sheet]);

  // --- clipboard -------------------------------------------------------------
  // Tab-separated, which is what Excel and Sheets put on the clipboard, so a
  // range copied here pastes into them and back.
  useEffect(() => {
    /**
     * Ranges picked apart copy as one block when they line up — whole columns
     * over the same rows, or rows over the same columns — closed up the way
     * Excel does. Ranges that do not line up copy the one made last.
     */
    const copied = () => {
      const alignedRows = ranges.every((entry) => entry.top === ranges[0].top && entry.bottom === ranges[0].bottom);
      const alignedColumns = ranges.every((entry) => entry.left === ranges[0].left && entry.right === ranges[0].right);
      return chartLines(alignedRows || alignedColumns ? ranges : [range]);
    };

    const onCopy = (event: ClipboardEvent) => {
      if (editing || selectedChartId || !isGridFocused()) return;
      const { rows, columns } = copied();
      const lines = rows.map((row) =>
        columns
          .map((column) => {
            const value = sheet.value(row, column);
            return isError(value) ? value : formatValue(value, sheet.style(row, column));
          })
          .join('\t'),
      );
      event.clipboardData?.setData('text/plain', lines.join('\n'));
      event.preventDefault();
    };

    const onPaste = (event: ClipboardEvent) => {
      if (!canEdit || editing || selectedChartId || !isGridFocused()) return;
      const text = event.clipboardData?.getData('text/plain');
      if (!text) return;
      event.preventDefault();
      const rows = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
      const entries: { row: number; column: number; input: string }[] = [];
      rows.forEach((line, rowOffset) => {
        line.split('\t').forEach((cell, columnOffset) => {
          const row = range.top + rowOffset;
          const column = range.left + columnOffset;
          if (row < sheet.shape.rows && column < sheet.shape.columns) {
            entries.push({ row, column, input: cell });
          }
        });
      });
      sheet.setCells(entries);
      const bottom = Math.min(sheet.shape.rows - 1, range.top + rows.length - 1);
      const right = Math.min(
        sheet.shape.columns - 1,
        range.left + Math.max(...rows.map((line) => line.split('\t').length)) - 1,
      );
      setSelection({ anchor: { row: range.top, column: range.left }, focus: { row: bottom, column: right } });
    };

    const onCut = (event: ClipboardEvent) => {
      if (!canEdit || editing || selectedChartId || !isGridFocused()) return;
      onCopy(event);
      const { rows, columns } = copied();
      session.ydoc.transact(() => {
        for (const row of rows) for (const column of columns) sheet.setCell(row, column, '');
      });
    };

    document.addEventListener('copy', onCopy);
    document.addEventListener('paste', onPaste);
    document.addEventListener('cut', onCut);
    return () => {
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('paste', onPaste);
      document.removeEventListener('cut', onCut);
    };
  }, [canEdit, editing, range, ranges, selectedChartId, session.ydoc, sheet]);

  const styleSelection = (patch: CellStyle) => {
    if (!canEdit) return;
    session.ydoc.transact(() => {
      for (const entry of ranges) sheet.styleRange(entry, patch);
    });
  };

  const sort = (direction: 'asc' | 'desc') => {
    if (!canEdit) return;
    if (range.top === range.bottom) {
      toast('Select the rows to sort first', 'error');
      return;
    }
    sheet.sortRange(range, range.left, direction);
    toast(`Sorted ${rangeName(range)} by column ${columnName(range.left)}`);
  };

  // --- rows and columns ------------------------------------------------------

  /**
   * How many lines an insert adds: as many as are selected, the way Excel does
   * it — except when the selection runs the whole way along that axis (a whole
   * column selected, then "insert row"), where it is one.
   */
  const insertCount = (axis: 'row' | 'column') => {
    if (axis === 'row') {
      const whole = range.top === 0 && range.bottom === sheet.shape.rows - 1;
      return whole ? 1 : range.bottom - range.top + 1;
    }
    const whole = range.left === 0 && range.right === sheet.shape.columns - 1;
    return whole ? 1 : range.right - range.left + 1;
  };

  const insertLines = (axis: 'row' | 'column', side: 'before' | 'after') => {
    if (!canEdit) return;
    const count = insertCount(axis);
    const at =
      axis === 'row'
        ? side === 'before' ? range.top : range.bottom + 1
        : side === 'before' ? range.left : range.right + 1;
    sheet.spliceLine(axis, at, count);
  };

  /** Every row (or column) any selected range touches, in order. */
  const selectedLines = (axis: 'row' | 'column') => {
    const { rows, columns } = chartLines(ranges);
    return axis === 'row' ? rows : columns;
  };

  /**
   * Deletes every selected row or column, including ones picked apart. The
   * last run goes first, so the indices of the runs before it still hold.
   */
  const deleteLines = (axis: 'row' | 'column') => {
    if (!canEdit) return;
    const lines = selectedLines(axis);
    const runs: [number, number][] = [];
    for (const index of lines) {
      const last = runs.at(-1);
      if (last && index === last[1] + 1) last[1] = index;
      else runs.push([index, index]);
    }
    session.ydoc.transact(() => {
      for (const [first, last] of runs.reverse()) sheet.spliceLine(axis, first, -(last - first + 1));
    });
    const start = { row: range.top, column: range.left };
    setSelection({ anchor: start, focus: start });
  };

  const clearSelection = () => {
    if (!canEdit) return;
    session.ydoc.transact(() => {
      for (const entry of ranges) sheet.clearRange(entry);
    });
  };

  /** Keys on the grid while a chart is selected are the chart's. */
  const interceptGridKey = (event: React.KeyboardEvent): boolean => {
    if (!selectedChartId) return false;
    if (event.key === 'Escape' || event.key.startsWith('Arrow')) {
      event.preventDefault();
      setSelectedChartId(null);
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && canEdit) {
      event.preventDefault();
      sheet.deleteChart(selectedChartId);
      setSelectedChartId(null);
    }
    return true;
  };

  const menuItems = (target: GridMenuTarget): SheetMenuItem[] => {
    const rowCount = insertCount('row');
    const columnCount = insertCount('column');
    const rowWord = rowCount === 1 ? 'row' : `${rowCount} rows`;
    const columnWord = columnCount === 1 ? 'column' : `${columnCount} columns`;
    const deleteRows = selectedLines('row').length;
    const deleteColumns = selectedLines('column').length;
    const items: SheetMenuItem[] = [];

    if (target !== 'column') {
      items.push(
        { label: `Insert ${rowWord} above`, icon: 'arrow-bar-up', onSelect: () => insertLines('row', 'before') },
        { label: `Insert ${rowWord} below`, icon: 'arrow-bar-down', onSelect: () => insertLines('row', 'after') },
      );
    }
    if (target !== 'row') {
      items.push(
        { label: `Insert ${columnWord} left`, icon: 'arrow-bar-left', onSelect: () => insertLines('column', 'before') },
        { label: `Insert ${columnWord} right`, icon: 'arrow-bar-right', onSelect: () => insertLines('column', 'after') },
      );
    }
    items.push('divider');
    // Deleting every row of the sheet because a whole column was selected is never what was meant.
    if (target !== 'column' && deleteRows < sheet.shape.rows) {
      items.push({
        label: deleteRows === 1 ? 'Delete row' : `Delete ${deleteRows} rows`,
        icon: 'trash3',
        danger: true,
        onSelect: () => deleteLines('row'),
      });
    }
    if (target !== 'row' && deleteColumns < sheet.shape.columns) {
      items.push({
        label: deleteColumns === 1 ? 'Delete column' : `Delete ${deleteColumns} columns`,
        icon: 'x-square',
        danger: true,
        onSelect: () => deleteLines('column'),
      });
    }
    items.push(
      { label: 'Clear contents', icon: 'eraser', onSelect: clearSelection },
      'divider',
      { label: 'Chart the selection', icon: 'bar-chart', onSelect: insertChart },
    );
    return items;
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* --- toolbar --- */}
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-[var(--color-line)] px-3 py-2">
        <input
          ref={titleRef}
          value={title}
          readOnly={!canEdit}
          onChange={(event) => {
            setTitle(event.target.value);
            titleSave.schedule(event.target.value);
          }}
          onBlur={() => titleSave.flush()}
          placeholder="Untitled spreadsheet"
          className="min-w-32 max-w-64 flex-1 border-0 bg-transparent text-base font-semibold outline-none"
        />

        {canEdit && (
          <>
            <Divider />
            <select
              value={focusStyle?.format ?? 'general'}
              onChange={(event) => styleSelection({ format: event.target.value as CellFormat })}
              title="Number format"
              className="rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-1.5 py-1 text-xs outline-none"
            >
              {FORMATS.map((format) => (
                <option key={format.id} value={format.id}>
                  {format.label}
                </option>
              ))}
            </select>
            <Tool
              label="Fewer decimal places"
              icon="dash"
              onClick={() => styleSelection({ decimals: Math.max(0, (focusStyle?.decimals ?? 2) - 1) })}
            />
            <Tool
              label="More decimal places"
              icon="plus"
              onClick={() => styleSelection({ decimals: Math.min(9, (focusStyle?.decimals ?? 2) + 1) })}
            />

            <Divider />
            <Tool label="Bold" icon="type-bold" active={focusStyle?.bold} onClick={() => styleSelection({ bold: !focusStyle?.bold })} />
            <Tool label="Italic" icon="type-italic" active={focusStyle?.italic} onClick={() => styleSelection({ italic: !focusStyle?.italic })} />
            <Tool label="Align left" icon="text-left" onClick={() => styleSelection({ align: 'left' })} />
            <Tool label="Align centre" icon="text-center" onClick={() => styleSelection({ align: 'center' })} />
            <Tool label="Align right" icon="text-right" onClick={() => styleSelection({ align: 'right' })} />
            <Tool label="Clear formatting" icon="eraser" onClick={() => styleSelection({ format: undefined, bold: undefined, italic: undefined, align: undefined, decimals: undefined, background: undefined, color: undefined })} />

            <Divider />
            <Tool label="Sort selection A→Z by its first column" icon="sort-down" onClick={() => sort('asc')} />
            <Tool label="Sort selection Z→A by its first column" icon="sort-up" onClick={() => sort('desc')} />
            <Tool
              label="Sum the selection into the cell below it"
              icon="calculator"
              onClick={() => {
                const target = { row: range.bottom + 1, column: range.left };
                if (target.row >= sheet.shape.rows) return;
                sheet.setCell(target.row, target.column, `=SUM(${rangeName(range)})`);
                setSelection({ anchor: target, focus: target });
              }}
            />

            <Tool label="Chart the selection" icon="bar-chart" onClick={insertChart} />

            <Divider />
            <Tool label="Insert a row above" icon="arrow-bar-up" onClick={() => insertLines('row', 'before')} />
            <Tool label="Insert a row below" icon="arrow-bar-down" onClick={() => insertLines('row', 'after')} />
            <Tool label="Insert a column to the left" icon="arrow-bar-left" onClick={() => insertLines('column', 'before')} />
            <Tool label="Insert a column to the right" icon="arrow-bar-right" onClick={() => insertLines('column', 'after')} />
            <Tool label="Delete the selected rows" icon="trash3" onClick={() => deleteLines('row')} />
            <Tool label="Delete the selected columns" icon="x-square" onClick={() => deleteLines('column')} />
          </>
        )}

        <div className="ml-auto flex items-center gap-2 text-[11px] text-[var(--color-muted)]">
          {/* Reading a spreadsheet is enough to take a copy of it, so export is
              offered to viewers too. */}
          <Tool label={exporting ? 'Exporting…' : 'Export to Excel (.xlsx)'} icon="download" onClick={() => void exportFile()} />
          {peers.length > 0 && <span>{peers.length + 1} editing</span>}
          {!canEdit && <span className="rounded bg-[var(--color-surface)] px-1.5 py-0.5">Read only</span>}
        </div>
      </div>

      {/* --- name box and formula bar --- */}
      <div className="flex shrink-0 items-stretch border-b border-[var(--color-line)]">
        <div
          className="flex w-28 shrink-0 items-center justify-center border-r border-[var(--color-line)] px-2 text-xs font-medium"
          title={selectedChart ? selectedChart.range : ranges.map(rangeName).join(', ')}
        >
          <span className="truncate">{selectedChart ? 'Chart' : ranges.map(rangeName).join(',')}</span>
        </div>
        <div className="flex w-7 shrink-0 items-center justify-center border-r border-[var(--color-line)] text-[11px] text-[var(--color-muted)]">
          <Icon name="braces-asterisk" />
        </div>
        <input
          ref={formulaInput}
          value={formulaDraft ?? (editing ? editing.value : focusText)}
          readOnly={!canEdit}
          placeholder={canEdit ? 'Enter a value, or = to start a formula' : ''}
          onChange={(event) => setFormulaDraft(event.target.value)}
          onSelect={formulaAssist.onSelect}
          onFocus={() => setFormulaDraft(focusText)}
          onBlur={() => {
            if (formulaDraft !== null && formulaDraft !== focusText) commit(focus, formulaDraft, 'none');
            setFormulaDraft(null);
          }}
          onKeyDown={(event) => {
            if (formulaAssist.onKeyDown(event)) return;
            if (event.key === 'Enter') {
              event.preventDefault();
              commit(focus, formulaDraft ?? focusText, 'down');
              event.currentTarget.blur();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              setFormulaDraft(null);
              event.currentTarget.blur();
            }
          }}
          className="min-w-0 flex-1 bg-transparent px-2 text-xs outline-none"
        />
        {canEdit && formulaAssist.popup}
      </div>

      <SheetGrid
        sheet={sheet}
        selection={selection}
        selectionVisible={selectedChartId === null}
        onSelectionChange={(next) => {
          setSelection(next);
          setFormulaDraft(null);
          setSelectedChartId(null);
        }}
        interceptKey={interceptGridKey}
        onOpenMenu={
          canEdit
            ? (next) => {
                setSelectedChartId(null);
                setMenu(next);
              }
            : undefined
        }
        overlay={sheet.charts.map((chart) => (
          <SheetChartView
            key={chart.id}
            chart={chart}
            valueAt={sheet.value}
            editable={canEdit}
            selected={selectedChartId === chart.id}
            onSelect={() => setSelectedChartId(chart.id)}
            onChange={(patch) => sheet.updateChart(chart.id, patch)}
            onDelete={() => {
              sheet.deleteChart(chart.id);
              setSelectedChartId(null);
            }}
          />
        ))}
        editable={canEdit}
        editing={editing}
        onEditingChange={setEditing}
        onCommit={commit}
      />

      {menu && <SheetContextMenu x={menu.x} y={menu.y} items={menuItems(menu.target)} onClose={() => setMenu(null)} />}

      <SheetTabs
        sheets={sheet.sheets}
        activeId={sheet.sheetId}
        canEdit={canEdit}
        onSelect={setActiveSheetId}
        onAdd={() => setActiveSheetId(sheet.addSheet())}
        onRename={sheet.renameSheet}
        onDelete={(id) => {
          const problem = sheet.deleteSheet(id);
          if (problem) toast(problem, 'error');
        }}
        onMove={sheet.moveSheet}
        onProblem={(message) => toast(message, 'error')}
      />

      {/* --- status bar --- */}
      <div className="flex h-7 shrink-0 items-center justify-between border-t border-[var(--color-line)] px-3 text-[11px] text-[var(--color-muted)]">
        <span className="truncate">
          {isError(focusValue) ? (
            <span className="text-red-500">{focusValue} — check the formula in {rangeName(range)}</span>
          ) : (
            `${sheet.shape.rows} rows × ${sheet.shape.columns} columns`
          )}
        </span>
        {summary && <span className="shrink-0 tabular-nums">{summary}</span>}
      </div>
    </div>
  );
}

/** Rounded for display only; the cell itself keeps every digit. */
function trim(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
}

/**
 * Copy and paste belong to the grid, not to the page. Without this, copying in
 * the title field or a dialog would put a block of cells on the clipboard.
 */
function isGridFocused(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLElement && active.getAttribute('role') === 'grid';
}

function Tool({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: IconName;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip label={label}>
      <button
        onClick={onClick}
        aria-label={label}
        aria-pressed={active}
        className={cx(
          'grid h-7 w-7 place-items-center rounded-md text-sm',
          active
            ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
            : 'text-[var(--color-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-ink)]',
        )}
      >
        <Icon name={icon} />
      </button>
    </Tooltip>
  );
}

function Divider() {
  return <span className="mx-1 h-5 w-px shrink-0 bg-[var(--color-line)]" />;
}
