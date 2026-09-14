import type { ChartData } from '@paradocs/shared';
import { useSheetRef } from '../../lib/sheetRefs';
import { cx } from '../../lib/util';
import { ChartPlot } from './SheetChartView';

/**
 * How spreadsheet references look outside the spreadsheet. Documents and
 * canvases both draw from these, so a cell or a chart reads the same wherever
 * it is placed. Each asks for the spreadsheet's current value when it mounts.
 */

interface CellProps {
  spreadsheetId: string;
  sheetId: string;
  cell: string;
  label?: string;
}

interface ChartProps {
  spreadsheetId: string;
  sheetId: string;
  chartId: string;
  label?: string;
}

function useCell({ spreadsheetId, sheetId, cell, label }: CellProps) {
  const result = useSheetRef({ kind: 'cell', spreadsheetId, sheetId, cell });
  const name = label || cell;
  if (!result) return { text: name, source: 'Loading…', state: 'loading' as const };
  if (result.status !== 'ok' || result.kind !== 'cell') {
    return { text: `${name} (unavailable)`, source: 'This cell can’t be shown — the spreadsheet may be gone or not shared with you', state: 'missing' as const };
  }
  return {
    text: result.display,
    source: `${result.spreadsheetTitle} › ${result.sheetName}!${result.cell}`,
    state: result.isError ? ('error' as const) : ('ok' as const),
  };
}

/**
 * A cell's value in the middle of a sentence. The text is the value and
 * nothing else, which is also what copying it gives.
 */
export function SheetCellChip(props: CellProps) {
  const { text, source, state } = useCell(props);
  return (
    <span
      title={source}
      className={cx(
        'rounded px-1 font-medium tabular-nums',
        state === 'ok' && 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]',
        state === 'loading' && 'bg-[var(--color-surface)] text-[var(--color-muted)]',
        state === 'error' && 'bg-red-500/10 text-red-600',
        state === 'missing' && 'bg-amber-500/15 text-amber-600',
      )}
    >
      {text}
    </span>
  );
}

/** A cell on a board: its value large, with where it comes from beneath. */
export function SheetCellCard(props: CellProps) {
  const { text, source, state } = useCell(props);
  return (
    <div className="flex h-full w-full flex-col justify-center overflow-hidden rounded-lg border border-[var(--color-line)] bg-[var(--color-raised)] px-4 py-2">
      <span
        className={cx(
          'select-text truncate text-2xl font-semibold tabular-nums',
          state === 'error' && 'text-red-600',
          state === 'missing' && 'text-base text-amber-600',
          state === 'loading' && 'text-[var(--color-muted)]',
        )}
      >
        {text}
      </span>
      <span className="truncate text-[11px] text-[var(--color-muted)]">
        <span aria-hidden>▦ </span>
        {source}
      </span>
    </div>
  );
}

/** A chart as the spreadsheet draws it. `fill` stretches it to its container, as on a board. */
export function SheetChartCard({ fill, ...props }: ChartProps & { fill?: boolean }) {
  const result = useSheetRef({ kind: 'chart', ...props });
  const ok = result?.status === 'ok' && result.kind === 'chart' ? result : null;
  const title = ok?.title || props.label || 'Chart';
  return (
    <div
      contentEditable={false}
      className={cx(
        'flex w-full flex-col overflow-hidden rounded-lg border border-[var(--color-line)] bg-[var(--color-raised)]',
        fill ? 'h-full' : 'h-72',
      )}
    >
      <div className="flex items-baseline gap-2 border-b border-[var(--color-line)] px-3 py-1.5">
        <span className="truncate text-sm font-medium">{title}</span>
        {ok && (
          <span className="ml-auto truncate text-[11px] text-[var(--color-muted)]">
            {ok.spreadsheetTitle} › {ok.sheetName}
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 p-2">
        {ok ? (
          ok.data.series.length ? (
            <ChartPlot kind={ok.chartKind} data={ok.data} />
          ) : (
            <Empty>No numbers in this chart’s range</Empty>
          )
        ) : result ? (
          <Empty>This chart can’t be shown — it may have been deleted, or the spreadsheet isn’t shared with you</Empty>
        ) : (
          <Empty>Loading…</Empty>
        )}
      </div>
    </div>
  );
}

function Empty({ children }: { children: string }) {
  return <div className="grid h-full place-items-center px-4 text-center text-xs text-[var(--color-muted)]">{children}</div>;
}

/**
 * A chart as it leaves the editor — copied, or turned into markdown. Neither
 * has charts, so it goes as a titled table of the numbers it was drawn from.
 */
export function SheetChartTable(props: ChartProps) {
  const result = useSheetRef({ kind: 'chart', ...props });
  if (result?.status !== 'ok' || result.kind !== 'chart') {
    return <p>{`${props.label || 'Chart'} (unavailable)`}</p>;
  }
  return <ChartTable title={result.title || props.label || 'Chart'} data={result.data} />;
}

function ChartTable({ title, data }: { title: string; data: ChartData }) {
  return (
    <div>
      <p>
        <strong>{title}</strong>
      </p>
      <table>
        <thead>
          <tr>
            <th />
            {data.series.map((series) => (
              <th key={series.name}>{series.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.categories.map((category, index) => (
            <tr key={index}>
              <td>{category}</td>
              {data.series.map((series) => (
                <td key={series.name}>{series.values[index] ?? ''}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
