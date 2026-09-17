import { useState } from 'react';
import {
  WORK_ITEM_PRIORITIES,
  WORK_ITEM_TYPES,
  suggestProjectKey,
  type Project,
  type ProjectKind,
  type WorkItemPriority,
  type WorkItemType,
  type WorkspaceMember,
} from '@paradocs/shared';
import { useCreateProject, useCreateWorkItem } from '../../api/hooks';
import { cx } from '../../lib/util';
import Icon from '../Icon';
import { Modal } from '../Modal';
import { FIELD } from '../SettingsParts';
import { useToast } from '../Toast';
import { Button } from '../ui';
import { DueDatePicker, ITEM_TYPE, PRIORITY, PROJECT_KIND, PeoplePicker, PeopleStack, useMemberMap } from './projectUi';

export function NewProjectDialog({
  workspaceId,
  initialKind,
  onCreated,
  onClose,
}: {
  workspaceId: string;
  initialKind: ProjectKind;
  onCreated: (project: Project) => void;
  onClose: () => void;
}) {
  const create = useCreateProject(workspaceId);
  const toast = useToast();
  const [kind, setKind] = useState<ProjectKind>(initialKind);
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  // The key follows the name until someone types one of their own.
  const [keyEdited, setKeyEdited] = useState(false);
  const [icon, setIcon] = useState('');
  const [description, setDescription] = useState('');

  const shownKey = keyEdited ? key : name.trim() ? suggestProjectKey(name) : '';
  const validKey = /^[A-Z][A-Z0-9]{1,9}$/.test(shownKey);

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!name.trim() || !validKey) return;
    try {
      const project = await create.mutateAsync({ name: name.trim(), key: shownKey, kind, icon: icon.trim() || null, description });
      onCreated(project);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not create it', 'error');
    }
  }

  const kinds: { id: ProjectKind; hint: string }[] = [
    { id: 'project', hint: 'Planned work on a board, moved along as it gets done.' },
    { id: 'queue', hint: 'Requests that come in and are worked through, oldest first.' },
  ];

  return (
    <Modal
      title={`New ${PROJECT_KIND[kind].label.toLowerCase()}`}
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="subtle" className="text-xs" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" className="text-xs" disabled={!name.trim() || !validKey || create.isPending} onClick={() => void submit()}>
            Create
          </Button>
        </>
      }
    >
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        <div role="radiogroup" aria-label="Kind" className="grid grid-cols-2 gap-2">
          {kinds.map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={kind === option.id}
              onClick={() => setKind(option.id)}
              className={cx(
                'rounded-lg border px-3 py-2 text-left',
                kind === option.id ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]' : 'border-[var(--color-line)] hover:bg-[var(--color-surface)]',
              )}
            >
              <span className="flex items-center gap-1.5 text-sm font-medium">
                <Icon name={PROJECT_KIND[option.id].icon} /> {PROJECT_KIND[option.id].label}
              </span>
              <span className="mt-0.5 block text-xs text-[var(--color-muted)]">{option.hint}</span>
            </button>
          ))}
        </div>
        <div className="grid grid-cols-[3.5rem_minmax(0,1fr)_8rem] gap-2">
          <label className="text-xs text-[var(--color-muted)]">
            Icon
            <input value={icon} maxLength={4} onChange={(e) => setIcon(e.target.value)} placeholder="—" className={cx(FIELD, 'mt-1 text-center')} />
          </label>
          <label className="text-xs text-[var(--color-muted)]">
            Name
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={kind === 'queue' ? 'IT requests' : 'Website relaunch'}
              className={cx(FIELD, 'mt-1')}
            />
          </label>
          <label className="text-xs text-[var(--color-muted)]">
            Key
            <input
              value={shownKey}
              maxLength={10}
              onChange={(e) => {
                setKeyEdited(true);
                setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''));
              }}
              placeholder="WEB"
              className={cx(FIELD, 'mt-1 font-mono uppercase')}
            />
          </label>
        </div>
        <p className="text-xs text-[var(--color-muted)]">
          Work items are numbered after the key: {validKey ? `${shownKey}-1, ${shownKey}-2` : 'two to ten letters or digits, starting with a letter'}.
        </p>
        <label className="block text-xs text-[var(--color-muted)]">
          Description
          <textarea value={description} rows={2} onChange={(e) => setDescription(e.target.value)} className={cx(FIELD, 'mt-1 resize-y')} />
        </label>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

/**
 * Filing a new work item. Only what it takes to get it on the board is asked
 * for here; the description, comments and the rest are written in the item
 * itself, which opens as soon as it is made.
 */
export function NewWorkItemDialog({
  project,
  members,
  selfId,
  initialStatusId,
  onCreated,
  onClose,
}: {
  project: Project;
  members: WorkspaceMember[];
  selfId: string;
  /** Where it starts; the project's first status when not given. */
  initialStatusId?: string;
  onCreated: (itemId: string) => void;
  onClose: () => void;
}) {
  const create = useCreateWorkItem(project.id);
  const toast = useToast();
  const memberMap = useMemberMap(members);
  const [title, setTitle] = useState('');
  const [type, setType] = useState<WorkItemType>(project.kind === 'queue' ? 'request' : 'task');
  const [priority, setPriority] = useState<WorkItemPriority>('none');
  const [statusId, setStatusId] = useState(initialStatusId ?? project.statuses[0]?.id ?? '');
  const [dueDate, setDueDate] = useState('');
  const [estimate, setEstimate] = useState('');
  // Whoever files something reported or requested it, when the project has
  // such a role; they can take themselves off before creating it.
  const [roles, setRoles] = useState<Record<string, string[]>>(() => {
    const filer = project.roles.find((role) => /report|request/i.test(role.name));
    return filer ? { [filer.id]: [selfId] } : {};
  });
  const [picking, setPicking] = useState<{ roleId: string; anchor: HTMLElement } | null>(null);

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!title.trim()) return;
    const parsedEstimate = estimate.trim() === '' ? null : Number(estimate);
    try {
      const item = await create.mutateAsync({
        title: title.trim(),
        type,
        priority,
        statusId,
        dueDate: dueDate || null,
        estimate: parsedEstimate !== null && Number.isFinite(parsedEstimate) ? parsedEstimate : null,
        roles,
      });
      toast(`Created ${item.key}`);
      onCreated(item.id);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not create the work item', 'error');
    }
  }

  const pickingRole = picking && project.roles.find((role) => role.id === picking.roleId);

  return (
    <Modal
      title={`New work item in ${project.name}`}
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="subtle" className="text-xs" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" className="text-xs" disabled={!title.trim() || create.isPending} onClick={() => void submit()}>
            Create
          </Button>
        </>
      }
    >
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title"
          className={cx(FIELD, 'text-base')}
        />
        <div className="grid grid-cols-3 gap-2">
          <label className="text-xs text-[var(--color-muted)]">
            Type
            <select value={type} onChange={(e) => setType(e.target.value as WorkItemType)} className={cx(FIELD, 'mt-1')}>
              {WORK_ITEM_TYPES.map((t) => (
                <option key={t} value={t}>
                  {ITEM_TYPE[t].label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-[var(--color-muted)]">
            Status
            <select value={statusId} onChange={(e) => setStatusId(e.target.value)} className={cx(FIELD, 'mt-1')}>
              {project.statuses.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-[var(--color-muted)]">
            Priority
            <select value={priority} onChange={(e) => setPriority(e.target.value as WorkItemPriority)} className={cx(FIELD, 'mt-1')}>
              {WORK_ITEM_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY[p].label}
                </option>
              ))}
            </select>
          </label>
          <div className="text-xs text-[var(--color-muted)]" title="When the work is expected to be finished and delivered">
            Due date
            <DueDatePicker
              value={dueDate || null}
              onChange={(date) => setDueDate(date ?? '')}
              className={cx(FIELD, 'mt-1 text-[var(--color-ink)]')}
            />
          </div>
          <label className="text-xs text-[var(--color-muted)]">
            Estimate
            <input
              type="number"
              min={0}
              step="any"
              value={estimate}
              onChange={(e) => setEstimate(e.target.value)}
              placeholder="—"
              className={cx(FIELD, 'mt-1')}
            />
          </label>
        </div>
        {project.roles.length > 0 && (
          <div className="grid grid-cols-3 gap-2">
            {project.roles.map((role) => {
              const holders = roles[role.id] ?? [];
              return (
                <div key={role.id} className="text-xs text-[var(--color-muted)]">
                  {role.name}
                  <button
                    type="button"
                    onClick={(e) => setPicking({ roleId: role.id, anchor: e.currentTarget })}
                    className={cx(FIELD, 'mt-1 flex items-center gap-1.5 text-left')}
                  >
                    {holders.length === 0 ? (
                      <span className="text-[var(--color-muted)]">Nobody</span>
                    ) : (
                      <>
                        <PeopleStack userIds={holders} members={memberMap} />
                        <span className="truncate text-[var(--color-ink)]">
                          {holders.length === 1 ? (memberMap.get(holders[0])?.name ?? '') : `${holders.length} people`}
                        </span>
                      </>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        )}
        <button type="submit" hidden />
      </form>
      {picking && pickingRole && (
        <PeoplePicker
          anchor={picking.anchor}
          members={members}
          selected={roles[pickingRole.id] ?? []}
          multiple={pickingRole.multiple}
          onChange={(userIds) => setRoles((current) => ({ ...current, [pickingRole.id]: userIds }))}
          onClose={() => setPicking(null)}
        />
      )}
    </Modal>
  );
}
