import type { Channel, PresenceStatus } from '@paradocs/shared';
import { IconButton } from '../ui';
import Icon from '../Icon';
import { PresenceAvatar, STATUS_LABEL } from '../Presence';

/** The top of a direct conversation: who it is with, and whether they are around. */
export function DirectTitle({ channel, status }: { channel: Channel; status: PresenceStatus }) {
  const peer = channel.peer;
  return (
    <span className="flex min-w-0 items-center gap-2">
      <PresenceAvatar
        name={peer?.name ?? '?'}
        url={peer?.avatarUrl}
        seed={peer?.id}
        size="sm"
        status={peer ? status : undefined}
        ring="var(--color-canvas)"
      />
      <span className="truncate text-sm font-semibold">{peer?.name ?? 'Deleted account'}</span>
      {peer && <span className="shrink-0 text-xs text-[var(--color-muted)]">{STATUS_LABEL[status]}</span>}
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
