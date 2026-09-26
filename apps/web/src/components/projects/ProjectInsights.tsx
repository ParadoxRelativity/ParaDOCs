import { useMemo, useState, type ReactNode } from 'react';
import {
  INSIGHTS_RANGES,
  STALE_DAYS,
  insightsRangeStart,
  projectInsights,
  type DurationStats,
  type InsightsRange,
  type Project,
  type ProjectInsights as Insights,
  type WorkItemSummary,
} from '@paradocs/shared';
import { useArchivedWorkItems, useWorkItemResponses } from '../../api/hooks';
import { cx, useLocalStorage } from '../../lib/util';
import Icon, { type IconName } from '../Icon';
import { Spinner } from '../ui';
import { PRIORITY, PriorityIcon } from './projectUi';

const RANGE_LABEL: Record<InsightsRange, string> = { 30: '30 days', 90: '90 days', 180: '6 months', 365: '12 months' };

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A span of time as it reads at a glance: 40m, 5.5h, 3.2d. */
function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  if (ms < 2 * DAY) return `${Number((ms / HOUR).toFixed(1))}h`;
  return `${Number((ms / DAY).toFixed(1))}d`;
}

function formatNumber(value: number): string {
  return String(Number(value.toFixed(1)));
}

function weekLabel(start: string): string {
  return new Date(`${start}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * How a project or queue has been doing: work coming in against work going
 * out, how often due dates are met, sprint velocity for a project run in
 * sprints, and for a queue how quickly requests get a first response and get
 * resolved. Worked out from the items already loaded, plus when each queue item
 * was first responded to.
 */
export default function ProjectInsights({ project, items }: { project: Project; items: WorkItemSummary[] }) {
  const [stored, setRange] = useLocalStorage<InsightsRange>('paradocs.insightsRange', 90);
  const range = INSIGHTS_RANGES.includes(stored) ? stored : 90;
  const queue = project.kind === 'queue';
  // Only work filed or finished within the range counts here, besides what is
  // current; it is asked for from the start of the day the range starts, so
  // the key holds all day.
  const since = useMemo(() => insightsRangeStart(range).toISOString(), [range]);
  const responses = useWorkItemResponses(queue ? project.id : undefined, since);
  const archived = useArchivedWorkItems(project.id, { enabled: project.archive.count > 0, completedSince: since });

  const insights = useMemo(
    () =>
      projectInsights(project, [...items, ...(archived.data ?? [])], {
        range,
        responses: queue ? (responses.data ?? null) : null,
      }),
    [project, items, archived.data, range, queue, responses.data],
  );

  if ((queue && responses.isLoading) || archived.isLoading) return <Spinner />;

  return (
    <div className="scroll-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-5 px-6 py-5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="flex-1 text-sm font-semibold">
            {queue ? 'How the queue is being worked' : 'How the project is going'}
          </h2>
          <div role="radiogroup" aria-label="Range" className="flex rounded-md border border-[var(--color-line)] p-0.5 text-xs">
            {INSIGHTS_RANGES.map((option) => (
              <button
                key={option}
                role="radio"
                aria-checked={insights.range === option}
                onClick={() => setRange(option)}
                className={cx(
                  'rounded px-2 py-0.5',
                  insights.range === option ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]' : 'text-[var(--color-muted)]',
                )}
              >
                {RANGE_LABEL[option]}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {queue ? <QueueTiles insights={insights} /> : <ProjectTiles insights={insights} />}
        </div>

        <Panel
          title="Filed and finished per week"
          hint={`${insights.created} filed · ${insights.completed} finished in the last ${RANGE_LABEL[insights.range]}`}
        >
          <BarChart
            series={[
              { name: 'Filed', color: 'var(--color-series-2)' },
              { name: 'Finished', color: 'var(--color-series-1)' },
            ]}
            groups={insights.flow.map((week) => ({
              key: week.start,
              label: weekLabel(week.start),
              title: `Week of ${weekLabel(week.start)}`,
              values: [week.created, week.completed],
            }))}
          />
        </Panel>

        {insights.velocity && <VelocityPanel velocity={insights.velocity} />}

        <div className="grid gap-5 md:grid-cols-2">
          <OpenWorkPanel insights={insights} queue={queue} />
          <PriorityPanel insights={insights} queue={queue} />
        </div>
      </div>
    </div>
  );
}

// --- tiles ---------------------------------------------------------------------

function Tile({ icon, label, value, detail, tone }: { icon: IconName; label: string; value: string; detail?: ReactNode; tone?: 'bad' }) {
  return (
    <div className="rounded-xl border border-[var(--color-line)] p-3">
      <div className="flex items-center gap-1.5 text-xs text-[var(--color-muted)]">
        <Icon name={icon} />
        {label}
      </div>
      <div className={cx('mt-1 text-2xl font-semibold tabular-nums', tone === 'bad' && 'text-red-500')}>{value}</div>
      {detail && <div className="mt-0.5 text-xs text-[var(--color-muted)]">{detail}</div>}
    </div>
  );
}

function durationDetail(stats: DurationStats, noun: string): string {
  if (stats.count === 0) return `No ${noun} in this range`;
  return `avg ${formatDuration(stats.average)} · 90% within ${formatDuration(stats.p90)}`;
}

function ProjectTiles({ insights }: { insights: Insights }) {
  const { dueDates, velocity, leadTime, open } = insights;
  const settled = dueDates.onTime + dueDates.late + dueDates.missed;
  return (
    <>
      <Tile
        icon="calendar-check"
        label="Due dates hit"
        value={dueDates.rate === null ? '—' : `${Math.round(dueDates.rate * 100)}%`}
        detail={
          settled === 0
            ? 'Nothing was due in this range'
            : `${dueDates.onTime} of ${settled} on time${dueDates.late ? ` · ${dueDates.late} late` : ''}${dueDates.missed ? ` · ${dueDates.missed} still open` : ''}`
        }
      />
      {velocity?.average ? (
        <Tile
          icon="speedometer2"
          label="Velocity"
          value={velocity.estimated ? formatNumber(velocity.average.estimate) : formatNumber(velocity.average.items)}
          detail={`${velocity.estimated ? 'estimate' : 'items'} per sprint, last ${Math.min(3, velocity.sprints.length)}`}
        />
      ) : (
        <Tile icon="speedometer2" label="Throughput" value={formatNumber(insights.throughput)} detail="items finished per week" />
      )}
      <Tile icon="hourglass-split" label="Lead time" value={formatDuration(leadTime.median)} detail={leadTime.count ? `median filed → done · ${durationDetail(leadTime, 'work finished')}` : durationDetail(leadTime, 'work finished')} />
      <Tile
        icon="exclamation-circle"
        label="Overdue"
        value={String(open.overdue)}
        tone={open.overdue ? 'bad' : undefined}
        detail={`of ${open.total - open.backlog} open on the board`}
      />
    </>
  );
}

function QueueTiles({ insights }: { insights: Insights }) {
  const response = insights.response!;
  return (
    <>
      <Tile icon="reply" label="Time to first response" value={formatDuration(response.median)} detail={response.count ? `median · ${durationDetail(response, 'responses')}` : durationDetail(response, 'responses')} />
      <Tile icon="check2-circle" label="Time to resolve" value={formatDuration(insights.leadTime.median)} detail={insights.leadTime.count ? `median · ${durationDetail(insights.leadTime, 'resolutions')}` : durationDetail(insights.leadTime, 'resolutions')} />
      <Tile
        icon="chat-left-dots"
        label="Awaiting response"
        value={String(insights.unanswered ?? 0)}
        tone={insights.unanswered ? 'bad' : undefined}
        detail={`of ${insights.open.total} open`}
      />
      <Tile
        icon="inboxes"
        label="Resolved per week"
        value={formatNumber(insights.throughput)}
        detail={`${insights.created} filed · ${insights.completed} resolved`}
      />
    </>
  );
}

// --- panels --------------------------------------------------------------------

function Panel({ title, hint, action, children }: { title: string; hint?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-[var(--color-line)] p-4">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-2">
        <h3 className="text-sm font-medium">{title}</h3>
        {hint && <span className="text-xs text-[var(--color-muted)]">{hint}</span>}
        <span className="flex-1" />
        {action}
      </div>
      {children}
    </section>
  );
}

function VelocityPanel({ velocity }: { velocity: NonNullable<Insights['velocity']> }) {
  const [measure, setMeasure] = useState<'items' | 'estimate'>(velocity.estimated ? 'estimate' : 'items');
  if (velocity.sprints.length === 0) {
    return (
      <Panel title="Sprint velocity">
        <p className="py-6 text-center text-sm text-[var(--color-muted)]">Velocity shows once a sprint has been completed.</p>
      </Panel>
    );
  }
  const average = velocity.average ? velocity.average[measure] : null;
  return (
    <Panel
      title="Sprint velocity"
      hint={average !== null ? `${formatNumber(average)} ${measure === 'items' ? 'items' : 'estimate'} per sprint over the last ${Math.min(3, velocity.sprints.length)}` : undefined}
      action={
        velocity.estimated && (
          <div role="radiogroup" aria-label="Measure" className="flex rounded-md border border-[var(--color-line)] p-0.5 text-xs">
            {(['estimate', 'items'] as const).map((option) => (
              <button
                key={option}
                role="radio"
                aria-checked={measure === option}
                onClick={() => setMeasure(option)}
                className={cx(
                  'rounded px-2 py-0.5',
                  measure === option ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]' : 'text-[var(--color-muted)]',
                )}
              >
                {option === 'items' ? 'Items' : 'Estimates'}
              </button>
            ))}
          </div>
        )
      }
    >
      <BarChart
        series={[{ name: measure === 'items' ? 'Items finished' : 'Estimate finished', color: 'var(--color-series-1)' }]}
        reference={average ?? undefined}
        groups={velocity.sprints.map((sprint) => ({
          key: sprint.id,
          label: sprint.name,
          title: `${sprint.name} · completed ${new Date(sprint.completedAt).toLocaleDateString()}`,
          values: [sprint[measure]],
        }))}
      />
    </Panel>
  );
}

function OpenWorkPanel({ insights, queue }: { insights: Insights; queue: boolean }) {
  const { open } = insights;
  const rows: { icon: IconName; label: string; value: string; bad?: boolean }[] = [
    ...(open.backlog ? [{ icon: 'inbox' as IconName, label: 'In the backlog', value: String(open.backlog) }] : []),
    { icon: 'circle', label: 'Not started', value: String(open.notStarted) },
    { icon: 'circle-half', label: 'In progress', value: String(open.inProgress) },
    { icon: 'sign-stop', label: 'Blocked by other work', value: String(open.blocked), bad: open.blocked > 0 },
    { icon: 'calendar-x', label: 'Past due', value: String(open.overdue), bad: open.overdue > 0 },
    { icon: 'clock-history', label: `Untouched for ${STALE_DAYS}+ days`, value: String(open.stale), bad: open.stale > 0 },
    { icon: 'hourglass-bottom', label: queue ? 'Oldest open request' : 'Oldest open item', value: formatDuration(open.oldest) },
  ];
  return (
    <Panel title="Open work" hint={`${open.total} open`}>
      <ul className="divide-y divide-[var(--color-line)] text-sm">
        {rows.map((row) => (
          <li key={row.label} className="flex items-center gap-2 py-1.5">
            <Icon name={row.icon} className="w-4 text-[var(--color-muted)]" />
            <span className="flex-1">{row.label}</span>
            <span className={cx('tabular-nums', row.bad && 'font-medium text-red-500')}>{row.value}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function PriorityPanel({ insights, queue }: { insights: Insights; queue: boolean }) {
  const rows = insights.priorities.filter((p) => p.open || p.completed);
  return (
    <Panel title="By priority" hint="medians">
      {rows.length === 0 ? (
        <p className="py-4 text-center text-sm text-[var(--color-muted)]">Nothing to show yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-[var(--color-muted)]">
              <th className="py-1 font-normal">Priority</th>
              <th className="py-1 text-right font-normal">Open</th>
              <th className="py-1 text-right font-normal">{queue ? 'Resolved' : 'Finished'}</th>
              {queue && <th className="py-1 text-right font-normal">Response</th>}
              <th className="py-1 text-right font-normal">{queue ? 'Resolve' : 'Lead time'}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-line)]">
            {rows.map((row) => (
              <tr key={row.priority}>
                <td className="py-1.5">
                  <span className="flex items-center gap-1.5">
                    <PriorityIcon priority={row.priority} className="w-4 justify-center" />
                    {PRIORITY[row.priority].label}
                  </span>
                </td>
                <td className="py-1.5 text-right tabular-nums">{row.open}</td>
                <td className="py-1.5 text-right tabular-nums">{row.completed}</td>
                {queue && <td className="py-1.5 text-right tabular-nums">{formatDuration(row.response)}</td>}
                <td className="py-1.5 text-right tabular-nums">{formatDuration(row.resolve)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

// --- chart ---------------------------------------------------------------------

/** A step that lands the axis on round numbers: 1, 2, 5, 10, 20, 50… */
function niceStep(max: number, ticks: number): number {
  const rough = Math.max(max, 1) / ticks;
  const power = 10 ** Math.floor(Math.log10(rough));
  const scaled = rough / power;
  return (scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10) * power;
}

/**
 * Bars in groups along a time axis, one bar per series in each group, with a
 * tooltip over whichever group is hovered or focused. Drawn with plain boxes so
 * it fits whatever width it is given.
 */
function BarChart({
  series,
  groups,
  reference,
}: {
  series: { name: string; color: string }[];
  groups: { key: string; label: string; title: string; values: number[] }[];
  /** A level to mark across the chart, such as an average. */
  reference?: number;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const max = Math.max(reference ?? 0, ...groups.flatMap((g) => g.values));
  const step = niceStep(max, 4);
  const top = Math.max(step, Math.ceil(max / step) * step);
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  // Label as many groups as fit comfortably; the tooltip names the rest.
  const labelEvery = Math.max(1, Math.ceil(groups.length / 10));
  const active = hovered === null ? null : groups[hovered];

  return (
    <div>
      {series.length > 1 && (
        <div className="mb-2 flex gap-4 text-xs text-[var(--color-muted)]">
          {series.map((s) => (
            <span key={s.name} className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <div className="relative h-40 w-7 shrink-0 text-right text-[10px] tabular-nums text-[var(--color-muted)]" aria-hidden>
          {ticks.map((tick) => (
            <span key={tick} className="absolute right-0 translate-y-1/2" style={{ bottom: `${(tick / top) * 100}%` }}>
              {formatNumber(tick)}
            </span>
          ))}
        </div>
        <div className="relative min-w-0 flex-1">
          <div className="relative h-40">
            {ticks.map((tick) => (
              <div
                key={tick}
                aria-hidden
                className={cx('absolute inset-x-0 border-t', tick === 0 ? 'border-[var(--color-muted)]/50' : 'border-[var(--color-line)]')}
                style={{ bottom: `${(tick / top) * 100}%` }}
              />
            ))}
            {reference !== undefined && reference > 0 && (
              <div
                aria-hidden
                className="absolute inset-x-0 border-t border-dashed border-[var(--color-ink)]/60"
                style={{ bottom: `${(reference / top) * 100}%` }}
              >
                <span className="absolute -top-4 right-0 rounded bg-[var(--color-canvas)] px-1 text-[10px] text-[var(--color-muted)]">
                  avg {formatNumber(reference)}
                </span>
              </div>
            )}
            <div className="absolute inset-0 flex">
              {groups.map((group, index) => (
                <div
                  key={group.key}
                  tabIndex={0}
                  role="img"
                  aria-label={`${group.title}: ${series.map((s, i) => `${s.name} ${formatNumber(group.values[i])}`).join(', ')}`}
                  onMouseEnter={() => setHovered(index)}
                  onMouseLeave={() => setHovered(null)}
                  onFocus={() => setHovered(index)}
                  onBlur={() => setHovered(null)}
                  className={cx(
                    'flex h-full min-w-0 flex-1 items-end justify-center gap-[2px] px-[12%] outline-none',
                    hovered === index && 'bg-[var(--color-surface)]',
                  )}
                >
                  {group.values.map((value, i) => (
                    <div
                      key={series[i].name}
                      className="w-full max-w-6 rounded-t-[4px]"
                      style={{ height: `${(value / top) * 100}%`, background: series[i].color, minHeight: value > 0 ? 2 : 0 }}
                    />
                  ))}
                </div>
              ))}
            </div>
            {active && hovered !== null && (
              <div
                className="pointer-events-none absolute top-0 z-10 w-max -translate-x-1/2 rounded-md border border-[var(--color-line)] bg-[var(--color-raised)] px-2 py-1.5 text-xs shadow-md"
                style={{ left: `${Math.min(85, Math.max(15, ((hovered + 0.5) / groups.length) * 100))}%` }}
              >
                <div className="mb-0.5 font-medium">{active.title}</div>
                {series.map((s, i) => (
                  <div key={s.name} className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-sm" style={{ background: s.color }} />
                    <span className="text-[var(--color-muted)]">{s.name}</span>
                    <span className="ml-auto pl-3 tabular-nums">{formatNumber(active.values[i])}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="mt-1 flex text-[10px] text-[var(--color-muted)]" aria-hidden>
            {groups.map((group, index) => (
              <span key={group.key} className="min-w-0 flex-1 truncate text-center">
                {index % labelEvery === 0 ? group.label : ''}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
