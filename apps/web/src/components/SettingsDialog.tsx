import { useState } from 'react';
import type { User } from '@paradocs/shared';
import { useChangePassword, useSetAvatar, useUpdateProfile, useVoiceConfig } from '../api/hooks';
import { squareImage } from '../lib/images';
import { cx } from '../lib/util';
import Avatar from './Avatar';
import { Modal } from './Modal';
import { FIELD, PictureField, Section } from './SettingsParts';
import { AwayAfterSelect, StatusChoices, useStatusControls } from './Presence';
import { useToast } from './Toast';
import { Button } from './ui';
import Icon, { type IconName } from './Icon';
import VoiceSettings from './VoiceSettings';
import { desktop } from '../lib/desktop';
import type { Theme } from '../lib/theme';
import { useCallLayout, type CallLayout } from '../lib/callLayout';
import { useOpenBehaviour, type OpenBehaviour } from '../lib/openBehaviour';
import { ServersSection, UpdatesSection } from './DesktopSettings';

export const SETTINGS_SECTIONS = [
  'account',
  'appearance',
  'voice',
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
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  onClose: () => void;
}

/**
 * Your own settings: the account, how the app looks and sounds, and on the
 * desktop the servers and updates. What belongs to a workspace — its name,
 * apps, members and uploads — is in that workspace's Access app instead.
 */
export default function SettingsDialog(props: Props) {
  const { section, onSectionChange } = props;
  // Device settings are only worth showing on a server that can hold a call.
  const voiceEnabled = useVoiceConfig().data?.enabled ?? false;

  const nav: { id: SettingsSection; label: string; icon: IconName }[] = [
    { id: 'account', label: 'Account', icon: 'person' },
    { id: 'appearance', label: 'Appearance', icon: 'palette' },
    ...(voiceEnabled ? [{ id: 'voice' as const, label: 'Voice & video', icon: 'headset' as const }] : []),
    // The workspace's own settings are in the Access app, not here.
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
  // Changing the email address takes the password, as changing the password does.
  const [emailPassword, setEmailPassword] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');

  const emailChanged = email.trim() !== user.email;
  const profileDirty = name.trim() !== user.name || emailChanged;

  function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    updateProfile.mutate(
      { name: name.trim(), email: email.trim(), ...(emailChanged ? { currentPassword: emailPassword } : {}) },
      {
        onSuccess: () => {
          setEmailPassword('');
          toast('Profile updated');
        },
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
      <Section title="Picture">
        <PictureField
          preview={<Avatar name={user.name} url={user.avatarUrl} seed={user.id} size="xl" />}
          hasPicture={Boolean(user.avatarUrl)}
          pending={setAvatar.isPending}
          onPick={(file) => void savePicture(file)}
          onRemove={() => void savePicture(null)}
        />
      </Section>

      <StatusSection />

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
          {emailChanged && (
            <label className="block">
              <span className="mb-1 block text-xs text-[var(--color-muted)]">Current password</span>
              <input
                className={FIELD}
                type="password"
                autoComplete="current-password"
                value={emailPassword}
                onChange={(e) => setEmailPassword(e.target.value)}
                required
              />
            </label>
          )}
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

/** Your status, and how long you can be idle before you show as away. */
function StatusSection() {
  const { current, change } = useStatusControls();
  return (
    <Section title="Status">
      <StatusChoices value={current.status} onChange={(status) => change({ status })} />
      <label className="mt-3 flex items-center justify-between gap-3">
        <span className="text-xs">Show as away after</span>
        <AwayAfterSelect value={current.awayAfterMinutes} onChange={(minutes) => change({ awayAfterMinutes: minutes })} />
      </label>
    </Section>
  );
}

const THEMES: { id: Theme; label: string; icon: IconName }[] = [
  { id: 'light', label: 'Light', icon: 'sun' },
  { id: 'dark', label: 'Dark', icon: 'moon-stars' },
  { id: 'system', label: 'System', icon: 'display' },
];

const CALL_LAYOUTS: { id: CallLayout; label: string }[] = [
  { id: 'side', label: 'Beside' },
  { id: 'bottom', label: 'Below' },
];

const OPEN_BEHAVIOURS: { id: OpenBehaviour; label: string; icon: IconName }[] = [
  { id: 'here', label: 'In this tab', icon: 'box-arrow-in-right' },
  { id: 'tab', label: 'In a new tab', icon: 'window-plus' },
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
  const [openBehaviour, setOpenBehaviour] = useOpenBehaviour();
  return (
    <>
      <Section title="Theme">
        <div className="grid grid-cols-3 gap-2">
          {THEMES.map((option) => (
            <OptionCard key={option.id} selected={theme === option.id} onClick={() => onThemeChange(option.id)}>
              <div className="text-lg">
                <Icon name={option.icon} />
              </div>
              <div className="mt-1 text-xs font-medium">{option.label}</div>
            </OptionCard>
          ))}
        </div>
      </Section>

      <Section title="Opening a notification" hint={`Hold ${'\u2318'} or Ctrl to do the other one.`}>
        <div className="grid grid-cols-2 gap-2">
          {OPEN_BEHAVIOURS.map((option) => (
            <OptionCard
              key={option.id}
              selected={openBehaviour === option.id}
              onClick={() => setOpenBehaviour(option.id)}
            >
              <div className="text-lg">
                <Icon name={option.icon} />
              </div>
              <div className="mt-1 text-xs font-medium">{option.label}</div>
            </OptionCard>
          ))}
        </div>
      </Section>

      {showCallLayout && (
        <Section title="Focused video in calls">
          <div className="grid grid-cols-2 gap-2">
            {CALL_LAYOUTS.map((option) => (
              <OptionCard key={option.id} selected={callLayout === option.id} onClick={() => setCallLayout(option.id)}>
                <CallLayoutDiagram layout={option.id} />
                <div className="mt-2 text-xs font-medium">{option.label}</div>
              </OptionCard>
            ))}
          </div>
        </Section>
      )}
    </>
  );
}
