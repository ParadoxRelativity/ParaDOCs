import { useState } from 'react';
import type { PresenceStatus, WorkspaceMember } from '@paradocs/shared';
import { useMembers } from '../../api/hooks';
import { cx } from '../../lib/util';
import Icon from '../Icon';
import { Popover } from '../Popover';
import { PresenceAvatar, STATUS_LABEL, StatusDot, StatusMenu } from '../Presence';
import { Button, Spinner } from '../ui';

/**
 * Everyone in the workspace, beside the chat: who is around first, then
 * everyone else. Pressing a name opens their card, with a way to message or
 * call them — or, on your own name, to set your status.
 *
 * Rows are alphabetical within each group rather than ordered by status, so a
 * list of people drifting between online and away does not reshuffle under
 * the pointer.
 */
export function MemberList({
  workspaceId,
  presence,
  selfStatus,
  voiceEnabled,
  onMessage,
  onCall,
}: {
  workspaceId: string;
  presence: Record<string, PresenceStatus>;
  /** Your own status as this window sees it, which is ahead of the server's echo. */
  selfStatus: PresenceStatus;
  voiceEnabled: boolean;
  onMessage: (userId: string) => void;
  onCall: (userId: string, video: boolean) => void;
}) {
  const members = useMembers(workspaceId);
  const [open, setOpen] = useState<{ userId: string; anchor: HTMLElement } | null>(null);

  const statusOf = (member: WorkspaceMember): PresenceStatus =>
    member.isSelf ? selfStatus : (presence[member.userId] ?? 'offline');
  const everyone = [...(members.data ?? [])].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  );
  const around = everyone.filter((m) => statusOf(m) !== 'offline');
  const gone = everyone.filter((m) => statusOf(m) === 'offline');
  // Read fresh from the list, so an open card follows status changes.
  const selected = open ? everyone.find((m) => m.userId === open.userId) : undefined;

  const toggle = (member: WorkspaceMember, anchor: HTMLElement) =>
    setOpen((current) => (current?.userId === member.userId ? null : { userId: member.userId, anchor }));

  return (
    <div className="flex h-full flex-col bg-[var(--color-surface)]">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--color-line)] px-4 text-sm font-semibold">
        Members
        {members.data && (
          <span className="text-xs font-normal text-[var(--color-muted)]">{members.data.length}</span>
        )}
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {members.isLoading ? (
          <Spinner />
        ) : (
          <>
            <Group label="Online" count={around.length}>
              {around.map((member) => (
                <MemberRow
                  key={member.userId}
                  member={member}
                  status={statusOf(member)}
                  active={open?.userId === member.userId}
                  onOpen={(anchor) => toggle(member, anchor)}
                />
              ))}
            </Group>
            <Group label="Offline" count={gone.length}>
              {gone.map((member) => (
                <MemberRow
                  key={member.userId}
                  member={member}
                  status="offline"
                  active={open?.userId === member.userId}
                  onOpen={(anchor) => toggle(member, anchor)}
                />
              ))}
            </Group>
          </>
        )}
      </div>

      {open && selected && (
        <Popover anchor={open.anchor} placement="left" onClose={() => setOpen(null)} className="w-72">
          <MemberCard
            member={selected}
            status={statusOf(selected)}
            voiceEnabled={voiceEnabled}
            onMessage={() => {
              setOpen(null);
              onMessage(selected.userId);
            }}
            onCall={(video) => {
              setOpen(null);
              onCall(selected.userId, video);
            }}
          />
        </Popover>
      )}
    </div>
  );
}

function Group({ label, count, children }: { label: string; count: number; children: React.ReactNode }) {
  if (count === 0) return null;
  return (
    <div className="mb-2">
      <div className="px-2 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
        {label} — {count}
      </div>
      {children}
    </div>
  );
}

function MemberRow({
  member,
  status,
  active,
  onOpen,
}: {
  member: WorkspaceMember;
  status: PresenceStatus;
  active: boolean;
  onOpen: (anchor: HTMLElement) => void;
}) {
  return (
    <button
      onClick={(e) => onOpen(e.currentTarget)}
      aria-expanded={active}
      className={cx(
        'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left',
        active ? 'bg-[var(--color-line)]/70' : 'hover:bg-[var(--color-line)]/40',
        status === 'offline' && !active && 'opacity-60',
      )}
    >
      <PresenceAvatar name={member.name} url={member.avatarUrl} seed={member.userId} size="lg" status={status} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">
          {member.name}
          {member.isSelf && <span className="text-[var(--color-muted)]"> (you)</span>}
        </span>
        {(status === 'away' || status === 'busy') && (
          <span className="block truncate text-[11px] text-[var(--color-muted)]">{STATUS_LABEL[status]}</span>
        )}
      </span>
    </button>
  );
}

function MemberCard({
  member,
  status,
  voiceEnabled,
  onMessage,
  onCall,
}: {
  member: WorkspaceMember;
  status: PresenceStatus;
  voiceEnabled: boolean;
  onMessage: () => void;
  onCall: (video: boolean) => void;
}) {
  return (
    <div className="p-4">
      <div className="flex items-center gap-3">
        <PresenceAvatar
          name={member.name}
          url={member.avatarUrl}
          seed={member.userId}
          size="xl"
          status={status}
          ring="var(--color-raised)"
        />
        <div className="min-w-0">
          <p className="truncate font-semibold">
            {member.name}
            {member.isSelf && <span className="font-normal text-[var(--color-muted)]"> (you)</span>}
          </p>
          <p className="truncate text-xs text-[var(--color-muted)]">{member.email}</p>
          <p className="mt-1 flex items-center gap-1.5 text-xs">
            <StatusDot status={status} /> {STATUS_LABEL[status]}
            <span className="text-[var(--color-muted)]">· {member.role}</span>
          </p>
        </div>
      </div>

      {member.isSelf ? (
        <div className="-mx-2 mt-3 border-t border-[var(--color-line)] pt-2">
          <StatusMenu />
        </div>
      ) : (
        <div className="mt-4 flex gap-1.5">
          <Button variant="primary" className="min-w-0 flex-1 text-xs" onClick={onMessage}>
            <Icon name="chat-dots" /> Message
          </Button>
          {voiceEnabled && (
            <>
              <Button
                variant="subtle"
                className="px-2.5 text-xs"
                title={`Voice call ${member.name}`}
                aria-label={`Voice call ${member.name}`}
                onClick={() => onCall(false)}
              >
                <Icon name="telephone" />
              </Button>
              <Button
                variant="subtle"
                className="px-2.5 text-xs"
                title={`Video call ${member.name}`}
                aria-label={`Video call ${member.name}`}
                onClick={() => onCall(true)}
              >
                <Icon name="camera-video" />
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
