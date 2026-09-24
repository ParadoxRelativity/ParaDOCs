import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import {
  MAX_RETENTION_DAYS,
  type AdminOidcProvider,
  type AdminStatus,
  type AdminUser,
  type AdminVersionStatus,
  type OidcNewAccountMode,
  type ServerSettings,
} from '@paradocs/shared';
import { Button, Spinner } from '../components/ui';
import { ConfirmDialog, Modal } from '../components/Modal';
import { FIELD, Section } from '../components/SettingsParts';
import { useToast } from '../components/Toast';
import Icon, { type IconName } from '../components/Icon';
import { colorFromString, cx, formatDateTime, formatRelative, useDebounced } from '../lib/util';
import {
  useAdminLogin,
  useAdminLogout,
  useAdminSetup,
  useAdminStatus,
  useAdminUsers,
  useCheckForUpdate,
  useCreateOidcProvider,
  useCreateUser,
  useDeleteOidcProvider,
  useDeleteUser,
  useOidcProviders,
  useServerSettings,
  useSetUserPassword,
  useSignOutUser,
  useUpdateOidcProvider,
  useUpdateServerSettings,
  useUpdateUser,
  useVersionStatus,
} from './api';

/**
 * Server administration: settings for the whole server and every account on
 * it. Served only on the admin port, and signed in to separately from the app.
 */
export default function AdminApp() {
  const status = useAdminStatus();

  if (status.isLoading) return <Spinner />;
  if (!status.data) {
    return (
      <Centered>
        <p className="mb-3 text-sm text-[var(--color-muted)]">Could not reach the server.</p>
        <Button variant="subtle" onClick={() => void status.refetch()}>
          Try again
        </Button>
      </Centered>
    );
  }
  if (!status.data.user) return <SignIn setupRequired={status.data.setupRequired} />;
  return <Console user={status.data.user} />;
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center bg-[var(--color-surface)] p-6">{children}</div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-[var(--color-muted)]">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-[var(--color-muted)]">{hint}</span>}
    </label>
  );
}

function Switch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <label className={cx('flex items-center gap-3 text-sm', disabled ? 'opacity-60' : 'cursor-pointer')}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx(
          'relative h-5 w-9 shrink-0 rounded-full transition-colors',
          checked ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-line)]',
        )}
      >
        <span
          className={cx(
            'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-[left]',
            checked ? 'left-[18px]' : 'left-0.5',
          )}
        />
      </button>
      {label}
    </label>
  );
}

function Badge({ tone, children }: { tone: 'accent' | 'muted' | 'danger'; children: ReactNode }) {
  const tones = {
    accent: 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]',
    muted: 'border border-[var(--color-line)] text-[var(--color-muted)]',
    danger: 'bg-red-500/10 text-red-500',
  };
  return (
    <span className={cx('rounded-full px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide', tones[tone])}>
      {children}
    </span>
  );
}

function Initials({ user }: { user: AdminUser }) {
  const letters = user.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('');
  return (
    <span
      aria-hidden
      className={cx(
        'grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs font-semibold text-white',
        user.disabled && 'opacity-40',
      )}
      style={{ background: colorFromString(user.id) }}
    >
      {letters || '?'}
    </span>
  );
}

// --- sign in -------------------------------------------------------------------

function SignIn({ setupRequired }: { setupRequired: boolean }) {
  const [mode, setMode] = useState<'signin' | 'create'>('signin');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const login = useAdminLogin();
  const setup = useAdminSetup();

  const creating = setupRequired && mode === 'create';
  const active = creating ? setup : login;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (creating) setup.mutate({ name, email, password });
    else login.mutate({ email, password });
  }

  function switchMode() {
    login.reset();
    setup.reset();
    setMode(creating ? 'signin' : 'create');
  }

  return (
    <Centered>
      <div className="w-full max-w-sm rounded-xl border border-[var(--color-line)] bg-[var(--color-raised)] p-6 shadow-sm">
        <div className="mb-5">
          <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <Icon name="shield-lock" className="text-[var(--color-accent)]" /> Server administration
          </h1>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            {!setupRequired
              ? 'Sign in with a server administrator account.'
              : creating
                ? 'Create the first administrator account for this server.'
                : 'This server has no administrator yet. Sign in with an existing account to become the first.'}
          </p>
        </div>

        <form onSubmit={submit} className="space-y-3">
          {creating && (
            <Field label="Name">
              <input className={FIELD} value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" />
            </Field>
          )}
          <Field label="Email">
            <input
              className={FIELD}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="username"
            />
          </Field>
          <Field label="Password" hint={creating ? 'At least 10 characters.' : undefined}>
            <input
              className={FIELD}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={creating ? 10 : 1}
              autoComplete={creating ? 'new-password' : 'current-password'}
            />
          </Field>

          {active.error && <p className="text-sm text-red-500">{active.error.message}</p>}

          <Button variant="primary" className="w-full" type="submit" disabled={active.isPending}>
            {active.isPending ? 'Working…' : creating ? 'Create administrator' : 'Sign in'}
          </Button>
        </form>

        {setupRequired && (
          <button
            type="button"
            className="mt-4 w-full text-center text-xs text-[var(--color-muted)] hover:text-[var(--color-ink)]"
            onClick={switchMode}
          >
            {creating ? 'Have an account already? Sign in with it' : 'No account yet? Create an administrator'}
          </button>
        )}
      </div>
    </Centered>
  );
}

// --- console -------------------------------------------------------------------

type Tab = 'settings' | 'accounts' | 'sso';

const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: 'settings', label: 'Server settings', icon: 'sliders' },
  { id: 'accounts', label: 'Accounts', icon: 'people' },
  { id: 'sso', label: 'Single sign-on', icon: 'key' },
];

/** The open tab lives in the address, so a reload stays where it was. */
function useTab(): [Tab, (tab: Tab) => void] {
  const read = (): Tab => TABS.find((t) => `#${t.id}` === window.location.hash)?.id ?? 'settings';
  const [tab, setTab] = useState(read);
  useEffect(() => {
    const follow = () => setTab(read());
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, []);
  return [
    tab,
    (next) => {
      window.location.hash = next;
      setTab(next);
    },
  ];
}

function Console({ user }: { user: NonNullable<AdminStatus['user']> }) {
  const [tab, setTab] = useTab();
  const logout = useAdminLogout();

  return (
    <div className="flex h-full flex-col bg-[var(--color-surface)]">
      <header className="flex items-center gap-3 border-b border-[var(--color-line)] bg-[var(--color-raised)] px-4 py-2.5">
        <Icon name="shield-lock" className="text-[var(--color-accent)]" />
        <h1 className="text-sm font-semibold">ParaDOCs server administration</h1>
        <div className="ml-auto flex items-center gap-3">
          <span className="hidden truncate text-xs text-[var(--color-muted)] sm:inline">{user.email}</span>
          <Button variant="subtle" className="text-xs" disabled={logout.isPending} onClick={() => logout.mutate()}>
            <Icon name="box-arrow-right" /> Sign out
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <nav className="flex gap-1 border-b border-[var(--color-line)] p-2 sm:w-52 sm:flex-col sm:border-b-0 sm:border-r">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-current={tab === t.id ? 'page' : undefined}
              onClick={() => setTab(t.id)}
              className={cx(
                'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm',
                tab === t.id
                  ? 'bg-[var(--color-accent-soft)] font-medium text-[var(--color-accent)]'
                  : 'hover:bg-[var(--color-line)]',
              )}
            >
              <Icon name={t.icon} /> {t.label}
            </button>
          ))}
        </nav>
        <main className="scroll-thin min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
          <div className="mx-auto max-w-3xl">
            {tab === 'settings' && <SettingsPanel />}
            {tab === 'accounts' && <AccountsPanel selfId={user.id} />}
            {tab === 'sso' && <SsoPanel />}
          </div>
        </main>
      </div>
    </div>
  );
}

// --- settings ------------------------------------------------------------------

function SettingsPanel() {
  const settings = useServerSettings();
  if (settings.isLoading) return <Spinner />;
  if (!settings.data) return <p className="text-sm text-red-500">Could not load the server settings.</p>;
  return (
    <>
      <VersionCard />
      <SettingsForm current={settings.data} />
    </>
  );
}

const sentences = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(' ');

function describeVersion(status: AdminVersionStatus): { icon: IconName; tone: string; headline: string; detail?: string } {
  const muted = 'text-[var(--color-muted)]';
  const running = status.currentVersion ? `This server runs ParaDOCs ${status.currentVersion}.` : undefined;
  if (!status.checksEnabled) {
    return {
      icon: 'info-circle',
      tone: muted,
      headline: status.currentVersion ? `ParaDOCs ${status.currentVersion}` : 'Version unknown',
      detail: status.currentVersion
        ? 'Checking for new releases is off (UPDATE_CHECK=false).'
        : 'This server cannot tell which version it is, so it does not check for new releases.',
    };
  }
  if (status.updateAvailable && status.latest) {
    const released = status.latest.publishedAt ? `Released ${formatRelative(status.latest.publishedAt)}.` : undefined;
    return {
      icon: 'arrow-up-circle-fill',
      tone: 'text-[var(--color-accent)]',
      headline: `ParaDOCs ${status.latest.version} is available`,
      detail: sentences(running, released),
    };
  }
  if (status.error) {
    return { icon: 'exclamation-triangle', tone: 'text-amber-500', headline: 'Could not check for new releases', detail: status.error };
  }
  if (status.checkedAt) {
    return {
      icon: 'check-circle',
      tone: 'text-emerald-500',
      headline: 'This server is up to date',
      detail: sentences(running, `Checked ${formatRelative(status.checkedAt)}.`),
    };
  }
  return { icon: 'arrow-repeat', tone: muted, headline: 'Not checked yet', detail: sentences(running, 'The server checks shortly after it starts.') };
}

/** The version this server runs, and whether a newer release is out. */
function VersionCard() {
  const status = useVersionStatus();
  const check = useCheckForUpdate();
  const toast = useToast();
  if (!status.data) return null;

  const summary = describeVersion(status.data);
  const { latest, updateAvailable, checksEnabled } = status.data;

  return (
    <section className="mb-6">
      <h2 className="mb-3 text-lg font-semibold">Version</h2>
      <div className="flex items-start gap-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-raised)] p-4">
        <Icon name={summary.icon} className={cx('mt-0.5 text-lg', summary.tone)} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{summary.headline}</p>
          {summary.detail && <p className="mt-0.5 text-xs text-[var(--color-muted)]">{summary.detail}</p>}
          {updateAvailable && (
            <p className="mt-2 text-xs text-[var(--color-muted)]">
              With Docker Compose, back up, then run{' '}
              <code className="rounded bg-[var(--color-surface)] px-1 py-px">docker compose pull && docker compose up -d</code>.
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {latest && (
              <a
                href={latest.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-line)] px-2.5 py-1 text-xs hover:bg-[var(--color-surface)]"
              >
                <Icon name="box-arrow-up-right" /> Release notes
              </a>
            )}
            {checksEnabled && (
              <Button
                variant="subtle"
                className="text-xs"
                disabled={check.isPending}
                onClick={() => check.mutate(undefined, { onError: (err) => toast(err.message, 'error') })}
              >
                <Icon name="arrow-clockwise" /> {check.isPending ? 'Checking…' : 'Check now'}
              </Button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

const DEFAULT_RETENTION_DAYS = 365;

function SettingsForm({ current }: { current: ServerSettings }) {
  const update = useUpdateServerSettings();
  const toast = useToast();
  const [allowRegistration, setAllowRegistration] = useState(current.allowRegistration);
  const [passwordSignIn, setPasswordSignIn] = useState(current.passwordSignIn);
  const providers = useOidcProviders();
  const enabledProviders = providers.data?.providers.filter((p) => p.enabled) ?? [];
  const [limited, setLimited] = useState(current.messageRetentionMaxDays !== null);
  const [days, setDays] = useState(String(current.messageRetentionMaxDays ?? DEFAULT_RETENTION_DAYS));
  const [confirming, setConfirming] = useState(false);

  function reset() {
    setAllowRegistration(current.allowRegistration);
    setPasswordSignIn(current.passwordSignIn);
    setLimited(current.messageRetentionMaxDays !== null);
    setDays(String(current.messageRetentionMaxDays ?? DEFAULT_RETENTION_DAYS));
  }
  // What was saved becomes the new starting point.
  useEffect(reset, [current]);

  const parsedDays = Number(days);
  const daysValid = Number.isInteger(parsedDays) && parsedDays >= 1 && parsedDays <= MAX_RETENTION_DAYS;
  const retention = limited ? parsedDays : null;
  const dirty =
    allowRegistration !== current.allowRegistration ||
    passwordSignIn !== current.passwordSignIn ||
    retention !== current.messageRetentionMaxDays;
  const valid = !limited || daysValid;
  // Keeping messages for less time than before deletes history as soon as it is saved.
  const deletesHistory =
    retention !== null && (current.messageRetentionMaxDays === null || retention < current.messageRetentionMaxDays);

  function save() {
    setConfirming(false);
    update.mutate(
      { allowRegistration, passwordSignIn, messageRetentionMaxDays: retention },
      {
        onSuccess: () => toast('Server settings saved'),
        onError: (err) => toast(err.message, 'error'),
      },
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!dirty || !valid) return;
        if (deletesHistory) setConfirming(true);
        else save();
      }}
    >
      <h2 className="mb-6 text-lg font-semibold">Server settings</h2>

      <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-raised)] p-4">
        <Section
          title="Registration"
          hint="When off, create accounts under Accounts."
        >
          <Switch checked={allowRegistration} onChange={setAllowRegistration} label="Anyone can create an account" />
        </Section>

        <Section
          title="Sign-in"
          hint="Off leaves only single sign-on. This page always takes passwords, so you can turn it back on here."
        >
          <div className="space-y-2">
            <Switch
              checked={passwordSignIn}
              onChange={setPasswordSignIn}
              // Turning it off needs a provider; turning it back on never does.
              disabled={current.passwordSignIn && enabledProviders.length === 0}
              label="Allow signing in with email and password"
            />
            {current.passwordSignIn && enabledProviders.length === 0 && (
              <p className="text-xs text-[var(--color-muted)]">
                Add a provider under Single sign-on before turning this off.
              </p>
            )}
            {!passwordSignIn && current.passwordSignIn && providers.data && (
              <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
                People will sign in only with {enabledProviders.map((p) => p.name).join(' or ')}.{' '}
                {providers.data.unlinkedAccounts > 0 &&
                  `${providers.data.unlinkedAccounts} account${providers.data.unlinkedAccounts === 1 ? ' has' : 's have'} not signed in that way yet; ` +
                    'they are linked on their first single sign-on if the provider confirms the same email. '}
                The provider is checked when you save.
              </p>
            )}
          </div>
        </Section>

        <Section
          title="Message retention"
          hint="Direct messages are not affected."
        >
          <div className="space-y-2 text-sm">
            <label className="flex cursor-pointer items-center gap-2">
              <input type="radio" name="retention" checked={!limited} onChange={() => setLimited(false)} />
              Keep messages for as long as their channel exists
            </label>
            <label className="flex cursor-pointer flex-wrap items-center gap-2">
              <input type="radio" name="retention" checked={limited} onChange={() => setLimited(true)} />
              Delete messages older than
              {/* FIELD fills its container, so the container sets the width. */}
              <span className="w-24">
                <input
                  type="number"
                  min={1}
                  max={MAX_RETENTION_DAYS}
                  step={1}
                  value={days}
                  disabled={!limited}
                  aria-label="Days to keep messages"
                  onChange={(e) => {
                    setDays(e.target.value);
                    setLimited(true);
                  }}
                  className={FIELD}
                />
              </span>
              days
            </label>
            {limited && !daysValid && (
              <p className="text-xs text-red-500">Enter a whole number of days from 1 to {MAX_RETENTION_DAYS}.</p>
            )}
          </div>
        </Section>

        <div className="flex justify-end gap-2 border-t border-[var(--color-line)] pt-4">
          {dirty && (
            <Button variant="ghost" type="button" onClick={reset}>
              Discard changes
            </Button>
          )}
          <Button variant="primary" type="submit" disabled={!dirty || !valid || update.isPending}>
            {update.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </div>

      {confirming && retention !== null && (
        <ConfirmDialog
          title="Delete older messages?"
          description={`Messages in text channels older than ${retention} days, and the files shared in them, are permanently deleted as soon as you save, and from then on as they reach that age. This cannot be undone.`}
          confirmLabel="Save and delete"
          onConfirm={save}
          onCancel={() => setConfirming(false)}
        />
      )}
    </form>
  );
}

// --- accounts ------------------------------------------------------------------

function AccountsPanel({ selfId }: { selfId: string }) {
  const [search, setSearch] = useState('');
  const query = useDebounced(search.trim(), 250);
  const users = useAdminUsers(query);
  const [creating, setCreating] = useState(false);
  const [managingId, setManagingId] = useState<string | null>(null);
  // Looked up from the list each render, so the dialog shows changes as they land.
  const managing = users.data?.users.find((u) => u.id === managingId) ?? null;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="mr-auto">
          <h2 className="text-lg font-semibold">Accounts</h2>
          <p className="text-sm text-[var(--color-muted)]">
            Everyone with an account on this server{users.data && !query ? ` (${users.data.total})` : ''}.
          </p>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Icon name="person-plus" /> New account
        </Button>
      </div>

      <div className="relative mb-3">
        <Icon
          name="search"
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-[var(--color-muted)]"
        />
        <input
          className={cx(FIELD, 'pl-8')}
          placeholder="Search by name or email"
          aria-label="Search accounts"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {users.isLoading ? (
        <Spinner />
      ) : !users.data ? (
        <p className="text-sm text-red-500">Could not load accounts.</p>
      ) : users.data.users.length === 0 ? (
        <p className="py-8 text-center text-sm text-[var(--color-muted)]">No accounts match.</p>
      ) : (
        <ul className="divide-y divide-[var(--color-line)] overflow-hidden rounded-lg border border-[var(--color-line)] bg-[var(--color-raised)]">
          {users.data.users.map((u) => (
            <li key={u.id}>
              <button
                type="button"
                onClick={() => setManagingId(u.id)}
                className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-[var(--color-surface)]"
              >
                <Initials user={u} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                    <span className={cx('truncate', u.disabled && 'text-[var(--color-muted)]')}>{u.name}</span>
                    {u.id === selfId && <Badge tone="muted">You</Badge>}
                    {u.isServerAdmin && <Badge tone="accent">Admin</Badge>}
                    {u.disabled && <Badge tone="danger">Disabled</Badge>}
                  </div>
                  <div className="truncate text-xs text-[var(--color-muted)]">{u.email}</div>
                </div>
                <div className="hidden shrink-0 text-right text-xs text-[var(--color-muted)] sm:block">
                  <div>
                    {u.workspaceCount} workspace{u.workspaceCount === 1 ? '' : 's'}
                  </div>
                  <div>{u.lastSignInAt ? `Signed in ${formatRelative(u.lastSignInAt)}` : 'No active sessions'}</div>
                </div>
                <Icon name="chevron-right" className="text-xs text-[var(--color-muted)]" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {users.data && users.data.users.length < users.data.total && (
        <p className="mt-2 text-xs text-[var(--color-muted)]">
          Showing {users.data.users.length} of {users.data.total}. Search to find someone else.
        </p>
      )}

      {creating && <CreateAccountDialog onClose={() => setCreating(false)} />}
      {managing && (
        <ManageAccountDialog user={managing} self={managing.id === selfId} onClose={() => setManagingId(null)} />
      )}
    </div>
  );
}

function CreateAccountDialog({ onClose }: { onClose: () => void }) {
  const create = useCreateUser();
  const toast = useToast();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isServerAdmin, setIsServerAdmin] = useState(false);

  function submit(e: FormEvent) {
    e.preventDefault();
    create.mutate(
      { name, email, password, isServerAdmin },
      {
        onSuccess: (user) => {
          toast(`Created an account for ${user.name}`);
          onClose();
        },
      },
    );
  }

  return (
    <Modal
      title="New account"
      onClose={onClose}
      footer={
        <>
          <Button variant="subtle" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="create-account" disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create account'}
          </Button>
        </>
      }
    >
      <form id="create-account" onSubmit={submit} className="space-y-3">
        <Field label="Name">
          <input className={FIELD} value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} autoFocus />
        </Field>
        <Field label="Email">
          <input className={FIELD} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        <Field label="Password" hint="At least 10 characters.">
          <input
            className={FIELD}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={10}
            autoComplete="new-password"
          />
        </Field>
        <Switch checked={isServerAdmin} onChange={setIsServerAdmin} label="Server administrator" />
        {create.error && <p className="text-sm text-red-500">{create.error.message}</p>}
      </form>
    </Modal>
  );
}

function ManageAccountDialog({ user, self, onClose }: { user: AdminUser; self: boolean; onClose: () => void }) {
  const toast = useToast();
  const update = useUpdateUser();
  const setPassword = useSetUserPassword();
  const signOut = useSignOutUser();
  const remove = useDeleteUser();
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [password, setPasswordValue] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const fail = (err: Error) => toast(err.message, 'error');
  const nameChanged = name.trim() !== user.name;
  const emailChanged = email.trim() !== user.email;

  function saveProfile(e: FormEvent) {
    e.preventDefault();
    update.mutate(
      {
        id: user.id,
        input: { name: nameChanged ? name.trim() : undefined, email: emailChanged ? email.trim() : undefined },
      },
      { onSuccess: () => toast('Account updated'), onError: fail },
    );
  }

  function submitPassword(e: FormEvent) {
    e.preventDefault();
    setPassword.mutate(
      { id: user.id, password },
      {
        onSuccess: () => {
          setPasswordValue('');
          toast(`Password set. ${user.name} has been signed out of the app everywhere.`);
        },
        onError: fail,
      },
    );
  }

  return (
    <Modal
      wide
      title={user.name}
      description={user.email}
      // Escape belongs to the confirmation while it is open.
      onClose={confirmingDelete ? () => {} : onClose}
      footer={
        <Button variant="subtle" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="scroll-thin max-h-[65vh] overflow-y-auto pr-1">
        <p className="mb-4 text-xs text-[var(--color-muted)]">
          Created {formatDateTime(user.createdAt)} · member of {user.workspaceCount} workspace
          {user.workspaceCount === 1 ? '' : 's'} ·{' '}
          {user.lastSignInAt ? `last signed in ${formatRelative(user.lastSignInAt)}` : 'no active sessions'}
        </p>

        <Section title="Profile">
          <form onSubmit={saveProfile} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <Field label="Name">
              <input className={FIELD} value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
            </Field>
            <Field label="Email">
              <input className={FIELD} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </Field>
            <Button variant="primary" type="submit" disabled={!(nameChanged || emailChanged) || update.isPending}>
              Save
            </Button>
          </form>
        </Section>

        <Section title="Access">
          <div className="space-y-3">
            <div>
              <Switch
                checked={user.isServerAdmin}
                disabled={self || update.isPending}
                onChange={(isServerAdmin) => update.mutate({ id: user.id, input: { isServerAdmin } }, { onError: fail })}
                label="Server administrator"
              />
              <p className="ml-12 mt-1 text-xs text-[var(--color-muted)]">
                {self
                  ? 'You cannot remove your own administrator access. Another administrator can.'
                  : 'Can sign in to this page and change everything on it. Grants nothing inside workspaces.'}
              </p>
            </div>
            <div>
              <Switch
                checked={user.disabled}
                disabled={self || update.isPending}
                onChange={(disabled) => update.mutate({ id: user.id, input: { disabled } }, { onError: fail })}
                label="Account disabled"
              />
              <p className="ml-12 mt-1 text-xs text-[var(--color-muted)]">
                {self
                  ? 'You cannot disable your own account.'
                  : 'Cannot sign in, and is signed out everywhere at once. Everything the account made stays.'}
              </p>
            </div>
          </div>
        </Section>

        <Section title="Password" hint="Setting a new password signs the account out of the app everywhere.">
          <form onSubmit={submitPassword} className="flex flex-wrap gap-2">
            <input
              className={cx(FIELD, 'min-w-0 flex-1')}
              type="password"
              value={password}
              onChange={(e) => setPasswordValue(e.target.value)}
              placeholder="New password, at least 10 characters"
              aria-label="New password"
              minLength={10}
              required
              autoComplete="new-password"
            />
            <Button variant="subtle" type="submit" disabled={password.length < 10 || setPassword.isPending}>
              Set password
            </Button>
          </form>
        </Section>

        <Section title="Sessions">
          <Button
            variant="subtle"
            disabled={signOut.isPending}
            onClick={() =>
              signOut.mutate(user.id, {
                onSuccess: () => toast(`${user.name} has been signed out everywhere`),
                onError: fail,
              })
            }
          >
            <Icon name="box-arrow-right" /> Sign out everywhere
          </Button>
        </Section>

        {!self && (
          <Section
            title="Delete account"
            hint="Accounts whose workspaces others use can't be deleted; disable them instead."
          >
            <Button variant="danger" disabled={remove.isPending} onClick={() => setConfirmingDelete(true)}>
              <Icon name="trash" /> Delete account
            </Button>
          </Section>
        )}
      </div>

      {confirmingDelete && (
        <ConfirmDialog
          title={`Delete ${user.name}?`}
          description="The account, and every workspace it created with the documents and files in it, are permanently deleted. This cannot be undone."
          confirmLabel="Delete account"
          onConfirm={() => {
            setConfirmingDelete(false);
            remove.mutate(user.id, {
              onSuccess: () => {
                toast(`Deleted ${user.name}`);
                onClose();
              },
              onError: fail,
            });
          }}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}
    </Modal>
  );
}

// --- single sign-on ------------------------------------------------------------

const NEW_ACCOUNT_CHOICES: { mode: OidcNewAccountMode; label: string; hint: string }[] = [
  {
    mode: 'registration',
    label: 'Follow the registration setting',
    hint: 'Anyone the provider signs in gets an account while registration is open.',
  },
  {
    mode: 'always',
    label: 'Always, even with registration closed',
    hint: 'The provider decides who gets in. Suits your own identity provider; limit domains for a public one.',
  },
  { mode: 'never', label: 'Never', hint: 'Only people who already have an account here can sign in with it.' },
];

function CopyValue({ value }: { value: string }) {
  const toast = useToast();
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <code className="truncate rounded bg-[var(--color-surface)] px-1.5 py-0.5 text-xs">{value}</code>
      <button
        type="button"
        title="Copy"
        aria-label="Copy"
        className="shrink-0 text-xs text-[var(--color-muted)] hover:text-[var(--color-ink)]"
        onClick={(e) => {
          e.stopPropagation();
          void navigator.clipboard.writeText(value).then(() => toast('Copied'));
        }}
      >
        <Icon name="clipboard" />
      </button>
    </span>
  );
}

function SsoPanel() {
  const providers = useOidcProviders();
  const [editing, setEditing] = useState<AdminOidcProvider | 'new' | null>(null);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="mr-auto">
          <h2 className="text-lg font-semibold">Single sign-on</h2>
          <p className="text-sm text-[var(--color-muted)]">
            OpenID Connect providers people can sign in with, alongside email and password.
          </p>
        </div>
        <Button variant="primary" onClick={() => setEditing('new')}>
          <Icon name="plus-lg" /> Add provider
        </Button>
      </div>

      {providers.data && !providers.data.publicUrlSet && (
        <p className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
          PUBLIC_URL is not set, so the redirect addresses below are a guess. Set it to the address people use to
          reach ParaDOCs, such as https://docs.example.com, and restart.
        </p>
      )}

      {providers.isLoading ? (
        <Spinner />
      ) : !providers.data ? (
        <p className="text-sm text-red-500">Could not load providers.</p>
      ) : providers.data.providers.length === 0 ? (
        <p className="rounded-lg border border-dashed border-[var(--color-line)] py-8 text-center text-sm text-[var(--color-muted)]">
          No providers yet. Sign-in is email and password only.
        </p>
      ) : (
        <ul className="divide-y divide-[var(--color-line)] overflow-hidden rounded-lg border border-[var(--color-line)] bg-[var(--color-raised)]">
          {providers.data.providers.map((p) => (
            <li key={p.slug}>
              <button
                type="button"
                disabled={p.fromEnvironment}
                onClick={() => setEditing(p)}
                className="flex w-full items-center gap-3 px-3 py-2.5 text-left enabled:hover:bg-[var(--color-surface)]"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                    <span className={cx('truncate', !p.enabled && 'text-[var(--color-muted)]')}>{p.name}</span>
                    <Badge tone="muted">{p.slug}</Badge>
                    {p.fromEnvironment && <Badge tone="accent">Environment</Badge>}
                    {p.trustEmails && <Badge tone="muted">Trusted emails</Badge>}
                    {!p.enabled && <Badge tone="danger">Off</Badge>}
                  </div>
                  <div className="truncate text-xs text-[var(--color-muted)]">{p.issuer}</div>
                  <div className="flex items-center gap-1.5 text-xs text-[var(--color-muted)]">
                    Redirect URI <CopyValue value={p.redirectUri} />
                  </div>
                  {p.fromEnvironment && (
                    <div className="text-xs text-[var(--color-muted)]">
                      {p.enabled
                        ? 'Set by the OIDC_* settings; change it there.'
                        : 'Set by the OIDC_* settings, and off until OIDC_ENABLED=true is set there.'}
                    </div>
                  )}
                </div>
                {!p.fromEnvironment && <Icon name="chevron-right" className="text-xs text-[var(--color-muted)]" />}
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-4 text-xs text-[var(--color-muted)]">
        Someone signing in for the first time is matched to an existing account by email, but only when the provider
        says the address is verified, or you trust its emails. Otherwise a new account is made, if the provider allows
        it.
      </p>

      {editing && providers.data && (
        <ProviderDialog
          provider={editing === 'new' ? null : editing}
          redirectBase={providers.data.redirectBase}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function ProviderDialog({
  provider,
  redirectBase,
  onClose,
}: {
  provider: AdminOidcProvider | null;
  redirectBase: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const create = useCreateOidcProvider();
  const update = useUpdateOidcProvider();
  const remove = useDeleteOidcProvider();
  const [name, setName] = useState(provider?.name ?? '');
  const [slug, setSlug] = useState(provider?.slug ?? '');
  const [issuer, setIssuer] = useState(provider?.issuer ?? '');
  const [clientId, setClientId] = useState(provider?.clientId ?? '');
  const [clientSecret, setClientSecret] = useState('');
  const [removeSecret, setRemoveSecret] = useState(false);
  const [scopes, setScopes] = useState(provider?.scopes ?? 'openid email profile');
  const [newAccounts, setNewAccounts] = useState<OidcNewAccountMode>(provider?.newAccounts ?? 'registration');
  const [domains, setDomains] = useState(provider?.allowedDomains.join(', ') ?? '');
  const [enabled, setEnabled] = useState(provider?.enabled ?? true);
  const [trustEmails, setTrustEmails] = useState(provider?.trustEmails ?? false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const pending = create.isPending || update.isPending;
  const error = create.error ?? update.error;
  const allowedDomains = domains
    .split(/[\s,]+/)
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);

  function submit(e: FormEvent) {
    e.preventDefault();
    const common = {
      name: name.trim(),
      issuer: issuer.trim(),
      clientId: clientId.trim(),
      scopes,
      newAccounts,
      allowedDomains,
      // Only ever alongside allowed domains; the server refuses it otherwise.
      trustEmails: trustEmails && allowedDomains.length > 0,
      enabled,
    };
    if (!provider) {
      create.mutate(
        { ...common, slug, clientSecret: clientSecret || undefined },
        {
          onSuccess: (created) => {
            toast(`Added ${created.name}. Register its redirect URI with the provider if you have not.`);
            onClose();
          },
        },
      );
      return;
    }
    update.mutate(
      {
        id: provider.id!,
        input: { ...common, clientSecret: removeSecret ? null : clientSecret || undefined },
      },
      {
        onSuccess: () => {
          toast(`${common.name} saved`);
          onClose();
        },
      },
    );
  }

  function deleteProvider() {
    setConfirmingDelete(false);
    remove.mutate(provider!.id!, {
      onSuccess: () => {
        toast(`Removed ${provider!.name}`);
        onClose();
      },
      onError: (err) => toast(err.message, 'error'),
    });
  }

  return (
    <Modal
      wide
      title={provider ? provider.name : 'Add a provider'}
      onClose={confirmingDelete ? () => {} : onClose}
      footer={
        <>
          {provider && (
            <Button variant="danger" type="button" className="mr-auto" onClick={() => setConfirmingDelete(true)}>
              <Icon name="trash" /> Remove
            </Button>
          )}
          <Button variant="subtle" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="oidc-provider" disabled={pending}>
            {pending ? 'Checking…' : provider ? 'Save' : 'Add provider'}
          </Button>
        </>
      }
    >
      <form id="oidc-provider" onSubmit={submit} className="scroll-thin max-h-[65vh] space-y-3 overflow-y-auto pr-1">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" hint="On the sign-in button: “Sign in with …”">
            <input className={FIELD} value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} autoFocus />
          </Field>
          <Field label="Short name" hint={provider ? 'Part of the redirect URI, so it cannot change.' : 'Lower-case letters, digits and hyphens.'}>
            <input
              className={FIELD}
              value={slug}
              disabled={Boolean(provider)}
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
              required
              pattern="[a-z0-9][a-z0-9\-]{0,39}"
              placeholder="google"
            />
          </Field>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-[var(--color-muted)]">
          Redirect URI <CopyValue value={`${redirectBase}${slug || '<short name>'}/callback`} />
        </div>
        <Field label="Issuer URL" hint="Where /.well-known/openid-configuration is found. Checked when you save.">
          <input
            className={FIELD}
            type="url"
            value={issuer}
            onChange={(e) => setIssuer(e.target.value)}
            required
            placeholder="https://accounts.google.com"
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Client ID">
            <input className={FIELD} value={clientId} onChange={(e) => setClientId(e.target.value)} required />
          </Field>
          <Field
            label="Client secret"
            hint={
              provider?.hasClientSecret
                ? 'A secret is stored. Leave blank to keep it.'
                : 'Leave blank for a public client, which uses PKCE alone.'
            }
          >
            <input
              className={FIELD}
              type="password"
              autoComplete="off"
              value={clientSecret}
              disabled={removeSecret}
              onChange={(e) => setClientSecret(e.target.value)}
            />
          </Field>
        </div>
        {provider?.hasClientSecret && (
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={removeSecret} onChange={(e) => setRemoveSecret(e.target.checked)} />
            Remove the stored secret
          </label>
        )}
        <Field label="Scopes" hint="Must include openid; email is needed to match or create accounts.">
          <input className={FIELD} value={scopes} onChange={(e) => setScopes(e.target.value)} required />
        </Field>

        <fieldset className="space-y-1.5">
          <legend className="mb-1 text-xs font-medium text-[var(--color-muted)]">New accounts</legend>
          {NEW_ACCOUNT_CHOICES.map((choice) => (
            <label key={choice.mode} className="flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="radio"
                name="new-accounts"
                className="mt-1"
                checked={newAccounts === choice.mode}
                onChange={() => setNewAccounts(choice.mode)}
              />
              <span>
                {choice.label}
                <span className="block text-xs text-[var(--color-muted)]">{choice.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <Field label="Allowed email domains" hint="Comma-separated, such as example.com. Empty allows any domain.">
          <input className={FIELD} value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="example.com" />
        </Field>
        <div>
          <Switch
            checked={trustEmails && allowedDomains.length > 0}
            onChange={setTrustEmails}
            disabled={allowedDomains.length === 0}
            label="Trust this provider's email addresses"
          />
          <span className="mt-1 block text-xs text-[var(--color-muted)]">
            {allowedDomains.length === 0
              ? 'Needs allowed domains first, so the provider cannot vouch for addresses outside them.'
              : 'Treats its emails as verified even when it does not say so, as Microsoft Entra ID does not. Only turn this on for a provider whose accounts in these domains your organisation controls.'}
          </span>
        </div>
        <Switch checked={enabled} onChange={setEnabled} label="Show on the sign-in screen" />
        {error && <p className="text-sm text-red-500">{error.message}</p>}
      </form>

      {confirmingDelete && provider && (
        <ConfirmDialog
          title={`Remove ${provider.name}?`}
          description="People can no longer sign in with it. Their accounts stay, and set up again with the same issuer, it signs them in as before. Accounts without a password need one set under Accounts to sign in meanwhile."
          confirmLabel="Remove"
          onConfirm={deleteProvider}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}
    </Modal>
  );
}
