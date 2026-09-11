import { useState } from 'react';
import type { User } from '@paradocs/shared';
import {
  useChangePassword,
  useDeleteWorkspace,
  useSetAvatar,
  useSetWorkspaceAvatar,
  useUpdateProfile,
  useUpdateWorkspace,
  useVoiceConfig,
  type WorkspaceSummary,
} from '../api/hooks';
import { squareImage } from '../lib/images';
import { cx } from '../lib/util';
import Avatar from './Avatar';
import { ConfirmDialog, Modal } from './Modal';
import { FIELD, PictureField, Section } from './SettingsParts';
import { useToast } from './Toast';
import { Button } from './ui';
import Icon, { type IconName } from './Icon';
import MembersPanel from './MembersPanel';
import UploadsPanel from './UploadsPanel';
import VoiceSettings from './VoiceSettings';
import { desktop } from '../lib/desktop';
import type { Theme } from '../lib/theme';
import { useCallLayout, type CallLayout } from '../lib/callLayout';
import { ServersSection, UpdatesSection } from './DesktopSettings';
import WorkspaceIcon from './WorkspaceIcon';

export const SETTINGS_SECTIONS = [
  'account',
  'appearance',
  'voice',
  'workspace',
  'members',
  'uploads',
  'servers',
  'updates',
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export function isSettingsSection(value: string): value is SettingsSection {
  return (SETTINGS_SECTIONS as readonly string[]).includes(value);
}
export type { Theme } from '../lib/theme';

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

export default function SettingsDialog(props: Props) {
  const { section, onSectionChange, workspace } = props;
  const canManageWorkspace = workspace.role === 'owner' || workspace.role === 'admin';
  // Device settings are only worth showing on a server that can hold a call.
  const voiceEnabled = useVoiceConfig().data?.enabled ?? false;

  const nav: { id: SettingsSection; label: string; icon: IconName }[] = [
    { id: 'account', label: 'Account', icon: 'person' },
    { id: 'appearance', label: 'Appearance', icon: 'palette' },
    ...(voiceEnabled ? [{ id: 'voice' as const, label: 'Voice & video', icon: 'headset' as const }] : []),
    { id: 'workspace', label: 'Workspace', icon: 'briefcase' },
    { id: 'members', label: 'Members', icon: 'people' },
    // Storage housekeeping is an admin job, so the section is hidden otherwise.
    ...(canManageWorkspace ? [{ id: 'uploads' as const, label: 'Uploads', icon: 'paperclip' as const }] : []),
    // The desktop app's own settings, which mean nothing in a browser.
    ...(desktop
      ? [
          { id: 'servers' as const, label: 'Servers', icon: 'hdd-network' as const },
          { id: 'updates' as const, label: 'Updates', icon: 'arrow-repeat' as const },
        ]
      : []),
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
              <Icon name={item.icon} className="text-xs" />
              {item.label}
            </button>
          ))}
        </nav>

        <div className="scroll-thin max-h-[60vh] min-w-0 flex-1 overflow-y-auto pr-1">
          {section === 'account' && <AccountSection user={props.user} />}
          {section === 'appearance' && (
            <AppearanceSection
              theme={props.theme}
              onThemeChange={props.onThemeChange}
              showCallLayout={voiceEnabled}
            />
          )}
          {section === 'voice' && <VoiceSettings />}
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
          {desktop && section === 'servers' && <ServersSection />}
          {desktop && section === 'updates' && <UpdatesSection />}
        </div>
      </div>
    </Modal>
  );
}

function AccountSection({ user }: { user: User }) {
  const updateProfile = useUpdateProfile();
  const changePassword = useChangePassword();
  const setAvatar = useSetAvatar();
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

  async function savePicture(file: File | null) {
    try {
      // Cropped and scaled here, so a large photo uploads as a small square.
      await setAvatar.mutateAsync(file ? await squareImage(file) : null);
      toast(file ? 'Picture updated' : 'Picture removed');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not update your picture', 'error');
    }
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
      <Section title="Picture" hint="Shown beside your name in chat, comments, calls and the member list.">
        <PictureField
          preview={<Avatar name={user.name} url={user.avatarUrl} seed={user.id} size="xl" />}
          hasPicture={Boolean(user.avatarUrl)}
          pending={setAvatar.isPending}
          onPick={(file) => void savePicture(file)}
          onRemove={() => void savePicture(null)}
        />
      </Section>

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

const THEMES: { id: Theme; label: string; hint: string; icon: IconName }[] = [
  { id: 'light', label: 'Light', hint: 'Always light', icon: 'sun' },
  { id: 'dark', label: 'Dark', hint: 'Always dark', icon: 'moon-stars' },
  { id: 'system', label: 'System', hint: 'Follow your OS setting', icon: 'display' },
];

const CALL_LAYOUTS: { id: CallLayout; label: string; hint: string }[] = [
  { id: 'side', label: 'Beside', hint: 'Other videos in a column' },
  { id: 'bottom', label: 'Below', hint: 'Other videos in a row' },
];

function OptionCard({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={selected}
      className={cx(
        'rounded-lg border px-2 py-3 text-center transition-colors',
        selected
          ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]'
          : 'border-[var(--color-line)] hover:bg-[var(--color-surface)]',
      )}
    >
      {children}
    </button>
  );
}

/** A small picture of the layout: the focused video, and where the others go. */
function CallLayoutDiagram({ layout }: { layout: CallLayout }) {
  const side = layout === 'side';
  return (
    <div
      aria-hidden
      className={cx(
        'mx-auto flex h-12 w-20 gap-1 rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] p-1',
        side ? 'flex-row' : 'flex-col',
      )}
    >
      <div className="flex-1 rounded-sm bg-[var(--color-accent)] opacity-70" />
      <div className={cx('flex gap-1', side ? 'w-4 flex-col' : 'h-2.5 flex-row')}>
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex-1 rounded-sm bg-[var(--color-muted)] opacity-40" />
        ))}
      </div>
    </div>
  );
}

function AppearanceSection({
  theme,
  onThemeChange,
  showCallLayout,
}: {
  theme: Theme;
  onThemeChange: (t: Theme) => void;
  /** Only where the server can hold a call. */
  showCallLayout: boolean;
}) {
  const [callLayout, setCallLayout] = useCallLayout();
  const scope = desktop ? 'Applies on every server in this app.' : 'Applies to this browser only.';

  return (
    <>
      <Section title="Theme" hint={scope}>
        <div className="grid grid-cols-3 gap-2">
          {THEMES.map((option) => (
            <OptionCard key={option.id} selected={theme === option.id} onClick={() => onThemeChange(option.id)}>
              <div className="text-lg">
                <Icon name={option.icon} />
              </div>
              <div className="mt-1 text-xs font-medium">{option.label}</div>
              <div className="text-[10px] text-[var(--color-muted)]">{option.hint}</div>
            </OptionCard>
          ))}
        </div>
      </Section>

      {showCallLayout && (
        <Section
          title="Focused video in calls"
          hint={`Click a camera or shared screen in a call to make it large; the other videos move aside. ${scope}`}
        >
          <div className="grid grid-cols-2 gap-2">
            {CALL_LAYOUTS.map((option) => (
              <OptionCard key={option.id} selected={callLayout === option.id} onClick={() => setCallLayout(option.id)}>
                <CallLayoutDiagram layout={option.id} />
                <div className="mt-2 text-xs font-medium">{option.label}</div>
                <div className="text-[10px] text-[var(--color-muted)]">{option.hint}</div>
              </OptionCard>
            ))}
          </div>
        </Section>
      )}
    </>
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
  const setPicture = useSetWorkspaceAvatar(workspace.id);
  const toast = useToast();

  const [name, setName] = useState(workspace.name);
  const [icon, setIcon] = useState(workspace.icon ?? '');
  const [confirming, setConfirming] = useState(false);

  const dirty = name.trim() !== workspace.name || icon.trim() !== (workspace.icon ?? '');

  async function savePicture(file: File | null) {
    try {
      await setPicture.mutateAsync(file ? await squareImage(file) : null);
      toast(file ? 'Workspace picture updated' : 'Workspace picture removed');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not update the workspace picture', 'error');
    }
  }

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
        <div className="mb-3">
          <PictureField
            preview={
              <WorkspaceIcon
                name={name || workspace.name}
                icon={icon.trim() || null}
                avatarUrl={workspace.avatarUrl}
                size="lg"
              />
            }
            hasPicture={Boolean(workspace.avatarUrl)}
            pending={setPicture.isPending}
            disabled={!canManage}
            onPick={(file) => void savePicture(file)}
            onRemove={() => void savePicture(null)}
          />
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
            A picture takes the place of the icon. With neither, a letter from the workspace name is shown.
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
