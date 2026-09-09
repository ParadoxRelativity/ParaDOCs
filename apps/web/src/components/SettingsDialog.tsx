import { useState } from 'react';
import type { User } from '@paradocs/shared';
import {
  useChangePassword,
  useDeleteWorkspace,
  useUpdateProfile,
  useUpdateWorkspace,
  type WorkspaceSummary,
} from '../api/hooks';
import { cx } from '../lib/util';
import { ConfirmDialog, Modal } from './Modal';
import { useToast } from './Toast';
import { Button } from './ui';
import MembersPanel from './MembersPanel';
import UploadsPanel from './UploadsPanel';
import WorkspaceIcon from './WorkspaceIcon';

export type SettingsSection = 'account' | 'appearance' | 'workspace' | 'members' | 'uploads';
export type Theme = 'light' | 'dark' | 'system';

interface Props {
  section: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  user: User;
  workspace: WorkspaceSummary;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  onClose: () => void;
  onWorkspaceDeleted: () => void;
  onOpenDocument: (documentId: string) => void;
}

const FIELD =
  'w-full rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-2 py-1.5 text-sm ' +
  'outline-none focus:border-[var(--color-accent)] disabled:opacity-60';

export default function SettingsDialog(props: Props) {
  const { section, onSectionChange, workspace } = props;
  const canManageWorkspace = workspace.role === 'owner' || workspace.role === 'admin';

  const nav: { id: SettingsSection; label: string; icon: string }[] = [
    { id: 'account', label: 'Account', icon: '👤' },
    { id: 'appearance', label: 'Appearance', icon: '🎨' },
    { id: 'workspace', label: 'Workspace', icon: '🗂' },
    { id: 'members', label: 'Members', icon: '👥' },
    // Storage housekeeping is an admin job, so the section is hidden otherwise.
    ...(canManageWorkspace ? [{ id: 'uploads' as const, label: 'Uploads', icon: '📎' }] : []),
  ];

  return (
    <Modal
      title="Settings"
      onClose={props.onClose}
      wide
      footer={
        <Button variant="subtle" className="text-xs" onClick={props.onClose}>
          Done
        </Button>
      }
    >
      <div className="flex gap-4">
        <nav className="w-36 shrink-0 space-y-0.5">
          {nav.map((item) => (
            <button
              key={item.id}
              onClick={() => onSectionChange(item.id)}
              className={cx(
                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                section === item.id
                  ? 'bg-[var(--color-accent-soft)] font-medium text-[var(--color-accent)]'
                  : 'hover:bg-[var(--color-surface)]',
              )}
            >
              <span className="text-xs">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>

        <div className="scroll-thin max-h-[60vh] min-w-0 flex-1 overflow-y-auto pr-1">
          {section === 'account' && <AccountSection user={props.user} />}
          {section === 'appearance' && (
            <AppearanceSection theme={props.theme} onThemeChange={props.onThemeChange} />
          )}
          {section === 'workspace' && (
            <WorkspaceSection
              workspace={workspace}
              canManage={canManageWorkspace}
              onDeleted={props.onWorkspaceDeleted}
            />
          )}
          {section === 'members' && (
            <MembersPanel workspaceId={workspace.id} myRole={workspace.role} />
          )}
          {section === 'uploads' &&
            (canManageWorkspace ? (
              <UploadsPanel workspaceId={workspace.id} onOpenDocument={props.onOpenDocument} />
            ) : (
              <p className="text-xs text-[var(--color-muted)]">
                Only an owner or admin can manage uploads.
              </p>
            ))}
        </div>
      </div>
    </Modal>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="mb-5">
      <h3 className="text-sm font-semibold">{title}</h3>
      {hint && <p className="mb-2 mt-0.5 text-xs text-[var(--color-muted)]">{hint}</p>}
      <div className={hint ? '' : 'mt-2'}>{children}</div>
    </section>
  );
}

function AccountSection({ user }: { user: User }) {
  const updateProfile = useUpdateProfile();
  const changePassword = useChangePassword();
  const toast = useToast();

  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');

  const profileDirty = name.trim() !== user.name || email.trim() !== user.email;

  function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    updateProfile.mutate(
      { name: name.trim(), email: email.trim() },
      {
        onSuccess: () => toast('Profile updated'),
        onError: (err) => toast(err instanceof Error ? err.message : 'Could not save profile', 'error'),
      },
    );
  }

  function savePassword(e: React.FormEvent) {
    e.preventDefault();
    changePassword.mutate(
      { currentPassword, newPassword },
      {
        onSuccess: () => {
          setCurrentPassword('');
          setNewPassword('');
          toast('Password changed. Other sessions were signed out.');
        },
        onError: (err) =>
          toast(err instanceof Error ? err.message : 'Could not change password', 'error'),
      },
    );
  }

  return (
    <>
      <Section title="Profile">
        <form onSubmit={saveProfile} className="space-y-2">
          <label className="block">
            <span className="mb-1 block text-xs text-[var(--color-muted)]">Name</span>
            <input className={FIELD} value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-[var(--color-muted)]">Email</span>
            <input
              className={FIELD}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </label>
          <Button
            variant="primary"
            type="submit"
            className="text-xs"
            disabled={!profileDirty || updateProfile.isPending}
          >
            {updateProfile.isPending ? 'Saving…' : 'Save profile'}
          </Button>
        </form>
      </Section>

      <Section title="Password" hint="Changing your password signs out your other sessions.">
        <form onSubmit={savePassword} className="space-y-2">
          <label className="block">
            <span className="mb-1 block text-xs text-[var(--color-muted)]">Current password</span>
            <input
              className={FIELD}
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-[var(--color-muted)]">New password</span>
            <input
              className={FIELD}
              type="password"
              autoComplete="new-password"
              minLength={10}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
            <span className="mt-1 block text-xs text-[var(--color-muted)]">At least 10 characters.</span>
          </label>
          <Button
            variant="primary"
            type="submit"
            className="text-xs"
            disabled={newPassword.length < 10 || changePassword.isPending}
          >
            {changePassword.isPending ? 'Changing…' : 'Change password'}
          </Button>
        </form>
      </Section>
    </>
  );
}

const THEMES: { id: Theme; label: string; hint: string; icon: string }[] = [
  { id: 'light', label: 'Light', hint: 'Always light', icon: '☀️' },
  { id: 'dark', label: 'Dark', hint: 'Always dark', icon: '🌙' },
  { id: 'system', label: 'System', hint: 'Follow your OS setting', icon: '🖥️' },
];

function AppearanceSection({ theme, onThemeChange }: { theme: Theme; onThemeChange: (t: Theme) => void }) {
  return (
    <Section title="Theme" hint="Applies to this browser only.">
      <div className="grid grid-cols-3 gap-2">
        {THEMES.map((option) => (
          <button
            key={option.id}
            onClick={() => onThemeChange(option.id)}
            className={cx(
              'rounded-lg border px-2 py-3 text-center transition-colors',
              theme === option.id
                ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]'
                : 'border-[var(--color-line)] hover:bg-[var(--color-surface)]',
            )}
          >
            <div className="text-lg">{option.icon}</div>
            <div className="mt-1 text-xs font-medium">{option.label}</div>
            <div className="text-[10px] text-[var(--color-muted)]">{option.hint}</div>
          </button>
        ))}
      </div>
    </Section>
  );
}

function WorkspaceSection({
  workspace,
  canManage,
  onDeleted,
}: {
  workspace: WorkspaceSummary;
  canManage: boolean;
  onDeleted: () => void;
}) {
  const updateWorkspace = useUpdateWorkspace(workspace.id);
  const deleteWorkspace = useDeleteWorkspace();
  const toast = useToast();

  const [name, setName] = useState(workspace.name);
  const [icon, setIcon] = useState(workspace.icon ?? '');
  const [confirming, setConfirming] = useState(false);

  const dirty = name.trim() !== workspace.name || icon.trim() !== (workspace.icon ?? '');

  function save(e: React.FormEvent) {
    e.preventDefault();
    updateWorkspace.mutate(
      { name: name.trim(), icon: icon.trim() || null },
      {
        onSuccess: () => toast('Workspace updated'),
        onError: (err) =>
          toast(err instanceof Error ? err.message : 'Could not update workspace', 'error'),
      },
    );
  }

  return (
    <>
      <Section
        title="Workspace"
        hint={canManage ? undefined : 'Only an owner or admin can change these.'}
      >
        <div className="mb-3 flex items-center gap-2">
          <WorkspaceIcon name={name || workspace.name} icon={icon.trim() || null} size="lg" />
          <span className="text-xs text-[var(--color-muted)]">Preview</span>
        </div>
        <form onSubmit={save} className="space-y-2">
          <div className="flex gap-2">
            <label className="block w-16">
              <span className="mb-1 block text-xs text-[var(--color-muted)]">Icon</span>
              <input
                className={cx(FIELD, 'text-center')}
                value={icon}
                maxLength={2}
                disabled={!canManage}
                onChange={(e) => setIcon(e.target.value)}
                placeholder="—"
                aria-label="Workspace icon (optional)"
              />
            </label>
            <label className="block min-w-0 flex-1">
              <span className="mb-1 block text-xs text-[var(--color-muted)]">Name</span>
              <input
                className={FIELD}
                value={name}
                disabled={!canManage}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </label>
          </div>
          <p className="text-xs text-[var(--color-muted)]">
            The icon is optional. Clear it to show a letter from the workspace name instead.
          </p>
          {canManage && (
            <div className="flex items-center gap-2">
              <Button
                variant="primary"
                type="submit"
                className="text-xs"
                disabled={!dirty || updateWorkspace.isPending}
              >
                {updateWorkspace.isPending ? 'Saving…' : 'Save workspace'}
              </Button>
              {icon.trim() && (
                <Button variant="ghost" type="button" className="text-xs" onClick={() => setIcon('')}>
                  Remove icon
                </Button>
              )}
            </div>
          )}
        </form>
      </Section>

      <Section title="Details">
        <dl className="space-y-1 text-xs">
          <Row label="Your role" value={workspace.role} />
          <Row label="Documents" value={String(workspace.documentCount)} />
          <Row label="Members" value={String(workspace.memberCount)} />
          <Row label="Slug" value={workspace.slug} />
        </dl>
      </Section>

      {/* Deleting is owner-only, and the API refuses your last workspace. */}
      {workspace.role === 'owner' && (
        <Section title="Danger zone" hint="Deleting a workspace removes its documents for everyone in it.">
          <Button variant="danger" className="text-xs" onClick={() => setConfirming(true)}>
            Delete this workspace
          </Button>
        </Section>
      )}

      {confirming && (
        <ConfirmDialog
          title={`Delete "${workspace.name}"?`}
          description={`This permanently removes ${workspace.documentCount} document(s), every folder and tag, and revokes access for all ${workspace.memberCount} member(s). It cannot be undone.`}
          confirmLabel="Delete workspace"
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            deleteWorkspace.mutate(workspace.id, {
              onSuccess: () => {
                toast(`Deleted "${workspace.name}"`);
                onDeleted();
              },
              onError: (err) =>
                toast(err instanceof Error ? err.message : 'Could not delete workspace', 'error'),
            });
          }}
        />
      )}
    </>
  );
}

const Row = ({ label, value }: { label: string; value: string }) => (
  <div className="flex justify-between gap-2">
    <dt className="text-[var(--color-muted)]">{label}</dt>
    <dd className="truncate">{value}</dd>
  </div>
);
