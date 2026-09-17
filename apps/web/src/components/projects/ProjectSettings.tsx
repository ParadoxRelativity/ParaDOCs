import { useEffect, useState } from 'react';
import {
  STATUS_CATEGORIES,
  STATUS_CATEGORY_LABELS,
  STATUS_COLORS,
  type Project,
  type ProjectRole,
  type ProjectStatus,
  type StatusCategory,
  type WorkItemSummary,
} from '@paradocs/shared';
import { useDeleteProject, useProjectSetup, useUpdateProject } from '../../api/hooks';
import { cx } from '../../lib/util';
import { AccessDialog } from '../AccessDialog';
import Icon from '../Icon';
import { ConfirmDialog, Modal } from '../Modal';
import { FIELD, Section } from '../SettingsParts';
import { useToast } from '../Toast';
import { Button, IconButton } from '../ui';
import { CATEGORY_ICON, PROJECT_KIND } from './projectUi';
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
        <StatusSection project={project} items={items} canEdit={canEdit} />
        <RoleSection project={project} canEdit={canEdit} />

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
              className={cx(FIELD, 'w-32 py-1 text-xs')}
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
              className={cx(FIELD, 'min-w-0 flex-1 py-1')}
            />
            <select
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value as StatusCategory)}
              className={cx(FIELD, 'w-32 py-1 text-xs')}
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

function RoleSection({ project, canEdit }: { project: Project; canEdit: boolean }) {
  const setup = useProjectSetup(project.workspaceId, project.id);
  const toast = useToast();
  const [removing, setRemoving] = useState<ProjectRole | null>(null);
  const [newName, setNewName] = useState('');
  const [newMultiple, setNewMultiple] = useState(false);
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
      { name, multiple: newMultiple },
      {
        onSuccess: () => {
          setNewName('');
          setNewMultiple(false);
        },
        onError: fail('Could not add the role'),
      },
    );
  }

  return (
    <Section
      title="Roles"
      hint="What people can be on a work item here. The first role is the one boards and lists show, and workload starts from."
    >
      <ul className="divide-y divide-[var(--color-line)] rounded-lg border border-[var(--color-line)]">
        {roles.map((role, index) => (
          <li key={role.id} className="flex items-center gap-2 px-2 py-1.5">
            <Icon name={role.multiple ? 'people' : 'person'} className="w-5 text-center text-[var(--color-muted)]" />
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
              Several people
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
              Several people
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
    <div className="relative">
      <button
        disabled={disabled}
        onClick={() => setOpen(!open)}
        aria-label="Colour"
        className="grid h-6 w-6 place-items-center rounded-md hover:bg-[var(--color-surface)]"
      >
        <span className="h-3.5 w-3.5 rounded-full" style={{ background: color }} />
      </button>
      {open && (
        <div
          className="absolute left-0 top-full z-20 mt-1 grid grid-cols-4 gap-1 rounded-lg border border-[var(--color-line)] bg-[var(--color-raised)] p-1.5 shadow-lg"
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
              className={cx('h-5 w-5 rounded-full', option === color && 'ring-2 ring-[var(--color-accent)] ring-offset-1')}
              style={{ background: option }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
