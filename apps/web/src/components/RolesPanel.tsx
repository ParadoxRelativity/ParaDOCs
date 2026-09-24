import { useEffect, useState } from 'react';
import {
  PERMISSION_GROUPS,
  dependentsOf,
  permissionInfo,
  withPrerequisites,
  type WorkspacePermission,
  type WorkspaceRole,
} from '@paradocs/shared';
import {
  useCreateWorkspaceRole,
  useDeleteWorkspaceRole,
  useUpdateWorkspaceRole,
  useWorkspaceRoles,
} from '../api/hooks';
import { cx } from '../lib/util';
import Icon from './Icon';
import { Modal } from './Modal';
import { FIELD } from './SettingsParts';
import { useToast } from './Toast';
import { Button, IconButton, Spinner } from './ui';

/**
 * Roles: what each kind of member may do anywhere in the workspace. Owner and
 * Admin can do everything and are fixed; every other role is a set of
 * permissions that owners and admins choose. Everyone can look, so the name
 * beside a person means something to them.
 *
 * Roles are not teams. A team says whose things are whose, by being named on a
 * lock; a role says what kind of work someone does, everywhere. A lock can
 * narrow what a role allows, never widen it.
 */
export default function RolesPanel({ workspaceId, canManage }: { workspaceId: string; canManage: boolean }) {
  const roles = useWorkspaceRoles(workspaceId);
  const create = useCreateWorkspaceRole(workspaceId);
  const toast = useToast();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState('');

  const list = roles.data ?? [];
  const custom = list.filter((r) => !r.system);
  // What was chosen, or else the first role that can be changed.
  const selected = list.find((r) => r.id === selectedId) ?? custom[0] ?? list[0];

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      // A new role starts as a copy of the one being looked at, which is
      // usually the nearest thing to what is wanted.
      const role = await create.mutateAsync({
        name: name.trim(),
        copyFrom: selected && !selected.system ? selected.id : undefined,
      });
      setName('');
      setSelectedId(role.id);
      toast(`Role ${role.name} created`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not create the role', 'error');
    }
  }

  if (roles.isLoading) return <Spinner />;

  return (
    <div className="space-y-4">
      <p className="text-xs text-[var(--color-muted)]">
        A role sets what someone may do anywhere in the workspace. Locks on folders, documents, channels and projects can
        narrow it for the teams and people they name, but never go past it.
        {!canManage && ' Ask an owner or admin to change a role.'}
      </p>

      {canManage && (
        <form onSubmit={(e) => void add(e)} className="flex gap-1.5">
          <input
            className={cx(FIELD, 'min-w-0 flex-1')}
            placeholder={selected && !selected.system ? `New role, starting from ${selected.name}` : 'New role name'}
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
            aria-label="New role name"
          />
          <Button variant="primary" className="shrink-0 text-xs" type="submit" disabled={!name.trim() || create.isPending}>
            Create role
          </Button>
        </form>
      )}

      <div className="flex flex-col gap-4 md:flex-row">
        <ul className="shrink-0 space-y-0.5 md:w-52">
          {list.map((role) => (
            <li key={role.id}>
              <button
                onClick={() => setSelectedId(role.id)}
                aria-current={role.id === selected?.id}
                className={cx(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                  role.id === selected?.id
                    ? 'bg-[var(--color-accent-soft)] font-medium text-[var(--color-accent)]'
                    : 'hover:bg-[var(--color-line)]/50',
                )}
              >
                <Icon name={role.system ? 'lock' : 'person-badge'} className="text-xs text-[var(--color-muted)]" />
                <span className="min-w-0 flex-1 truncate">{role.name}</span>
                {role.isDefault && (
                  <span className="rounded bg-[var(--color-surface)] px-1 text-[10px] text-[var(--color-muted)]">default</span>
                )}
                <span className="text-[10px] text-[var(--color-muted)]">{role.memberCount}</span>
              </button>
            </li>
          ))}
        </ul>

        {selected && (
          <RoleEditor
            key={selected.id}
            workspaceId={workspaceId}
            role={selected}
            roles={list}
            canManage={canManage && !selected.system}
            onDeleted={() => setSelectedId(null)}
          />
        )}
      </div>
    </div>
  );
}

function RoleEditor({
  workspaceId,
  role,
  roles,
  canManage,
  onDeleted,
}: {
  workspaceId: string;
  role: WorkspaceRole;
  roles: WorkspaceRole[];
  /** False for Owner and Admin, whatever the viewer may do. */
  canManage: boolean;
  onDeleted: () => void;
}) {
  const update = useUpdateWorkspaceRole(workspaceId);
  const toast = useToast();
  const [name, setName] = useState(role.name);
  const [description, setDescription] = useState(role.description);
  const [permissions, setPermissions] = useState<Set<WorkspacePermission>>(() => new Set(role.permissions));
  const [deleting, setDeleting] = useState(false);

  // Someone else's change to this role arrives while it is open; take it,
  // unless there are edits here that would be lost.
  const saved = new Set(role.permissions);
  const dirty =
    name.trim() !== role.name ||
    description.trim() !== role.description ||
    permissions.size !== saved.size ||
    [...permissions].some((p) => !saved.has(p));
  const savedKey = role.permissions.join() + role.name + role.description;
  useEffect(() => {
    if (dirty) return;
    setName(role.name);
    setDescription(role.description);
    setPermissions(new Set(role.permissions));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  /** Turning one on brings what it needs; turning one off takes what needs it. */
  function toggle(permission: WorkspacePermission, on: boolean) {
    setPermissions((current) => {
      if (on) return new Set(withPrerequisites([...current, permission]));
      const next = new Set(current);
      next.delete(permission);
      for (const dependent of dependentsOf(permission)) next.delete(dependent);
      return next;
    });
  }

  function setGroup(groupPermissions: WorkspacePermission[], on: boolean) {
    setPermissions((current) => {
      if (on) return new Set(withPrerequisites([...current, ...groupPermissions]));
      const next = new Set(current);
      for (const permission of groupPermissions) {
        next.delete(permission);
        for (const dependent of dependentsOf(permission)) next.delete(dependent);
      }
      return next;
    });
  }

  function save() {
    update.mutate(
      { id: role.id, name: name.trim(), description: description.trim(), permissions: [...permissions] },
      {
        onSuccess: () => toast(`Saved ${name.trim()}`),
        onError: (err) => toast(err instanceof Error ? err.message : 'Could not save the role', 'error'),
      },
    );
  }

  function discard() {
    setName(role.name);
    setDescription(role.description);
    setPermissions(new Set(role.permissions));
  }

  const custom = roles.filter((r) => !r.system);
  const position = custom.findIndex((r) => r.id === role.id);
  function move(by: number) {
    update.mutate(
      { id: role.id, position: position + by },
      { onError: (err) => toast(err instanceof Error ? err.message : 'Could not move the role', 'error') },
    );
  }

  return (
    <div className="min-w-0 flex-1 space-y-4">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 space-y-2">
          {canManage ? (
            <>
              <input
                className={cx(FIELD, 'font-medium')}
                value={name}
                maxLength={40}
                onChange={(e) => setName(e.target.value)}
                aria-label="Role name"
              />
              <input
                className={FIELD}
                value={description}
                maxLength={200}
                placeholder="What this role is for"
                onChange={(e) => setDescription(e.target.value)}
                aria-label="Role description"
              />
            </>
          ) : (
            <>
              <h2 className="text-sm font-semibold">{role.name}</h2>
              {role.description && <p className="text-xs text-[var(--color-muted)]">{role.description}</p>}
            </>
          )}
          <p className="text-[11px] text-[var(--color-muted)]">
            {role.memberCount} {role.memberCount === 1 ? 'member' : 'members'}
            {role.inviteCount > 0 && ` · ${role.inviteCount} pending ${role.inviteCount === 1 ? 'invite' : 'invites'}`}
            {role.isDefault && ' · new invites start with this role'}
          </p>
        </div>
        {canManage && (
          <div className="flex shrink-0 items-center">
            <IconButton label="Move up" onClick={() => move(-1)} disabled={position <= 0 || update.isPending}>
              <Icon name="arrow-up" />
            </IconButton>
            <IconButton
              label="Move down"
              onClick={() => move(1)}
              disabled={position >= custom.length - 1 || update.isPending}
            >
              <Icon name="arrow-down" />
            </IconButton>
          </div>
        )}
      </div>

      {role.system && (
        <p className="rounded-md bg-[var(--color-surface)] px-3 py-2 text-xs text-[var(--color-muted)]">
          <Icon name="lock" /> {role.name} is built in. It can do everything
          {role.system === 'owner' ? ', including deleting the workspace' : ' but delete the workspace'}, gets past every
          lock, and manages people, roles and settings. It cannot be changed.
        </p>
      )}

      {PERMISSION_GROUPS.map((group) => {
        const ids = group.permissions.map((p) => p.id);
        const held = ids.filter((id) => permissions.has(id)).length;
        return (
          <fieldset key={group.id} className="rounded-lg border border-[var(--color-line)]">
            <legend className="sr-only">{group.label}</legend>
            <div className="flex items-center justify-between border-b border-[var(--color-line)] px-3 py-1.5">
              <span className="text-xs font-semibold">{group.label}</span>
              <span className="flex items-center gap-2 text-[11px] text-[var(--color-muted)]">
                {held} of {ids.length}
                {canManage && (
                  <>
                    <button
                      type="button"
                      className="hover:text-[var(--color-ink)]"
                      onClick={() => setGroup(ids, true)}
                      disabled={held === ids.length}
                    >
                      All
                    </button>
                    <button
                      type="button"
                      className="hover:text-[var(--color-ink)]"
                      onClick={() => setGroup(ids, false)}
                      disabled={held === 0}
                    >
                      None
                    </button>
                  </>
                )}
              </span>
            </div>
            <ul className="divide-y divide-[var(--color-line)]">
              {group.permissions.map((permission) => (
                <li key={permission.id}>
                  <label
                    className={cx(
                      'flex items-start gap-2.5 px-3 py-2',
                      canManage ? 'cursor-pointer hover:bg-[var(--color-surface)]' : 'cursor-default',
                    )}
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={permissions.has(permission.id)}
                      disabled={!canManage}
                      onChange={(e) => toggle(permission.id, e.target.checked)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm">{permission.label}</span>
                      <span className="block text-[11px] text-[var(--color-muted)]">
                        {permission.description}
                        {permission.requires.length > 0 &&
                          ` Needs ${permission.requires.map((r) => permissionInfo(r).label.toLowerCase()).join(' and ')}.`}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
        );
      })}

      {canManage && (
        <div className="sticky bottom-0 flex flex-wrap items-center gap-2 border-t border-[var(--color-line)] bg-[var(--color-canvas)] py-2">
          <Button variant="primary" className="text-xs" onClick={save} disabled={!dirty || !name.trim() || update.isPending}>
            Save changes
          </Button>
          {dirty && (
            <Button variant="subtle" className="text-xs" onClick={discard}>
              Discard
            </Button>
          )}
          <span className="flex-1" />
          {!role.isDefault && (
            <Button
              variant="ghost"
              className="text-xs"
              disabled={update.isPending}
              onClick={() =>
                update.mutate(
                  { id: role.id, isDefault: true },
                  {
                    onSuccess: () => toast(`New invites now start as ${role.name}`),
                    onError: (err) => toast(err instanceof Error ? err.message : 'Could not change it', 'error'),
                  },
                )
              }
            >
              Use for new invites
            </Button>
          )}
          <Button variant="danger" className="text-xs" onClick={() => setDeleting(true)}>
            Delete
          </Button>
        </div>
      )}

      {deleting && (
        <DeleteRoleDialog
          workspaceId={workspaceId}
          role={role}
          roles={roles}
          onClose={() => setDeleting(false)}
          onDeleted={onDeleted}
        />
      )}
    </div>
  );
}

/**
 * Deleting a role someone holds, or that pending invites or new invites use,
 * takes saying which role they get instead.
 */
function DeleteRoleDialog({
  workspaceId,
  role,
  roles,
  onClose,
  onDeleted,
}: {
  workspaceId: string;
  role: WorkspaceRole;
  roles: WorkspaceRole[];
  onClose: () => void;
  onDeleted: () => void;
}) {
  const remove = useDeleteWorkspaceRole(workspaceId);
  const toast = useToast();
  // Nobody is moved to Owner this way, and new invites never start as a built-in role.
  const targets = roles.filter((r) => r.id !== role.id && r.system !== 'owner' && !(role.isDefault && r.system));
  const needsTarget = role.memberCount > 0 || role.inviteCount > 0 || role.isDefault;
  const [moveTo, setMoveTo] = useState(targets.find((r) => !r.system)?.id ?? targets[0]?.id ?? '');

  const held = [
    role.memberCount > 0 && `${role.memberCount} ${role.memberCount === 1 ? 'person has' : 'people have'} this role`,
    role.inviteCount > 0 && `${role.inviteCount} pending ${role.inviteCount === 1 ? 'invite uses' : 'invites use'} it`,
    role.isDefault && 'new invites start with it',
  ].filter(Boolean);

  return (
    <Modal
      title={`Delete ${role.name}?`}
      description={
        needsTarget
          ? `${held.join(', ').replace(/^./, (c) => c.toUpperCase())}. Choose the role they get instead.`
          : 'Nobody has this role, so nothing else changes.'
      }
      onClose={onClose}
      footer={
        <>
          <Button variant="subtle" className="text-xs" onClick={onClose}>
            Cancel
          </Button>
          <button
            autoFocus
            disabled={remove.isPending || (needsTarget && !moveTo)}
            onClick={() =>
              remove.mutate(
                { id: role.id, moveTo: needsTarget ? moveTo : undefined },
                {
                  onSuccess: () => {
                    toast(`Deleted ${role.name}`);
                    onClose();
                    onDeleted();
                  },
                  onError: (err) => toast(err instanceof Error ? err.message : 'Could not delete the role', 'error'),
                },
              )
            }
            className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50"
          >
            Delete role
          </button>
        </>
      }
    >
      {needsTarget && (
        <select className={FIELD} value={moveTo} onChange={(e) => setMoveTo(e.target.value)} aria-label="Move them to">
          {targets.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      )}
    </Modal>
  );
}
