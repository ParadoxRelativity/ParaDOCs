import { useState } from 'react';
import type { Channel, VoiceOccupant } from '@paradocs/shared';
import { useCreateChannel, useDeleteChannel } from '../../api/hooks';
import { useToast } from '../Toast';
import { IconButton, InlineInput } from '../ui';
import Avatar from '../Avatar';
import Icon from '../Icon';
import { cx } from '../../lib/util';

/**
 * The channel list, shown in place of the folder tree while the chat tab is
 * open. Creating and removing channels is limited to owners and admins; the
 * controls are simply absent for everyone else rather than shown and refused.
 */
export function ChannelList({
  workspaceId,
  channels,
  activeChannelId,
  canManage,
  voiceEnabled,
  occupancy,
  connectedChannelId,
  onSelect,
}: {
  workspaceId: string;
  channels: Channel[];
  activeChannelId: string | null;
  canManage: boolean;
  /** Whether this server has a voice service at all. */
  voiceEnabled: boolean;
  /** Who is currently in each voice channel, keyed by channel id. */
  occupancy: Record<string, VoiceOccupant[]>;
  /** The voice channel this session is connected to, if any. */
  connectedChannelId: string | null;
  onSelect: (id: string) => void;
}) {
  const createChannel = useCreateChannel(workspaceId);
  const deleteChannel = useDeleteChannel(workspaceId);
  const [creating, setCreating] = useState<'text' | 'voice' | null>(null);
  const toast = useToast();

  async function create(name: string) {
    const kind = creating ?? 'text';
    setCreating(null);
    try {
      const channel = await createChannel.mutateAsync({ name, kind });
      onSelect(channel.id);
      toast(`${kind === 'voice' ? 'Voice channel ' : '#'}${channel.name} created`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not create the channel', 'error');
    }
  }

  async function remove(channel: Channel) {
    try {
      await deleteChannel.mutateAsync(channel.id);
      toast(`#${channel.name} deleted`);
      if (channel.id === activeChannelId) {
        const next = channels.find((c) => c.id !== channel.id);
        if (next) onSelect(next.id);
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not delete the channel', 'error');
    }
  }

  const text = channels.filter((c) => c.kind !== 'voice');
  const voice = channels.filter((c) => c.kind === 'voice');

  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-2">
      <Group
        label="Channels"
        canAdd={canManage}
        onAdd={() => setCreating('text')}
        creating={creating === 'text'}
        placeholder="channel-name"
        onCommit={create}
        onCancel={() => setCreating(null)}
        empty={canManage ? 'No channels yet. Add one with +.' : 'No channels yet.'}
        count={text.length}
      >
        {text.map((channel) => (
          <TextRow
            key={channel.id}
            channel={channel}
            active={channel.id === activeChannelId}
            canManage={canManage}
            onSelect={onSelect}
            onDelete={remove}
          />
        ))}
      </Group>

      {/* Hidden entirely when the server has no voice service: an empty
          section people cannot use is just a question with no answer. */}
      {(voiceEnabled || voice.length > 0) && (
        <Group
          label="Voice"
          canAdd={canManage && voiceEnabled}
          onAdd={() => setCreating('voice')}
          creating={creating === 'voice'}
          placeholder="voice-channel"
          onCommit={create}
          onCancel={() => setCreating(null)}
          empty=""
          count={voice.length}
        >
          {voice.map((channel) => (
            <VoiceRow
              key={channel.id}
              channel={channel}
              active={channel.id === activeChannelId}
              connected={channel.id === connectedChannelId}
              canManage={canManage}
              people={occupancy[channel.id] ?? []}
              onSelect={onSelect}
              onDelete={remove}
            />
          ))}
        </Group>
      )}
    </div>
  );
}

function Group({
  label,
  canAdd,
  onAdd,
  creating,
  placeholder,
  onCommit,
  onCancel,
  empty,
  count,
  children,
}: {
  label: string;
  canAdd: boolean;
  onAdd: () => void;
  creating: boolean;
  placeholder: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
  empty: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-2">
      <div className="mb-1 flex items-center justify-between px-2 pt-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
          {label}
        </span>
        {canAdd && (
          <IconButton label={`New ${label.toLowerCase()} channel`} onClick={onAdd}>
            <Icon name="plus-lg" />
          </IconButton>
        )}
      </div>
      {creating && (
        <div className="px-2 py-1">
          <InlineInput placeholder={placeholder} onCommit={onCommit} onCancel={onCancel} />
        </div>
      )}
      {count === 0 && !creating && empty && (
        <p className="px-2 py-2 text-xs text-[var(--color-muted)]">{empty}</p>
      )}
      {children}
    </div>
  );
}

function TextRow({
  channel,
  active,
  canManage,
  onSelect,
  onDelete,
}: {
  channel: Channel;
  active: boolean;
  canManage: boolean;
  onSelect: (id: string) => void;
  onDelete: (channel: Channel) => void;
}) {
  const unread = channel.unread ?? 0;
  const mentioned = channel.mentions ?? 0;
  return (
    <Row channel={channel} active={active} canManage={canManage} onSelect={onSelect} onDelete={onDelete}>
      <span className="text-[var(--color-muted)]">#</span>
      <span
        className={cx(
          'min-w-0 flex-1 truncate',
          unread > 0 && !active && 'font-semibold text-[var(--color-ink)]',
        )}
      >
        {channel.name}
      </span>
      {/* A mention count replaces the unread count rather than sitting beside
          it: two numbers on one row is a puzzle, and the one that names you is
          the one worth reading. */}
      {mentioned > 0 && !active ? (
        <span
          title={`${mentioned} ${mentioned === 1 ? 'mention' : 'mentions'}`}
          className="shrink-0 rounded-full bg-amber-500 px-1.5 text-[11px] font-semibold text-white"
        >
          @{mentioned > 99 ? '99+' : mentioned}
        </span>
      ) : (
        unread > 0 &&
        !active && (
          <span className="shrink-0 rounded-full bg-[var(--color-accent)] px-1.5 text-[11px] font-semibold text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )
      )}
    </Row>
  );
}

function VoiceRow({
  channel,
  active,
  connected,
  canManage,
  people,
  onSelect,
  onDelete,
}: {
  channel: Channel;
  active: boolean;
  connected: boolean;
  canManage: boolean;
  people: VoiceOccupant[];
  onSelect: (id: string) => void;
  onDelete: (channel: Channel) => void;
}) {
  return (
    <>
      <Row channel={channel} active={active} canManage={canManage} onSelect={onSelect} onDelete={onDelete}>
        <Icon name="volume-up" className="text-[var(--color-muted)]" />
        <span className="min-w-0 flex-1 truncate">{channel.name}</span>
        {/* Which room you are actually in, as distinct from which one you are
            looking at — they are often not the same once a call outlives the
            view that started it. */}
        {connected && (
          <span
            title="You are in this call"
            className="h-2 w-2 shrink-0 rounded-full bg-emerald-500"
          />
        )}
        {people.length > 0 && (
          <span className="shrink-0 text-[11px] text-[var(--color-muted)]">{people.length}</span>
        )}
      </Row>
      {/* Names under the channel, the way a voice channel reads elsewhere: the
          useful question is who is in there, not how many. */}
      {people.map((person, index) => (
        <div
          key={`${index}-${person.name}`}
          className="flex items-center gap-2 py-0.5 pl-8 text-xs text-[var(--color-muted)]"
        >
          <Avatar name={person.name} url={person.avatarUrl} size="xs" />
          <span className="truncate">{person.name}</span>
        </div>
      ))}
    </>
  );
}

function Row({
  channel,
  active,
  canManage,
  onSelect,
  onDelete,
  children,
}: {
  channel: Channel;
  active: boolean;
  canManage: boolean;
  onSelect: (id: string) => void;
  onDelete: (channel: Channel) => void;
  children: React.ReactNode;
}) {
  const quiet = !active && (channel.unread ?? 0) === 0 && (channel.mentions ?? 0) === 0;
  return (
    <div className="group relative">
      <button
        onClick={() => onSelect(channel.id)}
        className={cx(
          'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
          active ? 'bg-[var(--color-line)]/70 font-medium' : 'hover:bg-[var(--color-line)]/40',
          quiet && 'text-[var(--color-muted)]',
        )}
      >
        {children}
      </button>
      {canManage && (
        <span className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-100">
          <IconButton label={`Delete ${channel.name}`} onClick={() => onDelete(channel)}>
            <Icon name="trash3" />
          </IconButton>
        </span>
      )}
    </div>
  );
}
