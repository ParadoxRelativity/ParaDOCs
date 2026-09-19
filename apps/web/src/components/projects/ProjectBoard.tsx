import { Fragment, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  boardLanes,
  cellTarget,
  cellTargets,
  layoutOf,
  type BoardCellView,
  type BoardLaneView,
  type Project,
  type ProjectStatus,
  type WorkItemSummary,
  type WorkspaceMember,
} from '@paradocs/shared';
import { useUpdateProject, useUpdateWorkItem } from '../../api/hooks';
import { cx, useLocalStorage } from '../../lib/util';
import Icon from '../Icon';
import { Popover } from '../Popover';
import { useToast } from '../Toast';
import { IconButton } from '../ui';
import { PeopleStack, PriorityIcon, StatusPill, TypeIcon, formatDue, isOverdue } from './projectUi';

/** What a dragged card carries, so nothing else can be dropped on a column. */
const DRAG_TYPE = 'application/x-paradocs-work-item';

/** What a dragged column header carries, so cards and columns never mix. */
const LANE_DRAG_TYPE = 'application/x-paradocs-board-lane';

/** A position between two neighbours, or past whichever end there is. */
export function positionBetween(before: number | undefined, after: number | undefined): number {
  if (before === undefined && after === undefined) return 1;
  if (before === undefined) return after! - 1;
  if (after === undefined) return before + 1;
  return (before + after) / 2;
}

/** Which of a column's two levels a fold is remembered against. */
function laneFoldKey(lane: BoardLaneView): string {
  return `lane:${lane.key}`;
}

/**
 * A project laid out as columns, in the arrangement the project keeps rather
 * than one column per status: statuses can be merged into a single column,
 * columns stacked over and under each other in one lane, and lanes reordered.
 * Cards are dragged between and within columns; where one is dropped is where
 * it stays, for everyone. Backlog statuses are on no column: what is in them is
 * not planned yet, and has a view of its own.
 *
 * Where a card may be dropped is what the workflow its type follows allows.
 * Columns it does not are dimmed while the card is in the air and will not take
 * it, so a move that the server would refuse cannot be started. A merged column
 * takes a card if any one of its statuses will have it.
 *
 * The arrangement is the project's and is saved for everyone. Which lanes and
 * columns are folded up is this reader's alone and stays in the browser: it
 * says nothing about the work, and changes several times an hour.
 */
export default function ProjectBoard({
  project,
  items,
  memberMap,
  canEdit,
  activeItemId,
  onOpenItem,
  onOpenBacklog,
}: {
  project: Project;
  items: WorkItemSummary[];
  memberMap: Map<string, WorkspaceMember>;
  canEdit: boolean;
  activeItemId: string | null;
  onOpenItem: (itemId: string) => void;
  onOpenBacklog?: () => void;
}) {
  const update = useUpdateWorkItem(project.id);
  const saveProject = useUpdateProject(project.workspaceId, project.id);
  const toast = useToast();
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ cellKey: string; index: number; statusId: string | null } | null>(null);
  const [laneDrag, setLaneDrag] = useState<string | null>(null);
  const [laneDrop, setLaneDrop] = useState<number | null>(null);
  const [folded, setFolded] = useLocalStorage<string[]>(`paradocs.boardFolded.${project.id}`, []);
  const [menu, setMenu] = useState<{ cellKey: string; anchor: HTMLElement } | null>(null);

  const lanes = useMemo(() => boardLanes(project), [project]);
  const held = dragging ? items.find((item) => item.id === dragging) : undefined;

  const backlogIds = new Set(project.statuses.filter((s) => s.category === 'backlog').map((s) => s.id));
  const backlogCount = items.filter((item) => backlogIds.has(item.statusId)).length;

  /** Every column's cards, in the order the column draws them, by cell key. */
  const byCell = useMemo(() => {
    const byStatus = new Map<string, WorkItemSummary[]>();
    for (const item of items) {
      const list = byStatus.get(item.statusId);
      if (list) list.push(item);
      else byStatus.set(item.statusId, [item]);
    }
    const cells = new Map<string, WorkItemSummary[]>();
    for (const lane of lanes) {
      for (const cell of lane.cells) {
        // A merged column ranks its statuses' work together. Positions are one
        // number line across the project, so cards from either still interleave
        // in the order someone dragged them into.
        const list = cell.statuses.flatMap((status) => byStatus.get(status.id) ?? []);
        list.sort((a, b) => a.position - b.position || a.number - b.number);
        cells.set(cell.key, list);
      }
    }
    return cells;
  }, [items, lanes]);

  const isFolded = (key: string) => folded.includes(key);
  const toggleFold = (key: string) =>
    setFolded((current) => (current.includes(key) ? current.filter((k) => k !== key) : [...current, key]));

  /** The statuses this column offers the card in the air, which may be none or several. */
  const offeredBy = (cell: BoardCellView) => (held ? cellTargets(project, cell, held) : []);
  const takes = (cell: BoardCellView) => !held || offeredBy(cell).length > 0;

  /**
   * `index` counts the column as drawn, with the dragged card still in it.
   * `chosen` is the status a drop box was dropped in, where the column offered
   * a choice; without one the column decides for itself.
   */
  function moveTo(cell: BoardCellView, index: number, itemId: string, chosen: string | null) {
    const current = items.find((item) => item.id === itemId);
    if (!current) return;
    const statusId = chosen ?? cellTarget(project, cell, current);
    if (!statusId) return;
    const column = byCell.get(cell.key) ?? [];
    const original = column.findIndex((item) => item.id === itemId);
    // Dropped back where it already was, as what it already was.
    if (statusId === current.statusId && original !== -1 && (original === index || original === index - 1)) return;
    const others = column.filter((item) => item.id !== itemId);
    const target = original !== -1 && index > original ? index - 1 : index;
    const position = positionBetween(others[target - 1]?.position, others[target]?.position);
    update.mutate(
      { id: itemId, statusId: statusId === current.statusId ? undefined : statusId, position },
      { onError: (err) => toast(err instanceof Error ? err.message : 'Could not move the work item', 'error') },
    );
  }

  /** Saves an arrangement, dropping any lane an edit emptied. */
  function saveLayout(next: BoardLaneView[]) {
    saveProject.mutate(
      { boardLayout: layoutOf(next.filter((lane) => lane.cells.length > 0)) },
      { onError: (err) => toast(err instanceof Error ? err.message : 'Could not change the board layout', 'error') },
    );
  }

  /** The lanes with one cell taken out, ready for it to be put somewhere else. */
  function without(cellKey: string): { rest: BoardLaneView[]; cell: BoardCellView; laneIndex: number } | null {
    const laneIndex = lanes.findIndex((lane) => lane.cells.some((c) => c.key === cellKey));
    if (laneIndex === -1) return null;
    const cell = lanes[laneIndex].cells.find((c) => c.key === cellKey)!;
    const rest = lanes.map((lane) => ({ ...lane, cells: lane.cells.filter((c) => c.key !== cellKey) }));
    return { rest, cell, laneIndex };
  }

  /** Puts one column's statuses into another, so they are shown as one list. */
  function merge(cellKey: string, intoKey: string) {
    const taken = without(cellKey);
    if (!taken) return;
    saveLayout(
      taken.rest.map((lane) => ({
        ...lane,
        cells: lane.cells.map((c) =>
          c.key === intoKey ? { ...c, statuses: [...c.statuses, ...taken.cell.statuses], merged: true } : c,
        ),
      })),
    );
  }

  /** Moves a column under the last one in another lane, so they share a width. */
  function stackUnder(cellKey: string, laneKey: string) {
    const taken = without(cellKey);
    if (!taken) return;
    saveLayout(
      taken.rest.map((lane) => (lane.key === laneKey ? { ...lane, cells: [...lane.cells, taken.cell] } : lane)),
    );
  }

  /** Takes a stacked column back out into a lane of its own, beside the one it was in. */
  function unstack(cellKey: string) {
    const taken = without(cellKey);
    if (!taken) return;
    const next = [...taken.rest];
    next.splice(taken.laneIndex + 1, 0, {
      key: taken.cell.statuses[0].id,
      statuses: taken.cell.statuses,
      cells: [taken.cell],
    });
    saveLayout(next);
  }

  /**
   * Unpicks a merge. A column standing on its own becomes one lane per status,
   * which is what the board looks like unarranged; one inside a stack stays in
   * that stack, since that is the shape it was merged from.
   */
  function split(cellKey: string) {
    const taken = without(cellKey);
    if (!taken) return;
    const parts: BoardCellView[] = taken.cell.statuses.map((status) => ({
      key: status.id,
      name: status.name,
      named: false,
      statuses: [status],
      merged: false,
    }));
    const lane = lanes[taken.laneIndex];
    const at = lane.cells.findIndex((c) => c.key === cellKey);
    if (lane.cells.length > 1) {
      saveLayout(
        taken.rest.map((l, i) => {
          if (i !== taken.laneIndex) return l;
          const cells = [...l.cells];
          cells.splice(at, 0, ...parts);
          return { ...l, cells };
        }),
      );
      return;
    }
    const next = [...taken.rest];
    next.splice(
      taken.laneIndex,
      1,
      ...parts.map((cell) => ({ key: cell.statuses[0].id, statuses: cell.statuses, cells: [cell] })),
    );
    saveLayout(next);
  }

  /** Moves a whole lane one place along the board. */
  function moveLane(laneKey: string, delta: -1 | 1) {
    const from = lanes.findIndex((lane) => lane.key === laneKey);
    const to = from + delta;
    if (from === -1 || to < 0 || to >= lanes.length) return;
    const next = [...lanes];
    next.splice(to, 0, next.splice(from, 1)[0]);
    saveLayout(next);
  }

  /** Drops a dragged lane header at `index`, counting the lanes as drawn. */
  function dropLane(laneKey: string, index: number) {
    const from = lanes.findIndex((lane) => lane.key === laneKey);
    if (from === -1 || index === from || index === from + 1) return;
    const next = [...lanes];
    const [moved] = next.splice(from, 1);
    next.splice(index > from ? index - 1 : index, 0, moved);
    saveLayout(next);
  }

  function rename(cellKey: string, name: string) {
    saveLayout(
      lanes.map((lane) => ({
        ...lane,
        cells: lane.cells.map((c) =>
          c.key === cellKey ? { ...c, name: name.trim(), named: name.trim().length > 0 } : c,
        ),
      })),
    );
  }

  const menuCell = menu && lanes.flatMap((lane) => lane.cells).find((cell) => cell.key === menu.cellKey);
  const menuLane = menu && lanes.find((lane) => lane.cells.some((cell) => cell.key === menu.cellKey));

  /** The line shown between lanes while a column header is being dragged. */
  const laneIndicator = <div className="w-0.5 shrink-0 self-stretch rounded-full bg-[var(--color-accent)]" />;

  return (
    <div
      className="scroll-thin flex h-full gap-3 overflow-x-auto p-4"
      onDragEnd={() => {
        setLaneDrag(null);
        setLaneDrop(null);
      }}
    >
      {backlogIds.size > 0 && onOpenBacklog && (
        <button
          onClick={onOpenBacklog}
          title="Work not yet planned"
          className="flex w-10 shrink-0 flex-col items-center gap-2 rounded-xl bg-[var(--color-surface)] py-3 text-xs text-[var(--color-muted)] hover:text-[var(--color-ink)]"
        >
          <Icon name="inbox" />
          <span className="font-medium tabular-nums">{backlogCount}</span>
          <span className="[writing-mode:vertical-rl]">Backlog</span>
        </button>
      )}

      {lanes.map((lane, laneIndex) => {
        const laneCount = lane.cells.reduce((total, cell) => total + (byCell.get(cell.key)?.length ?? 0), 0);
        const dropZone = (index: number) => ({
          onDragOver: (e: DragEvent) => {
            if (!canEdit || !e.dataTransfer.types.includes(LANE_DRAG_TYPE)) return;
            e.preventDefault();
            const rect = e.currentTarget.getBoundingClientRect();
            setLaneDrop(e.clientX < rect.left + rect.width / 2 ? index : index + 1);
          },
          onDrop: (e: DragEvent) => {
            const key = e.dataTransfer.getData(LANE_DRAG_TYPE);
            const at = laneDrop;
            setLaneDrop(null);
            setLaneDrag(null);
            if (!key || at === null) return;
            e.preventDefault();
            dropLane(key, at);
          },
        });

        return (
          <Fragment key={lane.key}>
            {laneDrop === laneIndex && laneDrag !== null && laneIndicator}
            {isFolded(laneFoldKey(lane)) ? (
              <button
                onClick={() => toggleFold(laneFoldKey(lane))}
                title={`Show ${lane.cells.map((cell) => cell.name).join(' · ')}`}
                className={cx(
                  'flex w-10 shrink-0 flex-col items-center gap-2 rounded-xl bg-[var(--color-surface)] py-3 text-xs',
                  'text-[var(--color-muted)] hover:text-[var(--color-ink)]',
                  laneDrag === lane.key && 'opacity-40',
                )}
                draggable={canEdit}
                onDragStart={(e) => {
                  e.dataTransfer.setData(LANE_DRAG_TYPE, lane.key);
                  e.dataTransfer.effectAllowed = 'move';
                  setLaneDrag(lane.key);
                }}
                {...dropZone(laneIndex)}
              >
                <Icon name="chevron-bar-right" />
                <span className="font-medium tabular-nums">{laneCount}</span>
                <span className="truncate [writing-mode:vertical-rl]">
                  {lane.cells.map((cell) => cell.name).join(' · ')}
                </span>
              </button>
            ) : (
              <div
                className={cx('flex w-72 shrink-0 flex-col gap-3', laneDrag === lane.key && 'opacity-40')}
                {...dropZone(laneIndex)}
              >
                {lane.cells.map((cell) => (
                  <Column
                    key={cell.key}
                    project={project}
                    cell={cell}
                    items={byCell.get(cell.key) ?? []}
                    memberMap={memberMap}
                    canEdit={canEdit}
                    activeItemId={activeItemId}
                    dragging={dragging}
                    takesDrop={takes(cell)}
                    offered={offeredBy(cell)}
                    folded={lane.cells.length > 1 && isFolded(cell.key)}
                    stacked={lane.cells.length > 1}
                    dropIndex={drop?.cellKey === cell.key ? drop.index : null}
                    dropStatusId={drop?.cellKey === cell.key ? drop.statusId : null}
                    onToggleFold={() => toggleFold(lane.cells.length > 1 ? cell.key : laneFoldKey(lane))}
                    onOpenMenu={(anchor) => setMenu({ cellKey: cell.key, anchor })}
                    onOpenItem={onOpenItem}
                    onDragStart={setDragging}
                    onDragEnd={() => {
                      setDragging(null);
                      setDrop(null);
                    }}
                    onDragOverIndex={(index, statusId) => setDrop({ cellKey: cell.key, index, statusId })}
                    onDropAt={(index, itemId, statusId) => {
                      setDrop(null);
                      setDragging(null);
                      moveTo(cell, index, itemId, statusId);
                    }}
                    laneKey={lane.key}
                    onLaneDragStart={() => setLaneDrag(lane.key)}
                  />
                ))}
              </div>
            )}
            {laneIndex === lanes.length - 1 && laneDrop === lanes.length && laneDrag !== null && laneIndicator}
          </Fragment>
        );
      })}

      {menu && menuCell && menuLane && (
        <ColumnMenu
          anchor={menu.anchor}
          cell={menuCell}
          lane={menuLane}
          lanes={lanes}
          canEdit={canEdit}
          folded={isFolded(menuLane.cells.length > 1 ? menuCell.key : laneFoldKey(menuLane))}
          first={lanes[0]?.key === menuLane.key}
          last={lanes[lanes.length - 1]?.key === menuLane.key}
          onClose={() => setMenu(null)}
          onToggleFold={() => toggleFold(menuLane.cells.length > 1 ? menuCell.key : laneFoldKey(menuLane))}
          onFoldLane={() => toggleFold(laneFoldKey(menuLane))}
          onMoveLane={(delta) => moveLane(menuLane.key, delta)}
          onMerge={(intoKey) => merge(menuCell.key, intoKey)}
          onStackUnder={(laneKey) => stackUnder(menuCell.key, laneKey)}
          onUnstack={() => unstack(menuCell.key)}
          onSplit={() => split(menuCell.key)}
          onRename={(name) => rename(menuCell.key, name)}
        />
      )}
    </div>
  );
}

/** A column's heading: its status, or the statuses a merge put together. */
function CellHeading({ cell }: { cell: BoardCellView }) {
  if (!cell.merged) return <StatusPill status={cell.statuses[0]} />;
  return (
    <span
      className="inline-flex min-w-0 items-center gap-1 rounded-full bg-[var(--color-raised)] px-2 py-0.5 text-xs font-medium"
      title={cell.statuses.map((s) => s.name).join(', ')}
    >
      <span className="flex shrink-0 -space-x-0.5">
        {cell.statuses.map((status) => (
          <span key={status.id} className="h-2 w-2 rounded-full" style={{ background: status.color }} />
        ))}
      </span>
      <span className="truncate">{cell.name}</span>
    </span>
  );
}

/** What a drop box lays over the cards behind it. */
const VEIL = 'color-mix(in srgb, var(--color-canvas) 88%, transparent)';

/**
 * One box per status a column is offering the card in the air, drawn over its
 * cards while the drag is in flight, so every drop shows the status it makes.
 * The card takes the status of whichever box it is dropped in, so a workflow
 * that allows two of a merged column's statuses is answered by where the card
 * is let go rather than guessed at.
 *
 * The boxes stack, so each spans the column's width. Down picks the status,
 * and where the pointer sits within a box, as a fraction of its height, picks
 * the place in the column: each box stands for the whole column in miniature.
 */
function StatusBoxes({
  statuses,
  active,
  onOver,
  onDrop,
}: {
  statuses: ProjectStatus[];
  /** The one the pointer is over, which is drawn as the one that would be taken. */
  active: string | null;
  /** `fraction` is how far down the box the pointer is, from 0 to 1. */
  onOver: (statusId: string, fraction: number) => void;
  onDrop: (statusId: string, fraction: number, itemId: string) => void;
}) {
  const fractionOf = (e: DragEvent<HTMLElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return rect.height > 0 ? Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)) : 1;
  };
  return (
    <div className="absolute inset-0 z-10 flex flex-col gap-1 p-1">
      {statuses.map((status) => {
        const chosen = active === status.id;
        return (
          <div
            key={status.id}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
              e.preventDefault();
              onOver(status.id, fractionOf(e));
            }}
            onDrop={(e) => {
              const id = e.dataTransfer.getData(DRAG_TYPE);
              if (!id) return;
              e.preventDefault();
              e.stopPropagation();
              onDrop(status.id, fractionOf(e), id);
            }}
            className={cx(
              'flex min-h-0 flex-1 flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed transition-colors',
              chosen ? 'border-solid' : 'border-[var(--color-line)]',
            )}
            // Veiled rather than opaque: enough to read the label over whatever
            // cards are behind, not so much that the insertion line loses its
            // bearings. The chosen one takes its status's colour over the veil.
            style={
              chosen
                ? {
                    borderColor: status.color,
                    background: `color-mix(in srgb, ${status.color} 16%, ${VEIL})`,
                  }
                : { background: VEIL }
            }
          >
            <span
              className="max-w-full truncate rounded-full px-2 py-0.5 text-[11px] font-medium"
              style={{ background: `color-mix(in srgb, ${status.color} 20%, transparent)`, color: status.color }}
            >
              {status.name}
            </span>
            {chosen && (
              <span style={{ color: status.color }}>
                <Icon name="box-arrow-in-down" className="text-xs" />
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Column({
  project,
  cell,
  items,
  memberMap,
  canEdit,
  activeItemId,
  dragging,
  takesDrop,
  offered,
  folded,
  stacked,
  dropIndex,
  dropStatusId,
  onToggleFold,
  onOpenMenu,
  onOpenItem,
  onDragStart,
  onDragEnd,
  onDragOverIndex,
  onDropAt,
  laneKey,
  onLaneDragStart,
}: {
  project: Project;
  cell: BoardCellView;
  items: WorkItemSummary[];
  memberMap: Map<string, WorkspaceMember>;
  canEdit: boolean;
  activeItemId: string | null;
  dragging: string | null;
  /** False while a card no status here will take is being dragged. */
  takesDrop: boolean;
  /** The statuses here that would take the card in the air. Several: the drop must choose. */
  offered: ProjectStatus[];
  folded: boolean;
  /** Whether it shares its lane, which is what makes folding it a column-sized thing. */
  stacked: boolean;
  dropIndex: number | null;
  /** The status the pointer is over, while a choice is being drawn. */
  dropStatusId: string | null;
  onToggleFold: () => void;
  onOpenMenu: (anchor: HTMLElement) => void;
  onOpenItem: (itemId: string) => void;
  onDragStart: (itemId: string) => void;
  onDragEnd: () => void;
  onDragOverIndex: (index: number, statusId: string | null) => void;
  onDropAt: (index: number, itemId: string, statusId: string | null) => void;
  /** The lane this column sits in, which is what its heading drags. */
  laneKey: string;
  onLaneDragStart: () => void;
}) {
  const estimate = items.reduce((total, item) => total + (item.estimate ?? 0), 0);
  const primaryRole = project.roles[0];
  const list = useRef<HTMLDivElement>(null);

  /**
   * Whether the status boxes are up: over every column that takes the card in
   * the air, one box when there is only one status to land in and one per
   * status when a merged column has to ask which.
   */
  const boxed = canEdit && dragging !== null && takesDrop && offered.length > 0;
  const landing = offered.length === 1 ? offered[0] : undefined;

  // Above the drop boxes, which are drawn over the cards: where the card lands
  // is worth seeing even while a status is being picked.
  const indicator = <div className="relative z-20 h-0.5 rounded-full bg-[var(--color-accent)]" />;

  /**
   * Which gap in the column a box's pointer stands for, counted the way the
   * cards are drawn: `fraction` of the way down the box is taken as that far
   * down the visible column. The boxes cover the cards, so the cards' own
   * handlers cannot say.
   */
  function indexAt(fraction: number): number {
    if (!list.current) return items.length;
    const view = list.current.getBoundingClientRect();
    const clientY = view.top + fraction * view.height;
    const cards = [...list.current.querySelectorAll('[data-card]')];
    const found = cards.findIndex((card) => {
      const rect = card.getBoundingClientRect();
      return clientY < rect.top + rect.height / 2;
    });
    return found === -1 ? cards.length : found;
  }

  const heading = (
    <header
      className="flex items-center gap-2 px-3 pb-1 pt-2.5"
      draggable={canEdit}
      onDragStart={(e) => {
        // Cards are dragged from the list below; the heading moves the lane.
        e.dataTransfer.setData(LANE_DRAG_TYPE, laneKey);
        e.dataTransfer.effectAllowed = 'move';
        onLaneDragStart();
      }}
    >
      <button
        onClick={onToggleFold}
        title={folded ? 'Show the cards' : stacked ? 'Fold this column up' : 'Fold this lane up'}
        className="grid h-5 w-4 shrink-0 place-items-center rounded text-[10px] text-[var(--color-muted)] hover:bg-[var(--color-raised)] hover:text-[var(--color-ink)]"
      >
        <Icon name={folded ? 'chevron-right' : 'chevron-down'} />
      </button>
      <CellHeading cell={cell} />
      <span className="text-xs tabular-nums text-[var(--color-muted)]">{items.length}</span>
      {estimate > 0 && !folded && (
        <span className="text-xs text-[var(--color-muted)]" title="Total estimate">
          · {Number(estimate.toFixed(2))} est
        </span>
      )}
      <span className="min-w-0 flex-1" />
      {canEdit && (
        <IconButton
          label={`Lay out ${cell.name}`}
          className="h-5 w-5 text-[10px]"
          onClick={(e) => onOpenMenu(e.currentTarget)}
        >
          <Icon name="three-dots" />
        </IconButton>
      )}
    </header>
  );

  if (folded) {
    return <section className="shrink-0 rounded-xl bg-[var(--color-surface)] pb-1.5">{heading}</section>;
  }

  return (
    <section
      className={cx(
        'flex min-h-0 flex-1 flex-col rounded-xl bg-[var(--color-surface)] transition-opacity',
        dragging && !takesDrop && 'opacity-40',
      )}
      title={
        dragging && !takesDrop
          ? `${cell.name} is not a move this item's workflow allows`
          : landing && cell.merged
            ? `Dropping here puts it in ${landing.name}`
            : undefined
      }
      onDragOver={(e) => {
        // Not preventing the default is what refuses the drop.
        if (!canEdit || !takesDrop || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
        e.preventDefault();
        // The boxes take the drop while they are up.
        if (boxed) return;
        // Over the column but past its cards: the end of it.
        if ((e.target as HTMLElement).closest('[data-card]') === null) onDragOverIndex(items.length, null);
      }}
      onDrop={(e) => {
        const id = e.dataTransfer.getData(DRAG_TYPE);
        if (!id || dropIndex === null || !takesDrop) return;
        e.preventDefault();
        onDropAt(dropIndex, id, dropStatusId);
      }}
    >
      {heading}

      {/* The boxes sit outside the scrolling list so they cover what is in view. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div ref={list} className="scroll-thin min-h-0 flex-1 space-y-1.5 overflow-y-auto px-2 pb-2 pt-1">
          {items.map((item, index) => {
            const holders = primaryRole ? (item.roles[primaryRole.id] ?? []) : [];
            const holderNames = primaryRole?.freeForm ? (item.roleNames[primaryRole.id] ?? []) : [];
            const status = cell.statuses.find((s) => s.id === item.statusId) ?? cell.statuses[0];
            const overdue = isOverdue(item.dueDate, status.category === 'done');
            return (
              <div key={item.id}>
                {dropIndex === index && dragging !== item.id && indicator}
                <button
                  data-card
                  draggable={canEdit}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DRAG_TYPE, item.id);
                    e.dataTransfer.effectAllowed = 'move';
                    // Raising the drop boxes covers this card, and covering the
                    // source during dragstart makes the browser cancel the drag.
                    // Wait for the drag to begin before drawing them.
                    const id = item.id;
                    setTimeout(() => onDragStart(id), 0);
                  }}
                  onDragEnd={onDragEnd}
                  onDragOver={(e) => {
                    if (!canEdit || !takesDrop || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
                    e.preventDefault();
                    const rect = e.currentTarget.getBoundingClientRect();
                    onDragOverIndex(e.clientY < rect.top + rect.height / 2 ? index : index + 1, null);
                  }}
                  onClick={() => onOpenItem(item.id)}
                  className={cx(
                    'mt-1.5 block w-full rounded-lg border bg-[var(--color-raised)] p-2.5 text-left shadow-sm transition-colors',
                    item.id === activeItemId
                      ? 'border-[var(--color-accent)]'
                      : 'border-transparent hover:border-[var(--color-line)]',
                    dragging === item.id && 'opacity-40',
                  )}
                >
                  <p className={cx('text-sm leading-snug', status.category === 'done' && 'text-[var(--color-muted)] line-through')}>
                    {item.title}
                  </p>
                  <div className="mt-2 flex items-center gap-1.5 text-xs text-[var(--color-muted)]">
                    <TypeIcon type={item.type} />
                    <span>{item.key}</span>
                    {/* A merged column holds work from several statuses, so each card says which. */}
                    {cell.merged && (
                      <span className="flex items-center gap-0.5" title={status.name}>
                        <span className="h-1.5 w-1.5 rounded-full" style={{ background: status.color }} />
                        <span className="max-w-[5rem] truncate">{status.name}</span>
                      </span>
                    )}
                    {item.priority !== 'none' && <PriorityIcon priority={item.priority} />}
                    {item.dueDate && (
                      <span className={cx('flex items-center gap-0.5', overdue && 'text-red-500')}>
                        <Icon name="calendar-event" className="text-[10px]" />
                        {formatDue(item.dueDate)}
                      </span>
                    )}
                    {item.commentCount > 0 && (
                      <span className="flex items-center gap-0.5">
                        <Icon name="chat-left-text" className="text-[10px]" />
                        {item.commentCount}
                      </span>
                    )}
                    <span className="flex-1" />
                    {item.estimate !== null && (
                      <span className="rounded bg-[var(--color-surface)] px-1 tabular-nums" title="Estimate">
                        {item.estimate}
                      </span>
                    )}
                    <PeopleStack userIds={holders} names={holderNames} members={memberMap} max={2} size="xs" />
                  </div>
                </button>
              </div>
            );
          })}
          {dropIndex === items.length && indicator}
          {items.length === 0 && <p className="px-2 py-4 text-center text-xs text-[var(--color-muted)]">Nothing here</p>}
        </div>
        {boxed && (
          <StatusBoxes
            statuses={offered}
            active={dropStatusId}
            onOver={(statusId, fraction) => onDragOverIndex(indexAt(fraction), statusId)}
            onDrop={(statusId, fraction, itemId) => onDropAt(indexAt(fraction), itemId, statusId)}
          />
        )}
      </div>
    </section>
  );
}

const MENU_ITEM =
  'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-[var(--color-surface)] disabled:opacity-40 disabled:hover:bg-transparent';

/**
 * What can be done with one column: fold it away, move its lane, merge it with
 * another column, stack it under one, or undo either. Picking a column to merge
 * with or stack under takes over the same panel rather than opening a submenu,
 * which keeps the whole thing one press wide.
 */
function ColumnMenu({
  anchor,
  cell,
  lane,
  lanes,
  canEdit,
  folded,
  first,
  last,
  onClose,
  onToggleFold,
  onFoldLane,
  onMoveLane,
  onMerge,
  onStackUnder,
  onUnstack,
  onSplit,
  onRename,
}: {
  anchor: HTMLElement;
  cell: BoardCellView;
  lane: BoardLaneView;
  lanes: BoardLaneView[];
  canEdit: boolean;
  folded: boolean;
  first: boolean;
  last: boolean;
  onClose: () => void;
  onToggleFold: () => void;
  onFoldLane: () => void;
  onMoveLane: (delta: -1 | 1) => void;
  onMerge: (intoKey: string) => void;
  onStackUnder: (laneKey: string) => void;
  onUnstack: () => void;
  onSplit: () => void;
  onRename: (name: string) => void;
}) {
  const [mode, setMode] = useState<'root' | 'merge' | 'stack' | 'rename'>('root');
  const [name, setName] = useState(cell.name);
  const stacked = lane.cells.length > 1;

  /** Every other column, which is what a merge can be made into. */
  const others = lanes.flatMap((l) => l.cells).filter((c) => c.key !== cell.key);
  /** Every other lane, which is what this column can be stacked into. */
  const otherLanes = lanes.filter((l) => l.key !== lane.key);

  function act(run: () => void) {
    onClose();
    run();
  }

  if (mode === 'rename') {
    return (
      <Popover anchor={anchor} placement="below" onClose={onClose} className="w-64 p-2">
        <p className="px-1 pb-1.5 text-xs text-[var(--color-muted)]">What this merged column is called</p>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') act(() => onRename(name));
            if (e.key === 'Escape') onClose();
          }}
          maxLength={40}
          className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
        />
      </Popover>
    );
  }

  if (mode === 'merge' || mode === 'stack') {
    const merging = mode === 'merge';
    const choices = merging
      ? others.map((c) => ({ key: c.key, label: c.name, statuses: c.statuses }))
      : otherLanes.map((l) => ({ key: l.key, label: l.cells.map((c) => c.name).join(' · '), statuses: l.statuses }));
    return (
      <Popover anchor={anchor} placement="below" onClose={onClose} className="w-60 p-1">
        <button onClick={() => setMode('root')} className={cx(MENU_ITEM, 'text-xs text-[var(--color-muted)]')}>
          <Icon name="chevron-left" /> {merging ? 'Merge with' : 'Stack under'}
        </button>
        {choices.length === 0 ? (
          <p className="px-2 py-2 text-xs text-[var(--color-muted)]">
            {merging ? 'There is no other column to merge with.' : 'There is no other lane to stack under.'}
          </p>
        ) : (
          choices.map((choice) => (
            <button
              key={choice.key}
              onClick={() => act(() => (merging ? onMerge(choice.key) : onStackUnder(choice.key)))}
              className={MENU_ITEM}
            >
              <span className="flex shrink-0 -space-x-0.5">
                {choice.statuses.map((status) => (
                  <span key={status.id} className="h-2.5 w-2.5 rounded-full" style={{ background: status.color }} />
                ))}
              </span>
              <span className="min-w-0 truncate">{choice.label}</span>
            </button>
          ))
        )}
      </Popover>
    );
  }

  return (
    <Popover anchor={anchor} placement="below" onClose={onClose} className="w-56 p-1">
      <button onClick={() => act(onToggleFold)} className={MENU_ITEM}>
        <Icon name={folded ? 'chevron-down' : 'chevron-right'} />
        {folded ? 'Show the cards' : stacked ? 'Fold this column up' : 'Fold this lane up'}
      </button>
      {stacked && !folded && (
        <button onClick={() => act(onFoldLane)} className={MENU_ITEM}>
          <Icon name="chevron-bar-left" /> Fold the whole lane up
        </button>
      )}

      {canEdit && (
        <>
          <div className="my-1 border-t border-[var(--color-line)]" />
          <button onClick={() => act(() => onMoveLane(-1))} disabled={first} className={MENU_ITEM}>
            <Icon name="arrow-left" /> Move the lane left
          </button>
          <button onClick={() => act(() => onMoveLane(1))} disabled={last} className={MENU_ITEM}>
            <Icon name="arrow-right" /> Move the lane right
          </button>

          <div className="my-1 border-t border-[var(--color-line)]" />
          <button onClick={() => setMode('merge')} className={MENU_ITEM}>
            <Icon name="union" /> Merge with… <span className="flex-1" />
            <Icon name="chevron-right" className="text-[10px] text-[var(--color-muted)]" />
          </button>
          <button onClick={() => setMode('stack')} className={MENU_ITEM}>
            <Icon name="distribute-vertical" /> Stack under… <span className="flex-1" />
            <Icon name="chevron-right" className="text-[10px] text-[var(--color-muted)]" />
          </button>
          {stacked && (
            <button onClick={() => act(onUnstack)} className={MENU_ITEM}>
              <Icon name="arrows-expand" /> Give it its own lane
            </button>
          )}
          {cell.merged && (
            <>
              <button onClick={() => setMode('rename')} className={MENU_ITEM}>
                <Icon name="pencil" /> Rename the column…
              </button>
              <button onClick={() => act(onSplit)} className={MENU_ITEM}>
                <Icon name="intersect" /> Split it back apart
              </button>
            </>
          )}
        </>
      )}
    </Popover>
  );
}
