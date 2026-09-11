import { useState } from 'react';
import type { Channel, PresenceStatus, VoiceOccupant } from '@paradocs/shared';
import { useCreateChannel, useDeleteChannel, useOpenDirect } from '../../api/hooks';
import { useToast } from '../Toast';
import { IconButton, InlineInput } from '../ui';
import Avatar from '../Avatar';
import Icon from '../Icon';
import { PresenceAvatar } from '../Presence';
import { useTypists } from '../../lib/typing';
import { TypingDots } from './Typing';
import { cx } from '../../lib/util';
import { ChannelSettingsDialog } from './ChannelSettingsDialog';
import { DirectMessageDialog } from './DirectMessageDialog';

/**
 * The channel list, shown in place of the folder tree while the chat tab is
 * open, with direct conversations beneath. Creating, editing and removing
 * channels is limited to owners and admins; the controls are simply absent for
 * everyone else rather than shown and refused. Anyone can start a direct
 * conversation.
 */
export function ChannelList({
  workspaceId,
  channels,
  directs,
  presence,
  activeChannelId,
  canManage,
  voiceEnabled,
  occupancy,
  connectedChannelId,
  onSelect,
}: {
  workspaceId: string;
  channels: Channel[];
  /** The signed-in person's direct conversations, most recent first. */
  directs: Channel[];
  /** Who is around, keyed by user id. */
  presence: Record<string, PresenceStatus>;
  activeChannelId: string | null;
  canManage: boolean;
  /** Whether this server has a voice service at all. */
  voiceEnabled: boolean;
  /** Who is currently in each voice channel, keyed by channel id. */
  occupancy: Record<string, VoiceOccupant[]>;
  /** The voice channel or direct conversation this session is in a call in, if any. */
  connectedChannelId: string | null;
  onSelect: (id: string) => void;
}) {
  const createChannel = useCreateChannel(workspaceId);
  const deleteChannel = useDeleteChannel(workspaceId);
  const openDirect = useOpenDirect(workspaceId);
  const [creating, setCreating] = useState<'text' | 'voice' | null>(null);
  const [editing, setEditing] = useState<Channel | null>(null);
  const [choosingPerson, setChoosingPerson] = useState(false);
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

  async function startDirect(userId: string) {
    setChoosingPerson(false);
    try {
      const conversation = await openDirect.mutateAsync(userId);
      onSelect(conversation.id);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not open the conversation', 'error');
    }
  }

  const naming = (kind: 'text' | 'voice') =>
    creating === kind
      ? {
          placeholder: kind === 'voice' ? 'voice-channel' : 'channel-name',
          onCommit: create,
          onCancel: () => setCreating(null),
        }
      : null;

  const text = channels.filter((c) => c.kind === 'text');
  const voice = channels.filter((c) => c.kind === 'voice');

  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-2">
      <Group
        label="Channels"
        addLabel="New channel"
        canAdd={canManage}
        onAdd={() => setCreating('text')}
        creating={naming('text')}
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
            onEdit={setEditing}
            onDelete={remove}
          />
        ))}
      </Group>

      {/* Hidden entirely when the server has no voice service: an empty
          section people cannot use is just a question with no answer. */}
      {(voiceEnabled || voice.length > 0) && (
        <Group
          label="Voice"
          addLabel="New voice channel"
          canAdd={canManage && voiceEnabled}
          onAdd={() => setCreating('voice')}
          creating={naming('voice')}
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
              onEdit={setEditing}
              onDelete={remove}
            />
          ))}
        </Group>
      )}

      <Group
        label="Direct messages"
        addLabel="New direct message"
        canAdd
        onAdd={() => setChoosingPerson(true)}
        creating={null}
        empty="Message someone one-to-one with +."
        count={directs.length}
      >
        {directs.map((conversation) => (
          <DirectRow
            key={conversation.id}
            conversation={conversation}
            status={conversation.peer ? (presence[conversation.peer.id] ?? 'offline') : 'offline'}
            active={conversation.id === activeChannelId}
            inCall={conversation.id === connectedChannelId}
            onSelect={onSelect}
          />
        ))}
      </Group>

      {editing && (
        <ChannelSettingsDialog workspaceId={workspaceId} channel={editing} onClose={() => setEditing(null)} />
      )}
      {choosingPerson && (
        <DirectMessageDialog
          workspaceId={workspaceId}
          presence={presence}
          onChoose={(userId) => void startDirect(userId)}
          onClose={() => setChoosingPerson(false)}
        />
      )}
    </div>
  );
}

function Group({
  label,
  addLabel,
  canAdd,
  onAdd,
  creating,
  empty,
  count,
  children,
}: {
  label: string;
  addLabel: string;
  canAdd: boolean;
  onAdd: () => void;
  /** The name being typed for a new channel in this group, if one is. */
  creating: { placeholder: string; onCommit: (name: string) => void; onCancel: () => void } | null;
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
          <IconButton label={addLabel} onClick={onAdd}>
            <Icon name="plus-lg" />
          </IconButton>
        )}
      </div>
      {creating && (
        <div className="px-2 py-1">
          <InlineInput placeholder={creating.placeholder} onCommit={creating.onCommit} onCancel={creating.onCancel} />
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
  onEdit,
  onDelete,
}: {
  channel: Channel;
  active: boolean;
  canManage: boolean;
  onSelect: (id: string) => void;
  onEdit: (channel: Channel) => void;
  onDelete: (channel: Channel) => void;
}) {
  const unread = channel.unread ?? 0;
  const mentioned = channel.mentions ?? 0;
  return (
    <Row
      channel={channel}
      active={active}
      canManage={canManage}
      onSelect={onSelect}
      onEdit={onEdit}
      onDelete={onDelete}
    >
      <span className="text-[var(--color-muted)]">#</span>
      <span
        title={channel.topic ?? undefined}
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
  onEdit,
  onDelete,
}: {
  channel: Channel;
  active: boolean;
  connected: boolean;
  canManage: boolean;
  people: VoiceOccupant[];
  onSelect: (id: string) => void;
  onEdit: (channel: Channel) => void;
  onDelete: (channel: Channel) => void;
}) {
  return (
    <>
      <Row
        channel={channel}
        active={active}
        canManage={canManage}
        onSelect={onSelect}
        onEdit={onEdit}
        onDelete={onDelete}
      >
        <Icon name="volume-up" className="text-[var(--color-muted)]" />
        <span title={channel.topic ?? undefined} className="min-w-0 flex-1 truncate">
          {channel.name}
        </span>
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

function DirectRow({
  conversation,
  status,
  active,
  inCall,
  onSelect,
}: {
  conversation: Channel;
  status: PresenceStatus;
  active: boolean;
  inCall: boolean;
  onSelect: (id: string) => void;
}) {
  const unread = conversation.unread ?? 0;
  const peer = conversation.peer;
  const name = peer?.name ?? 'Deleted account';
  // Only the other person can be typing here; your own typing is never recorded.
  const typing = useTypists(conversation.id).length > 0;
  return (
    <button
      onClick={() => onSelect(conversation.id)}
      className={cx(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
        active ? 'bg-[var(--color-line)]/70 font-medium' : 'hover:bg-[var(--color-line)]/40',
        !active && unread === 0 && 'text-[var(--color-muted)]',
      )}
    >
      <PresenceAvatar
        name={name}
        url={peer?.avatarUrl}
        seed={peer?.id}
        size="sm"
        status={peer ? status : undefined}
      />
      <span className={cx('min-w-0 flex-1 truncate', unread > 0 && !active && 'font-semibold text-[var(--color-ink)]')}>
        {name}
      </span>
      {typing && (
        <span title={`${name} is typing`} className="shrink-0 text-[var(--color-muted)]">
          <TypingDots />
        </span>
      )}
      {inCall && (
        <span title="You are in a call here" className="shrink-0 text-xs text-emerald-500">
          <Icon name="telephone-fill" />
        </span>
      )}
      {/* Every message here is to you, so unread is painted like a mention. */}
      {unread > 0 && !active && (
        <span className="shrink-0 rounded-full bg-amber-500 px-1.5 text-[11px] font-semibold text-white">
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </button>
  );
}

function Row({
  channel,
  active,
  canManage,
  onSelect,
  onEdit,
  onDelete,
  children,
}: {
  channel: Channel;
  active: boolean;
  canManage: boolean;
  onSelect: (id: string) => void;
  onEdit: (channel: Channel) => void;
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
        <span className="absolute right-1 top-1/2 flex -translate-y-1/2 rounded-md bg-[var(--color-surface)] opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <IconButton label={`Edit ${channel.name}`} onClick={() => onEdit(channel)}>
            <Icon name="pencil" />
          </IconButton>
          <IconButton label={`Delete ${channel.name}`} onClick={() => onDelete(channel)}>
            <Icon name="trash3" />
          </IconButton>
        </span>
      )}
    </div>
  );
}
