import { useEffect, useMemo, useRef, useState } from 'react';
import { memberRef, parseMessage, type WorkspaceMember } from '@paradocs/shared';
import { cx } from '../../lib/util';
import Avatar from '../Avatar';

/**
 * Tagging people in canvas text.
 *
 * A canvas element's text is a plain string, so a tag is the `<@uuid>` token
 * chat already uses: the board stores who, never what they are called, and a
 * tag therefore keeps up with a rename on its own.
 *
 * That leaves two jobs. While the text is being read the tokens have to be
 * drawn as names, and while it is being typed an `@` has to offer the people it
 * could mean. Both live here so every text-carrying element — notes, labels,
 * shapes, mind-map nodes — behaves the same way.
 */

/** A tagged name as it is drawn on the board. */
export function MentionChip({ name, unknown = false }: { name: string; unknown?: boolean }) {
  return (
    <span
      className={cx(
        'rounded px-1 font-medium',
        unknown
          ? 'bg-[var(--color-line)] text-[var(--color-muted)]'
          : 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]',
      )}
    >
      @{name}
    </span>
  );
}

/**
 * Canvas text with its tags drawn as names. Someone no longer in the workspace
 * still reads as a tag rather than as raw markup — the tag was a real thing
 * that happened, and hiding it would silently change what the board says.
 */
export function renderMentionText(text: string, names: Map<string, string>) {
  if (!text.includes('<@')) return text;
  return parseMessage(text).map((segment, index) => {
    if (segment.type === 'text') return <span key={index}>{segment.value}</span>;
    if (segment.type !== 'member') return null;
    const name = names.get(segment.id);
    return <MentionChip key={index} name={name ?? 'unknown'} unknown={!name} />;
  });
}

/** Everyone in the workspace, by id, for drawing tags. */
export function useMemberNames(members: WorkspaceMember[] | undefined): Map<string, string> {
  return useMemo(() => new Map((members ?? []).map((m) => [m.userId, m.name])), [members]);
}

// --- typing a tag -----------------------------------------------------------

/** The `@…` being typed at the caret, or null when the caret is not in one. */
export function mentionQueryAt(value: string, caret: number): { query: string; start: number } | null {
  const before = value.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at === -1) return null;
  // Only at a word boundary, so an email address is not read as a tag.
  if (at > 0 && !/[\s(>]/.test(before[at - 1])) return null;
  const query = before.slice(at + 1);
  // A name is one or two words at most; anything longer is ordinary prose that
  // happens to follow an @.
  if (!/^[^\n@]{0,40}$/.test(query)) return null;
  return { query, start: at };
}

export interface MentionPick {
  id: string;
  name: string;
  avatarUrl: string | null;
}

/**
 * The list of people an `@` could mean, floating over the element being typed
 * in. Keyboard-first: the arrows move, Enter or Tab picks, Escape dismisses
 * without losing what has been typed.
 */
export function MentionPicker({
  members,
  query,
  onPick,
  onDismiss,
}: {
  members: WorkspaceMember[];
  query: string;
  onPick: (member: MentionPick) => void;
  onDismiss: () => void;
}) {
  const needle = query.trim().toLowerCase();
  const matches = useMemo(
    () =>
      members
        .filter((m) => m.name.toLowerCase().includes(needle))
        .slice(0, 6)
        .map((m) => ({ id: m.userId, name: m.name, avatarUrl: m.avatarUrl })),
    [members, needle],
  );

  const [active, setActive] = useState(0);
  // A narrowing query can leave the highlight past the end of the list.
  useEffect(() => setActive(0), [needle]);

  const activeRef = useRef({ matches, active, onPick, onDismiss });
  activeRef.current = { matches, active, onPick, onDismiss };

  // Listened for in the capture phase: the textarea underneath handles its own
  // keys and would otherwise move the caret before this ever saw the arrow.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const { matches: list, active: index, onPick: pick, onDismiss: dismiss } = activeRef.current;
      if (list.length === 0) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        setActive((current) =>
          event.key === 'ArrowDown' ? (current + 1) % list.length : (current - 1 + list.length) % list.length,
        );
      } else if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        event.stopPropagation();
        pick(list[index] ?? list[0]);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        dismiss();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  if (matches.length === 0) return null;

  return (
    <div
      role="listbox"
      aria-label="People"
      className="absolute left-0 top-full z-30 mt-1 w-56 overflow-hidden rounded-lg border border-[var(--color-line)] bg-[var(--color-raised)] py-1 shadow-xl"
      // The textarea must keep the focus: losing it would commit the text and
      // close the very editor this list is for.
      onMouseDown={(event) => event.preventDefault()}
    >
      {matches.map((member, index) => (
        <button
          key={member.id}
          role="option"
          aria-selected={index === active}
          onMouseEnter={() => setActive(index)}
          onClick={() => onPick(member)}
          className={cx(
            'flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm',
            index === active ? 'bg-[var(--color-surface)]' : 'hover:bg-[var(--color-surface)]',
          )}
        >
          <Avatar name={member.name} url={member.avatarUrl} seed={member.id} size="sm" />
          <span className="min-w-0 flex-1 truncate">{member.name}</span>
        </button>
      ))}
    </div>
  );
}

/** Replaces the `@…` being typed with a tag, and says where the caret lands. */
export function applyMention(
  value: string,
  at: { query: string; start: number },
  member: MentionPick,
): { text: string; caret: number } {
  const token = `${memberRef(member.id)} `;
  const head = value.slice(0, at.start);
  const tail = value.slice(at.start + 1 + at.query.length);
  return { text: `${head}${token}${tail}`, caret: head.length + token.length };
}
