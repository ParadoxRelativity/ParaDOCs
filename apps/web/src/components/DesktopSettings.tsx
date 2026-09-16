import { useState } from 'react';
import {
  requireDesktop,
  useDesktopConnections,
  useDesktopUpdates,
  type DesktopConnection,
  type UpdateStatus,
} from '../lib/desktop';
import { cx, formatRelative } from '../lib/util';
import ConnectServerDialog from './ConnectServerDialog';
import Icon, { type IconName } from './Icon';
import { ConfirmDialog } from './Modal';
import { FIELD, Section } from './SettingsParts';
import { useToast } from './Toast';
import { Button, IconButton, InlineInput, Spinner } from './ui';

/** The places the desktop app can open: the workspace on this computer, and servers. */
export function ServersSection() {
  const connections = useDesktopConnections();
  const toast = useToast();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [removing, setRemoving] = useState<DesktopConnection | null>(null);
  const [connecting, setConnecting] = useState(false);

  async function rename(id: string, label: string) {
    setRenaming(null);
    const result = await requireDesktop().connections.rename(id, label);
    if (!result.ok) toast(result.error, 'error');
  }

  async function remove(connection: DesktopConnection) {
    setRemoving(null);
    const result = await requireDesktop().connections.remove(connection.id);
    if (result.ok) toast(`Removed ${connection.label}`);
    else toast(result.error, 'error');
  }

  async function open(id: string) {
    const result = await requireDesktop().connections.open(id);
    if (!result.ok) toast(result.error, 'error');
  }

  return (
    <>
      <Section title="Servers">
        <ul className="space-y-1">
          {connections.map((connection) => (
            <li
              key={connection.id}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-[var(--color-surface)]"
            >
              <Icon
                name={connection.kind === 'local' ? 'laptop' : 'globe2'}
                className="text-[var(--color-muted)]"
              />
              <div className="min-w-0 flex-1">
                {renaming === connection.id ? (
                  <InlineInput
                    defaultValue={connection.label}
                    onCommit={(label) => void rename(connection.id, label)}
                    onCancel={() => setRenaming(null)}
                    className={FIELD}
                  />
                ) : (
                  <p className="truncate text-sm">
                    {connection.label}
                    {connection.active && <span className="text-xs text-[var(--color-muted)]"> · Open now</span>}
                  </p>
                )}
                <p className="truncate text-[11px] text-[var(--color-muted)]">
                  {connection.kind === 'local' ? 'Documents stay on this computer' : connection.url}
                </p>
              </div>
              {!connection.active && (
                <Button variant="ghost" className="text-xs" onClick={() => void open(connection.id)}>
                  Open
                </Button>
              )}
              <IconButton label={`Rename ${connection.label}`} onClick={() => setRenaming(connection.id)}>
                <Icon name="pencil" />
              </IconButton>
              {/* The app always needs somewhere to open. */}
              {connections.length > 1 && (
                <IconButton label={`Remove ${connection.label}`} onClick={() => setRemoving(connection)}>
                  <Icon name="trash3" />
                </IconButton>
              )}
            </li>
          ))}
        </ul>
        <Button variant="subtle" className="mt-3 text-xs" onClick={() => setConnecting(true)}>
          <Icon name="plus-lg" /> Connect to a server
        </Button>
      </Section>

      {removing && (
        <ConfirmDialog
          title={`Remove ${removing.label}?`}
          description={
            removing.kind === 'local'
              ? 'Its documents stay on this computer.'
              : 'This app is signed out of it. Nothing on the server is deleted.'
          }
          confirmLabel="Remove"
          onConfirm={() => void remove(removing)}
          onCancel={() => setRemoving(null)}
        />
      )}
      {connecting && <ConnectServerDialog onClose={() => setConnecting(false)} />}
    </>
  );
}

function describeUpdate(status: UpdateStatus): { icon: IconName; tone: string; headline: string; detail?: string } {
  const muted = 'text-[var(--color-muted)]';
  switch (status.phase) {
    case 'unsupported':
      return { icon: 'info-circle', tone: muted, headline: 'Updates are not available for this build', detail: status.reason };
    case 'checking':
      return { icon: 'arrow-repeat', tone: muted, headline: 'Checking for updates…' };
    case 'available':
      return {
        icon: 'cloud-arrow-down',
        tone: 'text-[var(--color-accent)]',
        headline: `ParaDOCs ${status.newVersion} is available`,
        detail: status.releaseDate ? `Released ${new Date(status.releaseDate).toLocaleDateString()}.` : undefined,
      };
    case 'downloading':
      return {
        icon: 'cloud-arrow-down',
        tone: 'text-[var(--color-accent)]',
        headline: status.newVersion ? `Downloading ParaDOCs ${status.newVersion}` : 'Downloading the update',
        detail: `${status.percent ?? 0}%`,
      };
    case 'downloaded':
      return {
        icon: 'check-circle',
        tone: 'text-emerald-500',
        headline: `ParaDOCs ${status.newVersion} is ready to install`,
        detail: 'It installs when you quit, or restart now to use it straight away.',
      };
    case 'error':
      return { icon: 'exclamation-triangle', tone: 'text-red-500', headline: 'Could not check for updates', detail: status.message };
    default:
      return status.checkedAt
        ? {
            icon: 'check-circle',
            tone: 'text-emerald-500',
            headline: 'ParaDOCs is up to date',
            detail: `Checked ${formatRelative(status.checkedAt)}.`,
          }
        : {
            icon: 'arrow-repeat',
            tone: muted,
            headline: 'Not checked yet',
            detail: status.checkOnLaunch ? 'The app checks shortly after it starts.' : 'Automatic checks are off.',
          };
  }
}

/** The installed version, what the release channel has, and when it was last asked. */
export function UpdatesSection() {
  const status = useDesktopUpdates();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  if (!status) return <Spinner />;

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Something went wrong', 'error');
    } finally {
      setBusy(false);
    }
  }

  const updates = requireDesktop().updates;
  const summary = describeUpdate(status);
  const unsupported = status.phase === 'unsupported';
  const working = busy || status.phase === 'checking' || status.phase === 'downloading';

  return (
    <>
      <Section title="Updates" hint={`This is ParaDOCs ${status.currentVersion}.`}>
        <div className="flex items-start gap-3 rounded-lg border border-[var(--color-line)] p-3">
          <Icon name={summary.icon} className={cx('mt-0.5 text-lg', summary.tone)} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{summary.headline}</p>
            {summary.detail && <p className="mt-0.5 text-xs text-[var(--color-muted)]">{summary.detail}</p>}
            {status.phase === 'downloading' && (
              <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={status.percent ?? 0}
                className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--color-surface)]"
              >
                <div
                  className="h-full rounded-full bg-[var(--color-accent)]"
                  style={{ width: `${status.percent ?? 0}%` }}
                />
              </div>
            )}
          </div>
          {status.phase === 'available' && (
            <Button
              variant="primary"
              className="shrink-0 text-xs"
              disabled={busy}
              onClick={() => void run(() => updates.download())}
            >
              Download
            </Button>
          )}
          {status.phase === 'downloaded' && (
            <Button variant="primary" className="shrink-0 text-xs" onClick={() => void run(() => updates.install())}>
              Restart to update
            </Button>
          )}
        </div>
        {!unsupported && (
          <Button
            variant="subtle"
            className="mt-3 text-xs"
            disabled={working || status.phase === 'downloaded'}
            onClick={() => void run(() => updates.check())}
          >
            <Icon name="arrow-clockwise" /> {status.phase === 'checking' ? 'Checking…' : 'Check for updates'}
          </Button>
        )}
      </Section>

      {!unsupported && (
        <Section title="Preferences">
          <div className="space-y-3">
            <Toggle
              label="Check for updates automatically"
              checked={status.checkOnLaunch}
              onChange={(on) => void run(() => updates.setCheckOnLaunch(on))}
            />
            <Toggle
              label="Download updates in the background"
              checked={status.autoDownload}
              onChange={(on) => void run(() => updates.setAutoDownload(on))}
            />
          </div>
        </Section>
      )}
    </>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-[var(--color-accent)]"
      />
      <span className="text-sm">{label}</span>
    </label>
  );
}
