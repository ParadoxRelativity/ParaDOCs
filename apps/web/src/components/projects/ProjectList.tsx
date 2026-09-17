import { useState } from 'react';
import type { ProjectKind, ProjectSummary } from '@paradocs/shared';
import { useProjects, useUpdateProject } from '../../api/hooks';
import { MODIFIER, asksForNewTab, openTab } from '../../lib/tabs';
import { cx, useLocalStorage } from '../../lib/util';
import { AccessDialog, LockMark, type NamedAccessTarget } from '../AccessDialog';
import Icon from '../Icon';
import SheetContextMenu, { type SheetMenuItem } from '../sheet/SheetContextMenu';
import { useToast } from '../Toast';
import { IconButton } from '../ui';
import { NewProjectDialog } from './ProjectDialogs';
import { ProjectIcon } from './projectUi';

/**
 * The Projects app's side of the sidebar: your own work, then the workspace's
 * projects and queues, and the archived ones tucked away beneath.
 */
export function ProjectList({
  workspaceId,
  activeProjectId,
  canEdit,
  canManageAccess,
  myWorkCount,
  onOpenMyWork,
  onSelect,
}: {
  workspaceId: string;
  /** Null while My work is showing. */
  activeProjectId: string | null;
  canEdit: boolean;
  canManageAccess: boolean;
  myWorkCount: number | undefined;
  onOpenMyWork: () => void;
  onSelect: (projectId: string) => void;
}) {
  const projects = useProjects(workspaceId);
  const [archivedOpen, setArchivedOpen] = useLocalStorage('paradocs.archivedProjectsOpen', false);
  const archived = useProjects(archivedOpen ? workspaceId : undefined, true);
  const [creating, setCreating] = useState<ProjectKind | null>(null);
  const [securing, setSecuring] = useState<NamedAccessTarget | null>(null);

  const list = projects.data ?? [];
  const groups: { kind: ProjectKind; label: string }[] = [
    { kind: 'project', label: 'Projects' },
    { kind: 'queue', label: 'Queues' },
  ];

  const rowProps = { workspaceId, activeProjectId, canEdit, canManageAccess, onSelect, onManageAccess: setSecuring };

  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-2">
      <button
        onClick={onOpenMyWork}
        className={cx(
          'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm',
          activeProjectId === null
            ? 'bg-[var(--color-accent-soft)] font-medium text-[var(--color-accent)]'
            : 'hover:bg-[var(--color-line)]/50',
        )}
      >
        <span className="w-4 text-center text-xs">
          <Icon name="person-check" />
        </span>
        <span className="flex-1 text-left">My work</span>
        {myWorkCount !== undefined && myWorkCount > 0 && (
          <span className="text-[10px] text-[var(--color-muted)]">{myWorkCount}</span>
        )}
      </button>

      {groups.map(({ kind, label }) => {
        const entries = list.filter((project) => project.kind === kind);
        return (
          <div key={kind} className="mt-3">
            <div className="mb-0.5 flex items-center justify-between px-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">{label}</span>
              {canEdit && (
                <IconButton label={kind === 'queue' ? 'New queue' : 'New project'} onClick={() => setCreating(kind)}>
                  <Icon name="plus-lg" />
                </IconButton>
              )}
            </div>
            {entries.map((project) => (
              <ProjectRow key={project.id} project={project} {...rowProps} />
            ))}
            {projects.data && entries.length === 0 && (
              <p className="px-2 py-1.5 text-xs text-[var(--color-muted)]">
                {kind === 'queue' ? 'No queues yet.' : 'No projects yet.'}
              </p>
            )}
          </div>
        );
      })}

      <div className="mt-4">
        <button
          onClick={() => setArchivedOpen(!archivedOpen)}
          className="flex w-full items-center gap-1.5 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)] hover:text-[var(--color-ink)]"
        >
          <Icon name="chevron-right" className={cx('text-[9px] transition-transform', archivedOpen && 'rotate-90')} />
          Archived
        </button>
        {archivedOpen &&
          (archived.data?.length ? (
            archived.data.map((project) => <ProjectRow key={project.id} project={project} {...rowProps} />)
          ) : (
            <p className="px-2 py-1.5 text-xs text-[var(--color-muted)]">{archived.isLoading ? 'Loading…' : 'Nothing archived.'}</p>
          ))}
      </div>

      {creating && (
        <NewProjectDialog
          workspaceId={workspaceId}
          initialKind={creating}
          onClose={() => setCreating(null)}
          onCreated={(project) => {
            setCreating(null);
            onSelect(project.id);
          }}
        />
      )}
      {securing && <AccessDialog workspaceId={workspaceId} target={securing} onClose={() => setSecuring(null)} />}
    </div>
  );
}

function ProjectRow({
  project,
  workspaceId,
  activeProjectId,
  canEdit,
  canManageAccess,
  onSelect,
  onManageAccess,
}: {
  project: ProjectSummary;
  workspaceId: string;
  activeProjectId: string | null;
  canEdit: boolean;
  canManageAccess: boolean;
  onSelect: (projectId: string) => void;
  onManageAccess: (target: NamedAccessTarget) => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const update = useUpdateProject(workspaceId, project.id);
  const toast = useToast();
  const active = project.id === activeProjectId;
  const canChange = canEdit && project.permission === 'edit';

  const items: SheetMenuItem[] = [];
  items.push({
    label: 'Open in new tab',
    icon: 'window-plus',
    onSelect: () => openTab(`/w/${workspaceId}/p/${project.id}`, project.name),
  });
  if (canManageAccess) {
    items.push({
      label: 'Permissions',
      icon: 'shield-lock',
      onSelect: () => onManageAccess({ kind: 'project', id: project.id, name: project.name }),
    });
  }
  if (canChange) {
    items.push('divider', {
      label: project.archivedAt ? 'Restore' : 'Archive',
      icon: project.archivedAt ? 'box-arrow-in-down' : 'archive',
      onSelect: () =>
        update.mutate(
          { archived: !project.archivedAt },
          {
            onSuccess: () => toast(project.archivedAt ? `Restored ${project.name}` : `Archived ${project.name}`),
            onError: (err) => toast(err instanceof Error ? err.message : 'Could not change it', 'error'),
          },
        ),
    });
  }

  return (
    <div
      className={cx(
        'group flex items-center rounded-md pr-1',
        active ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]' : 'hover:bg-[var(--color-line)]/50',
      )}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      <button
        title={`${project.name} — hold ${MODIFIER} to open in a new tab`}
        onClick={(event) => {
          if (asksForNewTab(event)) openTab(`/w/${workspaceId}/p/${project.id}`, project.name);
          else onSelect(project.id);
        }}
        onAuxClick={(event) => {
          if (event.button !== 1) return;
          event.preventDefault();
          openTab(`/w/${workspaceId}/p/${project.id}`, project.name, { background: true });
        }}
        className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-2 text-left text-sm"
      >
        <ProjectIcon project={project} className="w-4 shrink-0 text-center text-xs" />
        <span className={cx('min-w-0 flex-1 truncate', active && 'font-medium')}>{project.name}</span>
        <LockMark access={project.access} />
        {project.openCount > 0 && <span className="text-[10px] text-[var(--color-muted)] group-hover:hidden">{project.openCount}</span>}
      </button>
      <span className={cx(menu ? 'flex' : 'hidden group-hover:flex')}>
        <IconButton
          label="Project options"
          aria-haspopup="menu"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setMenu({ x: rect.left, y: rect.bottom + 4 });
          }}
        >
          <Icon name="three-dots" />
        </IconButton>
      </span>
      {menu && <SheetContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
    </div>
  );
}
