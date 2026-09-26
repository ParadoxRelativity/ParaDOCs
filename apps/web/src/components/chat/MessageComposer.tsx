import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import {
  HERE_REF,
  MAX_ATTACHMENTS_PER_MESSAGE,
  attachmentKind,
  channelRef,
  documentRef,
  memberRef,
  projectRef,
  spreadsheetRef,
  workItemRef,
  type AttachmentKind,
  type Channel,
  type MessageAttachment,
  type ProjectKind,
} from '@paradocs/shared';
import { api } from '../../api/client';
import {
  useAppEnabled,
  useMembers,
  useProjects,
  useLinkTargets,
  useUploadConfig,
  useWorkItemListing,
} from '../../api/hooks';
import { uploadChatFile } from '../../lib/chatFiles';
import { useTypingReporter } from '../../lib/typing';
import { replaceShortcodes, searchEmoji, type EmojiOption } from '../../lib/emoji';
import { cx, formatBytes, useDebounced } from '../../lib/util';
import Icon, { DocumentIcon, SpreadsheetIcon } from '../Icon';
import { useToast } from '../Toast';
import { IconButton } from '../ui';
import { EmojiPicker } from './EmojiPicker';
import { fileIcon } from './MessageAttachments';

/**
 * The message box, with inline pickers for the things you can reference and
 * the files going out with the message.
 *
 * Typing `#` offers channels, `@` people (and `@here`, for everyone in the
 * channel), `[[` documents and spreadsheets, and `\\` work items — by key or
 * by title — along with the boards and queues they are worked on.
 * What gets inserted is the id token, not the name — so the rendered link
 * follows a rename — while what you typed to find it never appears in the
 * message.
 *
 * `[[` offers both kinds together because linking a thing is one gesture: the
 * person reaching for it is thinking of what they want to point at, not which
 * of the app's tables it lives in. Each kind keeps its own token, so what is
 * inserted still says which it was.
 * Typing `:` and a couple of letters offers emoji.
 *
 * Files upload the moment they are added, so sending is instant.
 */

interface Trigger {
  kind: 'channel' | 'document' | 'workItem' | 'member' | 'emoji';
  /** Index of the trigger character(s) in the textarea value. */
  start: number;
  query: string;
}

/** What `@here` is typed as, and its row's key in the people picker. */
const HERE = 'here';

/** How many rows a picker offers before you are better off narrowing the query. */
const PICKER_LIMIT = 6;

/** What starts a work item reference: two backslashes, so a lone one in a path is left alone. */
export const WORK_ITEM_TRIGGER = '\\\\';

/**
 * An inserted work item, board or queue, followed by what was typed after it:
 * the search is over.
 */
export const INSERTED_REF = /^[A-Z][A-Z0-9]*(?:-\d+| board| queue)\s/;

/**
 * How a board or queue reads in the box: `\\ENG board`. The word after the
 * key keeps it from being the start of one of its own items' labels,
 * `\\ENG-12`, which would swap the wrong one for its token on send.
 */
export function projectLabel(project: { key: string; kind: ProjectKind }): string {
  return `${WORK_ITEM_TRIGGER}${project.key} ${project.kind === 'queue' ? 'queue' : 'board'}`;
}

/** Boards and queues matching what is typed, by name or key; a couple, above the work items. */
export function matchProjects<T extends { name: string; key: string }>(projects: T[] | undefined, query: string): T[] {
  const needle = query.trim().toLowerCase();
  return (projects ?? []).filter((p) => p.name.toLowerCase().includes(needle) || p.key.toLowerCase().includes(needle)).slice(0, 2);
}

const TRIGGERS: { kind: Trigger['kind']; token: string }[] = [
  { kind: 'workItem', token: WORK_ITEM_TRIGGER },
  { kind: 'document', token: '[[' },
  { kind: 'channel', token: '#' },
  { kind: 'member', token: '@' },
  { kind: 'emoji', token: ':' },
];

function findTrigger(value: string, caret: number): Trigger | null {
  for (const { kind, token } of TRIGGERS) {
    const start = value.lastIndexOf(token, caret - 1);
    if (start === -1) continue;
    const query = value.slice(start + token.length, caret);
    // A channel or document trigger ends at whitespace: "#general " is
    // finished, not a live search. A person's name has spaces in it, so a
    // mention stays open for one word and gives up after that.
    // A work item's title can be searched by a few words.
    const limit = kind === 'member' ? /\s\S*\s/ : kind === 'workItem' ? /\n|\s\S*\s\S*\s/ : /\s/;
    if (limit.test(query)) continue;
    if (kind === 'workItem' && INSERTED_REF.test(query)) continue;
    // `#`, `@` and `:` only start a mention at a word boundary, so "C#", an
    // email address and "12:30" are left alone.
    if (kind !== 'document' && start > 0 && !/\s/.test(value[start - 1])) continue;
    // Emoji wait for two letters of a shortcode, so a lone colon is just a colon.
    if (kind === 'emoji' && !/^[a-z0-9_+-]{2,}$/i.test(query)) continue;
    return { kind, start, query };
  }
  return null;
}

interface PendingFile {
  key: string;
  file: File;
  kind: AttachmentKind;
  /** A local preview for pictures and videos, until the message is sent. */
  previewUrl: string | null;
  progress: number;
  status: 'uploading' | 'ready' | 'failed';
  attachment?: MessageAttachment;
  error?: string;
  controller: AbortController;
}

export interface ComposerHandle {
  /** Adds files from outside the box, such as a drop onto the channel. */
  addFiles: (files: File[]) => void;
}

let nextKey = 0;

export const MessageComposer = forwardRef<
  ComposerHandle,
  {
    workspaceId: string;
    channelId: string;
    channels: Channel[];
    /** Where the message goes, as the placeholder says it: "#general", or a person's name. */
    target: string;
    /** A conversation between two people, where `@here` would only ever reach the one other. */
    direct?: boolean;
    disabled?: boolean;
    onSend: (input: { body: string; attachmentIds: string[] }) => Promise<void>;
    /** Tells the others here that you are typing, or have stopped. */
    onTyping?: (typing: boolean) => void;
  }
>(function MessageComposer({ workspaceId, channelId, channels, target, direct = false, disabled, onSend, onTyping }, ref) {
  const [value, setValue] = useState('');
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [highlighted, setHighlighted] = useState(0);
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [queued, setQueued] = useState(false);
  const [emojiAnchor, setEmojiAnchor] = useState<HTMLElement | null>(null);
  const [emojiOptions, setEmojiOptions] = useState<EmojiOption[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const sending = useRef(false);
  const toast = useToast();
  const uploadConfig = useUploadConfig();
  // References chosen from a picker, in the order they were inserted.
  const picked = useRef<{ label: string; token: string }[]>([]);
  // Read by the unmount cleanup, which would otherwise see the first render's list.
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  // Only fetched once the matching mention is actually being typed.
  // And only from the apps the workspace has on.
  const docsOn = useAppEnabled(workspaceId, 'docs');
  const sheetsOn = useAppEnabled(workspaceId, 'sheets');
  // Searched on the server as the name is typed, since a workspace can hold
  // more documents and spreadsheets than any list it would send. Each kind is
  // asked for a full picker's worth, so either can fill the list alone.
  const linkQuery = useDebounced(trigger?.kind === 'document' ? trigger.query.trim() : '', 150);
  const targets = useLinkTargets(
    trigger?.kind === 'document' && (docsOn || sheetsOn) ? workspaceId : undefined,
    linkQuery,
    { limit: PICKER_LIMIT },
  );
  // Work items are searched on the server, since a workspace can have thousands:
  // by title, or by key, so `[[ENG-12` finds the one meant.
  const projectsOn = useAppEnabled(workspaceId, 'projects');
  const workItems = useWorkItemListing(trigger?.kind === 'workItem' && projectsOn ? workspaceId : undefined, {
    q: trigger?.kind === 'workItem' ? trigger.query || undefined : undefined,
    limit: PICKER_LIMIT,
  });
  const projects = useProjects(trigger?.kind === 'workItem' && projectsOn ? workspaceId : undefined);
  const members = useMembers(trigger?.kind === 'member' ? workspaceId : undefined);

  const emojiQuery = trigger?.kind === 'emoji' ? trigger.query : null;
  useEffect(() => {
    if (emojiQuery === null) return;
    let cancelled = false;
    void searchEmoji(emojiQuery, PICKER_LIMIT).then((results) => {
      if (!cancelled) setEmojiOptions(results);
    });
    return () => {
      cancelled = true;
    };
  }, [emojiQuery]);

  const options = useMemo(() => {
    if (!trigger) return [];
    const needle = trigger.query.toLowerCase();
    if (trigger.kind === 'emoji') {
      return emojiOptions.map((e) => ({
        id: e.id,
        icon: <span className="text-base leading-none">{e.native}</span>,
        label: `:${e.id}:`,
        hint: e.name,
        insert: e.native,
        token: e.native,
      }));
    }
    if (trigger.kind === 'channel') {
      return channels
        .filter((c) => c.name.includes(needle))
        .slice(0, PICKER_LIMIT)
        .map((c) => ({ id: c.id, label: `#${c.name}`, hint: c.topic ?? '', insert: `#${c.name}`, token: channelRef(c.id) }));
    }
    if (trigger.kind === 'member') {
      // Offered first while what is typed could still be it, so `@h` finds it.
      const here =
        !direct && HERE.startsWith(needle)
          ? [{ id: HERE, label: '@here', hint: '', insert: '@here', token: HERE_REF }]
          : [];
      const people = (members.data ?? [])
        .filter((m) => m.name.toLowerCase().includes(needle) || m.email.toLowerCase().includes(needle))
        .slice(0, PICKER_LIMIT - here.length)
        .map((m) => ({
          id: m.userId,
          label: `@${m.name}`,
          hint: m.isSelf ? 'you' : m.email,
          insert: `@${m.name}`,
          token: memberRef(m.userId),
        }));
      return [...here, ...people];
    }
    if (trigger.kind === 'workItem') {
      const boards = matchProjects(projects.data, trigger.query).map((p) => ({
        id: p.id,
        icon: <Icon name={p.kind === 'queue' ? 'inboxes' : 'kanban'} />,
        label: p.name,
        hint: p.kind === 'queue' ? 'Queue' : 'Board',
        insert: projectLabel(p),
        token: projectRef(p.id),
      }));
      // Already matched on the server, by key or title.
      const items = (workItems.data ?? []).map((item) => ({
        id: item.id,
        icon: <Icon name="card-text" />,
        label: `${item.key} ${item.title}`,
        hint: item.status.name,
        insert: `${WORK_ITEM_TRIGGER}${item.key}`,
        token: workItemRef(item.id),
      }));
      return [...boards, ...items].slice(0, PICKER_LIMIT);
    }
    // Both lists arrive newest-first, so interleaving by title would bury a
    // sheet someone just touched under documents they have not opened in
    // months. They are matched separately and concatenated, documents first.
    const matchesTitle = (title: string) => (title || 'Untitled').toLowerCase().includes(needle);
    const documentOptions = (targets.data?.documents ?? []).filter((d) => matchesTitle(d.title)).map((d) => ({
      id: d.id,
      icon: <DocumentIcon doc={d} />,
      label: d.title || 'Untitled',
      hint: '',
      // What appears in the box: the title, not the id token.
      insert: `[[${d.title || 'Untitled'}]]`,
      token: documentRef(d.id),
    }));
    const sheetOptions = (targets.data?.spreadsheets ?? []).filter((s) => matchesTitle(s.title)).map((s) => ({
      id: s.id,
      icon: <SpreadsheetIcon sheet={s} />,
      label: s.title || 'Untitled',
      hint: 'Spreadsheet',
      insert: `[[${s.title || 'Untitled'}]]`,
      token: spreadsheetRef(s.id),
    }));
    // Six rows in all, but documents cannot crowd spreadsheets out of a list
    // that offers both: each kind is guaranteed up to half, and whatever the
    // other kind does not use is handed back.
    const documentShare = Math.min(
      documentOptions.length,
      Math.max(PICKER_LIMIT - sheetOptions.length, PICKER_LIMIT / 2),
    );
    return [
      ...documentOptions.slice(0, documentShare),
      ...sheetOptions.slice(0, PICKER_LIMIT - documentShare),
    ];
  }, [trigger, channels, direct, targets.data, workItems.data, projects.data, members.data, emojiOptions]);

  // Grow with the text, up to a limit, and shrink back once it is sent.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [value]);

  // Leaving the channel abandons the draft, so its unsent files go with it.
  useEffect(
    () => () => {
      for (const item of pendingRef.current) discard(item);
    },
    [],
  );

  const uploading = pending.some((p) => p.status === 'uploading');

  // A message sent while files were still uploading goes out once they finish.
  useEffect(() => {
    if (queued && !uploading) {
      setQueued(false);
      void send();
    }
    // send reads this render's state, which is what should go out.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queued, uploading]);

  useImperativeHandle(ref, () => ({ addFiles }));

  const typing = useTypingReporter(disabled ? undefined : onTyping);

  function sync(next: string, caret: number) {
    setValue(next);
    typing.changed(next);
    const found = findTrigger(next, caret);
    setTrigger(found);
    setHighlighted(0);
  }

  function choose(option: { insert: string; token: string }) {
    if (!trigger) return;
    const input = inputRef.current;
    const caret = input?.selectionStart ?? value.length;
    const before = value.slice(0, trigger.start);
    const after = value.slice(caret);
    const next = `${before}${option.insert} ${after}`;
    setValue(next);
    setTrigger(null);
    // Remembered so the readable label can be swapped for its id on send.
    if (option.insert !== option.token) picked.current.push({ label: option.insert, token: option.token });
    requestAnimationFrame(() => {
      input?.focus();
      const position = before.length + option.insert.length + 1;
      input?.setSelectionRange(position, position);
    });
  }

  function insertAtCaret(text: string) {
    const input = inputRef.current;
    const start = input?.selectionStart ?? value.length;
    const end = input?.selectionEnd ?? value.length;
    setValue(value.slice(0, start) + text + value.slice(end));
    setTrigger(null);
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(start + text.length, start + text.length);
    });
  }

  /**
   * Swaps the readable labels for the id tokens that actually get stored.
   *
   * Picked references go first, each replacing its own first remaining
   * occurrence. Then any `#name` typed by hand that matches a real channel is
   * linked too, so writing `#general` straight out works the same as choosing
   * it from the list, and so is `@here`.
   */
  function toTokens(text: string): string {
    let body = text;
    for (const { label, token } of picked.current) {
      // A string pattern replaces only the first match, which is what keeps two
      // references to the same title from collapsing onto one id.
      if (body.includes(label)) body = body.replace(label, token);
    }
    const byName = new Map(channels.map((c) => [c.name, c.id]));
    body = body.replace(/(^|\s)#([a-z0-9-]+)/g, (match, lead: string, name: string) => {
      const id = byName.get(name);
      return id ? `${lead}${channelRef(id)}` : match;
    });
    return direct ? body : body.replace(/(^|\s)@here(?![\w-])/gi, `$1${HERE_REF}`);
  }

  function update(key: string, patch: Partial<PendingFile>) {
    setPending((current) => current.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  }

  /** Stops an upload, or removes an uploaded file that will not be sent. */
  function discard(item: PendingFile) {
    item.controller.abort();
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    if (item.status === 'ready' && item.attachment) {
      void api.delete(`/attachments/${item.attachment.id}`).catch(() => {});
    }
  }

  function addFiles(files: File[]) {
    if (disabled || files.length === 0) return;
    const room = MAX_ATTACHMENTS_PER_MESSAGE - pendingRef.current.length;
    if (room <= 0) {
      toast(`A message can carry up to ${MAX_ATTACHMENTS_PER_MESSAGE} files`, 'error');
      return;
    }
    if (files.length > room) {
      toast(`Only ${room} more ${room === 1 ? 'file fits' : 'files fit'} in this message`, 'error');
    }

    const maxBytes = uploadConfig.data?.maxBytes;
    const added: PendingFile[] = [];
    for (const file of files.slice(0, room)) {
      // Checked here as well as on the server, which cuts an oversized upload
      // off partway and cannot always get its explanation back to the browser.
      if (maxBytes && file.size > maxBytes) {
        toast(`${file.name} is larger than the ${formatBytes(maxBytes)} limit`, 'error');
        continue;
      }
      const kind = attachmentKind(file.name);
      added.push({
        key: `file-${++nextKey}`,
        file,
        kind,
        previewUrl: kind === 'image' || kind === 'video' ? URL.createObjectURL(file) : null,
        progress: 0,
        status: 'uploading',
        controller: new AbortController(),
      });
    }
    if (added.length === 0) return;

    setPending((current) => [...current, ...added]);
    for (const item of added) void upload(item);
    inputRef.current?.focus();
  }

  async function upload(item: PendingFile) {
    try {
      const attachment = await uploadChatFile(channelId, item.file, {
        signal: item.controller.signal,
        onProgress: (progress) => update(item.key, { progress }),
      });
      if (item.controller.signal.aborted) {
        // Removed while the last bytes were landing.
        void api.delete(`/attachments/${attachment.id}`).catch(() => {});
        return;
      }
      update(item.key, { status: 'ready', progress: 1, attachment });
    } catch (err) {
      if (item.controller.signal.aborted) return;
      update(item.key, { status: 'failed', error: err instanceof Error ? err.message : 'Upload failed' });
    }
  }

  function removeFile(key: string) {
    const item = pendingRef.current.find((p) => p.key === key);
    if (item) discard(item);
    setPending((current) => current.filter((p) => p.key !== key));
  }

  async function send() {
    if (disabled || sending.current) return;
    if (pending.some((p) => p.status === 'uploading')) {
      setQueued(true);
      return;
    }

    const body = replaceShortcodes(toTokens(value)).trim();
    const ready = pending.filter((p) => p.status === 'ready' && p.attachment);
    if (!body && ready.length === 0) return;

    const draft = { value, pending, picked: picked.current };
    setValue('');
    setPending([]);
    setTrigger(null);
    picked.current = [];
    typing.sent();
    sending.current = true;
    try {
      await onSend({ body, attachmentIds: ready.map((p) => p.attachment!.id) });
      // Sent files are shown from the server now, and failed ones are dropped.
      for (const item of draft.pending) {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : 'The message could not be sent', 'error');
      // Put the draft back, unless something new was started in the meantime.
      setValue((current) => current || draft.value);
      setPending((current) => (current.length > 0 ? current : draft.pending));
      if (picked.current.length === 0) picked.current = draft.picked;
    } finally {
      sending.current = false;
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (trigger && options.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlighted((h) => (h + 1) % options.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlighted((h) => (h - 1 + options.length) % options.length);
        return;
      }
      // Enter picks the highlighted option rather than sending a half-typed
      // mention; Escape abandons the picker and leaves the text alone.
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        choose(options[highlighted]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setTrigger(null);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  const pickerLabel =
    trigger?.kind === 'channel'
      ? 'Channels'
      : trigger?.kind === 'member'
        ? 'People'
        : trigger?.kind === 'emoji'
          ? 'Emoji'
          : trigger?.kind === 'workItem'
            ? 'Boards, queues & work items'
            : 'Documents & spreadsheets';

  return (
    <div className="relative border-t border-[var(--color-line)] p-3">
      {trigger && options.length > 0 && (
        <div className="absolute bottom-full left-3 right-3 z-20 mb-1 overflow-hidden rounded-lg border border-[var(--color-line)] bg-[var(--color-raised)] shadow-lg">
          <div className="px-3 py-1.5 text-[11px] uppercase tracking-wide text-[var(--color-muted)]">{pickerLabel}</div>
          {options.map((option, index) => (
            <button
              key={option.id}
              type="button"
              onMouseDown={(e) => {
                // mousedown, not click: blurring the textarea first would close
                // the picker before the click landed.
                e.preventDefault();
                choose(option);
              }}
              onMouseEnter={() => setHighlighted(index)}
              className={cx(
                'flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-sm',
                index === highlighted && 'bg-[var(--color-surface)]',
              )}
            >
              <span className="min-w-0 flex-1 truncate">
                {'icon' in option && <>{option.icon} </>}
                {option.label}
              </span>
              {option.hint && <span className="truncate text-xs text-[var(--color-muted)]">{option.hint}</span>}
            </button>
          ))}
        </div>
      )}

      <div
        className={cx(
          'rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] focus-within:border-[var(--color-accent)]',
          disabled && 'opacity-60',
        )}
      >
        {pending.length > 0 && (
          <div className="flex flex-wrap gap-2 border-b border-[var(--color-line)] p-2">
            {pending.map((item) => (
              <PendingTile key={item.key} item={item} onRemove={() => removeFile(item.key)} />
            ))}
          </div>
        )}

        <div className="flex items-end gap-1 px-1">
          <IconButton
            label="Attach files"
            disabled={disabled}
            onClick={() => fileInput.current?.click()}
            className="mb-1.5 disabled:pointer-events-none"
          >
            <Icon name="plus-circle" />
          </IconButton>
          <textarea
            ref={inputRef}
            value={value}
            rows={1}
            disabled={disabled}
            placeholder={
              disabled
                ? 'You cannot post here'
                : `Message ${target}   —   @ someone, # a channel, [[ a document, : an emoji`
            }
            onChange={(e) => sync(e.target.value, e.target.selectionStart)}
            onKeyDown={onKeyDown}
            onBlur={() => setTrigger(null)}
            onPaste={(e) => {
              // A pasted screenshot or copied file arrives as a file, not text.
              const files = Array.from(e.clipboardData.files);
              if (files.length === 0) return;
              e.preventDefault();
              addFiles(files);
            }}
            className="max-h-40 min-w-0 flex-1 resize-none bg-transparent px-1 py-2 text-sm outline-none"
          />
          <IconButton
            label="Emoji"
            disabled={disabled}
            aria-expanded={emojiAnchor !== null}
            onClick={(e) => setEmojiAnchor(emojiAnchor ? null : e.currentTarget)}
            className="mb-1.5 disabled:pointer-events-none"
          >
            <Icon name="emoji-smile" />
          </IconButton>
        </div>
      </div>

      {queued && uploading && (
        <p className="mt-1 text-xs text-[var(--color-muted)]">Sending once the files finish uploading…</p>
      )}

      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          addFiles(Array.from(e.target.files ?? []));
          // Cleared so choosing the same file again still fires a change.
          e.target.value = '';
        }}
      />

      {emojiAnchor && (
        <EmojiPicker
          anchor={emojiAnchor}
          onSelect={(emoji) => {
            insertAtCaret(emoji);
            setEmojiAnchor(null);
          }}
          onClose={() => setEmojiAnchor(null)}
        />
      )}
    </div>
  );
});

function PendingTile({ item, onRemove }: { item: PendingFile; onRemove: () => void }) {
  const failed = item.status === 'failed';
  return (
    <div
      title={failed ? item.error : item.file.name}
      className={cx(
        'relative flex w-48 items-center gap-2 overflow-hidden rounded-md border bg-[var(--color-raised)] p-1.5 pr-7',
        failed ? 'border-red-500/60' : 'border-[var(--color-line)]',
      )}
    >
      <div className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded bg-[var(--color-surface)] text-xl text-[var(--color-muted)]">
        {item.previewUrl && item.kind === 'image' ? (
          <img src={item.previewUrl} alt="" className="h-full w-full object-cover" />
        ) : item.previewUrl && item.kind === 'video' ? (
          <video src={item.previewUrl} muted preload="metadata" className="h-full w-full object-cover" />
        ) : (
          <Icon name={fileIcon(item.file.name)} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium">{item.file.name}</div>
        <div className={cx('truncate text-[11px]', failed ? 'text-red-500' : 'text-[var(--color-muted)]')}>
          {failed
            ? item.error
            : item.status === 'uploading'
              ? `Uploading ${Math.round(item.progress * 100)}%`
              : formatBytes(item.file.size)}
        </div>
      </div>
      <button
        type="button"
        onClick={onRemove}
        title="Remove"
        aria-label={`Remove ${item.file.name}`}
        className="absolute right-1 top-1 grid h-5 w-5 place-items-center rounded text-[var(--color-muted)] hover:bg-[var(--color-line)] hover:text-[var(--color-ink)]"
      >
        <Icon name="x" />
      </button>
      {item.status === 'uploading' && (
        <div className="absolute inset-x-0 bottom-0 h-0.5 bg-[var(--color-line)]">
          <div className="h-full bg-[var(--color-accent)] transition-[width]" style={{ width: `${item.progress * 100}%` }} />
        </div>
      )}
    </div>
  );
}
