import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  channelRef,
  documentRef,
  memberRef,
  parseMessage,
  projectRef,
  spreadsheetRef,
  workItemRef,
  type MessageReferences,
} from '@paradocs/shared';
import {
  useAppEnabled,
  useChannels,
  useMembers,
  useLinkTargets,
  useProjects,
  useWorkItemListing,
} from '../../api/hooks';
import { cx, useDebounced } from '../../lib/util';
import Avatar from '../Avatar';
import Icon, { DocumentIcon, SpreadsheetIcon } from '../Icon';
import { INSERTED_REF, WORK_ITEM_TRIGGER, matchProjects, projectLabel } from '../chat/MessageComposer';
import { Button } from '../ui';

/**
 * Writing a work item's description or a comment on it.
 *
 * What is stored is written the way a chat message is, with id tokens, and
 * what is typed reads the way the chat box does: `@` offers people, `#`
 * channels, `[[` documents and spreadsheets, and `\\` other work items, boards and queues. The box
 * shows names, and they are swapped for their tokens when saved, so a
 * reference follows a rename.
 */

interface Trigger {
  kind: 'member' | 'channel' | 'link' | 'item';
  start: number;
  query: string;
}

interface Option {
  id: string;
  icon: ReactNode;
  label: string;
  hint: string;
  insert: string;
  token: string;
}

const LIMIT = 8;

function findTrigger(value: string, caret: number): Trigger | null {
  const tokens: { kind: Trigger['kind']; token: string }[] = [
    { kind: 'item', token: WORK_ITEM_TRIGGER },
    { kind: 'link', token: '[[' },
    { kind: 'channel', token: '#' },
    { kind: 'member', token: '@' },
  ];
  for (const { kind, token } of tokens) {
    const start = value.lastIndexOf(token, caret - 1);
    if (start === -1) continue;
    const query = value.slice(start + token.length, caret);
    // A name can have one space in it; a link may have several words.
    const limit =
      kind === 'member' ? /\s\S*\s|\n/ : kind === 'channel' ? /\s/ : kind === 'item' ? /\n|\s\S*\s\S*\s/ : /\n|]]/;
    if (limit.test(query) || query.length > 60) continue;
    // A work item, board or queue already inserted, with more written after it.
    if (kind === 'item' && INSERTED_REF.test(query)) continue;
    if (kind !== 'link' && start > 0 && !/\s|\(/.test(value[start - 1])) continue;
    return { kind, start, query };
  }
  return null;
}

/** A stored body as the box shows it, and what each name there stands for. */
function toDisplay(body: string, references: MessageReferences | undefined): { text: string; picked: { label: string; token: string }[] } {
  const picked: { label: string; token: string }[] = [];
  const refs = references ?? { documents: [], spreadsheets: [], channels: [], members: [], workItems: [] };
  const text = parseMessage(body)
    .map((segment) => {
      if (segment.type === 'text') return segment.value;
      if (segment.type === 'here') return '<!here>';
      let label: string | undefined;
      let token = '';
      if (segment.type === 'member') {
        const name = refs.members.find((m) => m.id === segment.id)?.name;
        label = name && `@${name}`;
        token = memberRef(segment.id);
      } else if (segment.type === 'channel') {
        const name = refs.channels.find((c) => c.id === segment.id)?.name;
        label = name && `#${name}`;
        token = channelRef(segment.id);
      } else if (segment.type === 'document') {
        const title = refs.documents.find((d) => d.id === segment.id)?.title;
        label = title !== undefined ? `[[${title || 'Untitled'}]]` : undefined;
        token = documentRef(segment.id);
      } else if (segment.type === 'spreadsheet') {
        const title = refs.spreadsheets.find((s) => s.id === segment.id)?.title;
        label = title !== undefined ? `[[${title || 'Untitled'}]]` : undefined;
        token = spreadsheetRef(segment.id);
      } else if (segment.type === 'project') {
        const project = (refs.projects ?? []).find((p) => p.id === segment.id);
        label = project && projectLabel(project);
        token = projectRef(segment.id);
      } else {
        const key = (refs.workItems ?? []).find((i) => i.id === segment.id)?.key;
        label = key && `${WORK_ITEM_TRIGGER}${key}`;
        token = workItemRef(segment.id);
      }
      // Something the reader cannot see stays as it was stored, so saving an
      // edit does not quietly drop a link someone else put there.
      if (!label) return token;
      picked.push({ label, token });
      return label;
    })
    .join('');
  return { text, picked };
}

export default function ReferenceEditor({
  workspaceId,
  initialBody = '',
  references,
  placeholder,
  submitLabel,
  autoFocus,
  minRows = 3,
  onSubmit,
  onCancel,
}: {
  workspaceId: string;
  initialBody?: string;
  references?: MessageReferences;
  placeholder?: string;
  submitLabel: string;
  autoFocus?: boolean;
  minRows?: number;
  /** Resolves once saved; the box clears itself when there is nothing to cancel back to. */
  onSubmit: (body: string) => Promise<unknown> | void;
  onCancel?: () => void;
}) {
  const initial = useMemo(() => toDisplay(initialBody, references), [initialBody, references]);
  const [value, setValue] = useState(initial.text);
  const picked = useRef(initial.picked);
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [highlighted, setHighlighted] = useState(0);
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);

  const docsOn = useAppEnabled(workspaceId, 'docs');
  const sheetsOn = useAppEnabled(workspaceId, 'sheets');
  const chatOn = useAppEnabled(workspaceId, 'chat');
  const linking = trigger?.kind === 'link';
  const itemSearch = trigger?.kind === 'item';
  const members = useMembers(trigger?.kind === 'member' ? workspaceId : undefined);
  const channels = useChannels(trigger?.kind === 'channel' && chatOn ? workspaceId : undefined);
  // Searched on the server as the name is typed, so nothing is out of reach
  // however many documents and spreadsheets the workspace holds.
  const linkQuery = useDebounced(linking ? trigger.query.trim() : '', 150);
  const targets = useLinkTargets(linking && (docsOn || sheetsOn) ? workspaceId : undefined, linkQuery, { limit: 4 });
  const workItems = useWorkItemListing(itemSearch ? workspaceId : undefined, {
    q: itemSearch ? trigger.query || undefined : undefined,
    limit: LIMIT,
  });
  const projects = useProjects(itemSearch ? workspaceId : undefined);

  const options: Option[] = useMemo(() => {
    if (!trigger) return [];
    const needle = trigger.query.toLowerCase();
    if (trigger.kind === 'member') {
      return (members.data ?? [])
        .filter((m) => m.name.toLowerCase().includes(needle) || m.email.toLowerCase().includes(needle))
        .slice(0, LIMIT)
        .map((m) => ({
          id: m.userId,
          icon: <Avatar name={m.name} url={m.avatarUrl} seed={m.userId} size="xs" />,
          label: m.name,
          hint: m.isSelf ? 'you' : m.email,
          insert: `@${m.name}`,
          token: memberRef(m.userId),
        }));
    }
    if (trigger.kind === 'channel') {
      return (channels.data ?? [])
        .filter((c) => c.kind === 'text' && c.name.includes(needle))
        .slice(0, LIMIT)
        .map((c) => ({ id: c.id, icon: <Icon name="hash" />, label: c.name, hint: c.topic ?? '', insert: `#${c.name}`, token: channelRef(c.id) }));
    }
    if (trigger.kind === 'item') {
      const boards = matchProjects(projects.data, trigger.query).map((p) => ({
        id: p.id,
        icon: <Icon name={p.kind === 'queue' ? 'inboxes' : 'kanban'} />,
        label: p.name,
        hint: p.kind === 'queue' ? 'Queue' : 'Board',
        insert: projectLabel(p),
        token: projectRef(p.id),
      }));
      const items = (workItems.data ?? []).map((item) => ({
        id: item.id,
        icon: <Icon name="card-text" />,
        label: `${item.key} ${item.title}`,
        hint: item.status.name,
        insert: `${WORK_ITEM_TRIGGER}${item.key}`,
        token: workItemRef(item.id),
      }));
      return [...boards, ...items].slice(0, LIMIT);
    }
    // The last answer stays up while the next is asked, so anything it holds
    // that no longer matches what is typed is left out.
    const matches = (title: string) => (title || 'Untitled').toLowerCase().includes(needle);
    const docs = (targets.data?.documents ?? []).filter((d) => matches(d.title)).slice(0, 4).map((d) => ({
      id: d.id,
      icon: <DocumentIcon doc={d} />,
      label: d.title || 'Untitled',
      hint: d.mode === 'canvas' ? 'Canvas' : 'Document',
      insert: `[[${d.title || 'Untitled'}]]`,
      token: documentRef(d.id),
    }));
    const sheets = (targets.data?.spreadsheets ?? []).filter((s) => matches(s.title)).slice(0, 3).map((s) => ({
      id: s.id,
      icon: <SpreadsheetIcon sheet={s} />,
      label: s.title || 'Untitled',
      hint: 'Spreadsheet',
      insert: `[[${s.title || 'Untitled'}]]`,
      token: spreadsheetRef(s.id),
    }));
    return [...docs, ...sheets].slice(0, LIMIT);
  }, [trigger, members.data, channels.data, targets.data, workItems.data, projects.data]);

  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + 2, 420)}px`;
  }, [value]);

  function sync(next: string, caret: number) {
    setValue(next);
    setTrigger(findTrigger(next, caret));
    setHighlighted(0);
  }

  function choose(option: Option) {
    if (!trigger) return;
    const el = input.current;
    const caret = el?.selectionStart ?? value.length;
    const before = value.slice(0, trigger.start);
    const next = `${before}${option.insert} ${value.slice(caret)}`;
    setValue(next);
    setTrigger(null);
    picked.current.push({ label: option.insert, token: option.token });
    requestAnimationFrame(() => {
      el?.focus();
      const position = before.length + option.insert.length + 1;
      el?.setSelectionRange(position, position);
    });
  }

  /** Names back into tokens, each picked name replacing its own first remaining occurrence. */
  function toBody(text: string): string {
    let body = text;
    for (const { label, token } of picked.current) {
      if (body.includes(label)) body = body.replace(label, token);
    }
    return body.trim();
  }

  async function submit() {
    const body = toBody(value);
    if (saving) return;
    setSaving(true);
    try {
      await onSubmit(body);
      if (!onCancel) {
        setValue('');
        picked.current = [];
      }
    } catch {
      // Whoever submitted has said what went wrong; the text stays to try again.
    } finally {
      setSaving(false);
    }
  }

  const unchanged = toBody(value) === initialBody.trim();

  return (
    <div className="relative">
      <textarea
        ref={input}
        autoFocus={autoFocus}
        value={value}
        rows={minRows}
        placeholder={placeholder}
        onChange={(e) => sync(e.target.value, e.target.selectionStart)}
        onClick={(e) => setTrigger(findTrigger(value, e.currentTarget.selectionStart))}
        onBlur={() => setTimeout(() => setTrigger(null), 150)}
        onKeyDown={(e) => {
          if (trigger && options.length > 0) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const step = e.key === 'ArrowDown' ? 1 : -1;
              setHighlighted((current) => (current + step + options.length) % options.length);
              return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault();
              choose(options[highlighted] ?? options[0]);
              return;
            }
          }
          if (e.key === 'Escape') {
            if (trigger) {
              e.preventDefault();
              e.stopPropagation();
              setTrigger(null);
            } else if (onCancel) {
              e.preventDefault();
              e.stopPropagation();
              onCancel();
            }
            return;
          }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
        className="scroll-thin w-full resize-none rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-2.5 py-2 text-sm leading-relaxed outline-none focus:border-[var(--color-accent)]"
      />

      {trigger && options.length > 0 && (
        <div
          role="listbox"
          className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-lg border border-[var(--color-line)] bg-[var(--color-raised)] py-1 shadow-xl"
          onMouseDown={(e) => e.preventDefault()}
        >
          {options.map((option, index) => (
            <button
              key={`${option.token}`}
              role="option"
              aria-selected={index === highlighted}
              onMouseEnter={() => setHighlighted(index)}
              onClick={() => choose(option)}
              className={cx(
                'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm',
                index === highlighted && 'bg-[var(--color-surface)]',
              )}
            >
              <span className="grid w-4 shrink-0 place-items-center text-xs text-[var(--color-muted)]">{option.icon}</span>
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {option.hint && <span className="shrink-0 truncate text-xs text-[var(--color-muted)]">{option.hint}</span>}
            </button>
          ))}
        </div>
      )}

      <div className="mt-1.5 flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-muted)]">
          @ people · # channels · [[ documents and spreadsheets · {WORK_ITEM_TRIGGER} work items and boards · ⌘↵ to save
        </span>
        {onCancel && (
          <Button variant="subtle" className="text-xs" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
        )}
        <Button
          variant="primary"
          className="text-xs"
          onClick={() => void submit()}
          disabled={saving || (onCancel ? unchanged : !value.trim())}
        >
          {saving ? 'Saving…' : submitLabel}
        </Button>
      </div>
    </div>
  );
}
