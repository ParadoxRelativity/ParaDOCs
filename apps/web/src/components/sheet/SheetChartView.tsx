import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CHART_COLORS,
  CHART_KINDS,
  MIN_CHART_HEIGHT,
  MIN_CHART_WIDTH,
  chartData,
  chartLines,
  chartRangeText,
  columnName,
  parseChartRanges,
  type CellRange,
  type CellValue,
  type ChartData,
  type ChartKind,
  type SheetChart,
} from '@paradocs/shared';
import { cx } from '../../lib/util';
import Icon from '../Icon';
import { Popover } from '../Popover';

const KIND_LABEL: Record<ChartKind, string> = { bar: 'Bar', line: 'Line', pie: 'Pie', scatter: 'Scatter' };

/** More rows than anyone ticks through by hand; past this, edit the range instead. */
const MAX_LISTED_ROWS = 500;

function display(value: CellValue): string {
  if (value === null) return '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return String(value);
}

/**
 * Which of a chart's rows and series it draws. Every row between its first and
 * last is listed, so a row left out can be put back; unticking one rewrites the
 * range with a gap where that row was, which keeps the chart following its data
 * as rows are inserted and deleted around it.
 */
function ChartDataPanel({
  chart,
  ranges,
  valueAt,
  onChange,
}: {
  chart: SheetChart;
  ranges: CellRange[] | null;
  valueAt: (row: number, column: number) => CellValue;
  onChange: (patch: Partial<SheetChart>) => void;
}) {
  const [text, setText] = useState(chart.range);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    setText(chart.range);
    setProblem(null);
  }, [chart.range]);

  const { rows, columns } = chartLines(ranges ?? []);
  const rowSet = new Set(rows);
  const columnSet = new Set(columns);
  const headerRow = chart.headers && rows.length > 1 ? rows[0] : null;
  const categoryColumn = chart.headers && columns.length > 1 ? columns[0] : null;

  const candidateRows: number[] = [];
  if (rows.length > 0) {
    const first = headerRow !== null ? headerRow + 1 : rows[0];
    for (let row = first; row <= rows[rows.length - 1] && candidateRows.length < MAX_LISTED_ROWS; row++) candidateRows.push(row);
  }
  const candidateColumns: number[] = [];
  if (columns.length > 0) {
    const first = categoryColumn !== null ? categoryColumn + 1 : columns[0];
    for (let column = first; column <= columns[columns.length - 1]; column++) candidateColumns.push(column);
  }
  const dataRowCount = rows.length - (headerRow !== null ? 1 : 0);
  const seriesCount = columns.length - (categoryColumn !== null ? 1 : 0);

  const commitText = () => {
    const cleaned = text.split(',').map((part) => part.trim()).filter(Boolean).join(',').toUpperCase();
    if (cleaned === chart.range) return;
    if (!parseChartRanges(cleaned)) {
      setProblem('Use ranges on this sheet, like A1:B10 or A1:A10,C1:C10');
      return;
    }
    setProblem(null);
    onChange({ range: cleaned });
  };

  const toggleRow = (row: number) => {
    const next = rowSet.has(row) ? rows.filter((entry) => entry !== row) : [...rows, row];
    onChange({ range: chartRangeText(next, columns) });
  };
  const toggleColumn = (column: number) => {
    const next = columnSet.has(column) ? columns.filter((entry) => entry !== column) : [...columns, column];
    onChange({ range: chartRangeText(rows, next) });
  };

  return (
    <div className="flex max-h-[26rem] flex-col text-xs" onPointerDown={(event) => event.stopPropagation()}>
      <div className="border-b border-[var(--color-line)] p-3">
        <label className="mb-1 block text-[11px] font-medium text-[var(--color-muted)]" htmlFor={`chart-range-${chart.id}`}>
          Data range
        </label>
        <input
          id={`chart-range-${chart.id}`}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onBlur={commitText}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commitText();
            }
          }}
          spellCheck={false}
          className="w-full rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-2 py-1 font-mono text-xs outline-none focus:border-[var(--color-accent)]"
        />
        {problem && <p className="mt-1 text-[11px] text-red-500">{problem}</p>}
      </div>

      {ranges && (
        <div className="min-h-0 overflow-y-auto p-3">
          {candidateColumns.length > 1 && (
            <>
              <div className="mb-1 text-[11px] font-medium text-[var(--color-muted)]">Series</div>
              <ul className="mb-3 flex flex-col">
                {candidateColumns.map((column) => {
                  const included = columnSet.has(column);
                  const name = headerRow !== null ? display(valueAt(headerRow, column)) : '';
                  return (
                    <li key={column}>
                      <label className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-[var(--color-surface)]">
                        <input
                          type="checkbox"
                          checked={included}
                          disabled={included && seriesCount <= 1}
                          onChange={() => toggleColumn(column)}
                        />
                        <span className="w-6 shrink-0 text-[var(--color-muted)]">{columnName(column)}</span>
                        <span className="truncate">{name}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </>
          )}

          <div className="mb-1 text-[11px] font-medium text-[var(--color-muted)]">Rows</div>
          <ul className="flex flex-col">
            {candidateRows.map((row) => {
              const included = rowSet.has(row);
              const name = display(valueAt(row, categoryColumn ?? columns[0]));
              return (
                <li key={row}>
                  <label className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-[var(--color-surface)]">
                    <input
                      type="checkbox"
                      checked={included}
                      disabled={included && dataRowCount <= 1}
                      onChange={() => toggleRow(row)}
                    />
                    <span className="w-8 shrink-0 tabular-nums text-[var(--color-muted)]">{row + 1}</span>
                    <span className={cx('truncate', !included && 'text-[var(--color-muted)] line-through')}>{name || '—'}</span>
                  </label>
                </li>
              );
            })}
          </ul>
          {candidateRows.length >= MAX_LISTED_ROWS && (
            <p className="mt-2 text-[11px] text-[var(--color-muted)]">Showing the first {MAX_LISTED_ROWS} rows. Edit the range for the rest.</p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One chart floating over the grid.
 *
 * It reads its numbers from the grid on every draw rather than holding a copy,
 * so typing into a cell it covers redraws it with no step in between. It can be
 * dragged by its title bar and resized from its corner; everything else about
 * it — kind, title, whether the range has headers — is a click away on the bar.
 */
export default function SheetChartView({
  chart,
  valueAt,
  editable,
  selected,
  onSelect,
  onChange,
  onDelete,
}: {
  chart: SheetChart;
  valueAt: (row: number, column: number) => CellValue;
  editable: boolean;
  selected: boolean;
  onSelect: () => void;
  onChange: (patch: Partial<SheetChart>) => void;
  onDelete: () => void;
}) {
  // Keyed on the range's text: parsing makes a new object every time, which
  // would otherwise recompute the series on every render of the editor.
  const range = useMemo(() => parseChartRanges(chart.range), [chart.range]);
  const data = useMemo(() => (range ? chartData(range, chart.headers, valueAt) : null), [range, chart.headers, valueAt]);
  const [draft, setDraft] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [dataAnchor, setDataAnchor] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!selected) setDataAnchor(null);
  }, [selected]);
  const gesture = useRef<{ kind: 'move' | 'resize'; startX: number; startY: number; origin: SheetChart } | null>(null);
  // Read from the window listeners below, which are set up once rather than on
  // every render; a parent passing a fresh callback each time must not tear
  // them down in the middle of a drag.
  const changeRef = useRef(onChange);
  changeRef.current = onChange;

  const box = draft ?? chart;

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const active = gesture.current;
      if (!active) return;
      const dx = event.clientX - active.startX;
      const dy = event.clientY - active.startY;
      const { origin } = active;
      setDraft(
        active.kind === 'move'
          ? { x: Math.max(0, origin.x + dx), y: Math.max(0, origin.y + dy), width: origin.width, height: origin.height }
          : {
              x: origin.x,
              y: origin.y,
              width: Math.max(MIN_CHART_WIDTH, origin.width + dx),
              height: Math.max(MIN_CHART_HEIGHT, origin.height + dy),
            },
      );
    };
    const onUp = () => {
      if (!gesture.current) return;
      gesture.current = null;
      // One write per gesture, so collaborators see the chart land rather than
      // a stream of intermediate positions.
      setDraft((current) => {
        if (current) changeRef.current(current);
        return null;
      });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, []);

  /**
   * Selecting a chart gives the grid the keyboard, so Delete and Escape reach
   * the chart — unless the press was on one of its own controls, which keep it.
   */
  const select = (event: React.PointerEvent) => {
    const target = event.target as HTMLElement;
    if (!target.closest('input, select, button, label')) {
      (event.currentTarget.closest('[role="grid"]') as HTMLElement | null)?.focus({ preventScroll: true });
    }
    onSelect();
  };

  const start = (kind: 'move' | 'resize') => (event: React.PointerEvent) => {
    if (!editable || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    select(event);
    gesture.current = { kind, startX: event.clientX, startY: event.clientY, origin: chart };
  };

  return (
    <div
      data-chart={chart.id}
      onPointerDown={(event) => {
        event.stopPropagation();
        select(event);
      }}
      // The grid underneath opens a cell on double-click; a double-click on a
      // chart is not aimed at the cell hidden behind it. Nor is a right-click.
      onDoubleClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
      className={cx(
        'absolute z-20 flex flex-col overflow-hidden rounded-lg border bg-[var(--color-raised)] shadow-lg',
        selected ? 'border-[var(--color-accent)] ring-2 ring-[var(--color-accent)]/30' : 'border-[var(--color-line)]',
      )}
      style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
    >
      <div
        onPointerDown={start('move')}
        className={cx(
          'flex h-8 shrink-0 items-center gap-1 border-b border-[var(--color-line)] px-2',
          editable && 'cursor-move',
        )}
      >
        {editable && selected ? (
          <input
            value={chart.title}
            onPointerDown={(event) => event.stopPropagation()}
            onChange={(event) => onChange({ title: event.target.value })}
            placeholder="Chart title"
            aria-label="Chart title"
            className="min-w-0 flex-1 bg-transparent text-xs font-medium outline-none"
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{chart.title || 'Chart'}</span>
        )}
        {editable && selected && (
          <>
            <select
              value={chart.kind}
              onPointerDown={(event) => event.stopPropagation()}
              onChange={(event) => onChange({ kind: event.target.value as ChartKind })}
              aria-label="Chart type"
              className="rounded border border-[var(--color-line)] bg-[var(--color-canvas)] px-1 text-[11px] outline-none"
            >
              {CHART_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {KIND_LABEL[kind]}
                </option>
              ))}
            </select>
            <label
              className="flex items-center gap-1 text-[11px] text-[var(--color-muted)]"
              onPointerDown={(event) => event.stopPropagation()}
              title="The first row names the series and the first column names the categories"
            >
              <input type="checkbox" checked={chart.headers} onChange={(event) => onChange({ headers: event.target.checked })} />
              Headers
            </label>
            <button
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => setDataAnchor(dataAnchor ? null : event.currentTarget)}
              aria-label="Choose the data"
              aria-expanded={dataAnchor !== null}
              title="Choose the rows and series to chart"
              className={cx(
                'grid h-6 w-6 place-items-center rounded hover:bg-[var(--color-surface)]',
                dataAnchor ? 'text-[var(--color-accent)]' : 'text-[var(--color-muted)] hover:text-[var(--color-ink)]',
              )}
            >
              <Icon name="sliders" />
            </button>
            {dataAnchor && (
              <Popover anchor={dataAnchor} placement="below" onClose={() => setDataAnchor(null)} className="w-72">
                <ChartDataPanel chart={chart} ranges={range} valueAt={valueAt} onChange={onChange} />
              </Popover>
            )}
            <button
              onPointerDown={(event) => event.stopPropagation()}
              onClick={onDelete}
              aria-label="Delete chart"
              title="Delete chart"
              className="grid h-6 w-6 place-items-center rounded text-[var(--color-muted)] hover:bg-[var(--color-surface)] hover:text-red-500"
            >
              <Icon name="trash3" />
            </button>
          </>
        )}
      </div>

      <div className="relative min-h-0 flex-1 p-2">
        {!range ? (
          <div className="grid h-full place-items-center text-center text-xs text-[var(--color-muted)]">
            The data this chart drew from was deleted.
          </div>
        ) : data && data.series.length > 0 ? (
          <ChartPlot kind={chart.kind} data={data} />
        ) : (
          <div className="grid h-full place-items-center text-xs text-[var(--color-muted)]">No numbers in {chart.range}</div>
        )}
      </div>

      {editable && (
        <span
          onPointerDown={start('resize')}
          aria-hidden
          className="absolute bottom-0 right-0 h-3.5 w-3.5 cursor-nwse-resize"
          style={{
            background: 'linear-gradient(135deg, transparent 50%, var(--color-muted) 50%, var(--color-muted) 60%, transparent 60%, transparent 75%, var(--color-muted) 75%, var(--color-muted) 85%, transparent 85%)',
          }}
        />
      )}
    </div>
  );
}

// --- drawing ------------------------------------------------------------------

const VIEW_W = 400;
const VIEW_H = 240;
const PAD = { top: 10, right: 12, bottom: 34, left: 40 };

/** Round numbers for an axis that starts at zero unless the data dips below it. */
function niceScale(min: number, max: number): { low: number; high: number; ticks: number[] } {
  const low = Math.min(0, min);
  const high = max <= low ? low + 1 : max;
  const rough = (high - low) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((candidate) => candidate >= rough) ?? rough;
  const start = Math.floor(low / step) * step;
  const end = Math.ceil(high / step) * step;
  const ticks: number[] = [];
  for (let tick = start; tick <= end + step / 2; tick += step) ticks.push(Number(tick.toPrecision(10)));
  return { low: start, high: end, ticks };
}

function short(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return String(Number(value.toPrecision(4)));
}

function Legend({ names }: { names: string[] }) {
  if (names.length < 2) return null;
  return (
    <div className="absolute right-2 top-1 flex max-w-[60%] flex-wrap justify-end gap-x-2 gap-y-0.5 text-[10px]">
      {names.map((name, index) => (
        <span key={`${name}-${index}`} className="flex items-center gap-1 text-[var(--color-muted)]">
          <span className="h-2 w-2 rounded-sm" style={{ background: CHART_COLORS[index % CHART_COLORS.length] }} />
          {name}
        </span>
      ))}
    </div>
  );
}

/** A chart's drawing alone, without the frame around it. Used wherever a chart is shown. */
export function ChartPlot({ kind, data }: { kind: ChartKind; data: ChartData }) {
  if (kind === 'pie') return <PiePlot data={data} />;

  const numbers = data.series.flatMap((series) => series.values.filter((v): v is number => v !== null));
  const xs = kind === 'scatter' ? data.categories.map(Number).filter(Number.isFinite) : [];
  const scale = niceScale(numbers.length ? Math.min(...numbers) : 0, numbers.length ? Math.max(...numbers) : 1);
  const plotW = VIEW_W - PAD.left - PAD.right;
  const plotH = VIEW_H - PAD.top - PAD.bottom;
  const yOf = (value: number) => PAD.top + plotH - ((value - scale.low) / (scale.high - scale.low)) * plotH;
  const count = Math.max(1, data.categories.length);
  const band = plotW / count;
  const xLow = xs.length ? Math.min(...xs) : 0;
  const xHigh = xs.length && Math.max(...xs) > xLow ? Math.max(...xs) : xLow + 1;
  const xOf = (index: number) =>
    kind === 'scatter' && xs.length === data.categories.length
      ? PAD.left + ((Number(data.categories[index]) - xLow) / (xHigh - xLow)) * plotW
      : PAD.left + band * index + band / 2;
  // Label every nth category, so a long axis does not become a black smear.
  const labelEvery = Math.ceil(count / 8);

  return (
    <>
      <Legend names={data.series.map((series) => series.name)} />
      <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} preserveAspectRatio="none" className="h-full w-full" role="img">
        {scale.ticks.map((tick) => (
          <g key={tick}>
            <line x1={PAD.left} x2={VIEW_W - PAD.right} y1={yOf(tick)} y2={yOf(tick)} stroke="var(--color-line)" strokeWidth={0.6} />
            <text x={PAD.left - 4} y={yOf(tick) + 3} textAnchor="end" fontSize={9} fill="var(--color-muted)">
              {short(tick)}
            </text>
          </g>
        ))}
        {data.categories.map((category, index) =>
          index % labelEvery === 0 ? (
            <text
              key={`${category}-${index}`}
              x={xOf(index)}
              y={VIEW_H - PAD.bottom + 13}
              textAnchor="middle"
              fontSize={9}
              fill="var(--color-muted)"
            >
              {category.length > 10 ? `${category.slice(0, 9)}…` : category}
            </text>
          ) : null,
        )}

        {data.series.map((series, seriesIndex) => {
          const color = CHART_COLORS[seriesIndex % CHART_COLORS.length];
          if (kind === 'bar') {
            const groupWidth = band * 0.8;
            const barWidth = groupWidth / data.series.length;
            return series.values.map((value, index) =>
              value === null ? null : (
                <rect
                  key={`${seriesIndex}-${index}`}
                  x={PAD.left + band * index + band * 0.1 + barWidth * seriesIndex}
                  y={Math.min(yOf(value), yOf(0))}
                  width={Math.max(1, barWidth - 1)}
                  height={Math.abs(yOf(value) - yOf(0))}
                  fill={color}
                  rx={1.5}
                >
                  <title>{`${series.name}, ${data.categories[index]}: ${value}`}</title>
                </rect>
              ),
            );
          }
          const points = series.values
            .map((value, index) => (value === null ? null : { x: xOf(index), y: yOf(value), value, index }))
            .filter((point): point is { x: number; y: number; value: number; index: number } => point !== null);
          return (
            <g key={seriesIndex}>
              {kind === 'line' && points.length > 1 && (
                <polyline
                  points={points.map((point) => `${point.x},${point.y}`).join(' ')}
                  fill="none"
                  stroke={color}
                  strokeWidth={2}
                  strokeLinejoin="round"
                />
              )}
              {points.map((point) => (
                <circle key={point.index} cx={point.x} cy={point.y} r={kind === 'scatter' ? 3.2 : 2.4} fill={color}>
                  <title>{`${series.name}, ${data.categories[point.index]}: ${point.value}`}</title>
                </circle>
              ))}
            </g>
          );
        })}
      </svg>
    </>
  );
}

function PiePlot({ data }: { data: ChartData }) {
  const values = data.series[0].values.map((value) => (value !== null && value > 0 ? value : 0));
  const total = values.reduce((a, b) => a + b, 0);
  if (total === 0) {
    return <div className="grid h-full place-items-center text-xs text-[var(--color-muted)]">A pie needs positive numbers</div>;
  }
  const cx0 = 120;
  const cy0 = 120;
  const r = 100;
  let angle = -Math.PI / 2;
  const slices = values.map((value, index) => {
    const sweep = (value / total) * Math.PI * 2;
    const start = angle;
    angle += sweep;
    const end = angle;
    const large = sweep > Math.PI ? 1 : 0;
    const path =
      sweep >= Math.PI * 2 - 1e-9
        ? `M ${cx0 - r} ${cy0} a ${r} ${r} 0 1 0 ${r * 2} 0 a ${r} ${r} 0 1 0 ${-r * 2} 0`
        : `M ${cx0} ${cy0} L ${cx0 + r * Math.cos(start)} ${cy0 + r * Math.sin(start)} A ${r} ${r} 0 ${large} 1 ${cx0 + r * Math.cos(end)} ${cy0 + r * Math.sin(end)} Z`;
    return { path, value, index };
  });

  return (
    <div className="flex h-full items-center gap-3">
      <svg viewBox="0 0 240 240" className="h-full max-h-full" role="img">
        {slices.map((slice) =>
          slice.value === 0 ? null : (
            <path key={slice.index} d={slice.path} fill={CHART_COLORS[slice.index % CHART_COLORS.length]} stroke="var(--color-raised)" strokeWidth={1.5}>
              <title>{`${data.categories[slice.index]}: ${slice.value} (${Math.round((slice.value / total) * 100)}%)`}</title>
            </path>
          ),
        )}
      </svg>
      <div className="flex min-w-0 flex-col gap-0.5 text-[10px]">
        {data.categories.map((category, index) => (
          <span key={`${category}-${index}`} className="flex items-center gap-1 truncate text-[var(--color-muted)]">
            <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: CHART_COLORS[index % CHART_COLORS.length] }} />
            <span className="truncate">{category}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
