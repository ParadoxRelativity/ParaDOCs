import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import type {
  InviteNotification,
  MentionNotification,
  MessageNotification,
  Notifications,
  ServerUpdateNotification,
} from '@paradocs/shared';
import {
  useAcceptInvite,
  useDeclineInvite,
  useMarkMentionsRead,
  useMarkNotificationsRead,
  useNotifications,
  useServerVersion,
} from '../api/hooks';
import {
  desktop,
  requireDesktop,
  useDesktopConnections,
  useDesktopNotifications,
  useDesktopUpdates,
  type DesktopConnection,
  type Outcome,
} from '../lib/desktop';
import { useDismissedUpdates } from '../lib/dismissedUpdates';
import { getOpenBehaviour } from '../lib/openBehaviour';
import { openTab } from '../lib/tabs';
import { cx, formatRelative } from '../lib/util';
import Avatar from './Avatar';
import Icon from './Icon';
import { useToast } from './Toast';
import { Button, IconButton, Spinner } from './ui';
import WorkspaceIcon from './WorkspaceIcon';

/**
 * Whether this click wants a new tab: the setting says what happens by default,
 * and holding the platform's modifier does the other one — the same bargain a
 * browser makes with a link.
 */
function wantsNewTab(event: { metaKey: boolean; ctrlKey: boolean }): boolean {
  const modified = event.metaKey || event.ctrlKey;
  return getOpenBehaviour() === 'tab' ? !modified : modified;
}

interface Actions {
  openChannel: (message: MessageNotification, newTab: boolean) => void;
  /** Opens the document or canvas someone tagged you in, and clears the tag. */
  openMention: (mention: MentionNotification, newTab: boolean) => void;
  accept: (invite: InviteNotification) => Promise<void>;
  decline: (invite: InviteNotification) => Promise<void>;
  markAllRead: () => Promise<void>;
  dismissServerUpdate: () => void;
}

/** Everything from one server. In the desktop app there is one per signed-in connection. */
interface Group {
  key: string;
  connection: DesktopConnection | null;
  notifications: Notifications;
  actions: Actions;
}

function countOf(notifications: Notifications): number {
  // A server that predates tagging sends no mentions at all, and one that
  // predates release checks no server update.
  return (
    notifications.invites.length +
    notifications.messages.length +
    (notifications.mentions?.length ?? 0) +
    (notifications.serverUpdate ? 1 : 0)
  );
}

/** A new version of this app, or of the page in this browser tab. */
interface ClientUpdate {
  /** Names the release and the stage, so dismissing one never hides the next. */
  key: string;
  headline: string;
  detail: string;
  action?: { label: string; run: () => unknown };
  percent?: number;
  /** Something to do, rather than progress to watch. */
  actionable: boolean;
}

/**
 * The desktop app updates itself and says how far along it is. A browser tab
 * keeps running the client it loaded, so it compares that with what the server
 * now runs and offers a reload when they differ.
 */
function useClientUpdate(): ClientUpdate | null {
  const app = useDesktopUpdates();
  const built = __PARADOCS_VERSION__;
  const serving = useServerVersion(!desktop && Boolean(built)).data;

  if (desktop) {
    if (!app?.newVersion) return null;
    const version = app.newVersion;
    const running = `You are running ${app.currentVersion}.`;
    switch (app.phase) {
      case 'available':
        return {
          key: `app-available:${version}`,
          headline: `ParaDOCs ${version} is available`,
          detail: running,
          action: { label: 'Download', run: () => requireDesktop().updates.download() },
          actionable: true,
        };
      case 'downloading':
        return {
          key: `app-downloading:${version}`,
          headline: `Downloading ParaDOCs ${version}`,
          detail: running,
          percent: app.percent ?? 0,
          actionable: false,
        };
      case 'downloaded':
        return {
          key: `app-ready:${version}`,
          headline: `ParaDOCs ${version} is ready to install`,
          detail: 'It installs when you quit, or restart now to use it straight away.',
          action: { label: 'Restart to update', run: () => requireDesktop().updates.install() },
          actionable: true,
        };
      default:
        return null;
    }
  }

  if (!built || !serving || serving === built) return null;
  return {
    key: `reload:${serving}`,
    headline: `This server now runs ParaDOCs ${serving}`,
    detail: `This page is still on ${built}. Reload to use the new version.`,
    action: { label: 'Reload', run: () => window.location.reload() },
    actionable: true,
  };
}

/**
 * The bell in the top bar, and the panel it opens: invitations to join a
 * workspace, and channels with unread messages. In the desktop app it gathers
 * them from every server this app is signed in to, not only the one on screen.
 */
export default function NotificationsMenu() {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();

  const here = useNotifications();
  const connections = useDesktopConnections();
  const elsewhere = useDesktopNotifications();
  const acceptInvite = useAcceptInvite();
  const declineInvite = useDeclineInvite();
  const markRead = useMarkNotificationsRead();
  const markMentionsRead = useMarkMentionsRead();
  const dismissed = useDismissedUpdates();
  const update = useClientUpdate();
  const clientUpdate = update && !dismissed.isDismissed(update.key) ? update : null;

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const close = () => setOpen(false);
  const report = (err: unknown, fallback: string) =>
    toast(err instanceof Error ? err.message : fallback, 'error');

  const groups: Group[] = [];

  /** A server update someone dismissed stays hidden until the release after it. */
  const serverUpdateKey = (connection: DesktopConnection | null, update: ServerUpdateNotification) =>
    `server:${connection?.id ?? 'here'}:${update.release.version}`;
  const withoutDismissed = (connection: DesktopConnection | null, notifications: Notifications): Notifications =>
    notifications.serverUpdate && dismissed.isDismissed(serverUpdateKey(connection, notifications.serverUpdate))
      ? { ...notifications, serverUpdate: null }
      : notifications;
  const dismissServerUpdate = (connection: DesktopConnection | null, notifications: Notifications) => {
    if (notifications.serverUpdate) dismissed.dismiss(serverUpdateKey(connection, notifications.serverUpdate));
  };

  if (here.data) {
    const connection = connections.find((c) => c.active) ?? null;
    const notifications = here.data;
    groups.push({
      key: 'here',
      connection,
      notifications: withoutDismissed(connection, notifications),
      actions: {
        dismissServerUpdate: () => dismissServerUpdate(connection, notifications),
        openChannel: (message, newTab) => {
          close();
          const path = `/w/${message.workspace.id}/c/${message.channelId}`;
          if (newTab) openTab(path, message.direct ? message.channelName : `#${message.channelName}`);
          else navigate(path);
        },
        openMention: (mention, newTab) => {
          close();
          const path = `/w/${mention.workspace.id}/d/${mention.documentId}`;
          if (newTab) openTab(path, mention.title);
          else navigate(path);
          // Going to look at it is what answers the tag.
          markMentionsRead.mutate([mention.documentId]);
        },
        accept: async (invite) => {
          try {
            const result = await acceptInvite.mutateAsync(invite.token);
            close();
            toast(`Joined ${invite.workspace.name}`);
            navigate(`/w/${result.workspaceId}`);
          } catch (err) {
            report(err, 'Could not join the workspace');
          }
        },
        decline: async (invite) => {
          try {
            await declineInvite.mutateAsync(invite.id);
          } catch (err) {
            report(err, 'Could not decline the invitation');
          }
        },
        markAllRead: async () => {
          try {
            await Promise.all([markRead.mutateAsync(undefined), markMentionsRead.mutateAsync(undefined)]);
          } catch (err) {
            report(err, 'Could not mark everything as read');
          }
        },
      },
    });
  }

  for (const listing of elsewhere.data ?? []) {
    if (listing.status !== 'ok') continue;
    const { connection, notifications } = listing;
    const bridge = requireDesktop();
    const settle = async (outcome: Promise<Outcome>) => {
      const result = await outcome;
      if (!result.ok) toast(result.error, 'error');
      void queryClient.invalidateQueries({ queryKey: ['desktopNotifications'] });
    };

    groups.push({
      key: connection.id,
      connection,
      notifications: withoutDismissed(connection, notifications),
      actions: {
        dismissServerUpdate: () => dismissServerUpdate(connection, notifications),
        // Another server's page has its own tabs, and switching to it is
        // already a change of context; it opens where it opens.
        openChannel: (message) => {
          close();
          void settle(bridge.connections.open(connection.id, `/w/${message.workspace.id}/c/${message.channelId}`));
        },
        openMention: (mention) => {
          close();
          void settle(bridge.notifications.markMentionsRead(connection.id, [mention.documentId]));
          void settle(bridge.connections.open(connection.id, `/w/${mention.workspace.id}/d/${mention.documentId}`));
        },
        // Joining happens on that server's own invitation page, which the
        // window switches to.
        accept: async (invite) => {
          close();
          await settle(bridge.connections.open(connection.id, `/invite/${invite.token}`));
        },
        decline: (invite) => settle(bridge.notifications.declineInvite(connection.id, invite.id)),
        markAllRead: async () => {
          await settle(bridge.notifications.markRead(connection.id));
          await settle(bridge.notifications.markMentionsRead(connection.id));
        },
      },
    });
  }

  const count =
    groups.reduce((total, group) => total + countOf(group.notifications), 0) + (clientUpdate?.actionable ? 1 : 0);
  // Progress alone is not news, but it is still worth seeing when the menu is open.
  const empty = count === 0 && !clientUpdate;
  // Being named, messaged directly, or invited is worth a louder badge than
  // ordinary chatter.
  const urgent = groups.some(
    (group) =>
      group.notifications.invites.length > 0 ||
      (group.notifications.mentions?.length ?? 0) > 0 ||
      group.notifications.messages.some((m) => m.mentions > 0 || m.direct),
  );

  return (
    <div ref={container} className="relative">
      <IconButton
        label={count > 0 ? `Notifications, ${count} new` : 'Notifications'}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cx(open && 'bg-[var(--color-surface)] text-[var(--color-ink)]')}
      >
        <Icon name={count > 0 ? 'bell-fill' : 'bell'} />
      </IconButton>
      {count > 0 && (
        <span
          aria-hidden
          className={cx(
            'pointer-events-none absolute -right-1 -top-1 min-w-4 rounded-full px-1 text-center text-[10px] font-semibold leading-4 text-white',
            urgent ? 'bg-amber-500' : 'bg-[var(--color-accent)]',
          )}
        >
          {count > 99 ? '99+' : count}
        </span>
      )}

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 top-full z-30 mt-2 flex max-h-[75vh] w-96 max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-raised)] shadow-2xl"
        >
          <div className="border-b border-[var(--color-line)] px-4 py-2.5 text-sm font-semibold">Notifications</div>
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
            {here.isLoading ? (
              <Spinner />
            ) : empty ? (
              <div className="px-6 py-10 text-center">
                <Icon name="bell" className="text-2xl text-[var(--color-muted)]" />
                <p className="mt-2 text-sm font-medium">You are all caught up</p>
              </div>
            ) : (
              <>
                {clientUpdate && (
                  <ClientUpdateRow update={clientUpdate} onDismiss={() => dismissed.dismiss(clientUpdate.key)} />
                )}
                {groups.map((group) => (
                  <NotificationGroup key={group.key} group={group} labelled={Boolean(desktop)} />
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function NotificationGroup({ group, labelled }: { group: Group; labelled: boolean }) {
  const { invites, messages } = group.notifications;
  const mentions = group.notifications.mentions ?? [];
  const serverUpdate = group.notifications.serverUpdate ?? null;
  if (countOf(group.notifications) === 0) return null;
  const unread = messages.length > 0 || mentions.length > 0;
  const heading = labelled && group.connection ? group.connection.label : unread ? 'Unread' : null;

  return (
    <section className="border-b border-[var(--color-line)] last:border-0">
      {heading && (
        <div className="flex items-center gap-1.5 px-4 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
          {labelled && group.connection && (
            <Icon name={group.connection.kind === 'local' ? 'laptop' : 'globe2'} />
          )}
          <span className="min-w-0 flex-1 truncate">{heading}</span>
          {unread && (
            <button
              onClick={() => void group.actions.markAllRead()}
              className="shrink-0 font-medium normal-case tracking-normal text-[var(--color-accent)] hover:underline"
            >
              Mark all as read
            </button>
          )}
        </div>
      )}
      {serverUpdate && <ServerUpdateRow update={serverUpdate} onDismiss={group.actions.dismissServerUpdate} />}
      {invites.map((invite) => (
        <InviteRow key={invite.id} invite={invite} actions={group.actions} />
      ))}
      {mentions.map((mention) => (
        <MentionRow
          key={mention.documentId}
          mention={mention}
          onOpen={(newTab) => group.actions.openMention(mention, newTab)}
        />
      ))}
      {messages.map((message) => (
        <MessageRow
          key={message.channelId}
          message={message}
          onOpen={(newTab) => group.actions.openChannel(message, newTab)}
        />
      ))}
    </section>
  );
}

function UpdateRow({
  icon,
  headline,
  detail,
  children,
}: {
  icon: 'arrow-up-circle' | 'hdd-rack';
  headline: string;
  detail: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex gap-3 px-4 py-2.5">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
        <Icon name={icon} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{headline}</p>
        <p className="text-xs text-[var(--color-muted)]">{detail}</p>
        {children}
      </div>
    </div>
  );
}

/** A new version of the desktop app, or of the page in this tab. */
function ClientUpdateRow({ update, onDismiss }: { update: ClientUpdate; onDismiss: () => void }) {
  return (
    <section className="border-b border-[var(--color-line)] last:border-0">
      <UpdateRow icon="arrow-up-circle" headline={update.headline} detail={update.detail}>
        {update.percent !== undefined && (
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={update.percent}
            className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--color-surface)]"
          >
            <div className="h-full rounded-full bg-[var(--color-accent)]" style={{ width: `${update.percent}%` }} />
          </div>
        )}
        {update.actionable && (
          <div className="mt-2 flex gap-1.5">
            {update.action && (
              <Button variant="primary" className="text-xs" onClick={() => void update.action!.run()}>
                {update.action.label}
              </Button>
            )}
            <Button variant="subtle" className="text-xs" onClick={onDismiss}>
              Later
            </Button>
          </div>
        )}
      </UpdateRow>
    </section>
  );
}

/** A newer release than this server runs. Only server administrators are sent one. */
function ServerUpdateRow({ update, onDismiss }: { update: ServerUpdateNotification; onDismiss: () => void }) {
  const { release } = update;
  const released = release.publishedAt ? ` · released ${formatRelative(release.publishedAt)}` : '';
  return (
    <UpdateRow
      icon="hdd-rack"
      headline={`ParaDOCs ${release.version} is available for this server`}
      detail={`It runs ${update.currentVersion}${released}. Only server administrators see this.`}
    >
      <div className="mt-2 flex gap-1.5">
        {/^https:\/\//i.test(release.url) && (
          <a
            href={release.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-line)] px-2 py-1 text-xs hover:bg-[var(--color-surface)]"
          >
            <Icon name="box-arrow-up-right" /> Release notes
          </a>
        )}
        <Button variant="subtle" className="text-xs" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </UpdateRow>
  );
}

/** Someone wrote your name into a document or onto a board. */
function MentionRow({ mention, onOpen }: { mention: MentionNotification; onOpen: (newTab: boolean) => void }) {
  return (
    <button onClick={(event) => onOpen(wantsNewTab(event))} className="flex w-full gap-3 px-4 py-2.5 text-left hover:bg-[var(--color-surface)]">
      <Avatar
        name={mention.taggedBy?.name ?? '?'}
        url={mention.taggedBy?.avatarUrl}
        seed={mention.taggedBy?.id}
        size="lg"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5 text-xs text-[var(--color-muted)]">
          <span className="truncate font-medium text-[var(--color-ink)]">
            <Icon name={mention.mode === 'canvas' ? 'easel' : 'file-earmark-text'} />{' '}
            {mention.title || 'Untitled'}
          </span>
          <span className="truncate">{mention.workspace.name}</span>
          <span className="ml-auto shrink-0">{formatRelative(mention.createdAt)}</span>
        </div>
        <p className="mt-0.5 text-sm">
          <span className="font-medium">{mention.taggedBy?.name ?? 'Someone'}</span> mentioned you in this{' '}
          {mention.mode === 'canvas' ? 'canvas' : 'document'}
        </p>
        <p className="mt-1">
          <span className="rounded-full bg-amber-500 px-1.5 text-[11px] font-semibold text-white">
            Mentioned you
          </span>
        </p>
      </div>
    </button>
  );
}

function InviteRow({ invite, actions }: { invite: InviteNotification; actions: Actions }) {
  const [busy, setBusy] = useState(false);

  async function run(action: (invite: InviteNotification) => Promise<void>) {
    setBusy(true);
    try {
      await action(invite);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex gap-3 px-4 py-2.5">
      <WorkspaceIcon
        name={invite.workspace.name}
        icon={invite.workspace.icon}
        avatarUrl={invite.workspace.avatarUrl}
        size="md"
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm">
          <span className="font-medium">{invite.invitedBy ?? 'Someone'}</span> invited you to{' '}
          <span className="font-medium">{invite.workspace.name}</span>
        </p>
        <p className="text-xs text-[var(--color-muted)]">
          As {invite.role} · {formatRelative(invite.createdAt)}
        </p>
        <div className="mt-2 flex gap-1.5">
          <Button variant="primary" className="text-xs" disabled={busy} onClick={() => void run(actions.accept)}>
            Join
          </Button>
          <Button variant="subtle" className="text-xs" disabled={busy} onClick={() => void run(actions.decline)}>
            Decline
          </Button>
        </div>
      </div>
    </div>
  );
}

function MessageRow({ message, onOpen }: { message: MessageNotification; onOpen: (newTab: boolean) => void }) {
  const { latest } = message;
  return (
    <button onClick={(event) => onOpen(wantsNewTab(event))} className="flex w-full gap-3 px-4 py-2.5 text-left hover:bg-[var(--color-surface)]">
      <Avatar
        name={latest.author?.name ?? '?'}
        url={latest.author?.avatarUrl}
        seed={latest.author?.id}
        size="lg"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5 text-xs text-[var(--color-muted)]">
          <span className="truncate font-medium text-[var(--color-ink)]">
            {message.direct ? message.channelName : `#${message.channelName}`}
          </span>
          <span className="truncate">{message.workspace.name}</span>
          <span className="ml-auto shrink-0">{formatRelative(latest.createdAt)}</span>
        </div>
        <p className="mt-0.5 line-clamp-2 text-sm">
          <span className="font-medium">{latest.author?.name ?? 'Someone'}:</span> {latest.preview}
        </p>
        {(message.mentions > 0 || message.unread > 1) && (
          <p className="mt-1 flex items-center gap-2 text-[11px] text-[var(--color-muted)]">
            {message.mentions > 0 && (
              <span className="rounded-full bg-amber-500 px-1.5 font-semibold text-white">
                {message.mentions === 1 ? 'Mentioned you' : `Mentioned you ${message.mentions} times`}
              </span>
            )}
            {message.unread > 1 && <span>{message.unread} unread</span>}
          </p>
        )}
      </div>
    </button>
  );
}
