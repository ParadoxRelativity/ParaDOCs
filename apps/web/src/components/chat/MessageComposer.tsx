import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { channelRef, documentRef, memberRef, type Channel } from '@paradocs/shared';
import { useAllDocuments, useMembers } from '../../api/hooks';
import { cx } from '../../lib/util';
import { DocumentIcon } from '../Icon';

/**
 * The message box, with inline pickers for the two things you can reference.
 *
 * Typing `#` offers channels and `[[` offers documents. What gets inserted is
 * the id token, not the name — so the rendered link follows a rename — while
 * what you typed to find it never appears in the message.
 */

interface Trigger {
  kind: 'channel' | 'document' | 'member';
  /** Index of the trigger character(s) in the textarea value. */
  start: number;
  query: string;
}

const TRIGGERS: { kind: Trigger['kind']; token: string }[] = [
  { kind: 'document', token: '[[' },
  { kind: 'channel', token: '#' },
  { kind: 'member', token: '@' },
];

function findTrigger(value: string, caret: number): Trigger | null {
  for (const { kind, token } of TRIGGERS) {
    const start = value.lastIndexOf(token, caret - 1);
    if (start === -1) continue;
    const query = value.slice(start + token.length, caret);
    // A channel or document trigger ends at whitespace: "#general " is
    // finished, not a live search. A person's name has spaces in it, so a
    // mention stays open for one word and gives up after that.
    const limit = kind === 'member' ? /\s\S*\s/ : /\s/;
    if (limit.test(query)) continue;
    // `#` and `@` only start a mention at a word boundary, so "C#" and an
    // email address are left alone.
    if (kind !== 'document' && start > 0 && !/\s/.test(value[start - 1])) continue;
    return { kind, start, query };
  }
  return null;
}

export function MessageComposer({
  workspaceId,
  channels,
  channelName,
  disabled,
  onSend,
}: {
  workspaceId: string;
  channels: Channel[];
  channelName: string;
  disabled?: boolean;
  onSend: (body: string) => void;
}) {
  const [value, setValue] = useState('');
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // References chosen from a picker, in the order they were inserted.
  const picked = useRef<{ label: string; token: string }[]>([]);

  // Only fetched once the matching mention is actually being typed.
  const documents = useAllDocuments(trigger?.kind === 'document' ? workspaceId : undefined, {
    sort: 'updated',
    archived: false,
    limit: 200,
  });
  const members = useMembers(trigger?.kind === 'member' ? workspaceId : undefined);

  const options = useMemo(() => {
    if (!trigger) return [];
    const needle = trigger.query.toLowerCase();
    if (trigger.kind === 'channel') {
      return channels
        .filter((c) => c.name.includes(needle))
        .slice(0, 6)
        .map((c) => ({ id: c.id, label: `#${c.name}`, hint: c.topic ?? '', insert: `#${c.name}`, token: channelRef(c.id) }));
    }
    if (trigger.kind === 'member') {
      return (members.data ?? [])
        .filter((m) => m.name.toLowerCase().includes(needle) || m.email.toLowerCase().includes(needle))
        .slice(0, 6)
        .map((m) => ({
          id: m.userId,
          label: `@${m.name}`,
          hint: m.isSelf ? 'you' : m.email,
          insert: `@${m.name}`,
          token: memberRef(m.userId),
        }));
    }
    return (documents.data?.documents ?? [])
      .filter((d) => (d.title || 'Untitled').toLowerCase().includes(needle))
      .slice(0, 6)
      .map((d) => ({
        id: d.id,
        icon: <DocumentIcon doc={d} />,
        label: d.title || 'Untitled',
        hint: '',
        // What appears in the box: the title, not the id token.
        insert: `[[${d.title || 'Untitled'}]]`,
        token: documentRef(d.id),
      }));
  }, [trigger, channels, documents.data, members.data]);

  function sync(next: string, caret: number) {
    setValue(next);
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
    picked.current.push({ label: option.insert, token: option.token });
    requestAnimationFrame(() => {
      input?.focus();
      const position = before.length + option.insert.length + 1;
      input?.setSelectionRange(position, position);
    });
  }

  /**
   * Swaps the readable labels for the id tokens that actually get stored.
   *
   * Picked references go first, each replacing its own first remaining
   * occurrence. Then any `#name` typed by hand that matches a real channel is
   * linked too, so writing `#general` straight out works the same as choosing
   * it from the list.
   */
  function toTokens(text: string): string {
    let body = text;
    for (const { label, token } of picked.current) {
      // A string pattern replaces only the first match, which is what keeps two
      // references to the same title from collapsing onto one id.
      if (body.includes(label)) body = body.replace(label, token);
    }
    const byName = new Map(channels.map((c) => [c.name, c.id]));
    return body.replace(/(^|\s)#([a-z0-9-]+)/g, (match, lead: string, name: string) => {
      const id = byName.get(name);
      return id ? `${lead}${channelRef(id)}` : match;
    });
  }

  function send() {
    const body = toTokens(value).trim();
    if (!body) return;
    onSend(body);
    setValue('');
    setTrigger(null);
    picked.current = [];
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
      send();
    }
  }

  return (
    <div className="relative border-t border-[var(--color-line)] p-3">
      {trigger && options.length > 0 && (
        <div className="absolute bottom-full left-3 right-3 z-20 mb-1 overflow-hidden rounded-lg border border-[var(--color-line)] bg-[var(--color-raised)] shadow-lg">
          <div className="px-3 py-1.5 text-[11px] uppercase tracking-wide text-[var(--color-muted)]">
            {trigger.kind === 'channel' ? 'Channels' : trigger.kind === 'member' ? 'People' : 'Documents'}
          </div>
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

      <textarea
        ref={inputRef}
        value={value}
        rows={1}
        disabled={disabled}
        placeholder={
          disabled
            ? 'You cannot post here'
            : `Message #${channelName}   —   @ someone, # a channel, [[ a document`
        }
        onChange={(e) => sync(e.target.value, e.target.selectionStart)}
        onKeyDown={onKeyDown}
        onBlur={() => setTrigger(null)}
        className={cx(
          'max-h-40 w-full resize-none rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)]',
          'px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)] disabled:opacity-60',
        )}
        style={{ height: 'auto' }}
        onInput={(e) => {
          const el = e.currentTarget;
          el.style.height = 'auto';
          el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
        }}
      />
    </div>
  );
}
