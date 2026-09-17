import { WORKSPACE_APPS, type WorkspaceApp } from '@paradocs/shared';
import { useUpdateWorkspace, type WorkspaceSummary } from '../api/hooks';
import { cx } from '../lib/util';
import Icon, { type IconName } from './Icon';
import { Section } from './SettingsParts';
import { useToast } from './Toast';

const APPS: Record<WorkspaceApp, { label: string; icon: IconName; hint: string }> = {
  docs: {
    label: 'Docs',
    icon: 'journals',
    hint: 'Pages, canvases, the journal, tags and the calendar.',
  },
  sheets: {
    label: 'Sheets',
    icon: 'table',
    hint: 'Spreadsheets, and the cells and charts documents show from them.',
  },
  chat: {
    label: 'Chat',
    icon: 'chat-dots',
    hint: 'Channels, direct messages and calls.',
  },
  projects: {
    label: 'Projects',
    icon: 'kanban',
    hint: 'Projects and queues of work items, with boards, workload and roles.',
  },
};

/**
 * Which apps a workspace uses. A workspace for one team's chat needs no
 * knowledge base, and one kept as a knowledge base needs no chat.
 *
 * Turning an app off hides it for everyone in the workspace and has the server
 * refuse it, but deletes nothing: turning it back on brings everything back.
 * Access stays on regardless, since it is where membership is managed.
 */
export default function WorkspaceAppsSettings({
  workspace,
  canManage,
}: {
  workspace: WorkspaceSummary;
  canManage: boolean;
}) {
  const update = useUpdateWorkspace(workspace.id);
  const toast = useToast();
  const enabled = workspace.apps;

  function toggle(app: WorkspaceApp, on: boolean) {
    const next = WORKSPACE_APPS.filter((a) => (a === app ? on : enabled.includes(a)));
    update.mutate(
      { apps: next },
      {
        onSuccess: () =>
          toast(
            on
              ? `${APPS[app].label} is on for everyone in ${workspace.name}`
              : `${APPS[app].label} is off. Nothing in it was deleted.`,
          ),
        onError: (err) => toast(err instanceof Error ? err.message : 'Could not change the apps', 'error'),
      },
    );
  }

  return (
    <Section
      title="Apps"
      hint={
        canManage
          ? 'Choose what this workspace is used for. Turning an app off hides it for everyone and keeps what is in it, so turning it back on restores everything.'
          : 'Only an owner or admin can change which apps this workspace uses.'
      }
    >
      <ul className="divide-y divide-[var(--color-line)] rounded-lg border border-[var(--color-line)]">
        {WORKSPACE_APPS.map((app) => {
          const on = enabled.includes(app);
          // The last app on stays on: a workspace with nothing else in it is only Access.
          const last = on && enabled.length === 1;
          const disabled = !canManage || last || update.isPending;
          return (
            <li key={app} className="flex items-center gap-3 px-3 py-2.5">
              <span
                className={cx(
                  'grid h-8 w-8 shrink-0 place-items-center rounded-md text-base',
                  on ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]' : 'bg-[var(--color-surface)] text-[var(--color-muted)]',
                )}
              >
                <Icon name={APPS[app].icon} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{APPS[app].label}</span>
                <span className="block text-xs text-[var(--color-muted)]">
                  {last && canManage ? 'At least one app has to stay on.' : APPS[app].hint}
                </span>
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={`${APPS[app].label} app`}
                disabled={disabled}
                onClick={() => toggle(app, !on)}
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
            </li>
          );
        })}
        <li className="flex items-center gap-3 px-3 py-2.5">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-[var(--color-accent-soft)] text-base text-[var(--color-accent)]">
            <Icon name="shield-lock" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">Access</span>
            <span className="block text-xs text-[var(--color-muted)]">
              Members, teams and these settings. Always on, since it is where the workspace is managed.
            </span>
          </span>
        </li>
      </ul>
    </Section>
  );
}
