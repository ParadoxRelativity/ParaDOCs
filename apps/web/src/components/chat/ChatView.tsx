import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { mentions, type Channel, type Message, type MessageReferences } from '@paradocs/shared';
import { api } from '../../api/client';
import {
  keys,
  useMessages,
  useSendMessage,
  useDeleteMessage,
  useMarkChannelRead,
  useToggleReaction,
  type MessagePage,
} from '../../api/hooks';
import { mergeReferences } from '../../lib/chatEvents';
import { cx, formatRelative } from '../../lib/util';
import { EmptyState, IconButton, Spinner } from '../ui';
import { useToast } from '../Toast';
import Avatar from '../Avatar';
import Icon from '../Icon';
import { ChannelSettingsDialog } from './ChannelSettingsDialog';
import { EmojiPicker } from './EmojiPicker';
import { MediaViewer, type ViewerItem } from './MediaViewer';
import { MessageAttachments } from './MessageAttachments';
import { MessageBody } from './MessageBody';
import { MessageComposer, type ComposerHandle } from './MessageComposer';
import { Reactions } from './Reactions';
import { TypingIndicator } from './Typing';

/** Consecutive messages from one person within this window share a header. */
const GROUP_WINDOW_MS = 5 * 60 * 1000;

function carriesFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes('Files');
}

/**
 * A conversation: a text channel, or a direct conversation with one person.
 * The two differ only at the top — a channel's name and topic, or the person
 * and a way to call them — so the rest is shared.
 */
export function ChatView({
  workspaceId,
  channel,
  channels,
  selfId,
  canPost,
  canModerate,
  canEditChannel = false,
  title,
  actions,
  stage,
  status,
  notifications,
  onEnableNotifications,
  onOpenDocument,
  onOpenSpreadsheet,
  onOpenChannel,
  onTyping,
}: {
  workspaceId: string;
  channel: Channel;
  channels: Channel[];
  selfId: string;
  canPost: boolean;
  canModerate: boolean;
  /** Owners and admins change a channel's name and topic from its header. */
  canEditChannel?: boolean;
  /** Takes the place of the channel name and topic. */
  title?: ReactNode;
  /** Controls at the end of the header. */
  actions?: ReactNode;
  /** Between the header and the messages: a call in progress here. */
  stage?: ReactNode;
  status: 'connecting' | 'connected' | 'disconnected';
  /** Whether the browser will show a mention notification. */
  notifications: 'unsupported' | 'default' | 'granted' | 'denied';
  onEnableNotifications: () => void;
  onOpenDocument: (id: string) => void;
  onOpenSpreadsheet: (id: string) => void;
  onOpenChannel: (id: string) => void;
  /** Tells everyone else in a channel that you are typing there, or have stopped. */
  onTyping?: (channelId: string, typing: boolean) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const page = useMessages(channel.id);
  const send = useSendMessage(channel.id);
  const remove = useDeleteMessage();
  const react = useToggleReaction(channel.id);
  const markRead = useMarkChannelRead(workspaceId);
  const scroller = useRef<HTMLDivElement>(null);
  const composer = useRef<ComposerHandle>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [viewer, setViewer] = useState<{ items: ViewerItem[]; index: number } | null>(null);
  const [reacting, setReacting] = useState<{ messageId: string; anchor: HTMLElement } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [editing, setEditing] = useState(false);
  // dragenter and dragleave fire for every child crossed, so depth is counted.
  const dragDepth = useRef(0);

  const direct = channel.kind === 'direct';
  const personName = channel.peer?.name ?? 'Deleted account';
  const target = direct ? personName : `#${channel.name}`;

  // Opening a channel clears its badge, and so does a message arriving while
  // you are looking at it.
  const messageCount = page.data?.messages.length ?? 0;
  useEffect(() => {
    if (page.data) markRead.mutate(channel.id);
    // markRead is a stable mutation object; including it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.id, messageCount, page.data !== undefined]);

  // Stick to the bottom unless the reader has scrolled up to read history.
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [messageCount, channel.id]);

  // A picture that loads after its message can still push the list taller.
  const keepPinned = useCallback(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, []);

  async function loadOlder() {
    const current = page.data;
    if (!current?.hasMore || loadingOlder) return;
    setLoadingOlder(true);
    const el = scroller.current;
    const previousHeight = el?.scrollHeight ?? 0;
    try {
      const older = await api.get<MessagePage>(
        `/channels/${channel.id}/messages?limit=50&before=${encodeURIComponent(current.messages[0].createdAt)}`,
      );
      qc.setQueryData<MessagePage>(keys.messages(channel.id), (existing) =>
        existing
          ? {
              messages: [...older.messages, ...existing.messages],
              hasMore: older.hasMore,
              references: mergeReferences(existing.references, older.references),
            }
          : existing,
      );
      // Keep the reader's eye where it was rather than jumping to the top.
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - previousHeight;
      });
    } finally {
      setLoadingOlder(false);
    }
  }

  function toggleReaction(messageId: string, emoji: string, on: boolean) {
    react.mutate(
      { messageId, emoji, on },
      { onError: (err) => toast(err instanceof Error ? err.message : 'Could not change the reaction', 'error') },
    );
  }

  const messages = page.data?.messages ?? [];
  const references = page.data?.references ?? { documents: [], spreadsheets: [], channels: [], members: [] };

  return (
    <div
      className="relative flex h-full min-h-0 flex-col"
      onDragEnter={(e) => {
        if (!canPost || !carriesFiles(e)) return;
        e.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(e) => {
        if (!canPost || !carriesFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={(e) => {
        if (!canPost || !carriesFiles(e)) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={(e) => {
        if (!canPost || !carriesFiles(e)) return;
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        composer.current?.addFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--color-line)] px-4">
        {title ?? (
          <>
            <span className="shrink-0 text-sm font-semibold">#{channel.name}</span>
            {canEditChannel ? (
              // The topic is edited where it is read, so the way to set one is
              // right beside the name.
              <button
                onClick={() => setEditing(true)}
                title="Edit the channel's name and topic"
                className={cx(
                  'min-w-0 truncate text-left text-xs text-[var(--color-muted)] hover:text-[var(--color-ink)]',
                  channel.topic && 'flex-1',
                )}
              >
                {channel.topic ?? (
                  <>
                    <Icon name="pencil" /> Add a topic
                  </>
                )}
              </button>
            ) : (
              channel.topic && (
                <span className="min-w-0 flex-1 truncate text-xs text-[var(--color-muted)]">{channel.topic}</span>
              )
            )}
          </>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {status !== 'connected' && (
            <span className="text-xs text-[var(--color-muted)]">
              {status === 'connecting' ? 'Connecting…' : 'Offline — reconnecting'}
            </span>
          )}
          {notifications === 'default' && (
            <button
              onClick={onEnableNotifications}
              className="rounded-md px-2 py-1 text-xs text-[var(--color-muted)] hover:bg-[var(--color-line)]/50 hover:text-[var(--color-ink)]"
            >
              <Icon name="bell" /> {direct ? 'Notify me of new messages' : 'Notify me when mentioned'}
            </button>
          )}
          {actions}
        </span>
      </header>

      {stage}

      <div ref={scroller} onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {page.isLoading ? (
          <Spinner />
        ) : messages.length === 0 ? (
          direct ? (
            <EmptyState icon="chat-dots" title={`This is the start of your conversation with ${personName}`} />
          ) : (
            <EmptyState icon="chat-dots" title={`#${channel.name} is quiet`} />
          )
        ) : (
          <>
            {page.data?.hasMore && (
              <div className="pb-3 text-center">
                <button
                  onClick={loadOlder}
                  disabled={loadingOlder}
                  className="rounded-md px-3 py-1 text-xs text-[var(--color-muted)] hover:bg-[var(--color-line)]/50"
                >
                  {loadingOlder ? 'Loading…' : 'Load earlier messages'}
                </button>
              </div>
            )}
            {messages.map((message, index) => (
              <Row
                key={message.id}
                message={message}
                previous={messages[index - 1]}
                references={references}
                selfId={selfId}
                canDelete={canModerate || message.author?.id === selfId}
                canReact={canPost}
                onDelete={() => remove.mutate(message.id)}
                onToggleReaction={(emoji, on) => toggleReaction(message.id, emoji, on)}
                onAddReaction={(anchor) => setReacting({ messageId: message.id, anchor })}
                onOpenMedia={(items, itemIndex) => setViewer({ items, index: itemIndex })}
                onMediaLoad={keepPinned}
                onOpenDocument={onOpenDocument}
                onOpenSpreadsheet={onOpenSpreadsheet}
                onOpenChannel={onOpenChannel}
              />
            ))}
          </>
        )}
      </div>

      <TypingIndicator channelId={channel.id} />

      <MessageComposer
        // A draft, and the files uploaded for it, belong to one channel.
        key={channel.id}
        ref={composer}
        workspaceId={workspaceId}
        channelId={channel.id}
        channels={channels}
        target={target}
        disabled={!canPost}
        onTyping={onTyping ? (typing) => onTyping(channel.id, typing) : undefined}
        onSend={async (input) => {
          await send.mutateAsync(input);
        }}
      />

      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-30 grid place-items-center rounded-xl border-2 border-dashed border-[var(--color-accent)] bg-[var(--color-raised)]/85">
          <div className="text-center">
            <Icon name="cloud-arrow-up" className="text-3xl text-[var(--color-accent)]" />
            <p className="mt-2 text-sm font-medium">{direct ? `Drop to share with ${personName}` : `Drop to share in ${target}`}</p>
          </div>
        </div>
      )}

      {viewer && (
        <MediaViewer
          items={viewer.items}
          index={viewer.index}
          // From the latest state, so keys pressed faster than a render still count.
          onStep={(delta) =>
            setViewer((current) =>
              current
                ? { ...current, index: (current.index + delta + current.items.length) % current.items.length }
                : current,
            )
          }
          onClose={() => setViewer(null)}
        />
      )}

      {reacting && (
        <EmojiPicker
          anchor={reacting.anchor}
          onSelect={(emoji) => {
            toggleReaction(reacting.messageId, emoji, true);
            setReacting(null);
          }}
          onClose={() => setReacting(null)}
        />
      )}

      {editing && (
        <ChannelSettingsDialog workspaceId={workspaceId} channel={channel} onClose={() => setEditing(false)} />
      )}
    </div>
  );
}

function Row({
  message,
  previous,
  references,
  selfId,
  canDelete,
  canReact,
  onDelete,
  onToggleReaction,
  onAddReaction,
  onOpenMedia,
  onMediaLoad,
  onOpenDocument,
  onOpenSpreadsheet,
  onOpenChannel,
}: {
  message: Message;
  previous: Message | undefined;
  references: MessageReferences;
  selfId: string;
  canDelete: boolean;
  canReact: boolean;
  onDelete: () => void;
  onToggleReaction: (emoji: string, on: boolean) => void;
  onAddReaction: (anchor: HTMLElement) => void;
  onOpenMedia: (items: ViewerItem[], index: number) => void;
  onMediaLoad: () => void;
  onOpenDocument: (id: string) => void;
  onOpenSpreadsheet: (id: string) => void;
  onOpenChannel: (id: string) => void;
}) {
  const mentionsMe = !message.deletedAt && mentions(message.body, selfId);
  // A server that predates files and reactions sends neither.
  const attachments = message.attachments ?? [];
  const reactions = message.reactions ?? [];

  const grouped =
    previous !== undefined &&
    previous.author?.id === message.author?.id &&
    new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime() < GROUP_WINDOW_MS &&
    !previous.deletedAt &&
    !message.deletedAt;

  if (message.deletedAt) {
    return (
      <div className="group py-0.5 pl-12 text-sm italic text-[var(--color-muted)]">Message deleted</div>
    );
  }

  return (
    <div
      className={cx(
        'group relative flex gap-2 rounded px-2 py-0.5 hover:bg-[var(--color-line)]/30',
        grouped ? '' : 'mt-3',
        // A message that names you is worth finding at a glance when scrolling.
        mentionsMe && 'bg-amber-400/10 shadow-[inset_2px_0_0_0_var(--color-accent)]',
      )}
    >
      {/* Only the first message of a run shows the picture; the rest keep its
          column so their text lines up underneath. */}
      <div className="w-8 shrink-0">
        {!grouped && (
          <Avatar
            name={message.author?.name ?? '?'}
            url={message.author?.avatarUrl}
            seed={message.author?.id}
            size="lg"
            className="mt-0.5"
          />
        )}
      </div>
      <div className="min-w-0 flex-1">
        {!grouped && (
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold">{message.author?.name ?? 'Unknown'}</span>
            <span className="text-xs text-[var(--color-muted)]">{formatRelative(message.createdAt)}</span>
          </div>
        )}
        {message.body && (
          <div className="text-sm">
            <MessageBody
              body={message.body}
              references={references}
              selfId={selfId}
              onOpenDocument={onOpenDocument}
              onOpenSpreadsheet={onOpenSpreadsheet}
              onOpenChannel={onOpenChannel}
            />
            {message.editedAt && <span className="ml-1 text-xs text-[var(--color-muted)]">(edited)</span>}
          </div>
        )}
        {attachments.length > 0 && (
          <MessageAttachments
            attachments={attachments}
            onOpen={onOpenMedia}
            onLoad={onMediaLoad}
            className={message.body ? 'mt-1.5' : 'mt-0.5'}
          />
        )}
        {reactions.length > 0 && (
          <Reactions
            reactions={reactions}
            selfId={selfId}
            canReact={canReact}
            onToggle={onToggleReaction}
            onAdd={onAddReaction}
          />
        )}
      </div>

      {(canReact || canDelete) && (
        <div className="absolute -top-3 right-2 z-10 hidden items-center gap-0.5 rounded-md border border-[var(--color-line)] bg-[var(--color-raised)] p-0.5 shadow-sm focus-within:flex group-hover:flex">
          {canReact && (
            <IconButton label="Add reaction" onClick={(e) => onAddReaction(e.currentTarget)}>
              <Icon name="emoji-smile" />
            </IconButton>
          )}
          {canDelete && (
            <IconButton label="Delete message" onClick={onDelete}>
              <Icon name="trash3" />
            </IconButton>
          )}
        </div>
      )}
    </div>
  );
}
