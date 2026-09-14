import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_COLUMN_WIDTH,
  MAIN_SHEET_ID,
  ROW_HEIGHT,
  columnName,
  formatValue,
  isError,
  normalizeRange,
  rangeName,
  type CellFormat,
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
import SheetGrid, { type Selection } from './SheetGrid';
import SheetTabs from './SheetTabs';
import SheetChartView from './SheetChartView';
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
  const titleRef = useRef<HTMLInputElement>(null);

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
  }, [sheet.sheetId]);

  /**
   * Charts the selected range, placed just to the right of it so the chart and
   * its data can be read side by side, which is where people look for it.
   */
  function insertChart() {
    if (range.top === range.bottom && range.left === range.right) {
      toast('Select the data to chart first — a column of numbers, or a table with headers.', 'error');
      return;
    }
    const widths = sheet.shape.columnWidths ?? {};
    let x = 0;
    for (let column = 0; column <= range.right; column++) x += widths[column] ?? DEFAULT_COLUMN_WIDTH;
    const id = sheet.addChart({
      kind: 'bar',
      title: '',
      range: rangeName(range),
      headers: true,
      x: x + 16,
      y: range.top * ROW_HEIGHT,
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

  const range = normalizeRange(selection.anchor, selection.focus);
  const focus = selection.focus;
  const focusText = sheet.text(focus.row, focus.column);
  const focusValue = sheet.value(focus.row, focus.column);
  const focusStyle = sheet.style(focus.row, focus.column);

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
    for (let row = range.top; row <= range.bottom; row++) {
      for (let column = range.left; column <= range.right; column++) {
        const value = sheet.value(row, column);
        if (value === null || value === '') continue;
        filled++;
        if (typeof value === 'number') numbers.push(value);
      }
    }
    if (numbers.length === 0) return filled > 0 ? `Count ${filled}` : null;
    const total = numbers.reduce((a, b) => a + b, 0);
    return `Sum ${trim(total)} · Average ${trim(total / numbers.length)} · Count ${numbers.length}`;
  }, [range, sheet]);

  // --- clipboard -------------------------------------------------------------
  // Tab-separated, which is what Excel and Sheets put on the clipboard, so a
  // range copied here pastes into them and back.
  useEffect(() => {
    const onCopy = (event: ClipboardEvent) => {
      if (editing || !isGridFocused()) return;
      const lines: string[] = [];
      for (let row = range.top; row <= range.bottom; row++) {
        const line: string[] = [];
        for (let column = range.left; column <= range.right; column++) {
          const value = sheet.value(row, column);
          line.push(isError(value) ? value : formatValue(value, sheet.style(row, column)));
        }
        lines.push(line.join('\t'));
      }
      event.clipboardData?.setData('text/plain', lines.join('\n'));
      event.preventDefault();
    };

    const onPaste = (event: ClipboardEvent) => {
      if (!canEdit || editing || !isGridFocused()) return;
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
      if (!canEdit || editing || !isGridFocused()) return;
      onCopy(event);
      sheet.clearRange(range);
    };

    document.addEventListener('copy', onCopy);
    document.addEventListener('paste', onPaste);
    document.addEventListener('cut', onCut);
    return () => {
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('paste', onPaste);
      document.removeEventListener('cut', onCut);
    };
  }, [canEdit, editing, range, sheet]);

  const styleSelection = (patch: CellStyle) => {
    if (!canEdit) return;
    sheet.styleRange(range, patch);
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
            <Tool label="Insert a row above" icon="arrow-bar-up" onClick={() => sheet.spliceLine('row', range.top, 1)} />
            <Tool label="Insert a column to the left" icon="arrow-bar-left" onClick={() => sheet.spliceLine('column', range.left, 1)} />
            <Tool
              label="Delete the selected rows"
              icon="trash3"
              onClick={() => sheet.spliceLine('row', range.top, -(range.bottom - range.top + 1))}
            />
            <Tool
              label="Delete the selected columns"
              icon="x-square"
              onClick={() => sheet.spliceLine('column', range.left, -(range.right - range.left + 1))}
            />
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
        <div className="flex w-28 shrink-0 items-center justify-center border-r border-[var(--color-line)] px-2 text-xs font-medium">
          {rangeName(range)}
        </div>
        <div className="flex w-7 shrink-0 items-center justify-center border-r border-[var(--color-line)] text-[11px] text-[var(--color-muted)]">
          <Icon name="braces-asterisk" />
        </div>
        <input
          value={formulaDraft ?? (editing ? editing.value : focusText)}
          readOnly={!canEdit}
          placeholder={canEdit ? 'Enter a value, or = to start a formula' : ''}
          onChange={(event) => setFormulaDraft(event.target.value)}
          onFocus={() => setFormulaDraft(focusText)}
          onBlur={() => {
            if (formulaDraft !== null && formulaDraft !== focusText) commit(focus, formulaDraft, 'none');
            setFormulaDraft(null);
          }}
          onKeyDown={(event) => {
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
      </div>

      <SheetGrid
        sheet={sheet}
        selection={selection}
        onSelectionChange={(next) => {
          setSelection(next);
          setFormulaDraft(null);
          setSelectedChartId(null);
        }}
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
