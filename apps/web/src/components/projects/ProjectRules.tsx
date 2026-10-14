import { useState } from 'react';
import {
  MAX_RULE_ACTIONS,
  MAX_RULES,
  WORK_ITEM_PRIORITIES,
  type Project,
  type ProjectRule,
  type RuleAction,
  type RuleSource,
  type WorkItemPriority,
  type WorkspaceMember,
} from '@paradocs/shared';
import { useMembers, useProjectSetup } from '../../api/hooks';
import { cx } from '../../lib/util';
import Icon from '../Icon';
import { ConfirmDialog, Modal } from '../Modal';
import { FIELD, FIELD_BASE, Section } from '../SettingsParts';
import { useToast } from '../Toast';
import { Button, IconButton } from '../ui';
import { positionBetween } from './ProjectBoard';
import { PRIORITY } from './projectUi';

/** A rule as a sentence: "When work enters In review (Bug): set Assignee to the Reviewer." */
export function describeRule(project: Project, rule: Omit<ProjectRule, 'id' | 'position'>, members: WorkspaceMember[]): string {
  const status = project.statuses.find((s) => s.id === rule.statusId)?.name ?? 'a deleted status';
  const types = rule.typeIds
    ? ` (${rule.typeIds.map((id) => project.itemTypes.find((t) => t.id === id)?.name ?? 'a deleted type').join(', ')})`
    : '';
  const roleName = (id: string) => project.roles.find((r) => r.id === id)?.name ?? 'a deleted role';
  const source = (s: RuleSource | undefined) =>
    !s
      ? 'someone'
      : s.kind === 'mover'
        ? 'whoever moved it'
        : s.kind === 'role'
          ? `the ${roleName(s.roleId)}`
          : (members.find((m) => m.userId === s.userId)?.name ?? 'a former member');
  const actions = rule.actions.map((action) =>
    action.kind === 'priority'
      ? `set priority to ${PRIORITY[action.priority].label.toLowerCase()}`
      : action.op === 'clear'
        ? `clear ${roleName(action.roleId)}`
        : action.op === 'add'
          ? `add ${source(action.source)} to ${roleName(action.roleId)}`
          : `set ${roleName(action.roleId)} to ${source(action.source)}`,
  );
  return `When work enters ${status}${types}: ${actions.join('; ')}.`;
}

/**
 * What the project fills in when work reaches a status. Rules run on the
 * server with every move, however it is made, so they apply to moves made
 * through the API and AI connections too.
 */
export function RuleSection({ project, canEdit }: { project: Project; canEdit: boolean }) {
  const setup = useProjectSetup(project.workspaceId, project.id);
  const members = useMembers(project.workspaceId).data ?? [];
  const toast = useToast();
  const [editing, setEditing] = useState<ProjectRule | 'new' | null>(null);
  const [removing, setRemoving] = useState<ProjectRule | null>(null);
  const rules = project.rules;
  const fail = (fallback: string) => (err: unknown) => toast(err instanceof Error ? err.message : fallback, 'error');

  function move(index: number, by: -1 | 1) {
    const target = index + by;
    if (target < 0 || target >= rules.length) return;
    const others = rules.filter((_, i) => i !== index);
    const position = positionBetween(others[target - 1]?.position, others[target]?.position);
    setup.updateRule.mutate({ id: rules[index].id, position }, { onError: fail('Could not move the rule') });
  }

  return (
    <Section
      title="Rules"
      hint="What is filled in when work reaches a status, such as handing it to its reviewer when it goes to review. Rules run with every move, from the board, a bulk move, the API or an AI connection, in this order; a later rule wins over an earlier one. What they change does not set off other rules."
    >
      <ul className="divide-y divide-[var(--color-line)] rounded-lg border border-[var(--color-line)]">
        {rules.map((rule, index) => (
          <li key={rule.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1.5">
            <input
              type="checkbox"
              checked={rule.enabled}
              disabled={!canEdit}
              aria-label={`${rule.name} is on`}
              title={rule.enabled ? 'On' : 'Off'}
              onChange={(e) => setup.updateRule.mutate({ id: rule.id, enabled: e.target.checked }, { onError: fail('Could not change the rule') })}
            />
            <span className={cx('min-w-0 flex-1 basis-48', !rule.enabled && 'opacity-50')}>
              <span className="block text-sm font-medium">{rule.name}</span>
              <span className="block text-xs text-[var(--color-muted)]">{describeRule(project, rule, members)}</span>
            </span>
            {canEdit && (
              <div className="ml-auto flex">
                <IconButton label={`Edit ${rule.name}`} onClick={() => setEditing(rule)}>
                  <Icon name="pencil" />
                </IconButton>
                <IconButton label="Move earlier" disabled={index === 0} onClick={() => move(index, -1)}>
                  <Icon name="chevron-up" />
                </IconButton>
                <IconButton label="Move later" disabled={index === rules.length - 1} onClick={() => move(index, 1)}>
                  <Icon name="chevron-down" />
                </IconButton>
                <IconButton label="Delete rule" onClick={() => setRemoving(rule)}>
                  <Icon name="trash3" />
                </IconButton>
              </div>
            )}
          </li>
        ))}
        {rules.length === 0 && <li className="px-3 py-2 text-xs text-[var(--color-muted)]">No rules yet.</li>}
        {canEdit && rules.length < MAX_RULES && (
          <li className="px-2 py-1.5">
            <Button variant="subtle" className="text-xs" onClick={() => setEditing('new')}>
              <Icon name="plus-lg" /> New rule
            </Button>
          </li>
        )}
      </ul>

      {editing && (
        <RuleEditor
          project={project}
          members={members}
          rule={editing === 'new' ? null : editing}
          saving={setup.addRule.isPending || setup.updateRule.isPending}
          onClose={() => setEditing(null)}
          onSave={(rule) => {
            const done = { onSuccess: () => setEditing(null), onError: fail('Could not save the rule') };
            if (editing === 'new') setup.addRule.mutate(rule, done);
            else setup.updateRule.mutate({ id: editing.id, ...rule }, done);
          }}
        />
      )}
      {removing && (
        <ConfirmDialog
          title={`Delete ${removing.name}?`}
          description="Work already moved keeps what the rule filled in."
          onConfirm={() => {
            setup.deleteRule.mutate(removing.id, { onError: fail('Could not delete the rule') });
            setRemoving(null);
          }}
          onCancel={() => setRemoving(null)}
        />
      )}
    </Section>
  );
}

type Draft = Omit<ProjectRule, 'id' | 'position'>;

/** A rule's trigger and what it does, read as the sentence it makes. */
function RuleEditor({
  project,
  members,
  rule,
  saving,
  onClose,
  onSave,
}: {
  project: Project;
  members: WorkspaceMember[];
  rule: ProjectRule | null;
  saving: boolean;
  onClose: () => void;
  onSave: (rule: Draft) => void;
}) {
  const firstRole = project.roles[0];
  const [draft, setDraft] = useState<Draft>(() =>
    rule
      ? { name: rule.name, enabled: rule.enabled, statusId: rule.statusId, typeIds: rule.typeIds, actions: rule.actions }
      : {
          name: '',
          enabled: true,
          statusId: project.statuses.find((s) => s.category === 'active')?.id ?? project.statuses[0]?.id ?? '',
          typeIds: null,
          actions: firstRole ? [{ kind: 'role', roleId: firstRole.id, op: 'set', source: { kind: 'mover' } }] : [],
        },
  );
  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
  const setAction = (index: number, action: RuleAction) => set({ actions: draft.actions.map((a, i) => (i === index ? action : a)) });

  /** A rule's source as one select value: `mover`, `role:<id>` or `member:<id>`. */
  const sourceValue = (source: RuleSource | undefined) =>
    !source ? 'mover' : source.kind === 'mover' ? 'mover' : source.kind === 'role' ? `role:${source.roleId}` : `member:${source.userId}`;
  const sourceOf = (value: string): RuleSource =>
    value.startsWith('role:')
      ? { kind: 'role', roleId: value.slice(5) }
      : value.startsWith('member:')
        ? { kind: 'member', userId: value.slice(7) }
        : { kind: 'mover' };

  const valid = draft.name.trim() && draft.statusId && draft.actions.length > 0 && (draft.typeIds === null || draft.typeIds.length > 0);
  const select = cx(FIELD_BASE, 'min-w-0 max-w-full py-1');

  return (
    <Modal
      title={rule ? 'Edit rule' : 'New rule'}
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="subtle" className="text-xs" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" className="text-xs" disabled={!valid || saving} onClick={() => onSave({ ...draft, name: draft.name.trim() })}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <label className="block text-xs text-[var(--color-muted)]">
          Name
          <input
            autoFocus
            value={draft.name}
            maxLength={80}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="Hand over for review"
            className={cx(FIELD, 'mt-1')}
          />
        </label>

        <div className="flex flex-wrap items-center gap-2">
          <span>When work enters</span>
          <select value={draft.statusId} onChange={(e) => set({ statusId: e.target.value })} className={select} aria-label="Status">
            {project.statuses.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>

        <fieldset>
          <legend className="text-xs text-[var(--color-muted)]">For</legend>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={draft.typeIds === null} onChange={() => set({ typeIds: null })} /> Every type
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={draft.typeIds !== null} onChange={() => set({ typeIds: draft.typeIds ?? [] })} /> Only…
            </label>
          </div>
          {draft.typeIds !== null && (
            <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
              {project.itemTypes.map((t) => (
                <label key={t.id} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={draft.typeIds!.includes(t.id)}
                    onChange={(e) =>
                      set({ typeIds: e.target.checked ? [...draft.typeIds!, t.id] : draft.typeIds!.filter((id) => id !== t.id) })
                    }
                  />
                  {t.name}
                </label>
              ))}
            </div>
          )}
        </fieldset>

        <div>
          <p className="text-xs text-[var(--color-muted)]">Then</p>
          <ul className="mt-1 space-y-2">
            {draft.actions.map((action, index) => (
              <li key={index} className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--color-line)] px-2 py-1.5">
                {action.kind === 'priority' ? (
                  <>
                    <span>set priority to</span>
                    <select
                      value={action.priority}
                      onChange={(e) => setAction(index, { kind: 'priority', priority: e.target.value as WorkItemPriority })}
                      className={select}
                      aria-label="Priority"
                    >
                      {WORK_ITEM_PRIORITIES.map((p) => (
                        <option key={p} value={p}>
                          {PRIORITY[p].label}
                        </option>
                      ))}
                    </select>
                  </>
                ) : (
                  <>
                    <select
                      value={action.op}
                      onChange={(e) => {
                        const op = e.target.value as 'set' | 'add' | 'clear';
                        setAction(index, { ...action, op, source: op === 'clear' ? undefined : (action.source ?? { kind: 'mover' }) });
                      }}
                      className={select}
                      aria-label="What to do"
                    >
                      <option value="set">set</option>
                      <option value="add">add to</option>
                      <option value="clear">clear</option>
                    </select>
                    <select
                      value={action.roleId}
                      onChange={(e) => setAction(index, { ...action, roleId: e.target.value })}
                      className={select}
                      aria-label="Role"
                    >
                      {project.roles.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                    {action.op !== 'clear' && (
                      <>
                        <span>{action.op === 'add' ? 'with' : 'to'}</span>
                        <select
                          value={sourceValue(action.source)}
                          onChange={(e) => setAction(index, { ...action, source: sourceOf(e.target.value) })}
                          className={select}
                          aria-label="Who"
                        >
                          <option value="mover">whoever moved it</option>
                          <optgroup label="Whoever holds">
                            {project.roles
                              .filter((r) => r.id !== action.roleId)
                              .map((r) => (
                                <option key={r.id} value={`role:${r.id}`}>
                                  the {r.name}
                                </option>
                              ))}
                          </optgroup>
                          <optgroup label="A member">
                            {members.map((m) => (
                              <option key={m.userId} value={`member:${m.userId}`}>
                                {m.name}
                              </option>
                            ))}
                          </optgroup>
                        </select>
                      </>
                    )}
                  </>
                )}
                <IconButton
                  label="Remove this action"
                  className="ml-auto"
                  onClick={() => set({ actions: draft.actions.filter((_, i) => i !== index) })}
                >
                  <Icon name="x-lg" />
                </IconButton>
              </li>
            ))}
          </ul>
          {draft.actions.length < MAX_RULE_ACTIONS && (
            <div className="mt-2 flex flex-wrap gap-2">
              {firstRole && (
                <Button
                  variant="subtle"
                  className="text-xs"
                  onClick={() => set({ actions: [...draft.actions, { kind: 'role', roleId: firstRole.id, op: 'set', source: { kind: 'mover' } }] })}
                >
                  <Icon name="person-plus" /> Fill a role
                </Button>
              )}
              <Button
                variant="subtle"
                className="text-xs"
                onClick={() => set({ actions: [...draft.actions, { kind: 'priority', priority: 'high' }] })}
              >
                <Icon name="flag" /> Set the priority
              </Button>
            </div>
          )}
        </div>

        {valid && <p className="rounded-lg bg-[var(--color-surface)] px-3 py-2 text-xs text-[var(--color-muted)]">{describeRule(project, draft, members)}</p>}
      </div>
    </Modal>
  );
}
