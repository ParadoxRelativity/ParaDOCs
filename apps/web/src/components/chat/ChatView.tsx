import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { mentions, type Channel, type Message, type MessageReferences } from '@paradocs/shared';
import { api } from '../../api/client';
import { keys, useMessages, useSendMessage, useDeleteMessage, useMarkChannelRead, type MessagePage } from '../../api/hooks';
import { mergeReferences } from '../../lib/chatEvents';
import { cx, formatRelative } from '../../lib/util';
import { EmptyState, IconButton, Spinner } from '../ui';
import { MessageBody } from './MessageBody';
import { MessageComposer } from './MessageComposer';

/** Consecutive messages from one person within this window share a header. */
const GROUP_WINDOW_MS = 5 * 60 * 1000;

export function ChatView({
  workspaceId,
  channel,
  channels,
  selfId,
  canPost,
  canModerate,
  status,
  notifications,
  onEnableNotifications,
  onOpenDocument,
  onOpenChannel,
}: {
  workspaceId: string;
  channel: Channel;
  channels: Channel[];
  selfId: string;
  canPost: boolean;
  canModerate: boolean;
  status: 'connecting' | 'connected' | 'disconnected';
  /** Whether the browser will show a mention notification. */
  notifications: 'unsupported' | 'default' | 'granted' | 'denied';
  onEnableNotifications: () => void;
  onOpenDocument: (id: string) => void;
  onOpenChannel: (id: string) => void;
}) {
  const qc = useQueryClient();
  const page = useMessages(channel.id);
  const send = useSendMessage(channel.id);
  const remove = useDeleteMessage();
  const markRead = useMarkChannelRead(workspaceId);
  const scroller = useRef<HTMLDivElement>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);


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

  const messages = page.data?.messages ?? [];
  const references = page.data?.references ?? { documents: [], channels: [], members: [] };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--color-line)] px-4">
        <span className="text-sm font-semibold">#{channel.name}</span>
        {channel.topic && (
          <span className="min-w-0 flex-1 truncate text-xs text-[var(--color-muted)]">{channel.topic}</span>
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
              🔔 Notify me when mentioned
            </button>
          )}
        </span>
      </header>

      <div ref={scroller} onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {page.isLoading ? (
          <Spinner />
        ) : messages.length === 0 ? (
          <EmptyState icon="💬" title={`#${channel.name} is quiet`} hint="Say something to start it off." />
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
                onDelete={() => remove.mutate(message.id)}
                onOpenDocument={onOpenDocument}
                onOpenChannel={onOpenChannel}
              />
            ))}
          </>
        )}
      </div>

      <MessageComposer
        workspaceId={workspaceId}
        channels={channels}
        channelName={channel.name}
        disabled={!canPost}
        onSend={(body) => send.mutate(body)}
      />
    </div>
  );
}

function Row({
  message,
  previous,
  references,
  selfId,
  canDelete,
  onDelete,
  onOpenDocument,
  onOpenChannel,
}: {
  message: Message;
  previous: Message | undefined;
  references: MessageReferences;
  selfId: string;
  canDelete: boolean;
  onDelete: () => void;
  onOpenDocument: (id: string) => void;
  onOpenChannel: (id: string) => void;
}) {
  const mentionsMe = !message.deletedAt && mentions(message.body, selfId);

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
        'group relative rounded px-2 py-0.5 hover:bg-[var(--color-line)]/30',
        grouped ? '' : 'mt-3',
        // A message that names you is worth finding at a glance when scrolling.
        mentionsMe && 'bg-amber-400/10 shadow-[inset_2px_0_0_0_var(--color-accent)]',
      )}
    >
      {!grouped && (
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold">{message.author?.name ?? 'Unknown'}</span>
          <span className="text-xs text-[var(--color-muted)]">{formatRelative(message.createdAt)}</span>
        </div>
      )}
      <div className="flex items-start gap-2 text-sm">
        <div className="min-w-0 flex-1">
          <MessageBody
            body={message.body}
            references={references}
            selfId={selfId}
            onOpenDocument={onOpenDocument}
            onOpenChannel={onOpenChannel}
          />
          {message.editedAt && <span className="ml-1 text-xs text-[var(--color-muted)]">(edited)</span>}
        </div>
        {canDelete && (
          <span className="opacity-0 transition-opacity group-hover:opacity-100">
            <IconButton label="Delete message" onClick={onDelete}>
              ×
            </IconButton>
          </span>
        )}
      </div>
    </div>
  );
}
