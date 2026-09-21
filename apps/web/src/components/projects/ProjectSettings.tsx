import { useEffect, useState } from 'react';
import {
  STATUS_CATEGORIES,
  STATUS_CATEGORY_LABELS,
  STATUS_COLORS,
  ITEM_TYPE_COLORS,
  ITEM_TYPE_ICONS,
  defaultableTypes,
  type Project,
  type ProjectItemType,
  type ProjectRole,
  type ProjectStatus,
  type ProjectWorkflow,
  type StatusCategory,
  type WorkItemSummary,
} from '@paradocs/shared';
import { useDeleteProject, useProjectSetup, useUpdateProject } from '../../api/hooks';
import { cx } from '../../lib/util';
import { AccessDialog } from '../AccessDialog';
import Icon, { type IconName } from '../Icon';
import { ConfirmDialog, Modal } from '../Modal';
import { FIELD, FIELD_BASE, Section } from '../SettingsParts';
import { useToast } from '../Toast';
import { Button, IconButton } from '../ui';
import { CATEGORY_ICON, PROJECT_KIND, StatusPill, TypeIcon } from './projectUi';
import { positionBetween } from './ProjectBoard';

/**
 * How a project is set up: its name and key, the statuses its work moves
 * through, the roles people take on its items, who can reach it, and whether it
 * is still in use.
 */
export default function ProjectSettings({
  project,
  items,
  canEdit,
  canManageAccess,
  onDeleted,
}: {
  project: Project;
  items: WorkItemSummary[];
  canEdit: boolean;
  canManageAccess: boolean;
  onDeleted: () => void;
}) {
  const [securing, setSecuring] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const update = useUpdateProject(project.workspaceId, project.id);
  const remove = useDeleteProject(project.workspaceId);
  const toast = useToast();
  const noun = PROJECT_KIND[project.kind].label.toLowerCase();

  return (
    <div className="scroll-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-6 py-6">
        <GeneralSection project={project} canEdit={canEdit} />
        <ItemTypeSection project={project} items={items} canEdit={canEdit} />
        <StatusSection project={project} items={items} canEdit={canEdit} />
        <WorkflowSection project={project} canEdit={canEdit} />
        <RoleSection project={project} canEdit={canEdit} />
        {project.kind === 'project' && <SprintSection project={project} canEdit={canEdit} />}

        <Section
          title="Permissions"
          hint={
            project.access === 'open'
              ? `Everyone in the workspace can reach this ${noun}.`
              : project.access === 'allow'
                ? `Only the teams and people listed can reach this ${noun}.`
                : `Everyone except the teams and people listed can reach this ${noun}.`
          }
        >
          {canManageAccess ? (
            <Button variant="subtle" className="text-xs" onClick={() => setSecuring(true)}>
              <Icon name="shield-lock" /> Change permissions
            </Button>
          ) : (
            <p className="text-xs text-[var(--color-muted)]">Only an owner or admin can change who can reach it.</p>
          )}
        </Section>

        {canEdit && (
          <Section
            title={project.archivedAt ? 'Archived' : 'Archive'}
            hint={
              project.archivedAt
                ? `This ${noun} is archived: it is out of the sidebar and nothing new can be added to it. Links to its work still open.`
                : `Archiving takes the ${noun} out of the sidebar and stops new work being added, and keeps everything in it. It can be restored any time.`
            }
          >
            <div className="flex gap-2">
              <Button
                variant="subtle"
                className="text-xs"
                disabled={update.isPending}
                onClick={() =>
                  update.mutate(
                    { archived: !project.archivedAt },
                    {
                      onSuccess: () => toast(project.archivedAt ? `Restored ${project.name}` : `Archived ${project.name}`),
                      onError: (err) => toast(err instanceof Error ? err.message : 'Could not change the project', 'error'),
                    },
                  )
                }
              >
                <Icon name={project.archivedAt ? 'box-arrow-in-down' : 'archive'} />
                {project.archivedAt ? 'Restore' : 'Archive'}
              </Button>
              {project.canDelete && (
                <Button variant="danger" className="text-xs" onClick={() => setConfirmingDelete(true)}>
                  <Icon name="trash3" /> Delete {noun}
                </Button>
              )}
            </div>
          </Section>
        )}
      </div>

      {securing && (
        <AccessDialog
          workspaceId={project.workspaceId}
          target={{ kind: 'project', id: project.id, name: project.name }}
          onClose={() => setSecuring(false)}
        />
      )}
      {confirmingDelete && (
        <ConfirmDialog
          title={`Delete ${project.name}?`}
          description={`Its ${project.itemCount === 1 ? 'work item' : `${project.itemCount} work items`}, their comments and history will be deleted for everyone, and links to them will stop working. This cannot be undone — archiving keeps everything.`}
          confirmLabel={`Delete ${noun}`}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => {
            setConfirmingDelete(false);
            remove.mutate(project.id, {
              onSuccess: () => {
                toast(`Deleted ${project.name}`);
                onDeleted();
              },
              onError: (err) => toast(err instanceof Error ? err.message : 'Could not delete the project', 'error'),
            });
          }}
        />
      )}
    </div>
  );
}

/**
 * Whether the board is run in sprints. Turning it off keeps the sprints and
 * what is in them, so turning it back on picks up where it was.
 */
function SprintSection({ project, canEdit }: { project: Project; canEdit: boolean }) {
  const update = useUpdateProject(project.workspaceId, project.id);
  const toast = useToast();
  const on = project.sprintsEnabled;
  const running = project.sprints.find((s) => s.state === 'active');
  const disabled = !canEdit || update.isPending;

  return (
    <Section
      title="Sprints"
      hint="Run the board in sprints: plan work into a sprint from the backlog, start it, and the board shows that sprint's work until it is completed."
    >
      <div className="flex items-center gap-3 rounded-lg border border-[var(--color-line)] px-3 py-2.5">
        <Icon name="arrow-repeat" className={cx('text-base', on ? 'text-[var(--color-accent)]' : 'text-[var(--color-muted)]')} />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">Use sprints</span>
          <span className="block text-xs text-[var(--color-muted)]">
            {on
              ? running
                ? `${running.name} is running.`
                : `${project.sprints.filter((s) => s.state === 'planned').length} planned, none running.`
              : 'Off: the board shows all planned work. Turning sprints off later keeps them for when they are turned back on.'}
          </span>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label="Use sprints"
          disabled={disabled}
          onClick={() =>
            update.mutate(
              { sprintsEnabled: !on },
              {
                onSuccess: () => toast(on ? 'Sprints turned off' : 'Sprints turned on. Plan the first one in the backlog.'),
                onError: (err) => toast(err instanceof Error ? err.message : 'Could not change the project', 'error'),
              },
            )
          }
          className={cx(
            'relative h-5 w-9 shrink-0 rounded-full transition-colors',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]',
            on ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-line)]',
            disabled && 'cursor-not-allowed opacity-50',
          )}
        >
          <span
            aria-hidden
            className={cx(
              'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-[left] duration-150 motion-reduce:transition-none',
              on ? 'left-[1.125rem]' : 'left-0.5',
            )}
          />
        </button>
      </div>
    </Section>
  );
}

/**
 * The kinds of work the project holds: what each is called and looks like,
 * which roles apply to its items, and which one new work starts as. Every
 * project starts with Task, Bug, Story, Epic and Request, and any of them can
 * go. An epic-kind type holds other work instead of being worked on, so its
 * items stay off the board and out of sprints; that is chosen when a type is
 * made, since changing it would reshuffle the work already filed as it.
 */
function ItemTypeSection({ project, items, canEdit }: { project: Project; items: WorkItemSummary[]; canEdit: boolean }) {
  const setup = useProjectSetup(project.workspaceId, project.id);
  const update = useUpdateProject(project.workspaceId, project.id);
  const toast = useToast();
  const [newName, setNewName] = useState('');
  const [newEpic, setNewEpic] = useState(false);
  const [editingRoles, setEditingRoles] = useState<string | null>(null);
  const [removing, setRemoving] = useState<ProjectItemType | null>(null);
  const [narrowing, setNarrowing] = useState<{ type: ProjectItemType; roleIds: string[]; role: string; affected: number } | null>(
    null,
  );
  const fail = (fallback: string) => (err: unknown) => toast(err instanceof Error ? err.message : fallback, 'error');

  const types = project.itemTypes;
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.typeId, (counts.get(item.typeId) ?? 0) + 1);
  const workTypes = defaultableTypes(project);

  function move(index: number, by: -1 | 1) {
    const target = index + by;
    if (target < 0 || target >= types.length) return;
    const others = types.filter((_, i) => i !== index);
    const position = positionBetween(others[target - 1]?.position, others[target]?.position);
    setup.updateItemType.mutate({ id: types[index].id, position }, { onError: fail('Could not move the type') });
  }

  function add() {
    const name = newName.trim();
    if (!name) return;
    setup.addItemType.mutate(
      {
        name,
        epic: newEpic,
        icon: newEpic ? 'flag' : 'check2-square',
        color: ITEM_TYPE_COLORS[types.length % ITEM_TYPE_COLORS.length],
      },
      {
        onSuccess: () => {
          setNewName('');
          setNewEpic(false);
        },
        onError: fail('Could not add the type'),
      },
    );
  }

  /** Turns a role on or off for a type, asking first when that takes people off its items. */
  function toggleRole(type: ProjectItemType, roleId: string, on: boolean) {
    const roleIds = on ? [...type.roleIds, roleId] : type.roleIds.filter((id) => id !== roleId);
    const affected = on
      ? 0
      : items.filter(
          (item) =>
            item.typeId === type.id && ((item.roles[roleId]?.length ?? 0) > 0 || (item.roleNames[roleId]?.length ?? 0) > 0),
        ).length;
    if (affected > 0) {
      const role = project.roles.find((r) => r.id === roleId)?.name ?? 'that role';
      setNarrowing({ type, roleIds, role, affected });
    } else {
      setup.updateItemType.mutate({ id: type.id, roleIds }, { onError: fail('Could not change the roles') });
    }
  }

  function remove(type: ProjectItemType) {
    if ((counts.get(type.id) ?? 0) > 0) setRemoving(type);
    else setup.deleteItemType.mutate({ id: type.id }, { onError: fail('Could not delete the type') });
  }

  return (
    <Section
      title="Work item types"
      hint="The kinds of work filed here, and which roles apply to each. An epic-kind type holds other work — stories, tasks, bugs — and is followed in the Epics view instead of on the board or in sprints."
    >
      <ul className="divide-y divide-[var(--color-line)] rounded-lg border border-[var(--color-line)]">
        {types.map((type, index) => {
          const lastWorkType = !type.epic && workTypes.length <= 1;
          const expanded = editingRoles === type.id;
          const roleCount = project.roles.filter((role) => type.roleIds.includes(role.id)).length;
          return (
            <li key={type.id}>
              <div className="flex items-center gap-2 px-2 py-1.5">
                <IconPicker
                  icon={type.icon}
                  color={type.color}
                  disabled={!canEdit}
                  onChange={(icon) => setup.updateItemType.mutate({ id: type.id, icon }, { onError: fail('Could not change the icon') })}
                />
                <ColorSwatch
                  color={type.color}
                  disabled={!canEdit}
                  onChange={(color) => setup.updateItemType.mutate({ id: type.id, color }, { onError: fail('Could not change the colour') })}
                />
                <RenameField
                  value={type.name}
                  disabled={!canEdit}
                  onCommit={(name) => setup.updateItemType.mutate({ id: type.id, name }, { onError: fail('Could not rename the type') })}
                />
                {type.epic && (
                  <span
                    className="shrink-0 rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-medium text-violet-600 dark:text-violet-300"
                    title="Holds other work: kept off the board and out of sprints, and followed in the Epics view"
                  >
                    Epic-kind
                  </span>
                )}
                {type.id === project.defaultTypeId && (
                  <span className="shrink-0 rounded bg-[var(--color-accent-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-accent)]">
                    Default
                  </span>
                )}
                <span className="w-14 shrink-0 text-right text-xs text-[var(--color-muted)]">{counts.get(type.id) ?? 0} items</span>
                <Button variant="subtle" className="shrink-0 text-xs" onClick={() => setEditingRoles(expanded ? null : type.id)}>
                  {expanded ? 'Done' : `${roleCount} of ${project.roles.length} roles`}
                </Button>
                {canEdit && (
                  <>
                    <IconButton label="Move earlier" disabled={index === 0} onClick={() => move(index, -1)}>
                      <Icon name="chevron-up" />
                    </IconButton>
                    <IconButton label="Move later" disabled={index === types.length - 1} onClick={() => move(index, 1)}>
                      <Icon name="chevron-down" />
                    </IconButton>
                    <IconButton
                      label={lastWorkType ? 'A project needs at least one type that is not epic-kind' : 'Delete type'}
                      disabled={lastWorkType}
                      onClick={() => remove(type)}
                    >
                      <Icon name="trash3" />
                    </IconButton>
                  </>
                )}
              </div>
              {expanded && (
                <div className="flex flex-wrap gap-x-4 gap-y-1.5 border-t border-[var(--color-line)] bg-[var(--color-surface)]/40 px-9 py-2">
                  {project.roles.length === 0 && <span className="text-xs text-[var(--color-muted)]">The project has no roles yet.</span>}
                  {project.roles.map((role) => (
                    <label key={role.id} className="flex items-center gap-1.5 text-xs">
                      <input
                        type="checkbox"
                        checked={type.roleIds.includes(role.id)}
                        disabled={!canEdit}
                        onChange={(e) => toggleRole(type, role.id, e.target.checked)}
                      />
                      {role.name}
                    </label>
                  ))}
                </div>
              )}
            </li>
          );
        })}
        {canEdit && (
          <li className="flex items-center gap-2 px-2 py-1.5">
            <Icon name="plus-circle" className="w-5 shrink-0 text-center text-[var(--color-muted)]" />
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && add()}
              placeholder={newEpic ? 'New epic-kind type, such as Initiative' : 'New type, such as Spike'}
              className={cx(FIELD_BASE, 'min-w-24 flex-1 py-1')}
            />
            <label
              className="flex shrink-0 items-center gap-1.5 text-xs text-[var(--color-muted)]"
              title="Holds other work, as an epic does: kept off the board and out of sprints, and followed in the Epics view. Cannot be changed once the type is made."
            >
              <input type="checkbox" checked={newEpic} onChange={(e) => setNewEpic(e.target.checked)} />
              Epic-kind
            </label>
            <Button variant="subtle" className="text-xs" disabled={!newName.trim()} onClick={add}>
              Add
            </Button>
          </li>
        )}
      </ul>

      <label className="mt-3 flex items-center gap-2 text-xs text-[var(--color-muted)]">
        New work starts as
        <select
          value={project.defaultTypeId}
          disabled={!canEdit || update.isPending}
          onChange={(e) =>
            update.mutate(
              { defaultTypeId: e.target.value },
              {
                onSuccess: (saved) =>
                  toast(`New work starts as ${saved.itemTypes.find((t) => t.id === saved.defaultTypeId)?.name ?? 'that type'}`),
                onError: fail('Could not change the project'),
              },
            )
          }
          className={cx(FIELD_BASE, 'w-44 py-1 text-xs text-[var(--color-ink)]')}
          aria-label="Default work item type"
        >
          {workTypes.map((type) => (
            <option key={type.id} value={type.id}>
              {type.name}
            </option>
          ))}
        </select>
      </label>

      {removing && (
        <RemoveTypeDialog
          type={removing}
          count={counts.get(removing.id) ?? 0}
          others={types.filter((t) => t.id !== removing.id)}
          onCancel={() => setRemoving(null)}
          onConfirm={(moveTo) => {
            setRemoving(null);
            setup.deleteItemType.mutate({ id: removing.id, moveTo }, { onError: fail('Could not delete the type') });
          }}
        />
      )}
      {narrowing && (
        <ConfirmDialog
          title={`Take ${narrowing.role} off ${narrowing.type.name}?`}
          description={`${narrowing.affected === 1 ? 'One' : narrowing.affected} ${narrowing.type.name} ${narrowing.affected === 1 ? 'item has' : 'items have'} someone in ${narrowing.role}. They will be taken off, and each item's history will say so.`}
          confirmLabel="Take off"
          onCancel={() => setNarrowing(null)}
          onConfirm={() => {
            const { type, roleIds } = narrowing;
            setNarrowing(null);
            setup.updateItemType.mutate({ id: type.id, roleIds }, { onError: fail('Could not change the roles') });
          }}
        />
      )}
    </Section>
  );
}

function RemoveTypeDialog({
  type,
  count,
  others,
  onCancel,
  onConfirm,
}: {
  type: ProjectItemType;
  count: number;
  others: ProjectItemType[];
  onCancel: () => void;
  onConfirm: (moveTo: string) => void;
}) {
  // Work of the same kind first: an epic becoming a task has to let go of what was under it.
  const sorted = [...others.filter((t) => t.epic === type.epic), ...others.filter((t) => t.epic !== type.epic)];
  const [moveTo, setMoveTo] = useState(sorted[0]?.id ?? '');
  const target = others.find((t) => t.id === moveTo);
  return (
    <Modal
      title={`Delete ${type.name}?`}
      description={`${count === 1 ? 'One work item is' : `${count} work items are`} ${type.name}. Choose what ${count === 1 ? 'it becomes' : 'they become'}.`}
      onClose={onCancel}
      footer={
        <>
          <Button variant="subtle" className="text-xs" onClick={onCancel}>
            Cancel
          </Button>
          <button
            onClick={() => onConfirm(moveTo)}
            disabled={!moveTo}
            className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50"
          >
            Change and delete
          </button>
        </>
      }
    >
      <select value={moveTo} onChange={(e) => setMoveTo(e.target.value)} className={FIELD} aria-label="Change items to">
        {sorted.map((other) => (
          <option key={other.id} value={other.id}>
            {other.name}
            {other.epic ? ' (epic-kind)' : ''}
          </option>
        ))}
      </select>
      {target && target.epic !== type.epic && (
        <p className="mt-2 text-xs text-amber-600">
          {type.epic
            ? `${target.name} is not epic-kind, so the work organised under these items will no longer be under anything.`
            : `${target.name} is epic-kind, so these items will be taken out of their sprints and epics.`}
        </p>
      )}
      <p className="mt-2 text-xs text-[var(--color-muted)]">Anyone in a role {target?.name ?? 'the new type'} does not offer is taken off.</p>
    </Modal>
  );
}

/** Picks a type's icon from the set offered, drawn in the type's colour. */
function IconPicker({
  icon,
  color,
  disabled,
  onChange,
}: {
  icon: string;
  color: string;
  disabled: boolean;
  onChange: (icon: (typeof ITEM_TYPE_ICONS)[number]) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative shrink-0">
      <button
        disabled={disabled}
        onClick={() => setOpen(!open)}
        aria-label="Icon"
        className="grid h-6 w-6 place-items-center rounded-md hover:bg-[var(--color-surface)]"
        style={{ color }}
      >
        <Icon name={icon as IconName} />
      </button>
      {open && (
        <div
          className="absolute left-0 top-full z-20 mt-1 grid w-max grid-cols-6 gap-1 rounded-lg border border-[var(--color-line)] bg-[var(--color-raised)] p-2 shadow-lg"
          onMouseLeave={() => setOpen(false)}
        >
          {ITEM_TYPE_ICONS.map((option) => (
            <button
              key={option}
              onClick={() => {
                setOpen(false);
                if (option !== icon) onChange(option);
              }}
              aria-label={option}
              title={option}
              className={cx(
                'grid h-7 w-7 place-items-center rounded-md hover:bg-[var(--color-surface)]',
                option === icon && 'ring-2 ring-[var(--color-accent)]',
              )}
              style={{ color }}
            >
              <Icon name={option} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function GeneralSection({ project, canEdit }: { project: Project; canEdit: boolean }) {
  const update = useUpdateProject(project.workspaceId, project.id);
  const toast = useToast();
  const [name, setName] = useState(project.name);
  const [key, setKey] = useState(project.key);
  const [icon, setIcon] = useState(project.icon ?? '');
  const [description, setDescription] = useState(project.description);

  useEffect(() => {
    setName(project.name);
    setKey(project.key);
    setIcon(project.icon ?? '');
    setDescription(project.description);
  }, [project.name, project.key, project.icon, project.description]);

  const dirty =
    name.trim() !== project.name ||
    key.trim().toUpperCase() !== project.key ||
    (icon.trim() || null) !== project.icon ||
    description !== project.description;

  function save() {
    update.mutate(
      { name: name.trim(), key: key.trim(), icon: icon.trim() || null, description },
      {
        onSuccess: () => toast('Saved'),
        onError: (err) => toast(err instanceof Error ? err.message : 'Could not save', 'error'),
      },
    );
  }

  return (
    <Section title="Details">
      <div className="grid grid-cols-[3.5rem_minmax(0,1fr)_8rem] gap-2">
        <label className="text-xs text-[var(--color-muted)]">
          Icon
          <input
            value={icon}
            maxLength={4}
            disabled={!canEdit}
            onChange={(e) => setIcon(e.target.value)}
            placeholder="—"
            className={cx(FIELD, 'mt-1 text-center')}
          />
        </label>
        <label className="text-xs text-[var(--color-muted)]">
          Name
          <input value={name} disabled={!canEdit} onChange={(e) => setName(e.target.value)} className={cx(FIELD, 'mt-1')} />
        </label>
        <label className="text-xs text-[var(--color-muted)]">
          Key
          <input
            value={key}
            disabled={!canEdit}
            maxLength={10}
            onChange={(e) => setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
            className={cx(FIELD, 'mt-1 font-mono uppercase')}
          />
        </label>
      </div>
      <label className="mt-2 block text-xs text-[var(--color-muted)]">
        Description
        <textarea
          value={description}
          disabled={!canEdit}
          rows={3}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What this is for"
          className={cx(FIELD, 'mt-1 resize-y')}
        />
      </label>
      {key !== project.key && key.length >= 2 && (
        <p className="mt-1 text-xs text-amber-600">
          Every item&apos;s key changes with it — {project.key}-1 becomes {key}-1. Links to items keep working.
        </p>
      )}
      {canEdit && (
        <div className="mt-2 flex justify-end">
          <Button variant="primary" className="text-xs" disabled={!dirty || !name.trim() || update.isPending} onClick={save}>
            Save
          </Button>
        </div>
      )}
    </Section>
  );
}

function StatusSection({ project, items, canEdit }: { project: Project; items: WorkItemSummary[]; canEdit: boolean }) {
  const setup = useProjectSetup(project.workspaceId, project.id);
  const toast = useToast();
  const [removing, setRemoving] = useState<ProjectStatus | null>(null);
  const [newName, setNewName] = useState('');
  const [newCategory, setNewCategory] = useState<StatusCategory>('active');
  const fail = (fallback: string) => (err: unknown) => toast(err instanceof Error ? err.message : fallback, 'error');

  const statuses = project.statuses;
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.statusId, (counts.get(item.statusId) ?? 0) + 1);

  function move(index: number, by: -1 | 1) {
    const target = index + by;
    if (target < 0 || target >= statuses.length) return;
    const others = statuses.filter((_, i) => i !== index);
    const position = positionBetween(others[target - 1]?.position, others[target]?.position);
    setup.updateStatus.mutate({ id: statuses[index].id, position }, { onError: fail('Could not move the status') });
  }

  function add() {
    const name = newName.trim();
    if (!name) return;
    setup.addStatus.mutate(
      { name, category: newCategory, color: STATUS_COLORS[statuses.length % STATUS_COLORS.length] },
      { onSuccess: () => setNewName(''), onError: fail('Could not add the status') },
    );
  }

  return (
    <Section
      title="Statuses"
      hint="The stages work moves through, in board order. Each one counts as backlog, not started, in progress or done, whatever it is called. Backlog statuses are kept off the board, in the Backlog view."
    >
      <ul className="divide-y divide-[var(--color-line)] rounded-lg border border-[var(--color-line)]">
        {statuses.map((status, index) => (
          <li key={status.id} className="flex items-center gap-2 px-2 py-1.5">
            <ColorSwatch
              color={status.color}
              disabled={!canEdit}
              onChange={(color) => setup.updateStatus.mutate({ id: status.id, color }, { onError: fail('Could not change the colour') })}
            />
            <RenameField
              value={status.name}
              disabled={!canEdit}
              onCommit={(name) => setup.updateStatus.mutate({ id: status.id, name }, { onError: fail('Could not rename the status') })}
            />
            <span className="w-14 shrink-0 text-right text-xs text-[var(--color-muted)]">
              {counts.get(status.id) ?? 0} items
            </span>
            <select
              value={status.category}
              disabled={!canEdit}
              onChange={(e) =>
                setup.updateStatus.mutate(
                  { id: status.id, category: e.target.value as StatusCategory },
                  { onError: fail('Could not change the status') },
                )
              }
              className={cx(FIELD_BASE, 'w-32 shrink-0 py-1 text-xs')}
              aria-label={`What ${status.name} means`}
            >
              {STATUS_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {STATUS_CATEGORY_LABELS[category]}
                </option>
              ))}
            </select>
            {canEdit && (
              <>
                <IconButton label="Move earlier" disabled={index === 0} onClick={() => move(index, -1)}>
                  <Icon name="chevron-up" />
                </IconButton>
                <IconButton label="Move later" disabled={index === statuses.length - 1} onClick={() => move(index, 1)}>
                  <Icon name="chevron-down" />
                </IconButton>
                <IconButton
                  label="Delete status"
                  disabled={statuses.length <= 1}
                  onClick={() => {
                    if ((counts.get(status.id) ?? 0) > 0) setRemoving(status);
                    else setup.deleteStatus.mutate({ id: status.id }, { onError: fail('Could not delete the status') });
                  }}
                >
                  <Icon name="trash3" />
                </IconButton>
              </>
            )}
          </li>
        ))}
        {canEdit && (
          <li className="flex items-center gap-2 px-2 py-1.5">
            <Icon name={CATEGORY_ICON[newCategory]} className="w-5 text-center text-[var(--color-muted)]" />
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && add()}
              placeholder="New status"
              className={cx(FIELD_BASE, 'min-w-24 flex-1 py-1')}
            />
            <select
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value as StatusCategory)}
              className={cx(FIELD_BASE, 'w-32 shrink-0 py-1 text-xs')}
              aria-label="What the new status means"
            >
              {STATUS_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {STATUS_CATEGORY_LABELS[category]}
                </option>
              ))}
            </select>
            <Button variant="subtle" className="text-xs" disabled={!newName.trim()} onClick={add}>
              Add
            </Button>
          </li>
        )}
      </ul>

      {removing && (
        <RemoveStatusDialog
          status={removing}
          count={counts.get(removing.id) ?? 0}
          others={statuses.filter((s) => s.id !== removing.id)}
          onCancel={() => setRemoving(null)}
          onConfirm={(moveTo) => {
            setRemoving(null);
            setup.deleteStatus.mutate({ id: removing.id, moveTo }, { onError: fail('Could not delete the status') });
          }}
        />
      )}
    </Section>
  );
}

function RemoveStatusDialog({
  status,
  count,
  others,
  onCancel,
  onConfirm,
}: {
  status: ProjectStatus;
  count: number;
  others: ProjectStatus[];
  onCancel: () => void;
  onConfirm: (moveTo: string) => void;
}) {
  const [moveTo, setMoveTo] = useState(others[0]?.id ?? '');
  return (
    <Modal
      title={`Delete ${status.name}?`}
      description={`${count === 1 ? 'One work item is' : `${count} work items are`} in this status. Choose where ${count === 1 ? 'it goes' : 'they go'}.`}
      onClose={onCancel}
      footer={
        <>
          <Button variant="subtle" className="text-xs" onClick={onCancel}>
            Cancel
          </Button>
          <button
            onClick={() => onConfirm(moveTo)}
            disabled={!moveTo}
            className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50"
          >
            Move and delete
          </button>
        </>
      }
    >
      <select value={moveTo} onChange={(e) => setMoveTo(e.target.value)} className={FIELD} aria-label="Move items to">
        {others.map((other) => (
          <option key={other.id} value={other.id}>
            {other.name}
          </option>
        ))}
      </select>
    </Modal>
  );
}

/**
 * The routes work can take through the board. A workflow says, for each status,
 * which statuses an item there may move to next; a type is then pointed at a
 * workflow, and its items follow it. Nothing is set up to begin with, and a
 * type with no workflow moves anywhere, so this only ever narrows things.
 */
function WorkflowSection({ project, canEdit }: { project: Project; canEdit: boolean }) {
  const setup = useProjectSetup(project.workspaceId, project.id);
  const toast = useToast();
  const [newName, setNewName] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [removing, setRemoving] = useState<ProjectWorkflow | null>(null);
  const fail = (fallback: string) => (err: unknown) => toast(err instanceof Error ? err.message : fallback, 'error');

  const { workflows, statuses } = project;

  function add() {
    const name = newName.trim();
    if (!name) return;
    setup.addWorkflow.mutate(
      { name },
      {
        onSuccess: (workflow) => {
          setNewName('');
          setOpen(workflow.id);
        },
        onError: fail('Could not add the workflow'),
      },
    );
  }

  /** Turns one move on or off, sending the whole set back as it should now stand. */
  function toggleMove(workflow: ProjectWorkflow, from: string, to: string, allow: boolean) {
    const current = workflow.transitions[from] ?? [];
    const next = { ...workflow.transitions, [from]: allow ? [...current, to] : current.filter((id) => id !== to) };
    setup.updateWorkflow.mutate({ id: workflow.id, transitions: next }, { onError: fail('Could not change the workflow') });
  }

  return (
    <Section
      title="Workflows"
      hint="How work moves through the board. A workflow says which statuses an item may go to from where it is — including which board status it may leave the backlog for. Each item type follows one workflow; a type with none set moves anywhere."
    >
      <ul className="divide-y divide-[var(--color-line)] rounded-lg border border-[var(--color-line)]">
        {workflows.map((workflow) => {
          const moves = Object.values(workflow.transitions).reduce((total, tos) => total + tos.length, 0);
          const expanded = open === workflow.id;
          return (
            <li key={workflow.id}>
              <div className="flex items-center gap-2 px-2 py-1.5">
                <Icon name="diagram-2" className="w-5 shrink-0 text-center text-[var(--color-muted)]" />
                <RenameField
                  value={workflow.name}
                  disabled={!canEdit}
                  onCommit={(name) =>
                    setup.updateWorkflow.mutate({ id: workflow.id, name }, { onError: fail('Could not rename the workflow') })
                  }
                />
                <span className="shrink-0 text-xs text-[var(--color-muted)]">
                  {moves === 1 ? '1 move' : `${moves} moves`}
                </span>
                <Button variant="subtle" className="shrink-0 text-xs" onClick={() => setOpen(expanded ? null : workflow.id)}>
                  {expanded ? 'Done' : canEdit ? 'Edit moves' : 'See moves'}
                </Button>
                {canEdit && (
                  <IconButton label="Delete workflow" onClick={() => setRemoving(workflow)}>
                    <Icon name="trash3" />
                  </IconButton>
                )}
              </div>
              {expanded && <TransitionGrid workflow={workflow} statuses={statuses} canEdit={canEdit} onToggle={toggleMove} />}
            </li>
          );
        })}
        {workflows.length === 0 && (
          <li className="px-3 py-2 text-xs text-[var(--color-muted)]">
            No workflows yet, so work moves anywhere on the board.
          </li>
        )}
        {canEdit && (
          <li className="flex items-center gap-2 px-2 py-1.5">
            <Icon name="plus-circle" className="w-5 shrink-0 text-center text-[var(--color-muted)]" />
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && add()}
              placeholder="New workflow, such as Standard"
              className={cx(FIELD_BASE, 'min-w-24 flex-1 py-1')}
            />
            <Button variant="subtle" className="text-xs" disabled={!newName.trim()} onClick={add}>
              Add
            </Button>
          </li>
        )}
      </ul>

      {workflows.length > 0 && (
        <div className="mt-3">
          <h4 className="text-xs font-semibold">What each type follows</h4>
          <ul className="mt-1 divide-y divide-[var(--color-line)] rounded-lg border border-[var(--color-line)]">
            {project.itemTypes.map((type) => (
              <li key={type.id} className="flex items-center gap-2 px-2 py-1.5">
                <TypeIcon type={type} className="w-5 shrink-0 justify-center" />
                <span className="min-w-0 flex-1 text-sm">{type.name}</span>
                <select
                  value={type.workflowId ?? ''}
                  disabled={!canEdit}
                  onChange={(e) =>
                    setup.updateItemType.mutate(
                      { id: type.id, workflowId: e.target.value || null },
                      { onError: fail('Could not change what this type follows') },
                    )
                  }
                  className={cx(FIELD_BASE, 'w-44 shrink-0 py-1 text-xs')}
                  aria-label={`Workflow ${type.name} items follow`}
                >
                  <option value="">Moves anywhere</option>
                  {workflows.map((workflow) => (
                    <option key={workflow.id} value={workflow.id}>
                      {workflow.name}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
        </div>
      )}

      {removing && (
        <ConfirmDialog
          title={`Delete ${removing.name}?`}
          description="Any item type following it moves anywhere again. Nothing else about the work changes."
          confirmLabel="Delete workflow"
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            setRemoving(null);
            if (open === removing.id) setOpen(null);
            setup.deleteWorkflow.mutate(removing.id, { onError: fail('Could not delete the workflow') });
          }}
        />
      )}
    </Section>
  );
}

/**
 * The moves a workflow allows, as a grid: a row per status an item can be in,
 * a column per status it could go to. The diagonal is blank — staying put is
 * not a move — and a row with nothing ticked is where work stops.
 */
function TransitionGrid({
  workflow,
  statuses,
  canEdit,
  onToggle,
}: {
  workflow: ProjectWorkflow;
  statuses: ProjectStatus[];
  canEdit: boolean;
  onToggle: (workflow: ProjectWorkflow, from: string, to: string, allow: boolean) => void;
}) {
  if (statuses.length < 2) {
    return <p className="px-3 pb-2 text-xs text-[var(--color-muted)]">Add a second status before setting out a route between them.</p>;
  }
  return (
    <div className="scroll-thin overflow-x-auto border-t border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2">
      <table className="text-xs">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 bg-[var(--color-surface)] pr-2 text-left font-medium text-[var(--color-muted)]">
              From ↓ / to →
            </th>
            {statuses.map((status) => (
              <th key={status.id} className="px-1 pb-1 font-normal">
                <span className="block w-16 truncate text-center" title={status.name}>
                  {status.name}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {statuses.map((from) => (
            <tr key={from.id}>
              <th scope="row" className="sticky left-0 z-10 bg-[var(--color-surface)] py-0.5 pr-2 text-left font-normal">
                <StatusPill status={from} />
              </th>
              {statuses.map((to) => {
                const allowed = (workflow.transitions[from.id] ?? []).includes(to.id);
                return (
                  <td key={to.id} className="px-1 text-center">
                    {from.id === to.id ? (
                      <span className="text-[var(--color-line)]">·</span>
                    ) : (
                      <input
                        type="checkbox"
                        checked={allowed}
                        disabled={!canEdit}
                        onChange={(e) => onToggle(workflow, from.id, to.id, e.target.checked)}
                        aria-label={`Allow ${from.name} to ${to.name}`}
                      />
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RoleSection({ project, canEdit }: { project: Project; canEdit: boolean }) {
  const setup = useProjectSetup(project.workspaceId, project.id);
  const toast = useToast();
  const [removing, setRemoving] = useState<ProjectRole | null>(null);
  const [newName, setNewName] = useState('');
  const [newMultiple, setNewMultiple] = useState(false);
  const [newFreeForm, setNewFreeForm] = useState(false);
  const fail = (fallback: string) => (err: unknown) => toast(err instanceof Error ? err.message : fallback, 'error');
  const roles = project.roles;

  function move(index: number, by: -1 | 1) {
    const target = index + by;
    if (target < 0 || target >= roles.length) return;
    const others = roles.filter((_, i) => i !== index);
    const position = positionBetween(others[target - 1]?.position, others[target]?.position);
    setup.updateRole.mutate({ id: roles[index].id, position }, { onError: fail('Could not move the role') });
  }

  function add() {
    const name = newName.trim();
    if (!name) return;
    setup.addRole.mutate(
      { name, multiple: newMultiple, freeForm: newFreeForm },
      {
        onSuccess: () => {
          setNewName('');
          setNewMultiple(false);
          setNewFreeForm(false);
        },
        onError: fail('Could not add the role'),
      },
    );
  }

  return (
    <Section
      title="Roles"
      hint="What people can be on a work item here. The first role is the one boards and lists show, and workload starts from. A free-form role also takes a name typed straight in, for a customer with no account here. Which types each role applies to is set under Work item types; a new role applies to every type."
    >
      <ul className="divide-y divide-[var(--color-line)] rounded-lg border border-[var(--color-line)]">
        {roles.map((role, index) => (
          <li key={role.id} className="flex items-center gap-2 px-2 py-1.5">
            <Icon
              name={role.freeForm ? 'person-vcard' : role.multiple ? 'people' : 'person'}
              className="w-5 text-center text-[var(--color-muted)]"
            />
            <RenameField
              value={role.name}
              disabled={!canEdit}
              onCommit={(name) => setup.updateRole.mutate({ id: role.id, name }, { onError: fail('Could not rename the role') })}
            />
            <label className="flex shrink-0 items-center gap-1.5 text-xs text-[var(--color-muted)]">
              <input
                type="checkbox"
                checked={role.multiple}
                disabled={!canEdit}
                onChange={(e) =>
                  setup.updateRole.mutate({ id: role.id, multiple: e.target.checked }, { onError: fail('Could not change the role') })
                }
              />
              Several
            </label>
            <label
              className="flex shrink-0 items-center gap-1.5 text-xs text-[var(--color-muted)]"
              title={`Lets a name be typed into ${role.name} as well as someone picked, for a customer or anyone else without an account here. Turning it off again drops the names already typed in.`}
            >
              <input
                type="checkbox"
                checked={role.freeForm}
                disabled={!canEdit}
                onChange={(e) =>
                  setup.updateRole.mutate({ id: role.id, freeForm: e.target.checked }, { onError: fail('Could not change the role') })
                }
              />
              Free-form
            </label>
            {canEdit && (
              <>
                <IconButton label="Move earlier" disabled={index === 0} onClick={() => move(index, -1)}>
                  <Icon name="chevron-up" />
                </IconButton>
                <IconButton label="Move later" disabled={index === roles.length - 1} onClick={() => move(index, 1)}>
                  <Icon name="chevron-down" />
                </IconButton>
                <IconButton label="Delete role" onClick={() => setRemoving(role)}>
                  <Icon name="trash3" />
                </IconButton>
              </>
            )}
          </li>
        ))}
        {roles.length === 0 && <li className="px-3 py-2 text-xs text-[var(--color-muted)]">No roles yet.</li>}
        {canEdit && (
          <li className="flex items-center gap-2 px-2 py-1.5">
            <Icon name="person-plus" className="w-5 text-center text-[var(--color-muted)]" />
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && add()}
              placeholder="New role, such as Approver"
              className={cx(FIELD, 'min-w-0 flex-1 py-1')}
            />
            <label className="flex shrink-0 items-center gap-1.5 text-xs text-[var(--color-muted)]">
              <input type="checkbox" checked={newMultiple} onChange={(e) => setNewMultiple(e.target.checked)} />
              Several
            </label>
            <label
              className="flex shrink-0 items-center gap-1.5 text-xs text-[var(--color-muted)]"
              title="Lets a name be typed into the role as well as someone picked, for a customer or anyone else without an account here."
            >
              <input type="checkbox" checked={newFreeForm} onChange={(e) => setNewFreeForm(e.target.checked)} />
              Free-form
            </label>
            <Button variant="subtle" className="text-xs" disabled={!newName.trim()} onClick={add}>
              Add
            </Button>
          </li>
        )}
      </ul>

      {removing && (
        <ConfirmDialog
          title={`Delete the ${removing.name} role?`}
          description={`Everyone who is ${removing.name} on a work item in this project stops being it. The items themselves are kept.`}
          confirmLabel="Delete role"
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            setRemoving(null);
            setup.deleteRole.mutate(removing.id, { onError: fail('Could not delete the role') });
          }}
        />
      )}
    </Section>
  );
}

function RenameField({ value, disabled, onCommit }: { value: string; disabled: boolean; onCommit: (value: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <input
      value={text}
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const trimmed = text.trim();
        if (!trimmed) setText(value);
        else if (trimmed !== value) onCommit(trimmed);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setText(value);
          e.currentTarget.blur();
        }
      }}
      className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-1 text-sm outline-none hover:border-[var(--color-line)] focus:border-[var(--color-accent)] disabled:hover:border-transparent"
    />
  );
}

function ColorSwatch({ color, disabled, onChange }: { color: string; disabled: boolean; onChange: (color: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative shrink-0">
      <button
        disabled={disabled}
        onClick={() => setOpen(!open)}
        aria-label="Colour"
        className="grid h-6 w-6 place-items-center rounded-md hover:bg-[var(--color-surface)]"
      >
        <span className="h-3.5 w-3.5 rounded-full" style={{ background: color }} />
      </button>
      {open && (
        // `w-max` so the swatches lay out at their own size rather than being
        // squeezed into however wide the button beneath them happens to be.
        <div
          className="absolute left-0 top-full z-20 mt-1 grid w-max grid-cols-4 gap-1.5 rounded-lg border border-[var(--color-line)] bg-[var(--color-raised)] p-2 shadow-lg"
          onMouseLeave={() => setOpen(false)}
        >
          {STATUS_COLORS.map((option) => (
            <button
              key={option}
              onClick={() => {
                setOpen(false);
                if (option !== color) onChange(option);
              }}
              aria-label={option}
              className={cx(
                'h-5 w-5 shrink-0 rounded-full',
                option === color && 'ring-2 ring-[var(--color-accent)] ring-offset-2 ring-offset-[var(--color-raised)]',
              )}
              style={{ background: option }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
