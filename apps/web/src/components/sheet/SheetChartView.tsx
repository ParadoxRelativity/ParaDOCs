import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CHART_COLORS,
  CHART_KINDS,
  MIN_CHART_HEIGHT,
  MIN_CHART_WIDTH,
  chartData,
  parseChartRange,
  type CellValue,
  type ChartData,
  type ChartKind,
  type SheetChart,
} from '@paradocs/shared';
import { cx } from '../../lib/util';
import Icon from '../Icon';

const KIND_LABEL: Record<ChartKind, string> = { bar: 'Bar', line: 'Line', pie: 'Pie', scatter: 'Scatter' };

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
  const range = useMemo(() => parseChartRange(chart.range), [chart.range]);
  const data = useMemo(() => (range ? chartData(range, chart.headers, valueAt) : null), [range, chart.headers, valueAt]);
  const [draft, setDraft] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
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

  const start = (kind: 'move' | 'resize') => (event: React.PointerEvent) => {
    if (!editable || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    onSelect();
    gesture.current = { kind, startX: event.clientX, startY: event.clientY, origin: chart };
  };

  return (
    <div
      data-chart={chart.id}
      onPointerDown={(event) => {
        event.stopPropagation();
        onSelect();
      }}
      // The grid underneath opens a cell on double-click; a double-click on a
      // chart is not aimed at the cell hidden behind it.
      onDoubleClick={(event) => event.stopPropagation()}
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
