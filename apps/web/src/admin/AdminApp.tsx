import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { MAX_RETENTION_DAYS, type AdminStatus, type AdminUser, type ServerSettings } from '@paradocs/shared';
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
  useCreateUser,
  useDeleteUser,
  useServerSettings,
  useSetUserPassword,
  useSignOutUser,
  useUpdateServerSettings,
  useUpdateUser,
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
      <p className="mt-4 max-w-sm text-center text-xs text-[var(--color-muted)]">
        This page is separate from the app. Signing in here does not sign you in there, or the other way round.
      </p>
    </Centered>
  );
}

// --- console -------------------------------------------------------------------

type Tab = 'settings' | 'accounts';

const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: 'settings', label: 'Server settings', icon: 'sliders' },
  { id: 'accounts', label: 'Accounts', icon: 'people' },
];

/** The open tab lives in the address, so a reload stays where it was. */
function useTab(): [Tab, (tab: Tab) => void] {
  const read = (): Tab => (window.location.hash === '#accounts' ? 'accounts' : 'settings');
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
            {tab === 'settings' ? <SettingsPanel /> : <AccountsPanel selfId={user.id} />}
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
  return <SettingsForm current={settings.data} />;
}

const DEFAULT_RETENTION_DAYS = 365;

function SettingsForm({ current }: { current: ServerSettings }) {
  const update = useUpdateServerSettings();
  const toast = useToast();
  const [allowRegistration, setAllowRegistration] = useState(current.allowRegistration);
  const [limited, setLimited] = useState(current.messageRetentionMaxDays !== null);
  const [days, setDays] = useState(String(current.messageRetentionMaxDays ?? DEFAULT_RETENTION_DAYS));
  const [confirming, setConfirming] = useState(false);

  function reset() {
    setAllowRegistration(current.allowRegistration);
    setLimited(current.messageRetentionMaxDays !== null);
    setDays(String(current.messageRetentionMaxDays ?? DEFAULT_RETENTION_DAYS));
  }
  // What was saved becomes the new starting point.
  useEffect(reset, [current]);

  const parsedDays = Number(days);
  const daysValid = Number.isInteger(parsedDays) && parsedDays >= 1 && parsedDays <= MAX_RETENTION_DAYS;
  const retention = limited ? parsedDays : null;
  const dirty = allowRegistration !== current.allowRegistration || retention !== current.messageRetentionMaxDays;
  const valid = !limited || daysValid;
  // Keeping messages for less time than before deletes history as soon as it is saved.
  const deletesHistory =
    retention !== null && (current.messageRetentionMaxDays === null || retention < current.messageRetentionMaxDays);

  function save() {
    setConfirming(false);
    update.mutate(
      { allowRegistration, messageRetentionMaxDays: retention },
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
      <h2 className="text-lg font-semibold">Server settings</h2>
      <p className="mb-6 text-sm text-[var(--color-muted)]">
        These apply to every workspace on this server. Workspace owners cannot change them.
      </p>

      <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-raised)] p-4">
        <Section
          title="Registration"
          hint="Closed, nobody can sign up on their own; create their accounts under Accounts instead. The first account on a new server can always be created. Invited people also need an account before they can accept."
        >
          <Switch checked={allowRegistration} onChange={setAllowRegistration} label="Anyone can create an account" />
        </Section>

        <Section
          title="Message retention"
          hint="The longest a message in a text channel is kept. Older messages, and files shared in them, are permanently deleted, checked every hour. Direct messages are not affected."
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
      description="It starts with its own Personal workspace, just as if they had registered. Give them the password privately."
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

        <Section title="Sessions" hint="Ends every session the account has in the app and closes its open connections.">
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
            hint="Deletes the account and the workspaces it created. Messages it sent elsewhere stay, without an author. An account whose workspaces other people use cannot be deleted; disable it instead."
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
