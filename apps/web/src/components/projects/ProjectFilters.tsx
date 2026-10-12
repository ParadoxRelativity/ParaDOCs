import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  WORK_ITEM_PRIORITIES,
  decodeFilter,
  encodeFilter,
  isEpicType,
  isFilterEmpty,
  isOpenItem,
  matchesFilter,
  usesSprints,
  type DateFilter,
  type DateFilterKind,
  type FilterField,
  type Project,
  type WorkItemFilter,
  type WorkItemSummary,
  type WorkspaceMember,
} from '@paradocs/shared';
import { useWorkItemSearch } from '../../api/hooks';
import { useIsMobile } from '../../lib/mobile';
import { cx, formatDay, toISODate, useDebounced } from '../../lib/util';
import Icon from '../Icon';
import { MenuSheet, PRIORITY } from './projectUi';

/**
 * The filter a project is being looked at through. It is kept for the rest of
 * the session for each project, and written to the address as `?f=`, so a
 * filtered view can be passed on as a link; a link with one opens on it.
 */
export function useProjectFilter(projectId: string) {
  const storageKey = `paradocs.projectFilter.${projectId}`;
  const [search, setSearch] = useSearchParams();
  const [filter, setFilterState] = useState<WorkItemFilter>(() => {
    const linked = decodeFilter(search.get('f'));
    if (linked) return linked;
    try {
      return decodeFilter(sessionStorage.getItem(storageKey)) ?? {};
    } catch {
      return {};
    }
  });

  useEffect(() => {
    const encoded = isFilterEmpty(filter) ? null : encodeFilter(filter);
    try {
      if (encoded) sessionStorage.setItem(storageKey, encoded);
      else sessionStorage.removeItem(storageKey);
    } catch {
      // Storage can be blocked; the filter just will not outlast the page.
    }
    if ((search.get('f') ?? null) === encoded) return;
    const next = new URLSearchParams(search);
    if (encoded) next.set('f', encoded);
    else next.delete('f');
    setSearch(next, { replace: true });
    // Only when the filter changes; the address follows it, not the other way round.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, storageKey]);

  const setFilter = useCallback((next: WorkItemFilter) => setFilterState(next), []);
  return [filter, setFilter] as const;
}

/**
 * Whether an item meets the filter, with the search also finding work by its
 * description, which the server is asked about once three letters are typed.
 */
export function useFilterMatcher(project: Project | undefined, filter: WorkItemFilter, selfId: string) {
  const q = useDebounced(filter.q?.trim() ?? '', 300);
  const hits = useWorkItemSearch(project?.id ?? '', q);
  const descriptionHits = q.length >= 3 ? (hits.data ?? null) : null;
  return useMemo(() => {
    const today = toISODate(new Date());
    const context = { selfId, today, dayOf: (moment: string) => toISODate(new Date(moment)), descriptionHits };
    return (item: WorkItemSummary) => !project || matchesFilter(project, item, filter, context);
  }, [project, filter, selfId, descriptionHits]);
}

interface Option {
  value: string;
  label: string;
  color?: string;
}

const DATE_LABELS: Record<DateFilterKind, string> = {
  overdue: 'Overdue',
  today: 'Today',
  thisWeek: 'This week',
  next7: 'Next 7 days',
  last7: 'Last 7 days',
  none: 'No date',
  range: 'Between dates',
};

const DATE_FIELDS = ['due', 'created', 'updated'] as const;
type DateField = (typeof DATE_FIELDS)[number];
const isDateField = (field: FilterField): field is DateField => (DATE_FIELDS as readonly string[]).includes(field);

/** The presets each date offers: a due date can be missed or missing, a creation date cannot. */
const DATE_KINDS: Record<DateField, DateFilterKind[]> = {
  due: ['overdue', 'today', 'thisWeek', 'next7', 'none', 'range'],
  created: ['today', 'thisWeek', 'last7', 'range'],
  updated: ['today', 'thisWeek', 'last7', 'range'],
};

/**
 * A search and a row of conditions, each a chip that opens to be changed and
 * has an × to take it off. "Filter" adds one for any field: the type, status,
 * priority, epic, sprint, any role, or a date.
 */
export function FilterBar({
  project,
  items,
  members,
  filter,
  onChange,
}: {
  project: Project;
  /** The project's current work, for the epics a condition can name. */
  items: WorkItemSummary[];
  members: WorkspaceMember[];
  filter: WorkItemFilter;
  onChange: (filter: WorkItemFilter) => void;
}) {
  const mobile = useIsMobile();
  /** The sheet open, and on what: the list of fields, or one field's condition. */
  const [open, setOpen] = useState<{ anchor: HTMLElement; field: FilterField | null } | null>(null);

  const fields = useMemo(() => {
    const list: { field: FilterField; label: string }[] = [
      { field: 'type', label: 'Type' },
      { field: 'status', label: 'Status' },
      { field: 'priority', label: 'Priority' },
    ];
    if (project.kind === 'project' && project.itemTypes.some((t) => t.epic)) list.push({ field: 'epic', label: 'Epic' });
    if (usesSprints(project)) list.push({ field: 'sprint', label: 'Sprint' });
    for (const role of project.roles) list.push({ field: `role:${role.id}`, label: role.name });
    list.push({ field: 'due', label: 'Due date' }, { field: 'created', label: 'Created' }, { field: 'updated', label: 'Updated' });
    return list;
  }, [project]);
  const labelOf = (field: FilterField) => fields.find((f) => f.field === field)?.label ?? 'Field';

  function optionsFor(field: FilterField): Option[] {
    const self = members.find((m) => m.isSelf);
    switch (field) {
      case 'type':
        return project.itemTypes.map((t) => ({ value: t.id, label: t.name, color: t.color }));
      case 'status':
        return project.statuses.map((s) => ({ value: s.id, label: s.name, color: s.color }));
      case 'priority':
        return WORK_ITEM_PRIORITIES.map((p) => ({ value: p, label: PRIORITY[p].label }));
      case 'epic': {
        const chosen = new Set(filter.epic ?? []);
        return [
          { value: 'none', label: 'No epic' },
          ...items
            .filter((item) => isEpicType(project, item.typeId) && (isOpenItem(project, item) || chosen.has(item.id)))
            .sort((a, b) => a.number - b.number)
            .map((epic) => ({ value: epic.id, label: `${epic.key} ${epic.title}` })),
        ];
      }
      case 'sprint': {
        const chosen = new Set(filter.sprint ?? []);
        return [
          { value: 'none', label: 'No sprint' },
          ...project.sprints
            .filter((s) => s.state !== 'completed' || chosen.has(s.id))
            .map((s) => ({ value: s.id, label: s.name })),
        ];
      }
      default:
        return [
          { value: 'me', label: self ? `Me (${self.name})` : 'Me' },
          { value: 'none', label: 'Nobody' },
          ...members.filter((m) => !m.isSelf).map((m) => ({ value: m.userId, label: m.name })),
        ];
    }
  }

  function valuesOf(field: FilterField): string[] {
    if (field.startsWith('role:')) return filter.roles?.[field.slice(5)] ?? [];
    if (isDateField(field)) return [];
    return (filter[field as 'type' | 'status' | 'priority' | 'epic' | 'sprint'] as string[] | undefined) ?? [];
  }

  function setValues(field: FilterField, values: string[]) {
    if (field.startsWith('role:')) {
      onChange({ ...filter, roles: { ...filter.roles, [field.slice(5)]: values } });
    } else {
      onChange({ ...filter, [field]: values.length ? values : undefined });
    }
  }

  function setDate(field: DateField, date: DateFilter | undefined) {
    onChange({ ...filter, [field]: date });
  }

  function remove(field: FilterField) {
    if (field.startsWith('role:')) {
      const roles = { ...filter.roles };
      delete roles[field.slice(5)];
      onChange({ ...filter, roles });
    } else {
      onChange({ ...filter, [field]: undefined });
    }
  }

  /** The conditions set, in the order fields are offered. */
  const active = fields.filter(({ field }) => (isDateField(field) ? filter[field] !== undefined : valuesOf(field).length > 0));

  function chipText(field: FilterField): string {
    if (isDateField(field)) {
      const date = filter[field]!;
      if (date.kind !== 'range') return DATE_LABELS[date.kind];
      if (date.from && date.to) return `${formatDay(date.from)} – ${formatDay(date.to)}`;
      if (date.from) return `after ${formatDay(date.from)}`;
      return date.to ? `before ${formatDay(date.to)}` : 'any date';
    }
    const options = optionsFor(field);
    const names = valuesOf(field).map((v) => (v === 'me' ? 'Me' : (options.find((o) => o.value === v)?.label ?? 'Unknown')));
    return names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', ');
  }

  const anyFilter = !isFilterEmpty(filter);

  return (
    <>
      <div className={cx('relative', mobile ? 'min-w-0 flex-1' : '')}>
        <Icon name="search" className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-[var(--color-muted)]" />
        <input
          value={filter.q ?? ''}
          onChange={(e) => onChange({ ...filter, q: e.target.value || undefined })}
          placeholder="Search"
          aria-label="Search titles, keys and descriptions"
          className={cx(
            'rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] py-1 pl-6 pr-2 text-xs outline-none focus:border-[var(--color-accent)]',
            mobile ? 'w-full' : 'w-40',
          )}
        />
      </div>
      {active.length > 0 && (
        <div className={cx('flex gap-1', mobile ? 'scroll-none order-last w-full overflow-x-auto' : 'flex-wrap')}>
          {active.map(({ field, label }) => (
            <span
              key={field}
              className="flex shrink-0 items-center rounded-full border border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-xs text-[var(--color-accent)]"
            >
              <button onClick={(e) => setOpen({ anchor: e.currentTarget, field })} className="max-w-[16rem] truncate py-0.5 pl-2.5 pr-1">
                <span className="font-medium">{label}:</span> {chipText(field)}
              </button>
              <button
                onClick={() => remove(field)}
                aria-label={`Remove the ${label} filter`}
                className="rounded-full py-0.5 pl-0.5 pr-2 hover:text-[var(--color-ink)]"
              >
                <Icon name="x" />
              </button>
            </span>
          ))}
        </div>
      )}
      <button
        onClick={(e) => setOpen(open ? null : { anchor: e.currentTarget, field: null })}
        className="flex shrink-0 items-center gap-1 rounded-md border border-[var(--color-line)] px-2 py-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-ink)]"
      >
        <Icon name="funnel" /> Filter
      </button>
      {anyFilter && (
        <button onClick={() => onChange({})} className="shrink-0 text-xs text-[var(--color-muted)] hover:text-[var(--color-ink)]">
          Clear
        </button>
      )}

      {open && (
        <MenuSheet
          anchor={open.anchor}
          title={open.field ? labelOf(open.field) : 'Filter by'}
          onClose={() => setOpen(null)}
          className="w-64"
        >
          {open.field === null ? (
            <div className="max-h-80 overflow-y-auto">
              {fields.map(({ field, label }) => (
                <button
                  key={field}
                  onClick={() => setOpen({ ...open, field })}
                  className="flex w-full items-center rounded-lg px-2 py-1.5 text-left text-sm hover:bg-[var(--color-surface)]"
                >
                  <span className="flex-1">{label}</span>
                  {active.some((a) => a.field === field) && <Icon name="check2" className="text-[var(--color-accent)]" />}
                  <Icon name="chevron-right" className="ml-2 text-[10px] text-[var(--color-muted)]" />
                </button>
              ))}
            </div>
          ) : isDateField(open.field) ? (
            <DateEditor
              kinds={DATE_KINDS[open.field]}
              value={filter[open.field]}
              onChange={(date) => setDate(open.field as DateField, date)}
            />
          ) : (
            <ChoiceEditor
              options={optionsFor(open.field)}
              values={valuesOf(open.field)}
              onChange={(values) => setValues(open.field!, values)}
            />
          )}
        </MenuSheet>
      )}
    </>
  );
}

/** Ticks for a field that takes a choice; anything ticked counts. */
function ChoiceEditor({ options, values, onChange }: { options: Option[]; values: string[]; onChange: (values: string[]) => void }) {
  return (
    <div className="max-h-80 overflow-y-auto">
      {options.map((option) => {
        const checked = values.includes(option.value);
        return (
          <label key={option.value} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-[var(--color-surface)]">
            <input
              type="checkbox"
              checked={checked}
              onChange={() => onChange(checked ? values.filter((v) => v !== option.value) : [...values, option.value])}
            />
            {option.color && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: option.color }} />}
            <span className="min-w-0 truncate">{option.label}</span>
          </label>
        );
      })}
    </div>
  );
}

/** A preset for a date, or a range of days either end of which can be left open. */
function DateEditor({
  kinds,
  value,
  onChange,
}: {
  kinds: DateFilterKind[];
  value: DateFilter | undefined;
  onChange: (value: DateFilter | undefined) => void;
}) {
  const field = 'mt-1 w-full rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-2 py-1 text-sm outline-none focus:border-[var(--color-accent)]';
  return (
    <div className="space-y-0.5">
      {kinds.map((kind) => (
        <label key={kind} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-[var(--color-surface)]">
          <input type="radio" checked={value?.kind === kind} onChange={() => onChange({ kind })} />
          {DATE_LABELS[kind]}
        </label>
      ))}
      {value?.kind === 'range' && (
        <div className="grid grid-cols-2 gap-2 px-2 pb-1 text-xs text-[var(--color-muted)]">
          <label>
            From
            <input
              type="date"
              value={value.from ?? ''}
              onChange={(e) => onChange({ ...value, from: e.target.value || undefined })}
              className={field}
            />
          </label>
          <label>
            To
            <input
              type="date"
              value={value.to ?? ''}
              onChange={(e) => onChange({ ...value, to: e.target.value || undefined })}
              className={field}
            />
          </label>
        </div>
      )}
    </div>
  );
}
