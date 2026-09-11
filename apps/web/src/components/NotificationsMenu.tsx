import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import type { InviteNotification, MessageNotification, Notifications } from '@paradocs/shared';
import { useAcceptInvite, useDeclineInvite, useMarkNotificationsRead, useNotifications } from '../api/hooks';
import {
  desktop,
  requireDesktop,
  useDesktopConnections,
  useDesktopNotifications,
  type DesktopConnection,
  type Outcome,
} from '../lib/desktop';
import { cx, formatRelative } from '../lib/util';
import Avatar from './Avatar';
import Icon from './Icon';
import { useToast } from './Toast';
import { Button, IconButton, Spinner } from './ui';
import WorkspaceIcon from './WorkspaceIcon';

interface Actions {
  openChannel: (message: MessageNotification) => void;
  accept: (invite: InviteNotification) => Promise<void>;
  decline: (invite: InviteNotification) => Promise<void>;
  markAllRead: () => Promise<void>;
}

/** Everything from one server. In the desktop app there is one per signed-in connection. */
interface Group {
  key: string;
  connection: DesktopConnection | null;
  notifications: Notifications;
  actions: Actions;
}

function countOf(notifications: Notifications): number {
  return notifications.invites.length + notifications.messages.length;
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

  if (here.data) {
    groups.push({
      key: 'here',
      connection: connections.find((c) => c.active) ?? null,
      notifications: here.data,
      actions: {
        openChannel: (message) => {
          close();
          navigate(`/w/${message.workspace.id}/c/${message.channelId}`);
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
            await markRead.mutateAsync(undefined);
          } catch (err) {
            report(err, 'Could not mark messages as read');
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
      notifications,
      actions: {
        openChannel: (message) => {
          close();
          void settle(bridge.connections.open(connection.id, `/w/${message.workspace.id}/c/${message.channelId}`));
        },
        // Joining happens on that server's own invitation page, which the
        // window switches to.
        accept: async (invite) => {
          close();
          await settle(bridge.connections.open(connection.id, `/invite/${invite.token}`));
        },
        decline: (invite) => settle(bridge.notifications.declineInvite(connection.id, invite.id)),
        markAllRead: () => settle(bridge.notifications.markRead(connection.id)),
      },
    });
  }

  const count = groups.reduce((total, group) => total + countOf(group.notifications), 0);
  // Being named, messaged directly, or invited is worth a louder badge than
  // ordinary chatter.
  const urgent = groups.some(
    (group) =>
      group.notifications.invites.length > 0 ||
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
            ) : count === 0 ? (
              <div className="px-6 py-10 text-center">
                <Icon name="bell" className="text-2xl text-[var(--color-muted)]" />
                <p className="mt-2 text-sm font-medium">You are all caught up</p>
                <p className="mt-1 text-xs text-[var(--color-muted)]">
                  New messages and invitations to workspaces appear here.
                </p>
              </div>
            ) : (
              groups.map((group) => (
                <NotificationGroup key={group.key} group={group} labelled={Boolean(desktop)} />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function NotificationGroup({ group, labelled }: { group: Group; labelled: boolean }) {
  const { invites, messages } = group.notifications;
  if (countOf(group.notifications) === 0) return null;
  const heading = labelled && group.connection ? group.connection.label : messages.length > 0 ? 'Messages' : null;

  return (
    <section className="border-b border-[var(--color-line)] last:border-0">
      {heading && (
        <div className="flex items-center gap-1.5 px-4 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
          {labelled && group.connection && (
            <Icon name={group.connection.kind === 'local' ? 'laptop' : 'globe2'} />
          )}
          <span className="min-w-0 flex-1 truncate">{heading}</span>
          {messages.length > 0 && (
            <button
              onClick={() => void group.actions.markAllRead()}
              className="shrink-0 font-medium normal-case tracking-normal text-[var(--color-accent)] hover:underline"
            >
              Mark all as read
            </button>
          )}
        </div>
      )}
      {invites.map((invite) => (
        <InviteRow key={invite.id} invite={invite} actions={group.actions} />
      ))}
      {messages.map((message) => (
        <MessageRow key={message.channelId} message={message} onOpen={() => group.actions.openChannel(message)} />
      ))}
    </section>
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

function MessageRow({ message, onOpen }: { message: MessageNotification; onOpen: () => void }) {
  const { latest } = message;
  return (
    <button onClick={onOpen} className="flex w-full gap-3 px-4 py-2.5 text-left hover:bg-[var(--color-surface)]">
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
