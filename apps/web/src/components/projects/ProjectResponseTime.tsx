import { useEffect, useState } from 'react';
import {
  MAX_ESCALATION_STEPS,
  MAX_RESPONSE_MINUTES,
  escalationDeadlines,
  formatMinutes,
  type EscalationStep,
  type Project,
  type ProjectRole,
  type ResponseTime,
} from '@paradocs/shared';
import { useUpdateProject } from '../../api/hooks';
import Icon from '../Icon';
import { FIELD_BASE, Section } from '../SettingsParts';
import { useToast } from '../Toast';
import { Button, IconButton } from '../ui';

const UNITS = [
  { label: 'minutes', minutes: 1 },
  { label: 'hours', minutes: 60 },
  { label: 'days', minutes: 1440 },
] as const;

/** The largest unit a wait is a whole number of, so 90 minutes stays 90 minutes and 120 reads as 2 hours. */
function unitOf(minutes: number) {
  return [...UNITS].reverse().find((unit) => minutes % unit.minutes === 0) ?? UNITS[0];
}

/**
 * The role a new step escalates to: one filled from a schedule, then one that
 * is neither filled by whoever files the work nor typed in, as a requester and
 * a watcher are, then any.
 */
function likelyTarget(roles: ProjectRole[]): ProjectRole | undefined {
  return roles.find((r) => r.scheduleId) ?? roles.find((r) => !r.fillWithCreator && !r.freeForm) ?? roles[0];
}

/**
 * A queue's response time: how long the person in a role has to respond
 * before work passes to the next role, and the next. Off unless turned on;
 * turned on, it watches work filed from then.
 */
export default function ResponseTimeSection({ project, canEdit }: { project: Project; canEdit: boolean }) {
  const update = useUpdateProject(project.workspaceId, project.id);
  const toast = useToast();
  const saved = project.responseTime;
  const disabled = !canEdit || update.isPending;
  const roleName = (id: string | null) => project.roles.find((r) => r.id === id)?.name ?? 'Nobody in particular';

  function save(next: Pick<ResponseTime, 'roleId' | 'steps'> | null, done = 'Saved') {
    update.mutate(
      { responseTime: next },
      {
        onSuccess: () => toast(done),
        onError: (err) => toast(err instanceof Error ? err.message : 'Could not save', 'error'),
      },
    );
  }

  /** Off to on: wait on the first role, and escalate to the likeliest other one. */
  function turnOn() {
    const waited = project.roles[0];
    const target = likelyTarget(project.roles.filter((r) => r.id !== waited?.id));
    if (!target) return;
    save({ roleId: waited?.id ?? null, steps: [{ roleId: target.id, afterMinutes: 15 }] }, 'Response time on for new work');
  }

  const steps = saved?.steps ?? [];
  const used = new Set([saved?.roleId, ...steps.map((s) => s.roleId)]);
  const spare = project.roles.filter((r) => !used.has(r.id));
  const deadlines = escalationDeadlines(steps);
  const setSteps = (next: EscalationStep[]) => saved && save({ roleId: saved.roleId, steps: next });

  return (
    <Section
      title="Response time"
      hint="How long the person in a role has to respond before work passes on. A response is what insights counts: a comment from anyone but whoever filed it, a move to another status, or finishing it. Without one, each step brings in whoever holds its role — whoever is on its schedule at that moment, when it has one — and tells them and those it was waiting on. The people already on it stay on it. It watches work filed in the app, through the API, AI connections and intake forms, from when it is turned on; turning it off stops escalating everything at once."
    >
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={saved !== null}
          disabled={disabled || (saved === null && project.roles.length < 2)}
          onChange={(e) => (e.target.checked ? turnOn() : save(null, 'Response time off'))}
        />
        Escalate work nobody responds to
      </label>
      {saved === null && project.roles.length < 2 && (
        <p className="mt-1 text-xs text-[var(--color-muted)]">Add a role to escalate to under Roles, such as Escalation, first.</p>
      )}

      {saved && (
        <div className="mt-3 space-y-2">
          <label className="flex flex-wrap items-center gap-2 text-sm">
            Waiting on
            <select
              value={saved.roleId ?? ''}
              disabled={disabled}
              onChange={(e) => save({ roleId: e.target.value || null, steps })}
              className={`${FIELD_BASE} max-w-48`}
              aria-label="Role being waited on"
            >
              <option value="">Nobody in particular</option>
              {project.roles
                .filter((r) => r.id === saved.roleId || !steps.some((s) => s.roleId === r.id))
                .map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
            </select>
          </label>

          <ol className="divide-y divide-[var(--color-line)] rounded-lg border border-[var(--color-line)]">
            {steps.map((step, index) => (
              <StepRow
                key={`${index}:${step.roleId}`}
                project={project}
                step={step}
                first={index === 0}
                total={deadlines[index]}
                roleIds={project.roles
                  .filter((r) => r.id === step.roleId || !used.has(r.id))
                  .map((r) => r.id)}
                disabled={disabled}
                onChange={(next) => setSteps(steps.map((s, n) => (n === index ? next : s)))}
                onRemove={steps.length > 1 ? () => setSteps(steps.filter((_, n) => n !== index)) : undefined}
              />
            ))}
          </ol>

          {canEdit && steps.length < MAX_ESCALATION_STEPS && spare.length > 0 && (
            <Button
              variant="subtle"
              className="text-xs"
              disabled={disabled}
              onClick={() => setSteps([...steps, { roleId: likelyTarget(spare)!.id, afterMinutes: 30 }])}
            >
              <Icon name="plus-lg" /> Add a step
            </Button>
          )}
          <p className="text-xs text-[var(--color-muted)]">
            Watching work filed since {new Date(saved.since).toLocaleString()}.
            {saved.roleId && ` ${roleName(saved.roleId)} hears when work passes them.`}
          </p>
        </div>
      )}
    </Section>
  );
}

/** One step: after how long, and which role it brings in. */
function StepRow({
  project,
  step,
  first,
  total,
  roleIds,
  disabled,
  onChange,
  onRemove,
}: {
  project: Project;
  step: EscalationStep;
  first: boolean;
  /** Minutes from filing until this step. */
  total: number;
  roleIds: string[];
  disabled: boolean;
  onChange: (step: EscalationStep) => void;
  onRemove?: () => void;
}) {
  const [unit, setUnit] = useState(() => unitOf(step.afterMinutes));
  const [amount, setAmount] = useState(String(step.afterMinutes / unit.minutes));
  useEffect(() => {
    const fitting = unitOf(step.afterMinutes);
    setUnit(fitting);
    setAmount(String(step.afterMinutes / fitting.minutes));
  }, [step.afterMinutes]);

  const commit = (value: string, per: number) => {
    const minutes = Math.round(Number(value) * per);
    if (Number.isFinite(minutes) && minutes >= 1 && minutes <= MAX_RESPONSE_MINUTES) {
      if (minutes !== step.afterMinutes) onChange({ ...step, afterMinutes: minutes });
    } else {
      setAmount(String(step.afterMinutes / unit.minutes));
    }
  };

  return (
    <li className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
      <Icon name="stopwatch" className="text-[var(--color-muted)]" />
      <span>{first ? 'After' : 'Then'}</span>
      <input
        type="number"
        min={1}
        value={amount}
        disabled={disabled}
        onChange={(e) => setAmount(e.target.value)}
        onBlur={() => commit(amount, unit.minutes)}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        className={`${FIELD_BASE} w-16 tabular-nums`}
        aria-label={first ? 'How long before the first escalation' : 'How long after the step before'}
      />
      <select
        value={unit.minutes}
        disabled={disabled}
        onChange={(e) => {
          const next = UNITS.find((u) => u.minutes === Number(e.target.value)) ?? UNITS[0];
          setUnit(next);
          commit(amount, next.minutes);
        }}
        className={`${FIELD_BASE} w-24`}
        aria-label="Unit"
      >
        {UNITS.map((u) => (
          <option key={u.minutes} value={u.minutes}>
            {u.label}
          </option>
        ))}
      </select>
      <span>{first ? 'without a response, bring in' : 'more, bring in'}</span>
      <select
        value={step.roleId}
        disabled={disabled}
        onChange={(e) => onChange({ ...step, roleId: e.target.value })}
        className={`${FIELD_BASE} max-w-40`}
        aria-label="Role to escalate to"
      >
        {roleIds.map((id) => {
          const role = project.roles.find((r) => r.id === id)!;
          return (
            <option key={id} value={id}>
              {role.name}
              {role.scheduleId ? ' (on call)' : ''}
            </option>
          );
        })}
      </select>
      <span className="ml-auto flex items-center gap-1 text-xs text-[var(--color-muted)]">
        {formatMinutes(total)} in
        {onRemove && (
          <IconButton label="Remove this step" disabled={disabled} onClick={onRemove}>
            <Icon name="x-lg" />
          </IconButton>
        )}
      </span>
    </li>
  );
}
