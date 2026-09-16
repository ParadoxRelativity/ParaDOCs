import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { isValidSheetRef, type SheetRef } from '@paradocs/shared';
import { useSpreadsheets } from '../../api/hooks';
import { fetchOutline, useSheetRef } from '../../lib/sheetRefs';
import { cx } from '../../lib/util';
import { Modal } from '../Modal';
import { Button } from '../ui';

export type PickedSheetRef = SheetRef & { label: string };

/**
 * Chooses a cell or a chart in one of the workspace's spreadsheets, for a
 * document or a board to show. What is inserted is where the value lives; the
 * value shown is fetched from the spreadsheet each time the page is opened.
 */
export default function SheetRefPicker({
  kind,
  workspaceId,
  confirmLabel,
  onInsert,
  onCancel,
}: {
  kind: 'cell' | 'chart';
  workspaceId: string;
  confirmLabel: string;
  onInsert: (ref: PickedSheetRef) => void;
  onCancel: () => void;
}) {
  const spreadsheets = useSpreadsheets(workspaceId);
  const [spreadsheetId, setSpreadsheetId] = useState('');
  const [sheetId, setSheetId] = useState('');
  const [cell, setCell] = useState('A1');
  const [chartId, setChartId] = useState('');

  const outline = useQuery({
    queryKey: ['spreadsheet-outline', spreadsheetId],
    queryFn: () => fetchOutline(spreadsheetId),
    enabled: Boolean(spreadsheetId),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const sheets = outline.data?.sheets ?? [];
  const charts = sheets.flatMap((sheet) => sheet.charts.map((chart) => ({ ...chart, sheetId: sheet.id, sheetName: sheet.name })));

  // A newly chosen spreadsheet starts on its first sheet, or its first chart.
  useEffect(() => {
    if (!outline.data) return;
    const firstChart = outline.data.sheets.flatMap((sheet) => sheet.charts.map((chart) => ({ sheet: sheet.id, chart: chart.id })))[0];
    if (kind === 'chart' && firstChart) {
      setSheetId(firstChart.sheet);
      setChartId(firstChart.chart);
    } else {
      setSheetId(outline.data.sheets[0]?.id ?? '');
      setChartId('');
    }
    // Only a different spreadsheet resets the choice, not a refetch of the same one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outline.data?.id]);

  const sheet = sheets.find((entry) => entry.id === sheetId);
  const address = cell.trim().toUpperCase();
  const ref: SheetRef | null =
    !spreadsheetId || !sheet
      ? null
      : kind === 'cell'
        ? { kind: 'cell', spreadsheetId, sheetId, cell: address }
        : chartId
          ? { kind: 'chart', spreadsheetId, sheetId, chartId }
          : null;
  const valid = ref !== null && isValidSheetRef(ref);
  const preview = useSheetRef(kind === 'cell' && valid ? ref : null);

  function submit() {
    if (!ref || !valid || !sheet) return;
    const label =
      ref.kind === 'cell' ? `${sheet.name}!${address}` : charts.find((chart) => chart.id === chartId)?.title || 'Chart';
    onInsert({ ...ref, label });
  }

  const field =
    'w-full rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]';
  const caption = 'mb-1 block text-xs text-[var(--color-muted)]';
  const available = (spreadsheets.data ?? []).filter((entry) => !entry.archivedAt);

  return (
    <Modal
      title={kind === 'cell' ? 'Insert a spreadsheet cell' : 'Insert a spreadsheet chart'}
      onClose={onCancel}
      footer={
        <>
          <Button variant="subtle" className="text-xs" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" className="text-xs" onClick={submit} disabled={!valid}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <label className="block">
          <span className={caption}>Spreadsheet</span>
          <select autoFocus className={field} value={spreadsheetId} onChange={(e) => setSpreadsheetId(e.target.value)}>
            <option value="">{available.length ? 'Choose a spreadsheet…' : 'This workspace has no spreadsheets yet'}</option>
            {available.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.title}
              </option>
            ))}
          </select>
        </label>

        {spreadsheetId && outline.isLoading && <p className="text-xs text-[var(--color-muted)]">Loading…</p>}
        {spreadsheetId && outline.isError && (
          <p className="text-xs text-amber-600">That spreadsheet couldn’t be opened.</p>
        )}

        {kind === 'cell' && sheets.length > 0 && (
          <>
            <div className="flex gap-2">
              <label className="min-w-0 flex-1">
                <span className={caption}>Sheet</span>
                <select className={field} value={sheetId} onChange={(e) => setSheetId(e.target.value)}>
                  {sheets.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="w-28">
                <span className={caption}>Cell</span>
                <input
                  className={cx(field, 'font-mono uppercase')}
                  value={cell}
                  onChange={(e) => setCell(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submit();
                  }}
                  placeholder="B5"
                  spellCheck={false}
                />
              </label>
            </div>
            <div className="rounded-md bg-[var(--color-surface)] px-3 py-2 text-sm">
              {!valid ? (
                <span className="text-[var(--color-muted)]">Enter a cell address like B5</span>
              ) : !preview ? (
                <span className="text-[var(--color-muted)]">Looking up {address}…</span>
              ) : preview.status === 'ok' && preview.kind === 'cell' ? (
                <>
                  <span className="text-[var(--color-muted)]">Currently shows </span>
                  <strong className="tabular-nums">{preview.display || '(empty)'}</strong>
                </>
              ) : (
                <span className="text-amber-600">That cell can’t be shown</span>
              )}
            </div>
          </>
        )}

        {kind === 'chart' && outline.data && (
          charts.length === 0 ? (
            <p className="text-xs text-[var(--color-muted)]">This spreadsheet has no charts yet. Add one from its toolbar.</p>
          ) : (
            <div className="scroll-thin max-h-56 space-y-1 overflow-y-auto" role="listbox" aria-label="Charts">
              {charts.map((chart) => {
                const chosen = chart.id === chartId;
                return (
                  <button
                    key={chart.id}
                    type="button"
                    role="option"
                    aria-selected={chosen}
                    onClick={() => {
                      setSheetId(chart.sheetId);
                      setChartId(chart.id);
                    }}
                    onDoubleClick={submit}
                    className={cx(
                      'flex w-full items-baseline gap-2 rounded-md border px-3 py-2 text-left text-sm',
                      chosen
                        ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]'
                        : 'border-[var(--color-line)] hover:bg-[var(--color-surface)]',
                    )}
                  >
                    <span className="truncate font-medium">{chart.title || 'Untitled chart'}</span>
                    <span className="ml-auto shrink-0 text-xs text-[var(--color-muted)]">
                      {chart.kind} · {chart.sheetName}!{chart.range}
                    </span>
                  </button>
                );
              })}
            </div>
          )
        )}
      </div>
    </Modal>
  );
}
