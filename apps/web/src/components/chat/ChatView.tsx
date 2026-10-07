import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import {
  directName,
  isGroupDirect,
  mentions,
  type Channel,
  type Message,
  type MessageReferences,
  type ProjectReference,
  type WorkItemReference,
} from '@paradocs/shared';
import { api } from '../../api/client';
import {
  keys,
  useMessages,
  useSendMessage,
  useDeleteMessage,
  useMarkChannelRead,
  useToggleReaction,
  useBlockedIds,
  type MessagePage,
} from '../../api/hooks';
import { mergeReferences } from '../../lib/chatEvents';
import { playSound } from '../../lib/sounds';
import { cx, formatRelative } from '../../lib/util';
import { EmptyState, IconButton, Spinner } from '../ui';
import { useToast } from '../Toast';
import Avatar from '../Avatar';
import Icon, { type IconName } from '../Icon';
import { Popover } from '../Popover';
import { ChannelSettingsDialog } from './ChannelSettingsDialog';
import { EmojiPicker } from './EmojiPicker';
import { MediaViewer, type ViewerItem } from './MediaViewer';
import { MessageAttachments } from './MessageAttachments';
import { MessageBody } from './MessageBody';
import { MessageComposer, type ComposerHandle } from './MessageComposer';
import { BlockDialog, ReportMessageDialog } from './Moderation';
import { Reactions } from './Reactions';
import { TypingIndicator } from './Typing';

/** Consecutive messages from one person within this window share a header. */
const GROUP_WINDOW_MS = 5 * 60 * 1000;

function carriesFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes('Files');
}

/**
 * A touch screen has no hover to show a message's actions, so tapping a
 * message shows them instead.
 */
const TOUCH = typeof window !== 'undefined' && window.matchMedia?.('(hover: none)').matches;

/** A tap on one of these does its own thing rather than selecting the message. */
const INTERACTIVE = 'a, button, input, textarea, video, audio, img, [role="button"]';

/** One line in the list: a message, or a run of messages from someone you blocked, folded into one. */
type Item = { kind: 'message'; message: Message; previous: Message | undefined } | { kind: 'blocked'; messages: Message[] };

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
  onOpenWorkItem,
  onOpenProject,
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
  onOpenWorkItem?: (item: WorkItemReference) => void;
  onOpenProject?: (project: ProjectReference) => void;
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
  const [menu, setMenu] = useState<{ message: Message; anchor: HTMLElement } | null>(null);
  const [reporting, setReporting] = useState<Message | null>(null);
  const [blocking, setBlocking] = useState<{ id: string; name: string; blocked: boolean } | null>(null);
  // Messages from someone you blocked that you chose to see anyway.
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set());
  // On a touch screen, the message whose actions are showing.
  const [selected, setSelected] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const blockedIds = useBlockedIds();
  const [params, setParams] = useSearchParams();
  const linkedMessage = params.get('message');
  // dragenter and dragleave fire for every child crossed, so depth is counted.
  const dragDepth = useRef(0);

  const direct = channel.kind === 'direct';
  const personName = directName(channel);
  const target = direct ? personName : `#${channel.name}`;
  // A conversation between just you and someone you blocked is closed until you unblock them.
  const blockedPeer =
    direct && !isGroupDirect(channel) && channel.peer && blockedIds.has(channel.peer.id) ? channel.peer : null;

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

  // A link to one message, such as from a report, scrolls to it and marks it
  // for a moment, once it is loaded. Then the link is dropped from the address,
  // so coming back to the channel later does not jump again.
  const linkedLoaded = Boolean(linkedMessage && messages.some((m) => m.id === linkedMessage));
  useEffect(() => {
    if (!linkedMessage || !page.data) return;
    if (linkedLoaded) {
      const row = scroller.current?.querySelector(`[data-message-id="${CSS.escape(linkedMessage)}"]`);
      if (row) {
        pinned.current = false;
        row.scrollIntoView({ block: 'center' });
        setHighlighted(linkedMessage);
      }
    }
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete('message');
        return next;
      },
      { replace: true },
    );
    // setParams changes with every navigation; the link is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedMessage, linkedLoaded, page.data !== undefined]);
  useEffect(() => {
    if (!highlighted) return;
    const timer = window.setTimeout(() => setHighlighted(null), 4000);
    return () => window.clearTimeout(timer);
  }, [highlighted]);

  const items: Item[] = [];
  messages.forEach((message, index) => {
    const authorId = message.author?.id;
    if (authorId && authorId !== selfId && blockedIds.has(authorId) && !message.deletedAt && !revealed.has(message.id)) {
      const last = items[items.length - 1];
      if (last?.kind === 'blocked' && last.messages[0].author?.id === authorId) last.messages.push(message);
      else items.push({ kind: 'blocked', messages: [message] });
      return;
    }
    items.push({ kind: 'message', message, previous: messages[index - 1] });
  });

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
            {items.map((item) =>
              item.kind === 'blocked' ? (
                <BlockedRun
                  key={item.messages[0].id}
                  messages={item.messages}
                  onShow={() =>
                    setRevealed((current) => new Set([...current, ...item.messages.map((m) => m.id)]))
                  }
                />
              ) : (
                <Row
                  key={item.message.id}
                  message={item.message}
                  previous={item.previous}
                  references={references}
                  selfId={selfId}
                  canDelete={canModerate || item.message.author?.id === selfId}
                  canReact={canPost && !blockedPeer}
                  // Your own messages, and those of a deleted account, have no one to report or block.
                  hasMenu={Boolean(item.message.author && item.message.author.id !== selfId)}
                  selected={selected === item.message.id}
                  highlighted={highlighted === item.message.id}
                  onSelect={() => setSelected((current) => (current === item.message.id ? null : item.message.id))}
                  onMenu={(anchor) => setMenu({ message: item.message, anchor })}
                  onDelete={() => remove.mutate(item.message.id)}
                  onToggleReaction={(emoji, on) => toggleReaction(item.message.id, emoji, on)}
                  onAddReaction={(anchor) => setReacting({ messageId: item.message.id, anchor })}
                  onOpenMedia={(media, itemIndex) => setViewer({ items: media, index: itemIndex })}
                  onMediaLoad={keepPinned}
                  onOpenDocument={onOpenDocument}
                  onOpenSpreadsheet={onOpenSpreadsheet}
                  onOpenChannel={onOpenChannel}
                  onOpenWorkItem={onOpenWorkItem}
                  onOpenProject={onOpenProject}
                />
              ),
            )}
          </>
        )}
      </div>

      <TypingIndicator channelId={channel.id} />

      {blockedPeer && (
        <div className="mx-4 mb-1 flex items-center gap-2 rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-1.5 text-xs">
          <Icon name="slash-circle" className="text-[var(--color-muted)]" />
          <span className="min-w-0 flex-1">You blocked {blockedPeer.name}. Unblock them to message or call them.</span>
          <button
            onClick={() => setBlocking({ id: blockedPeer.id, name: blockedPeer.name, blocked: true })}
            className="shrink-0 font-medium text-[var(--color-accent)] hover:underline"
          >
            Unblock
          </button>
        </div>
      )}

      <MessageComposer
        // A draft, and the files uploaded for it, belong to one channel.
        key={channel.id}
        ref={composer}
        workspaceId={workspaceId}
        channelId={channel.id}
        channels={channels}
        target={target}
        // A group has an everyone to address; a pair does not.
        direct={direct && !isGroupDirect(channel)}
        disabled={!canPost || Boolean(blockedPeer)}
        disabledPlaceholder={blockedPeer ? `You blocked ${blockedPeer.name}` : undefined}
        onTyping={onTyping ? (typing) => onTyping(channel.id, typing) : undefined}
        onSend={async (input) => {
          try {
            await send.mutateAsync(input);
          } catch (err) {
            playSound('message_failed');
            throw err;
          }
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

      {menu?.message.author && (
        <MessageMenu
          anchor={menu.anchor}
          authorName={menu.message.author.name}
          blocked={blockedIds.has(menu.message.author.id)}
          onReport={() => setReporting(menu.message)}
          onBlock={(blocked) => {
            const author = menu.message.author!;
            setBlocking({ id: author.id, name: author.name, blocked });
          }}
          onClose={() => setMenu(null)}
        />
      )}

      {reporting && (
        <ReportMessageDialog
          messageId={reporting.id}
          authorName={reporting.author?.name ?? 'Someone'}
          direct={direct}
          onClose={() => setReporting(null)}
        />
      )}

      {blocking && (
        <BlockDialog
          user={blocking}
          blocked={blocking.blocked}
          onClose={() => {
            setBlocking(null);
            // What was shown of them anyway is hidden again.
            setRevealed(new Set());
          }}
        />
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
  hasMenu,
  selected,
  highlighted,
  onSelect,
  onMenu,
  onDelete,
  onToggleReaction,
  onAddReaction,
  onOpenMedia,
  onMediaLoad,
  onOpenDocument,
  onOpenSpreadsheet,
  onOpenChannel,
  onOpenWorkItem,
  onOpenProject,
}: {
  message: Message;
  previous: Message | undefined;
  references: MessageReferences;
  selfId: string;
  canDelete: boolean;
  canReact: boolean;
  /** Whether there is anything in the message's menu: reporting it, and blocking its author. */
  hasMenu: boolean;
  /** On a touch screen, whether its actions are showing. */
  selected: boolean;
  /** Arrived at from a link to it. */
  highlighted: boolean;
  onSelect: () => void;
  onMenu: (anchor: HTMLElement) => void;
  onDelete: () => void;
  onToggleReaction: (emoji: string, on: boolean) => void;
  onAddReaction: (anchor: HTMLElement) => void;
  onOpenMedia: (items: ViewerItem[], index: number) => void;
  onMediaLoad: () => void;
  onOpenDocument: (id: string) => void;
  onOpenSpreadsheet: (id: string) => void;
  onOpenChannel: (id: string) => void;
  onOpenWorkItem?: (item: WorkItemReference) => void;
  onOpenProject?: (project: ProjectReference) => void;
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

  const hasActions = canReact || canDelete || hasMenu;

  return (
    <div
      data-message-id={message.id}
      className={cx(
        'group relative flex gap-2 rounded px-2 py-0.5 transition-colors hover:bg-[var(--color-line)]/30',
        grouped ? '' : 'mt-3',
        // A message that names you is worth finding at a glance when scrolling.
        mentionsMe && 'bg-amber-400/10 shadow-[inset_2px_0_0_0_var(--color-accent)]',
        selected && 'bg-[var(--color-line)]/30',
        highlighted && 'bg-[var(--color-accent)]/15',
      )}
      onClick={(e) => {
        if (!TOUCH || !hasActions || (e.target as Element).closest(INTERACTIVE)) return;
        onSelect();
      }}
      onContextMenu={(e) => {
        // A right-click, or a long press where the device reports one, opens the menu.
        if (!hasMenu || (e.target as Element).closest('a, input, textarea')) return;
        e.preventDefault();
        onMenu(e.currentTarget);
      }}
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
              onOpenWorkItem={onOpenWorkItem}
              onOpenProject={onOpenProject}
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

      {hasActions && (
        <div
          className={cx(
            'absolute -top-3 right-2 z-10 items-center gap-0.5 rounded-md border border-[var(--color-line)] bg-[var(--color-raised)] p-0.5 shadow-sm focus-within:flex',
            selected ? 'flex' : TOUCH ? 'hidden' : 'hidden group-hover:flex',
          )}
        >
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
          {hasMenu && (
            <IconButton label="More" aria-haspopup="menu" onClick={(e) => onMenu(e.currentTarget)}>
              <Icon name="three-dots" />
            </IconButton>
          )}
        </div>
      )}
    </div>
  );
}

/** Messages from someone you blocked, folded into one line until you ask to see them. */
function BlockedRun({ messages, onShow }: { messages: Message[]; onShow: () => void }) {
  const name = messages[0].author?.name ?? 'someone';
  return (
    <div className="mt-1 flex items-center gap-2 py-0.5 pl-12 text-xs italic text-[var(--color-muted)]">
      <Icon name="slash-circle" />
      <span>
        {messages.length === 1 ? 'A message' : `${messages.length} messages`} from {name}, whom you blocked
      </span>
      <button onClick={onShow} className="not-italic text-[var(--color-accent)] hover:underline">
        Show
      </button>
    </div>
  );
}

/** What you can do about someone else's message: report it, or block them. */
function MessageMenu({
  anchor,
  authorName,
  blocked,
  onReport,
  onBlock,
  onClose,
}: {
  anchor: HTMLElement;
  authorName: string;
  blocked: boolean;
  onReport: () => void;
  onBlock: (blocked: boolean) => void;
  onClose: () => void;
}) {
  const item = (icon: IconName, label: string, run: () => void, danger = false) => (
    <button
      role="menuitem"
      className={cx(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
        danger ? 'text-red-500 hover:bg-red-500/10' : 'hover:bg-[var(--color-surface)]',
      )}
      onClick={() => {
        onClose();
        run();
      }}
    >
      <Icon name={icon} className={danger ? undefined : 'text-[var(--color-muted)]'} /> {label}
    </button>
  );
  return (
    <Popover anchor={anchor} placement="below" onClose={onClose}>
      <div role="menu" className="w-56 p-1">
        {item('flag', 'Report message…', onReport, true)}
        {blocked
          ? item('person-check', `Unblock ${authorName}…`, () => onBlock(true))
          : item('slash-circle', `Block ${authorName}…`, () => onBlock(false), true)}
      </div>
    </Popover>
  );
}
