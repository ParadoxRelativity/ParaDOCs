import { useMemo, useState } from 'react';
import {
  coverageGaps,
  parseLayerConfig,
  resolveLayers,
  type LayerConfig,
  type RotationConfig,
  type Schedule,
  type ScheduleLayer,
  type ScheduleLayerKind,
  type ScheduleWindow,
  type WorkspaceMember,
} from '@paradocs/shared';
import { useCreateLayer, useMembers, useUpdateLayer } from '../../api/hooks';
import { cx } from '../../lib/util';
import Avatar from '../Avatar';
import Icon from '../Icon';
import { Modal } from '../Modal';
import { FIELD, FIELD_BASE } from '../SettingsParts';
import { useToast } from '../Toast';
import { Button, IconButton } from '../ui';
import { DayPicker, formatRange, fromLocalInput, toLocalInput, zoneDiffers } from './scheduleUi';

export interface LayerDraft {
  name: string;
  config: LayerConfig;
  members: { userId: string; crew: string | null }[];
}

export const LAYER_KINDS: Record<ScheduleLayerKind, { label: string; icon: 'arrow-repeat' | 'grid-3x3' | 'calendar-week'; hint: string }> = {
  rotation: { label: 'Rotation', icon: 'arrow-repeat', hint: 'People take turns, handing off automatically: on-call.' },
  pattern: { label: 'Shift pattern', icon: 'grid-3x3', hint: 'Crews working a repeating cycle of day and night shifts.' },
  recurring: { label: 'Regular hours', icon: 'calendar-week', hint: "Each person's weekly hours, and one-off shifts." },
};

/** Today in `zone`, as 'YYYY-MM-DD'. */
export function todayIn(zone: string): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: zone });
}

/** What a new layer of each kind starts as. */
export function blankDraft(kind: ScheduleLayerKind, zone: string): LayerDraft {
  if (kind === 'rotation') {
    return {
      name: 'Primary',
      config: { start: `${todayIn(zone)}T09:00`, length: { unit: 'weeks', count: 1 }, restrictions: [] },
      members: [],
    };
  }
  if (kind === 'pattern') {
    return {
      name: 'Shifts',
      config: {
        start: todayIn(zone),
        shiftTypes: [{ id: 'day', name: 'Day', start: '07:00', end: '19:00' }],
        cycle: ['day', 'day', null, null],
        crews: [
          { id: 'a', name: 'A', offset: 0 },
          { id: 'b', name: 'B', offset: 2 },
        ],
      },
      members: [],
    };
  }
  return { name: 'Regular hours', config: { entries: [], oneOffs: [] }, members: [] };
}

/** The fields for one kind of layer. Patterns and regular hours register theirs here. */
export interface KindFieldsProps {
  schedule: Schedule;
  draft: LayerDraft;
  people: WorkspaceMember[];
  onChange: (draft: LayerDraft) => void;
}

export const KIND_FIELDS: Partial<Record<ScheduleLayerKind, (props: KindFieldsProps) => React.ReactNode>> = {
  rotation: (props) => <RotationFields {...props} />,
};

/**
 * Adding a layer, or changing one from a moment on. The preview below works
 * out the next weeks from what is in the form, with the same resolver the
 * server uses, so what it shows is what will be saved.
 */
export function LayerEditor({
  schedule,
  kind,
  layer,
  onClose,
}: {
  schedule: Schedule;
  kind: ScheduleLayerKind;
  /** The version in effect now, when changing an existing layer. */
  layer: ScheduleLayer | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const people = useMembers(schedule.workspaceId).data ?? [];
  const create = useCreateLayer(schedule.workspaceId, schedule.id);
  const update = useUpdateLayer(schedule.workspaceId, schedule.id);
  const [draft, setDraft] = useState<LayerDraft>(() =>
    layer
      ? { name: layer.name, config: layer.config, members: layer.members.map((m) => ({ userId: m.userId, crew: m.crew })) }
      : blankDraft(kind, schedule.timeZone),
  );
  // Empty means now.
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const checked = parseLayerConfig(kind, draft.config);
  const pending = create.isPending || update.isPending;
  const Fields = KIND_FIELDS[kind];

  async function save() {
    if (!checked.ok || !draft.name.trim()) return;
    try {
      const members = draft.members.map((m) => ({ userId: m.userId, crew: m.crew }));
      if (layer) {
        await update.mutateAsync({
          lineageId: layer.lineageId,
          name: draft.name.trim(),
          config: checked.config,
          members,
          effectiveFrom: effectiveFrom ? fromLocalInput(effectiveFrom) : undefined,
        });
      } else {
        await create.mutateAsync({ kind, name: draft.name.trim(), config: checked.config, members });
      }
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save the layer', 'error');
    }
  }

  return (
    <Modal
      title={layer ? `Edit ${layer.name}` : `New ${LAYER_KINDS[kind].label.toLowerCase()}`}
      description={LAYER_KINDS[kind].hint}
      onClose={onClose}
      wide
      footer={
        <>
          {layer && (
            <label className="mr-auto flex items-center gap-2 text-xs text-[var(--color-muted)]">
              Takes effect
              <input
                type="datetime-local"
                value={effectiveFrom}
                min={toLocalInput(new Date().toISOString())}
                onChange={(e) => setEffectiveFrom(e.target.value)}
                className={cx(FIELD_BASE, 'py-1 text-xs')}
              />
              {!effectiveFrom && <span>now</span>}
            </label>
          )}
          <Button variant="subtle" className="text-xs" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" className="text-xs" disabled={!checked.ok || !draft.name.trim() || pending} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <label className="block text-xs text-[var(--color-muted)]">
          Name
          <input
            autoFocus
            value={draft.name}
            maxLength={60}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            className={cx(FIELD, 'mt-1')}
          />
        </label>
        {Fields?.({ schedule, draft, people, onChange: setDraft })}
        {layer && (
          <p className="text-xs text-[var(--color-muted)]">
            Changes apply from when they take effect. Shifts before then stay as they were.
          </p>
        )}
        <Preview schedule={schedule} kind={kind} draft={draft} people={people} error={checked.ok ? null : checked.error} from={effectiveFrom} />
      </div>
    </Modal>
  );
}

/** The next four weeks of what the form describes. */
function Preview({
  schedule,
  kind,
  draft,
  people,
  error,
  from,
}: {
  schedule: Schedule;
  kind: ScheduleLayerKind;
  draft: LayerDraft;
  people: WorkspaceMember[];
  error: string | null;
  from: string;
}) {
  const result = useMemo(() => {
    if (error) return null;
    const start = from ? fromLocalInput(from) : new Date().toISOString();
    const end = new Date(Date.parse(start) + 28 * 86_400_000).toISOString();
    const layer: ScheduleLayer = {
      id: 'preview',
      lineageId: 'preview',
      kind,
      name: draft.name,
      position: 0,
      config: draft.config,
      effectiveFrom: start,
      effectiveUntil: null,
      members: draft.members.map((m, position) => ({ ...m, position })),
    };
    const shifts = resolveLayers(schedule, [layer], start, end).get('preview') ?? [];
    return { shifts, gaps: coverageGaps(shifts, start, end) };
  }, [schedule, kind, draft, error, from]);
  const name = (id: string) => people.find((p) => p.userId === id)?.name ?? 'Former member';
  const zone = zoneDiffers(schedule.timeZone) ? schedule.timeZone : undefined;

  return (
    <div className="rounded-lg border border-[var(--color-line)]">
      <div className="flex items-center justify-between border-b border-[var(--color-line)] px-3 py-1.5">
        <span className="text-xs font-semibold">Next four weeks</span>
        {result && result.gaps.length > 0 && result.shifts.length > 0 && (
          <span className="text-[11px] text-amber-600 dark:text-amber-400">
            <Icon name="exclamation-triangle" /> {result.gaps.length} {result.gaps.length === 1 ? 'gap' : 'gaps'} in cover
          </span>
        )}
      </div>
      {error ? (
        <p className="px-3 py-2 text-xs text-red-500">{error}</p>
      ) : result && result.shifts.length > 0 ? (
        <ul className="scroll-thin max-h-48 overflow-y-auto py-1 text-xs">
          {result.shifts.slice(0, 60).map((shift, i) => (
            <li key={i} className="flex gap-2 px-3 py-0.5">
              <span className="w-28 shrink-0 truncate font-medium">{name(shift.userId)}</span>
              <span className="min-w-0 flex-1 truncate text-[var(--color-muted)]">
                {formatRange(shift.start, shift.end, zone)}
                {shift.label && ` · ${shift.label}`}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-3 py-2 text-xs text-[var(--color-muted)]">Nobody on yet. Add people to see their shifts.</p>
      )}
      {zone && <p className="border-t border-[var(--color-line)] px-3 py-1 text-[11px] text-[var(--color-muted)]">Times in {zone.replace(/_/g, ' ')}.</p>}
    </div>
  );
}

/**
 * People in turn order, reordered by dragging or with the arrows, and added
 * from the schedule's members first.
 */
export function PeopleOrder({
  schedule,
  people,
  value,
  onChange,
}: {
  schedule: Schedule;
  people: WorkspaceMember[];
  value: string[];
  onChange: (userIds: string[]) => void;
}) {
  const [dragging, setDragging] = useState<number | null>(null);
  const byId = new Map(people.map((p) => [p.userId, p]));
  const onSchedule = new Set(schedule.members.map((m) => m.userId));
  const addable = people
    .filter((p) => !value.includes(p.userId))
    .sort((a, b) => Number(onSchedule.has(b.userId)) - Number(onSchedule.has(a.userId)) || a.name.localeCompare(b.name));

  const move = (from: number, to: number) => {
    if (to < 0 || to >= value.length || from === to) return;
    const next = [...value];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onChange(next);
  };

  return (
    <div className="rounded-lg border border-[var(--color-line)]">
      <ol className="py-1">
        {value.map((userId, index) => {
          const person = byId.get(userId);
          return (
            <li
              key={userId}
              draggable
              onDragStart={() => setDragging(index)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragging !== null) move(dragging, index);
                setDragging(null);
              }}
              onDragEnd={() => setDragging(null)}
              className={cx('flex items-center gap-2 px-2 py-1 text-sm', dragging === index && 'opacity-50')}
            >
              <Icon name="grip-vertical" className="cursor-grab text-[var(--color-muted)]" />
              <span className="w-4 text-right text-xs text-[var(--color-muted)]">{index + 1}</span>
              <Avatar name={person?.name ?? '?'} url={person?.avatarUrl} seed={userId} size="sm" />
              <span className="min-w-0 flex-1 truncate">{person?.name ?? 'Former member'}</span>
              <IconButton label="Move up" className="h-6 w-6" onClick={() => move(index, index - 1)} disabled={index === 0}>
                <Icon name="chevron-up" />
              </IconButton>
              <IconButton label="Move down" className="h-6 w-6" onClick={() => move(index, index + 1)} disabled={index === value.length - 1}>
                <Icon name="chevron-down" />
              </IconButton>
              <IconButton label={`Remove ${person?.name ?? ''}`} className="h-6 w-6" onClick={() => onChange(value.filter((id) => id !== userId))}>
                <Icon name="x-lg" />
              </IconButton>
            </li>
          );
        })}
        {value.length === 0 && <li className="px-3 py-1.5 text-xs text-[var(--color-muted)]">Nobody yet.</li>}
      </ol>
      {addable.length > 0 && (
        <div className="border-t border-[var(--color-line)] p-1.5">
          <select
            value=""
            aria-label="Add a person"
            onChange={(e) => e.target.value && onChange([...value, e.target.value])}
            className={FIELD}
          >
            <option value="">Add a person…</option>
            {addable.map((p) => (
              <option key={p.userId} value={p.userId}>
                {p.name}
                {onSchedule.has(p.userId) ? '' : ' (not on this schedule yet)'}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

const RESTRICTION_PRESETS: { label: string; windows: ScheduleWindow[] }[] = [
  { label: 'Weeknights', windows: [{ days: [1, 2, 3, 4, 5], start: '17:00', end: '09:00' }] },
  { label: 'Weekends', windows: [{ days: [6, 7], start: '00:00', end: '00:00' }] },
  { label: 'Business hours', windows: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }] },
];

/** Times of the week a layer covers, the rest falling through to the layers below. */
export function WindowList({ value, onChange }: { value: ScheduleWindow[]; onChange: (windows: ScheduleWindow[]) => void }) {
  const set = (index: number, patch: Partial<ScheduleWindow>) => onChange(value.map((w, i) => (i === index ? { ...w, ...patch } : w)));
  return (
    <div className="space-y-1.5">
      {value.map((window, index) => (
        <div key={index} className="flex flex-wrap items-center gap-2">
          <DayPicker value={window.days} onChange={(days) => set(index, { days })} />
          <input type="time" value={window.start} onChange={(e) => set(index, { start: e.target.value })} className={cx(FIELD_BASE, 'py-1 text-xs')} aria-label="From" />
          <span className="text-xs text-[var(--color-muted)]">to</span>
          <input type="time" value={window.end} onChange={(e) => set(index, { end: e.target.value })} className={cx(FIELD_BASE, 'py-1 text-xs')} aria-label="Until" />
          {window.end <= window.start && (
            <span className="text-[11px] text-[var(--color-muted)]">{window.end === window.start ? 'all day' : 'next day'}</span>
          )}
          <IconButton label="Remove" className="h-6 w-6" onClick={() => onChange(value.filter((_, i) => i !== index))}>
            <Icon name="x-lg" />
          </IconButton>
        </div>
      ))}
      <div className="flex flex-wrap gap-1.5">
        <Button variant="subtle" className="py-1 text-xs" onClick={() => onChange([...value, { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }])}>
          <Icon name="plus-lg" /> Add hours
        </Button>
        {RESTRICTION_PRESETS.map((preset) => (
          <Button key={preset.label} variant="ghost" className="py-1 text-xs" onClick={() => onChange([...value, ...preset.windows])}>
            {preset.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

function RotationFields({ schedule, draft, people, onChange }: KindFieldsProps) {
  const config = draft.config as RotationConfig;
  const setConfig = (patch: Partial<RotationConfig>) => onChange({ ...draft, config: { ...config, ...patch } });
  const [limited, setLimited] = useState(config.restrictions.length > 0);

  return (
    <>
      <div className="text-xs text-[var(--color-muted)]">
        <span className="mb-1 block">People, in turn order</span>
        <PeopleOrder
          schedule={schedule}
          people={people}
          value={draft.members.map((m) => m.userId)}
          onChange={(ids) => onChange({ ...draft, members: ids.map((userId) => ({ userId, crew: null })) })}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="text-xs text-[var(--color-muted)]">
          Each turn lasts
          <div className="mt-1 flex gap-1.5">
            <input
              type="number"
              min={1}
              max={366}
              value={config.length.count}
              onChange={(e) => setConfig({ length: { ...config.length, count: Math.max(1, Number(e.target.value) || 1) } })}
              className={cx(FIELD_BASE, 'w-20')}
              aria-label="Turn length"
            />
            <select
              value={config.length.unit}
              onChange={(e) => setConfig({ length: { ...config.length, unit: e.target.value as RotationConfig['length']['unit'] } })}
              className={cx(FIELD_BASE, 'flex-1')}
              aria-label="Unit"
            >
              <option value="hours">hours</option>
              <option value="days">days</option>
              <option value="weeks">weeks</option>
            </select>
          </div>
        </div>
        <label className="block text-xs text-[var(--color-muted)]">
          First handoff ({schedule.timeZone.replace(/_/g, ' ')})
          <input
            type="datetime-local"
            value={config.start}
            onChange={(e) => e.target.value && setConfig({ start: e.target.value.slice(0, 16) })}
            className={cx(FIELD, 'mt-1')}
          />
        </label>
      </div>
      <div className="text-xs text-[var(--color-muted)]">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={limited}
            onChange={(e) => {
              setLimited(e.target.checked);
              if (!e.target.checked) setConfig({ restrictions: [] });
            }}
          />
          Only cover certain hours
        </label>
        {limited && (
          <div className="mt-2">
            <WindowList value={config.restrictions} onChange={(restrictions) => setConfig({ restrictions })} />
          </div>
        )}
      </div>
    </>
  );
}
