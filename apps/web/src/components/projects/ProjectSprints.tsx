import { useMemo, useState, type ReactNode } from 'react';
import {
  DEFAULT_SPRINT_DAYS,
  daysUntil,
  type Project,
  type ProjectSprint,
  type ProjectStatus,
  type WorkItemSummary,
  type WorkspaceMember,
} from '@paradocs/shared';
import { useCreateWorkItem, useSprints } from '../../api/hooks';
import { cx, todayISO, toISODate } from '../../lib/util';
import Icon from '../Icon';
import { ConfirmDialog, Modal } from '../Modal';
import { Popover } from '../Popover';
import { FIELD } from '../SettingsParts';
import { useToast } from '../Toast';
import { Button, IconButton } from '../ui';
import { PeopleStack, PriorityIcon, StatusPill, TypeIcon, formatDue } from './projectUi';

/**
 * Sprints, for a project whose board is run in them: the bar over the board
 * saying which sprint is running and how far along it is, the dialogs that
 * start and complete one, and the backlog as it is planned with sprints on.
 */

const DRAG_TYPE = 'application/x-paradocs-sprint-item';

/** How many rows a section draws before asking to see more; a backlog can run to hundreds. */
const PAGE = 100;

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return toISODate(new Date(y, m - 1, d + days));
}

function statusOf(project: Project, item: WorkItemSummary): ProjectStatus | undefined {
  return project.statuses.find((s) => s.id === item.statusId);
}

function isDone(project: Project, item: WorkItemSummary): boolean {
  return statusOf(project, item)?.category === 'done';
}

/**
 * Whether an item is waiting to be planned: open, and in no sprint that is
 * still to come or running. Work reopened after its sprint completed counts,
 * so it can be planned again rather than lost.
 */
function inBacklog(project: Project, item: WorkItemSummary): boolean {
  if (isDone(project, item)) return false;
  if (!item.sprintId) return true;
  const state = project.sprints.find((s) => s.id === item.sprintId)?.state;
  return state !== 'planned' && state !== 'active';
}

function estimateOf(items: WorkItemSummary[]): number {
  return Number(items.reduce((total, item) => total + (item.estimate ?? 0), 0).toFixed(2));
}

function sortItems(items: WorkItemSummary[]): WorkItemSummary[] {
  return [...items].sort((a, b) => a.position - b.position || a.number - b.number);
}

export function sprintDates(sprint: Pick<ProjectSprint, 'startDate' | 'endDate'>): string | null {
  if (sprint.startDate && sprint.endDate) return `${formatDue(sprint.startDate)} – ${formatDue(sprint.endDate)}`;
  if (sprint.startDate) return `From ${formatDue(sprint.startDate)}`;
  if (sprint.endDate) return `Until ${formatDue(sprint.endDate)}`;
  return null;
}

function DaysLeft({ endDate }: { endDate: string | null }) {
  if (!endDate) return null;
  const days = daysUntil(endDate);
  const label =
    days > 1 ? `${days} days left` : days === 1 ? '1 day left' : days === 0 ? 'Ends today' : days === -1 ? '1 day over' : `${-days} days over`;
  return (
    <span
      className={cx(
        'rounded-full px-2 py-0.5 text-xs',
        days < 0 ? 'bg-red-500/10 text-red-600 dark:text-red-400' : days <= 2 ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300' : 'bg-[var(--color-surface)] text-[var(--color-muted)]',
      )}
    >
      {label}
    </span>
  );
}

/** How much of a sprint's work is done, by count and by estimate where there is one. */
function Progress({ project, items }: { project: Project; items: WorkItemSummary[] }) {
  const done = items.filter((item) => isDone(project, item));
  const total = estimateOf(items);
  const finished = estimateOf(done);
  const share = total > 0 ? finished / total : items.length > 0 ? done.length / items.length : 0;
  return (
    <span className="flex items-center gap-2 text-xs text-[var(--color-muted)]">
      <span
        className="h-1.5 w-24 overflow-hidden rounded-full bg-[var(--color-line)]"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(share * 100)}
        aria-label="Sprint progress"
      >
        <span className="block h-full rounded-full bg-emerald-500" style={{ width: `${share * 100}%` }} />
      </span>
      <span className="tabular-nums">
        {done.length} of {items.length} done
        {total > 0 && ` · ${finished} of ${total} estimated`}
      </span>
    </span>
  );
}

// --- the board -------------------------------------------------------------------

/** Over the board: the running sprint, how far along it is, and what to do with it. */
export function SprintBar({
  project,
  sprint,
  items,
  canEdit,
  onOpenBacklog,
}: {
  project: Project;
  sprint: ProjectSprint;
  /** The sprint's own work. */
  items: WorkItemSummary[];
  canEdit: boolean;
  onOpenBacklog: () => void;
}) {
  const [completing, setCompleting] = useState(false);
  const [editing, setEditing] = useState(false);
  const dates = sprintDates(sprint);
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--color-line)] px-4 py-2">
      <Icon name="arrow-repeat" className="text-[var(--color-accent)]" />
      <span className="text-sm font-semibold">{sprint.name}</span>
      {dates && <span className="text-xs text-[var(--color-muted)]">{dates}</span>}
      <DaysLeft endDate={sprint.endDate} />
      {sprint.goal && (
        <span className="min-w-0 max-w-md truncate text-xs text-[var(--color-muted)]" title={sprint.goal}>
          <Icon name="bullseye" /> {sprint.goal}
        </span>
      )}
      <span className="flex-1" />
      <Progress project={project} items={items} />
      <Button variant="subtle" className="text-xs" onClick={onOpenBacklog}>
        Plan sprints
      </Button>
      {canEdit && (
        <>
          <IconButton label="Edit sprint" onClick={() => setEditing(true)}>
            <Icon name="pencil" />
          </IconButton>
          <Button variant="primary" className="text-xs" onClick={() => setCompleting(true)}>
            <Icon name="check2-circle" /> Complete sprint
          </Button>
        </>
      )}
      {completing && (
        <CompleteSprintDialog project={project} sprint={sprint} items={items} onClose={() => setCompleting(false)} />
      )}
      {editing && <SprintDialog project={project} sprint={sprint} onClose={() => setEditing(false)} />}
    </div>
  );
}

/** Where the board would be, when the project runs in sprints and none is running. */
export function NoSprintRunning({
  project,
  canEdit,
  onOpenBacklog,
}: {
  project: Project;
  canEdit: boolean;
  onOpenBacklog: () => void;
}) {
  const next = project.sprints.find((s) => s.state === 'planned');
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <Icon name="arrow-repeat" className="text-3xl text-[var(--color-muted)]" />
      <p className="text-sm font-medium">No sprint is running</p>
      <p className="max-w-sm text-xs text-[var(--color-muted)]">
        {next
          ? `${next.name} is planned. Start it from the backlog and its work comes onto the board.`
          : 'Plan a sprint in the backlog: put work in it, then start it, and its work comes onto the board.'}
      </p>
      <Button variant={canEdit ? 'primary' : 'subtle'} className="mt-2 text-xs" onClick={onOpenBacklog}>
        <Icon name="inbox" /> Go to the backlog
      </Button>
    </div>
  );
}

// --- dialogs ---------------------------------------------------------------------

/** A sprint's name, goal and dates, for one being made or changed. */
function SprintFields({
  name,
  goal,
  startDate,
  endDate,
  onChange,
  requireDates,
}: {
  name: string;
  goal: string;
  startDate: string;
  endDate: string;
  onChange: (patch: Partial<{ name: string; goal: string; startDate: string; endDate: string }>) => void;
  requireDates?: boolean;
}) {
  return (
    <div className="space-y-2">
      <label className="block text-xs text-[var(--color-muted)]">
        Name
        <input value={name} maxLength={60} onChange={(e) => onChange({ name: e.target.value })} className={cx(FIELD, 'mt-1')} />
      </label>
      <label className="block text-xs text-[var(--color-muted)]">
        Goal
        <textarea
          value={goal}
          maxLength={500}
          rows={2}
          onChange={(e) => onChange({ goal: e.target.value })}
          placeholder="What this sprint is for"
          className={cx(FIELD, 'mt-1 resize-y')}
        />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-xs text-[var(--color-muted)]">
          Starts
          <input
            type="date"
            value={startDate}
            required={requireDates}
            onChange={(e) => {
              const next = e.target.value;
              // Keep the length it had when the start moves.
              const length = startDate && endDate ? daysUntil(endDate, new Date(`${startDate}T00:00:00`)) : DEFAULT_SPRINT_DAYS;
              onChange({ startDate: next, ...(next ? { endDate: addDays(next, length) } : {}) });
            }}
            className={cx(FIELD, 'mt-1')}
          />
        </label>
        <label className="block text-xs text-[var(--color-muted)]">
          Ends
          <input
            type="date"
            value={endDate}
            min={startDate || undefined}
            required={requireDates}
            onChange={(e) => onChange({ endDate: e.target.value })}
            className={cx(FIELD, 'mt-1')}
          />
        </label>
      </div>
    </div>
  );
}

/** Making a sprint, or changing one's name, goal and dates. */
export function SprintDialog({
  project,
  sprint,
  onClose,
}: {
  project: Project;
  /** Left out to make a new one. */
  sprint?: ProjectSprint;
  onClose: () => void;
}) {
  const sprints = useSprints(project.workspaceId, project.id);
  const toast = useToast();
  // A new sprint follows on from the last one planned, where that has an end.
  const after = [...project.sprints].reverse().find((s) => s.state !== 'completed' && s.endDate)?.endDate;
  const [fields, setFields] = useState(() => ({
    name: sprint?.name ?? `Sprint ${project.sprints.length + 1}`,
    goal: sprint?.goal ?? '',
    startDate: sprint ? (sprint.startDate ?? '') : after ? addDays(after, 1) : '',
    endDate: sprint ? (sprint.endDate ?? '') : after ? addDays(after, DEFAULT_SPRINT_DAYS) : '',
  }));
  const pending = sprints.create.isPending || sprints.update.isPending;
  const badDates = fields.startDate && fields.endDate && fields.endDate < fields.startDate;

  async function save() {
    const input = {
      name: fields.name.trim() || undefined,
      goal: fields.goal.trim(),
      startDate: fields.startDate || null,
      endDate: fields.endDate || null,
    };
    try {
      if (sprint) await sprints.update.mutateAsync({ id: sprint.id, ...input });
      else await sprints.create.mutateAsync(input);
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save the sprint', 'error');
    }
  }

  return (
    <Modal
      title={sprint ? `Edit ${sprint.name}` : 'New sprint'}
      onClose={onClose}
      footer={
        <>
          <Button variant="subtle" className="text-xs" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" className="text-xs" disabled={pending || Boolean(badDates)} onClick={save}>
            {sprint ? 'Save' : 'Create sprint'}
          </Button>
        </>
      }
    >
      <SprintFields {...fields} onChange={(patch) => setFields((f) => ({ ...f, ...patch }))} />
      {badDates && <p className="mt-1 text-xs text-red-500">A sprint cannot end before it starts.</p>}
    </Modal>
  );
}

/**
 * Starting a planned sprint: settling its dates, and — for a project only now
 * turning sprints on — taking in the work already on the board, which would
 * otherwise drop out of sight the moment the board shows one sprint.
 */
function StartSprintDialog({
  project,
  sprint,
  items,
  onClose,
}: {
  project: Project;
  sprint: ProjectSprint;
  items: WorkItemSummary[];
  onClose: () => void;
}) {
  const sprints = useSprints(project.workspaceId, project.id);
  const toast = useToast();
  const today = todayISO();
  const [fields, setFields] = useState(() => {
    const startDate = sprint.startDate ?? today;
    return {
      name: sprint.name,
      goal: sprint.goal,
      startDate,
      endDate: sprint.endDate && sprint.endDate >= startDate ? sprint.endDate : addDays(startDate, DEFAULT_SPRINT_DAYS),
    };
  });

  const own = items.filter((item) => item.sprintId === sprint.id);
  const waiting = own.filter((item) => statusOf(project, item)?.category === 'backlog').length;
  const loose = items.filter((item) => {
    const category = statusOf(project, item)?.category;
    return (category === 'todo' || category === 'active') && inBacklog(project, item);
  }).length;
  const [includeBoard, setIncludeBoard] = useState(loose > 0);
  const pending = sprints.update.isPending || sprints.start.isPending;
  const badDates = !fields.startDate || !fields.endDate || fields.endDate < fields.startDate;

  async function start() {
    try {
      const name = fields.name.trim();
      if ((name && name !== sprint.name) || fields.goal.trim() !== sprint.goal) {
        await sprints.update.mutateAsync({ id: sprint.id, name: name || undefined, goal: fields.goal.trim() });
      }
      await sprints.start.mutateAsync({
        id: sprint.id,
        startDate: fields.startDate,
        endDate: fields.endDate,
        includeBoard: includeBoard && loose > 0,
      });
      toast(`Started ${name || sprint.name}`);
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not start the sprint', 'error');
    }
  }

  return (
    <Modal
      title={`Start ${sprint.name}`}
      description={
        own.length === 0
          ? 'Nothing is in this sprint yet. It can be started empty and have work added as it runs.'
          : `${own.length === 1 ? 'One item goes' : `${own.length} items go`} onto the board.${
              waiting > 0 ? ` ${waiting === 1 ? 'One is' : `${waiting} are`} still in a backlog status and will move to the first board status ${waiting === 1 ? 'its' : 'their'} workflow allows.` : ''
            }`
      }
      onClose={onClose}
      footer={
        <>
          <Button variant="subtle" className="text-xs" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" className="text-xs" disabled={pending || badDates} onClick={start}>
            <Icon name="play-fill" /> Start sprint
          </Button>
        </>
      }
    >
      <SprintFields {...fields} requireDates onChange={(patch) => setFields((f) => ({ ...f, ...patch }))} />
      {fields.startDate && fields.endDate && fields.endDate < fields.startDate && (
        <p className="mt-1 text-xs text-red-500">A sprint cannot end before it starts.</p>
      )}
      {loose > 0 && (
        <label className="mt-3 flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={includeBoard} onChange={(e) => setIncludeBoard(e.target.checked)} />
          <span>
            Also bring in the {loose === 1 ? 'item' : `${loose} items`} already on the board
            <span className="block text-xs text-[var(--color-muted)]">
              {loose === 1 ? 'It is' : 'They are'} in no sprint, so the board would stop showing {loose === 1 ? 'it' : 'them'}.
            </span>
          </span>
        </label>
      )}
    </Modal>
  );
}

const NEW_SPRINT = '__new';

/**
 * Completing the running sprint. Finished work stays in it; the rest goes on to
 * a planned sprint, a new one, or back to the backlog.
 */
function CompleteSprintDialog({
  project,
  sprint,
  items,
  onClose,
}: {
  project: Project;
  sprint: ProjectSprint;
  items: WorkItemSummary[];
  onClose: () => void;
}) {
  const sprints = useSprints(project.workspaceId, project.id);
  const toast = useToast();
  const planned = project.sprints.filter((s) => s.state === 'planned');
  const [moveTo, setMoveTo] = useState(planned[0]?.id ?? NEW_SPRINT);
  const done = items.filter((item) => isDone(project, item)).length;
  const open = items.length - done;
  const pending = sprints.create.isPending || sprints.complete.isPending;

  async function complete() {
    try {
      let target: string | null = open > 0 && moveTo ? moveTo : null;
      if (target === NEW_SPRINT) target = (await sprints.create.mutateAsync({})).id;
      await sprints.complete.mutateAsync({ id: sprint.id, moveTo: target });
      toast(`Completed ${sprint.name}`);
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not complete the sprint', 'error');
    }
  }

  return (
    <Modal
      title={`Complete ${sprint.name}?`}
      description={
        open === 0
          ? `All ${items.length === 1 ? 'of its work is' : `${items.length} items are`} done.`
          : `${done} done, ${open} not. Finished work stays in the sprint; choose where the unfinished work goes. It keeps its status.`
      }
      onClose={onClose}
      footer={
        <>
          <Button variant="subtle" className="text-xs" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" className="text-xs" disabled={pending} onClick={complete}>
            Complete sprint
          </Button>
        </>
      }
    >
      {open > 0 && (
        <label className="block text-xs text-[var(--color-muted)]">
          Move the {open === 1 ? 'unfinished item' : `${open} unfinished items`} to
          <select value={moveTo} onChange={(e) => setMoveTo(e.target.value)} className={cx(FIELD, 'mt-1')}>
            {planned.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
            <option value={NEW_SPRINT}>A new sprint</option>
            <option value="">The backlog</option>
          </select>
        </label>
      )}
    </Modal>
  );
}

// --- the backlog -----------------------------------------------------------------

/** Where a section's work is: a sprint, or the backlog. */
type Target = { sprint: ProjectSprint | null };

/**
 * The backlog, with sprints on: the running sprint and each one planned after
 * it, each with its work, then everything not yet planned into one. Work is
 * put in a sprint by dragging it there, or picking it and choosing where.
 * Sprints are started and completed from here too.
 */
export function SprintBacklog({
  project,
  items,
  memberMap,
  canEdit,
  activeItemId,
  onOpenItem,
  onOpenBoard,
}: {
  project: Project;
  items: WorkItemSummary[];
  memberMap: Map<string, WorkspaceMember>;
  canEdit: boolean;
  activeItemId: string | null;
  onOpenItem: (itemId: string) => void;
  onOpenBoard: () => void;
}) {
  const sprints = useSprints(project.workspaceId, project.id);
  const toast = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [picking, setPicking] = useState<{ ids: string[]; anchor: HTMLElement } | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ProjectSprint | null>(null);
  const [starting, setStarting] = useState<ProjectSprint | null>(null);
  const [completing, setCompleting] = useState<ProjectSprint | null>(null);
  const [deleting, setDeleting] = useState<ProjectSprint | null>(null);

  const running = project.sprints.find((s) => s.state === 'active') ?? null;
  const planned = project.sprints.filter((s) => s.state === 'planned');
  const completed = project.sprints.filter((s) => s.state === 'completed');

  const bySprint = useMemo(() => {
    const map = new Map<string, WorkItemSummary[]>();
    for (const item of items) {
      if (!item.sprintId) continue;
      const list = map.get(item.sprintId);
      if (list) list.push(item);
      else map.set(item.sprintId, [item]);
    }
    for (const [key, list] of map) map.set(key, sortItems(list));
    return map;
  }, [items]);
  const backlog = useMemo(() => sortItems(items.filter((item) => inBacklog(project, item))), [items, project]);
  const targets: Target[] = [...(running ? [{ sprint: running }] : []), ...planned.map((sprint) => ({ sprint })), { sprint: null }];

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function place(ids: string[], sprint: ProjectSprint | null) {
    if (ids.length === 0) return;
    sprints.place.mutate(
      { itemIds: ids, sprintId: sprint?.id ?? null },
      {
        onSuccess: ({ moved }) => {
          setSelected(new Set());
          if (moved > 0) toast(`Moved ${moved === 1 ? '1 item' : `${moved} items`} to ${sprint?.name ?? 'the backlog'}`);
        },
        onError: (err) => toast(err instanceof Error ? err.message : 'Could not move them', 'error'),
      },
    );
  }

  const section = (target: Target, rows: WorkItemSummary[], heading: ReactNode, actions: ReactNode, empty: string) => (
    <SprintSection
      key={target.sprint?.id ?? 'backlog'}
      project={project}
      target={target}
      items={rows}
      heading={heading}
      actions={actions}
      empty={empty}
      memberMap={memberMap}
      canEdit={canEdit}
      activeItemId={activeItemId}
      selected={selected}
      onToggle={toggle}
      onToggleAll={(on) =>
        setSelected((current) => {
          const next = new Set(current);
          for (const item of rows) {
            if (on) next.add(item.id);
            else next.delete(item.id);
          }
          return next;
        })
      }
      onOpenItem={onOpenItem}
      onMoveOne={(id, anchor) => setPicking({ ids: [id], anchor })}
      onDropItem={(id) => place([id], target.sprint)}
    />
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--color-line)] px-4 py-2 text-sm">
        <span className="font-medium">{backlog.length === 1 ? '1 item' : `${backlog.length} items`} to plan</span>
        {running && (
          <button onClick={onOpenBoard} className="text-xs text-[var(--color-muted)] hover:text-[var(--color-ink)]">
            · {running.name} on the board
          </button>
        )}
        <span className="flex-1" />
        {canEdit && selected.size > 0 && (
          <>
            <span className="text-xs text-[var(--color-muted)]">{selected.size} selected</span>
            <Button variant="subtle" className="text-xs" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
            <Button
              variant="primary"
              className="text-xs"
              disabled={sprints.place.isPending}
              onClick={(e) => setPicking({ ids: [...selected], anchor: e.currentTarget })}
            >
              <Icon name="arrow-right" /> Move to…
            </Button>
          </>
        )}
        {canEdit && !project.archivedAt && (
          <Button variant="subtle" className="text-xs" onClick={() => setCreating(true)}>
            <Icon name="plus-lg" /> New sprint
          </Button>
        )}
      </div>

      {picking && (
        <Popover anchor={picking.anchor} placement="below" onClose={() => setPicking(null)} className="w-56 p-1">
          <p className="px-2 py-1 text-xs text-[var(--color-muted)]">
            {picking.ids.length === 1 ? 'Move it to' : `Move ${picking.ids.length} items to`}
          </p>
          {targets.map(({ sprint }) => (
            <button
              key={sprint?.id ?? 'backlog'}
              onClick={() => {
                const { ids } = picking;
                setPicking(null);
                place(ids, sprint);
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-[var(--color-surface)]"
            >
              <Icon name={sprint ? 'arrow-repeat' : 'inbox'} className="text-[var(--color-muted)]" />
              <span className="min-w-0 flex-1 truncate">{sprint?.name ?? 'Backlog'}</span>
              {sprint?.state === 'active' && <span className="text-xs text-[var(--color-muted)]">running</span>}
            </button>
          ))}
        </Popover>
      )}

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto pb-6">
        {running &&
          section(
            { sprint: running },
            bySprint.get(running.id) ?? [],
            <SprintHeading project={project} sprint={running} items={bySprint.get(running.id) ?? []} />,
            canEdit && (
              <>
                <IconButton label="Edit sprint" onClick={() => setEditing(running)}>
                  <Icon name="pencil" />
                </IconButton>
                <Button variant="subtle" className="text-xs" onClick={() => setCompleting(running)}>
                  <Icon name="check2-circle" /> Complete
                </Button>
              </>
            ),
            'Nothing in this sprint. Drag work here to add it to the board.',
          )}

        {planned.map((sprint) =>
          section(
            { sprint },
            bySprint.get(sprint.id) ?? [],
            <SprintHeading project={project} sprint={sprint} items={bySprint.get(sprint.id) ?? []} />,
            canEdit && (
              <>
                <IconButton label="Edit sprint" onClick={() => setEditing(sprint)}>
                  <Icon name="pencil" />
                </IconButton>
                <IconButton label="Delete sprint" onClick={() => setDeleting(sprint)}>
                  <Icon name="trash3" />
                </IconButton>
                <Button
                  variant={running ? 'subtle' : 'primary'}
                  className="text-xs"
                  disabled={Boolean(running)}
                  title={running ? `${running.name} is still running` : undefined}
                  onClick={() => setStarting(sprint)}
                >
                  <Icon name="play-fill" /> Start
                </Button>
              </>
            ),
            'Nothing planned yet. Drag work here from the backlog, or pick some and move it.',
          ),
        )}

        {!running && planned.length === 0 && (
          <div className="mx-4 mt-4 rounded-xl border border-dashed border-[var(--color-line)] px-4 py-6 text-center">
            <p className="text-sm font-medium">No sprints planned</p>
            <p className="mt-1 text-xs text-[var(--color-muted)]">
              Make a sprint, put work from the backlog in it, and start it to bring that work onto the board.
            </p>
            {canEdit && !project.archivedAt && (
              <Button variant="primary" className="mt-3 text-xs" onClick={() => setCreating(true)}>
                <Icon name="plus-lg" /> New sprint
              </Button>
            )}
          </div>
        )}

        {section(
          { sprint: null },
          backlog,
          <span className="flex items-center gap-2">
            <Icon name="inbox" className="text-[var(--color-muted)]" />
            <span className="text-sm font-semibold">Backlog</span>
            <span className="text-xs text-[var(--color-muted)]">
              {backlog.length}
              {estimateOf(backlog) > 0 && ` · ${estimateOf(backlog)} estimated`}
            </span>
          </span>,
          null,
          'Nothing waiting to be planned.',
        )}

        {completed.length > 0 && (
          <details className="mx-4 mt-6">
            <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">
              Completed sprints <span className="font-normal normal-case">{completed.length}</span>
            </summary>
            <ul className="mt-2 divide-y divide-[var(--color-line)] rounded-lg border border-[var(--color-line)]">
              {completed.map((sprint) => {
                const own = bySprint.get(sprint.id) ?? [];
                const done = own.filter((item) => isDone(project, item));
                return (
                  <li key={sprint.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <Icon name="check2-circle" className="text-emerald-500" />
                    <span className="min-w-0 flex-1 truncate font-medium">{sprint.name}</span>
                    {sprintDates(sprint) && <span className="text-xs text-[var(--color-muted)]">{sprintDates(sprint)}</span>}
                    <span className="text-xs tabular-nums text-[var(--color-muted)]">
                      {done.length} done{estimateOf(done) > 0 && ` · ${estimateOf(done)} estimated`}
                    </span>
                    {canEdit && (
                      <IconButton label="Delete sprint" onClick={() => setDeleting(sprint)}>
                        <Icon name="trash3" />
                      </IconButton>
                    )}
                  </li>
                );
              })}
            </ul>
          </details>
        )}
      </div>

      {creating && <SprintDialog project={project} onClose={() => setCreating(false)} />}
      {editing && <SprintDialog project={project} sprint={editing} onClose={() => setEditing(null)} />}
      {starting && <StartSprintDialog project={project} sprint={starting} items={items} onClose={() => setStarting(null)} />}
      {completing && (
        <CompleteSprintDialog
          project={project}
          sprint={completing}
          items={bySprint.get(completing.id) ?? []}
          onClose={() => setCompleting(null)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          description={
            deleting.state === 'completed'
              ? 'Its record of what was finished in it goes. The work itself is kept.'
              : 'Its work goes back to the backlog. Nothing else about it changes.'
          }
          confirmLabel="Delete sprint"
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const sprint = deleting;
            setDeleting(null);
            sprints.remove.mutate(sprint.id, {
              onSuccess: () => toast(`Deleted ${sprint.name}`),
              onError: (err) => toast(err instanceof Error ? err.message : 'Could not delete the sprint', 'error'),
            });
          }}
        />
      )}
    </div>
  );
}

function SprintHeading({ project, sprint, items }: { project: Project; sprint: ProjectSprint; items: WorkItemSummary[] }) {
  const dates = sprintDates(sprint);
  const estimate = estimateOf(items);
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
      <Icon name="arrow-repeat" className={sprint.state === 'active' ? 'text-[var(--color-accent)]' : 'text-[var(--color-muted)]'} />
      <span className="text-sm font-semibold">{sprint.name}</span>
      {sprint.state === 'active' && (
        <span className="rounded-full bg-[var(--color-accent-soft)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--color-accent)]">
          Running
        </span>
      )}
      {dates && <span className="text-xs text-[var(--color-muted)]">{dates}</span>}
      {sprint.state === 'active' ? (
        <Progress project={project} items={items} />
      ) : (
        <span className="text-xs text-[var(--color-muted)]">
          {items.length === 1 ? '1 item' : `${items.length} items`}
          {estimate > 0 && ` · ${estimate} estimated`}
        </span>
      )}
      {sprint.goal && (
        <span className="w-full truncate text-xs text-[var(--color-muted)]" title={sprint.goal}>
          <Icon name="bullseye" /> {sprint.goal}
        </span>
      )}
    </span>
  );
}

function SprintSection({
  project,
  target,
  items,
  heading,
  actions,
  empty,
  memberMap,
  canEdit,
  activeItemId,
  selected,
  onToggle,
  onToggleAll,
  onOpenItem,
  onMoveOne,
  onDropItem,
}: {
  project: Project;
  target: Target;
  items: WorkItemSummary[];
  heading: ReactNode;
  actions: ReactNode;
  empty: string;
  memberMap: Map<string, WorkspaceMember>;
  canEdit: boolean;
  activeItemId: string | null;
  selected: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: (on: boolean) => void;
  onOpenItem: (id: string) => void;
  onMoveOne: (id: string, anchor: HTMLElement) => void;
  onDropItem: (id: string) => void;
}) {
  const create = useCreateWorkItem(project.id);
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [over, setOver] = useState(false);
  const [shown, setShown] = useState(PAGE);
  const primaryRole = project.roles[0];
  const allSelected = items.length > 0 && items.every((item) => selected.has(item.id));
  const running = target.sprint?.state === 'active';
  const own = new Set(items.map((item) => item.id));

  function add() {
    const trimmed = title.trim();
    if (!trimmed) return;
    setTitle('');
    // Unplanned work waits in a backlog status; a running sprint's goes straight onto the board.
    const statusId = (
      running
        ? project.statuses.find((s) => s.category === 'todo')
        : (project.statuses.find((s) => s.category === 'backlog') ?? project.statuses.find((s) => s.category === 'todo'))
    )?.id;
    create.mutate(
      { title: trimmed, statusId, sprintId: target.sprint?.id ?? null },
      { onError: (err) => toast(err instanceof Error ? err.message : 'Could not add it', 'error') },
    );
  }

  return (
    <section
      className={cx('mx-4 mt-4 overflow-hidden rounded-xl border', over ? 'border-[var(--color-accent)]' : 'border-[var(--color-line)]')}
      onDragOver={(e) => {
        if (!canEdit || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        setOver(false);
        const id = e.dataTransfer.getData(DRAG_TYPE);
        if (!id || own.has(id)) return;
        e.preventDefault();
        onDropItem(id);
      }}
    >
      <div className="flex items-center gap-2 border-b border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2">
        {canEdit && items.length > 0 ? (
          <input
            type="checkbox"
            checked={allSelected}
            onChange={(e) => onToggleAll(e.target.checked)}
            aria-label={`Select everything in ${target.sprint?.name ?? 'the backlog'}`}
          />
        ) : (
          <span className="w-[13px]" />
        )}
        <span className="min-w-0 flex-1">{heading}</span>
        {actions}
      </div>

      <ol>
        {items.slice(0, shown).map((item) => {
          const status = statusOf(project, item);
          return (
            <li key={item.id}>
              <div
                draggable={canEdit}
                onDragStart={(e) => {
                  e.dataTransfer.setData(DRAG_TYPE, item.id);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onClick={() => onOpenItem(item.id)}
                className={cx(
                  'group flex cursor-pointer items-center gap-2 border-b border-[var(--color-line)] px-3 py-1.5 text-sm last:border-b-0',
                  item.id === activeItemId
                    ? 'bg-[var(--color-accent-soft)]'
                    : selected.has(item.id)
                      ? 'bg-[var(--color-surface)]'
                      : 'hover:bg-[var(--color-surface)]',
                )}
              >
                {canEdit ? (
                  <input
                    type="checkbox"
                    checked={selected.has(item.id)}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => onToggle(item.id)}
                    aria-label={`Select ${item.key}`}
                  />
                ) : (
                  <span className="w-[13px]" />
                )}
                {canEdit && <Icon name="grip-vertical" className="cursor-grab text-xs text-[var(--color-muted)] opacity-0 group-hover:opacity-100" />}
                <TypeIcon type={item.type} />
                <span className="w-16 shrink-0 text-xs text-[var(--color-muted)]">{item.key}</span>
                <span className={cx('min-w-0 flex-1 truncate', status?.category === 'done' && 'text-[var(--color-muted)] line-through')}>
                  {item.title}
                </span>
                {status && status.category !== 'backlog' && <StatusPill status={status} className="shrink-0" />}
                {item.priority !== 'none' && <PriorityIcon priority={item.priority} />}
                {item.estimate !== null && (
                  <span className="rounded bg-[var(--color-surface)] px-1 text-xs tabular-nums text-[var(--color-muted)]">
                    {item.estimate}
                  </span>
                )}
                <PeopleStack
                  userIds={primaryRole ? (item.roles[primaryRole.id] ?? []) : []}
                  names={primaryRole?.freeForm ? (item.roleNames[primaryRole.id] ?? []) : []}
                  members={memberMap}
                  size="xs"
                />
                {canEdit && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onMoveOne(item.id, e.currentTarget);
                    }}
                    title="Move to a sprint or the backlog"
                    className="hidden shrink-0 rounded px-1.5 py-0.5 text-xs text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)] group-hover:inline"
                  >
                    Move
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {items.length === 0 && <p className="px-4 py-4 text-center text-xs text-[var(--color-muted)]">{empty}</p>}
      {items.length > shown && (
        <div className="border-t border-[var(--color-line)] px-3 py-1.5">
          <Button variant="subtle" className="text-xs" onClick={() => setShown(shown + PAGE)}>
            Show {Math.min(PAGE, items.length - shown)} more of {items.length - shown}
          </Button>
        </div>
      )}
      {canEdit && !project.archivedAt && (
        <div className="flex items-center gap-2 border-t border-[var(--color-line)] px-3 py-1">
          <Icon name="plus-lg" className="text-xs text-[var(--color-muted)]" />
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
            placeholder={`Add to ${target.sprint?.name ?? 'the backlog'} — press Enter`}
            className="min-w-0 flex-1 bg-transparent py-1 text-sm outline-none placeholder:text-[var(--color-muted)]"
          />
        </div>
      )}
    </section>
  );
}
