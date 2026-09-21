import { useEffect, useMemo, useState } from 'react';
import {
  activeSprint,
  usesSprints,
  type User,
  isEpicType,
  type WorkItemListing,
  type WorkspaceMember,
} from '@paradocs/shared';
import {
  useMarkWorkItemsRead,
  useMembers,
  useNotifications,
  useProject,
  useProjects,
  useWorkItemListing,
  useWorkItems,
  type WorkspaceSummary,
} from '../../api/hooks';
import { cx, useLocalStorage } from '../../lib/util';
import Icon, { type IconName } from '../Icon';
import { Button, EmptyState, Spinner } from '../ui';
import ProjectBacklog from './ProjectBacklog';
import ProjectBoard from './ProjectBoard';
import ProjectEpics from './ProjectEpics';
import { NewProjectDialog, NewWorkItemDialog } from './ProjectDialogs';
import ProjectSettings from './ProjectSettings';
import { NoSprintRunning, SprintBacklog, SprintBar } from './ProjectSprints';
import ProjectTable from './ProjectTable';
import ProjectWorkload from './ProjectWorkload';
import WorkItemPanel, { type ProjectNavigation } from './WorkItemPanel';
import { PriorityIcon, ProjectIcon, StatusPill, TypeIcon, formatDue, isOverdue, useMemberMap } from './projectUi';

type View = 'epics' | 'backlog' | 'board' | 'list' | 'workload' | 'settings';

const VIEWS: { id: View; label: string; icon: IconName }[] = [
  { id: 'epics', label: 'Epics', icon: 'lightning-charge' },
  { id: 'backlog', label: 'Backlog', icon: 'inbox' },
  { id: 'board', label: 'Board', icon: 'kanban' },
  { id: 'list', label: 'List', icon: 'list-ul' },
  { id: 'workload', label: 'Workload', icon: 'bar-chart-steps' },
  { id: 'settings', label: 'Settings', icon: 'gear' },
];

/**
 * The Projects app's main area: the work assigned to you when no project is
 * open, or one project as a board, a list, its workload or its settings, with
 * a work item open beside it when one is chosen.
 */
export default function ProjectsApp({
  workspace,
  user,
  projectId,
  itemId,
  navigation,
  onOpenProject,
  onOpenItem,
  onCloseItem,
  onProjectDeleted,
}: {
  workspace: WorkspaceSummary;
  user: User;
  projectId: string | null;
  itemId: string | null;
  navigation: ProjectNavigation;
  onOpenProject: (projectId: string) => void;
  onOpenItem: (projectId: string, itemId: string) => void;
  onCloseItem: () => void;
  onProjectDeleted: () => void;
}) {
  const members = useMembers(workspace.id);

  // Opening an item answers whatever it was asking you for.
  const notifications = useNotifications();
  const markRead = useMarkWorkItemsRead();
  const waiting = notifications.data?.workItems?.some((n) => n.workItemId === itemId) ?? false;
  useEffect(() => {
    if (itemId && waiting) markRead.mutate([itemId]);
    // The mutation object is stable; including it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId, waiting]);

  if (!projectId) {
    return <MyWork workspace={workspace} user={user} onOpenItem={onOpenItem} onOpenProject={onOpenProject} />;
  }
  return (
    <ProjectView
      key={projectId}
      workspace={workspace}
      user={user}
      projectId={projectId}
      itemId={itemId}
      members={members.data ?? []}
      navigation={navigation}
      onOpenItem={(id) => onOpenItem(projectId, id)}
      onCloseItem={onCloseItem}
      onProjectDeleted={onProjectDeleted}
    />
  );
}

function ProjectView({
  workspace,
  user,
  projectId,
  itemId,
  members,
  navigation,
  onOpenItem,
  onCloseItem,
  onProjectDeleted,
}: {
  workspace: WorkspaceSummary;
  user: User;
  projectId: string;
  itemId: string | null;
  members: WorkspaceMember[];
  navigation: ProjectNavigation;
  onOpenItem: (itemId: string) => void;
  onCloseItem: () => void;
  onProjectDeleted: () => void;
}) {
  const project = useProject(projectId);
  const items = useWorkItems(projectId);
  const memberMap = useMemberMap(members);
  const [storedView, setView] = useLocalStorage<View | null>(`paradocs.projectView.${projectId}`, null);
  const [text, setText] = useState('');
  const [person, setPerson] = useState('');
  const [creating, setCreating] = useState<{ typeId?: string; epicId?: string } | null>(null);

  const data = project.data;
  const sprints = data ? usesSprints(data) : false;
  const running = data && sprints ? activeSprint(data) : null;
  // With sprints on, the backlog is where they are planned, whatever the statuses are.
  const hasBacklog = sprints || (data?.statuses.some((s) => s.category === 'backlog') ?? false);
  const hasEpics = data?.kind === 'project' && data.itemTypes.some((t) => t.epic);
  // A view with nothing to show — no backlog status, no epic-kind type — falls back to the default.
  const chosen = (storedView === 'backlog' && !hasBacklog) || (storedView === 'epics' && !hasEpics) ? null : storedView;
  const view: View = chosen ?? (data?.kind === 'queue' ? 'list' : 'board');
  // The workspace role, and then any lock on the project.
  const canEdit = workspace.role !== 'viewer' && data?.permission === 'edit';
  const canManageAccess = workspace.role === 'owner' || workspace.role === 'admin';

  const filtered = useMemo(() => {
    const needle = text.trim().toLowerCase();
    const who = person === 'me' ? user.id : person;
    return (items.data ?? []).filter(
      (item) =>
        (!needle || item.title.toLowerCase().includes(needle) || item.key.toLowerCase().includes(needle)) &&
        (!who || Object.values(item.roles).some((holders) => holders.includes(who))),
    );
  }, [items.data, text, person, user.id]);

  // A project's epics are followed in their own view, not worked on the board,
  // in the backlog or in workload; a queue has no such view, so shows them all.
  const worked = useMemo(
    () => (data?.kind === 'project' ? filtered.filter((item) => !isEpicType(data, item.typeId)) : filtered),
    [filtered, data],
  );

  // With sprints on, the board is the running sprint's work and nothing else.
  const onBoard = useMemo(
    () => (sprints ? (running ? worked.filter((item) => item.sprintId === running.id) : []) : worked),
    [worked, sprints, running],
  );
  const sprintItems = useMemo(
    () => (running ? (items.data ?? []).filter((item) => item.sprintId === running.id) : []),
    [items.data, running],
  );

  if (project.isLoading) return <Spinner />;
  if (!data) {
    return (
      <EmptyState
        icon="exclamation-triangle"
        title="This project cannot be opened"
        hint="It may have been deleted, or not be shared with you."
      />
    );
  }

  const byId = (id: View) => VIEWS.find((v) => v.id === id)!;
  const epicType = data.kind === 'project' ? data.itemTypes.find((t) => t.epic) : undefined;
  // A queue is worked as a list; a backlog tab only appears where there is one.
  const views = (
    data.kind === 'queue'
      ? (['list', 'board', 'backlog', 'workload', 'settings'] as View[])
      : (['epics', 'backlog', 'board', 'list', 'workload', 'settings'] as View[])
  )
    .filter((id) => id !== 'backlog' || hasBacklog)
    // Only a project with an epic-kind type has epics to follow.
    .filter((id) => id !== 'epics' || epicType !== undefined)
    .map(byId);
  // New work filed from the backlog goes there; from anywhere else, onto the board.
  const newStatusId =
    (view === 'backlog'
      ? data.statuses.find((s) => s.category === 'backlog')
      : data.statuses.find((s) => s.category !== 'backlog'))?.id ?? data.statuses[0]?.id;
  const filtering = text.trim() !== '' || person !== '';

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--color-line)] px-4 py-2">
          <ProjectIcon project={data} className="text-lg" />
          <h1 className="min-w-0 truncate text-base font-semibold">{data.name}</h1>
          <span className="rounded bg-[var(--color-surface)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-muted)]">
            {data.key}
          </span>
          <div role="tablist" className="ml-2 flex rounded-md border border-[var(--color-line)] p-0.5">
            {views.map((option) => (
              <button
                key={option.id}
                role="tab"
                aria-selected={view === option.id}
                onClick={() => setView(option.id)}
                className={cx(
                  'flex items-center gap-1 rounded px-2 py-0.5 text-xs',
                  view === option.id
                    ? 'bg-[var(--color-accent-soft)] font-medium text-[var(--color-accent)]'
                    : 'text-[var(--color-muted)] hover:text-[var(--color-ink)]',
                )}
              >
                <Icon name={option.icon} />
                {option.label}
              </button>
            ))}
          </div>
          <span className="flex-1" />
          {view !== 'settings' && (
            <>
              <div className="relative">
                <Icon name="funnel" className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-[var(--color-muted)]" />
                <input
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="Filter"
                  className="w-40 rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] py-1 pl-6 pr-2 text-xs outline-none focus:border-[var(--color-accent)]"
                />
              </div>
              {view !== 'workload' && (
                <select
                  value={person}
                  onChange={(e) => setPerson(e.target.value)}
                  className="rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
                  aria-label="Show work for"
                >
                  <option value="">Anyone</option>
                  <option value="me">Me</option>
                  {members
                    .filter((m) => !m.isSelf)
                    .map((m) => (
                      <option key={m.userId} value={m.userId}>
                        {m.name}
                      </option>
                    ))}
                </select>
              )}
            </>
          )}
          {canEdit && !data.archivedAt && (
            <Button variant="primary" className="text-xs" onClick={() => setCreating({})}>
              <Icon name="plus-lg" /> New
            </Button>
          )}
        </div>

        {data.archivedAt && (
          <div className="shrink-0 border-b border-[var(--color-line)] bg-amber-500/10 px-4 py-1.5 text-xs text-amber-700 dark:text-amber-300">
            <Icon name="archive" /> This {data.kind} is archived. Its work can still be read and changed, but nothing new can be added.
          </div>
        )}

        <div className="min-h-0 flex-1">
          {items.isLoading ? (
            <Spinner />
          ) : view === 'settings' ? (
            <ProjectSettings
              project={data}
              items={items.data ?? []}
              canEdit={canEdit}
              canManageAccess={canManageAccess}
              onDeleted={onProjectDeleted}
            />
          ) : view === 'epics' && epicType ? (
            <ProjectEpics
              project={data}
              items={items.data ?? []}
              visible={filtered}
              filtering={filtering}
              memberMap={memberMap}
              canEdit={canEdit}
              activeItemId={itemId}
              onOpenItem={onOpenItem}
              onNewItem={setCreating}
            />
          ) : view === 'backlog' && sprints ? (
            <SprintBacklog
              project={data}
              items={worked}
              memberMap={memberMap}
              canEdit={canEdit}
              activeItemId={itemId}
              onOpenItem={onOpenItem}
              onOpenBoard={() => setView('board')}
            />
          ) : view === 'backlog' ? (
            <ProjectBacklog
              project={data}
              items={worked}
              memberMap={memberMap}
              canEdit={canEdit}
              activeItemId={itemId}
              onOpenItem={onOpenItem}
              onOpenBoard={() => setView('board')}
            />
          ) : (items.data ?? []).length === 0 ? (
            <EmptyState
              icon={data.kind === 'queue' ? 'inboxes' : 'kanban'}
              title={data.kind === 'queue' ? 'Nothing in the queue' : 'No work items yet'}
              hint={canEdit ? 'Add the first with New. Work items can be linked from documents, canvases and chat.' : undefined}
            />
          ) : view === 'board' && sprints && !running ? (
            <NoSprintRunning project={data} canEdit={canEdit} onOpenBacklog={() => setView('backlog')} />
          ) : view === 'board' ? (
            <div className="flex h-full flex-col">
              {running && (
                <SprintBar
                  project={data}
                  sprint={running}
                  items={sprintItems}
                  canEdit={canEdit}
                  onOpenBacklog={() => setView('backlog')}
                />
              )}
              <div className="min-h-0 flex-1">
                <ProjectBoard
                  project={data}
                  items={onBoard}
                  memberMap={memberMap}
                  canEdit={canEdit && !filtering}
                  activeItemId={itemId}
                  onOpenItem={onOpenItem}
                  // The sprint bar leads to the backlog when there are sprints.
                  onOpenBacklog={hasBacklog && !sprints ? () => setView('backlog') : undefined}
                />
              </div>
            </div>
          ) : view === 'list' ? (
            <ProjectTable
              project={data}
              items={filtered}
              memberMap={memberMap}
              canEdit={canEdit}
              activeItemId={itemId}
              onOpenItem={onOpenItem}
            />
          ) : (
            <ProjectWorkload
              project={data}
              items={worked}
              members={members}
              memberMap={memberMap}
              activeItemId={itemId}
              onOpenItem={onOpenItem}
            />
          )}
        </div>
      </div>

      {itemId && (
        <aside className="w-[460px] max-w-[50%] shrink-0 border-l border-[var(--color-line)] bg-[var(--color-canvas)]">
          <WorkItemPanel
            workspaceId={workspace.id}
            itemId={itemId}
            project={data}
            members={members}
            selfId={user.id}
            canEdit={canEdit}
            onClose={onCloseItem}
            navigation={navigation}
          />
        </aside>
      )}

      {creating && (
        <NewWorkItemDialog
          project={data}
          members={members}
          selfId={user.id}
          initialStatusId={newStatusId}
          // Filed from the board while a sprint runs, it joins that sprint so it shows up there.
          initialSprintId={view === 'board' ? running?.id : undefined}
          initialTypeId={creating.typeId ?? (view === 'epics' && !creating.epicId ? epicType?.id : undefined)}
          initialEpicId={creating.epicId}
          onClose={() => setCreating(null)}
          onCreated={(id) => {
            setCreating(null);
            onOpenItem(id);
          }}
        />
      )}
    </div>
  );
}

/**
 * What is on your plate across every project: the work you hold a role on,
 * open first and soonest due first, and what you finished recently.
 */
function MyWork({
  workspace,
  user,
  onOpenItem,
  onOpenProject,
}: {
  workspace: WorkspaceSummary;
  user: User;
  onOpenItem: (projectId: string, itemId: string) => void;
  onOpenProject: (projectId: string) => void;
}) {
  const listing = useWorkItemListing(workspace.id, { mine: true, limit: 200 });
  const projects = useProjects(workspace.id);
  const [creating, setCreating] = useState(false);
  const canCreate = workspace.role !== 'viewer';

  const { open, done } = useMemo(() => {
    const all = listing.data ?? [];
    const openItems = all.filter((item) => item.status.category !== 'done');
    openItems.sort(
      (a, b) =>
        (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') ||
        ['urgent', 'high', 'medium', 'low', 'none'].indexOf(a.priority) - ['urgent', 'high', 'medium', 'low', 'none'].indexOf(b.priority) ||
        b.updatedAt.localeCompare(a.updatedAt),
    );
    return { open: openItems, done: all.filter((item) => item.status.category === 'done').slice(0, 10) };
  }, [listing.data]);

  const row = (item: WorkItemListing) => (
    <li key={item.id}>
      <button
        onClick={() => onOpenItem(item.project.id, item.id)}
        className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-[var(--color-surface)]"
      >
        <TypeIcon type={item.itemType} />
        <PriorityIcon priority={item.priority} className="w-4 justify-center" />
        <span className="w-20 shrink-0 text-xs text-[var(--color-muted)]">{item.key}</span>
        <span className={cx('min-w-0 flex-1 truncate', item.status.category === 'done' && 'text-[var(--color-muted)] line-through')}>
          {item.title}
        </span>
        <span className="hidden shrink-0 text-xs text-[var(--color-muted)] md:inline">{item.myRoles.join(', ')}</span>
        {item.dueDate && (
          <span className={cx('w-14 shrink-0 text-right text-xs', isOverdue(item.dueDate, item.status.category === 'done') ? 'text-red-500' : 'text-[var(--color-muted)]')}>
            {formatDue(item.dueDate)}
          </span>
        )}
        <StatusPill status={item.status} className="w-28 shrink-0 justify-center" />
      </button>
    </li>
  );

  return (
    <div className="scroll-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-6">
        <div className="mb-4 flex items-center gap-2">
          <h1 className="flex-1 text-lg font-semibold">My work</h1>
          {canCreate && (
            <Button variant="subtle" className="text-xs" onClick={() => setCreating(true)}>
              <Icon name="plus-lg" /> New project
            </Button>
          )}
        </div>

        {listing.isLoading ? (
          <Spinner />
        ) : open.length === 0 && done.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[var(--color-line)] px-6 py-10 text-center">
            <Icon name="person-check" className="text-2xl text-[var(--color-muted)]" />
            <p className="mt-2 text-sm font-medium">Nothing assigned to you, {user.name.split(' ')[0]}</p>
            <p className="mt-1 text-xs text-[var(--color-muted)]">
              Work items you are given a role on — assignee, reviewer or any other — gather here.
            </p>
          </div>
        ) : (
          <>
            <h2 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">
              Open <span className="font-normal normal-case">{open.length}</span>
            </h2>
            <ul className="divide-y divide-[var(--color-line)] overflow-hidden rounded-xl border border-[var(--color-line)]">
              {open.map(row)}
              {open.length === 0 && <li className="px-4 py-4 text-sm text-[var(--color-muted)]">All done.</li>}
            </ul>
            {done.length > 0 && (
              <>
                <h2 className="mb-1.5 mt-6 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">Recently done</h2>
                <ul className="divide-y divide-[var(--color-line)] overflow-hidden rounded-xl border border-[var(--color-line)]">
                  {done.map(row)}
                </ul>
              </>
            )}
          </>
        )}

        {(projects.data ?? []).length > 0 && (
          <>
            <h2 className="mb-1.5 mt-8 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">Projects and queues</h2>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {(projects.data ?? []).map((project) => (
                <button
                  key={project.id}
                  onClick={() => onOpenProject(project.id)}
                  className="rounded-xl border border-[var(--color-line)] p-3 text-left hover:bg-[var(--color-surface)]"
                >
                  <span className="flex items-center gap-2">
                    <ProjectIcon project={project} />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{project.name}</span>
                    <span className="font-mono text-[10px] text-[var(--color-muted)]">{project.key}</span>
                  </span>
                  <span className="mt-1 block text-xs text-[var(--color-muted)]">
                    {project.openCount} open · {project.itemCount} in all
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {creating && (
        <NewProjectDialog
          workspaceId={workspace.id}
          initialKind="project"
          onClose={() => setCreating(false)}
          onCreated={(project) => {
            setCreating(false);
            onOpenProject(project.id);
          }}
        />
      )}
    </div>
  );
}
