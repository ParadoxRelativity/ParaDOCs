import { directName, directPeople, isGroupDirect, type Channel, type PresenceStatus } from '@paradocs/shared';
import { IconButton } from '../ui';
import Avatar from '../Avatar';
import Icon from '../Icon';
import { PresenceAvatar, STATUS_LABEL } from '../Presence';

/**
 * Who a direct conversation is with, as a picture: the other person with their
 * status, or for a group, the first two of them overlapping — or, once fewer
 * than two others are left in it, a group glyph.
 */
export function DirectAvatar({
  channel,
  status,
  ring = 'var(--color-surface)',
}: {
  channel: Channel;
  /** The other person's status, in a conversation with one. */
  status: PresenceStatus;
  ring?: string;
}) {
  const people = directPeople(channel);
  if (isGroupDirect(channel) && people.length < 2) {
    return (
      <span
        aria-hidden
        className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[var(--color-line)] text-[10px] text-[var(--color-muted)]"
      >
        <Icon name="people-fill" />
      </span>
    );
  }
  if (people.length > 1) {
    const [first, second] = people;
    return (
      <span aria-hidden className="relative inline-block h-5 w-5 shrink-0">
        <Avatar name={first.name} url={first.avatarUrl} seed={first.id} size="xs" className="absolute left-0 top-0" />
        <Avatar
          name={second.name}
          url={second.avatarUrl}
          seed={second.id}
          size="xs"
          className="absolute bottom-0 right-0"
          style={{ boxShadow: `0 0 0 1.5px ${ring}` }}
        />
      </span>
    );
  }
  const peer = people[0];
  return (
    <PresenceAvatar
      name={peer?.name ?? '?'}
      url={peer?.avatarUrl}
      seed={peer?.id}
      size="sm"
      status={peer ? status : undefined}
      ring={ring}
    />
  );
}

/** The top of a direct conversation: who it is with, and whether they are around. */
export function DirectTitle({ channel, status }: { channel: Channel; status: PresenceStatus }) {
  const people = directPeople(channel);
  return (
    <span className="flex min-w-0 items-center gap-2">
      <DirectAvatar channel={channel} status={status} ring="var(--color-canvas)" />
      <span className="truncate text-sm font-semibold">{directName(channel)}</span>
      {isGroupDirect(channel) ? (
        <span className="shrink-0 text-xs text-[var(--color-muted)]">
          {people.length + 1} {people.length === 0 ? 'person' : 'people'}
        </span>
      ) : (
        people[0] && <span className="shrink-0 text-xs text-[var(--color-muted)]">{STATUS_LABEL[status]}</span>
      )}
    </span>
  );
}

export function DirectCallActions({ name, onCall }: { name: string; onCall: (video: boolean) => void }) {
  return (
    <>
      <IconButton label={`Voice call ${name}`} onClick={() => onCall(false)}>
        <Icon name="telephone" />
      </IconButton>
      <IconButton label={`Video call ${name}`} onClick={() => onCall(true)}>
        <Icon name="camera-video" />
      </IconButton>
    </>
  );
}
