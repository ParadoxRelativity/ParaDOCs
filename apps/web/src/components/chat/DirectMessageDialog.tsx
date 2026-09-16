import { useMemo, useState } from 'react';
import { MAX_DIRECT_PEOPLE, type PresenceStatus, type WorkspaceMember } from '@paradocs/shared';
import { useMembers } from '../../api/hooks';
import { cx } from '../../lib/util';
import Icon from '../Icon';
import { Modal } from '../Modal';
import { PresenceAvatar, STATUS_LABEL } from '../Presence';
import { FIELD } from '../SettingsParts';
import { Button, Spinner } from '../ui';

const NO_ONE: string[] = [];

/**
 * Picks who to talk to: one person, or several for a group conversation. Also
 * picks who to add to a conversation that already has people in it.
 *
 * Choosing someone adds them to the list rather than opening anything, so a
 * group is built up the same way as a pair. Enter on an empty search finishes
 * with whoever has been picked.
 */
export function DirectMessageDialog({
  workspaceId,
  presence,
  title = 'New direct message',
  excludeIds = NO_ONE,
  capacity = MAX_DIRECT_PEOPLE - 1,
  actionLabel = (count) => (count > 1 ? `Message ${count} people` : 'Message'),
  note,
  onChoose,
  onClose,
}: {
  workspaceId: string;
  presence: Record<string, PresenceStatus>;
  title?: string;
  /** People already in the conversation, who are not offered. */
  excludeIds?: string[];
  /** How many can be picked. */
  capacity?: number;
  actionLabel?: (count: number) => string;
  /** Said under the search, such as what the people added will be able to see. */
  note?: string;
  onChoose: (userIds: string[]) => void;
  onClose: () => void;
}) {
  const members = useMembers(workspaceId);
  const [search, setSearch] = useState('');
  const [highlighted, setHighlighted] = useState(0);
  const [picked, setPicked] = useState<WorkspaceMember[]>([]);

  const matches = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (members.data ?? [])
      .filter((m) => !m.isSelf && !excludeIds.includes(m.userId))
      .filter((m) => !needle || m.name.toLowerCase().includes(needle) || m.email.toLowerCase().includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }, [members.data, search, excludeIds]);
  const index = Math.min(highlighted, Math.max(matches.length - 1, 0));
  const alone = (members.data ?? []).every((m) => m.isSelf || excludeIds.includes(m.userId));
  const full = picked.length >= capacity;

  const isPicked = (member: WorkspaceMember) => picked.some((p) => p.userId === member.userId);

  function toggle(member: WorkspaceMember) {
    if (isPicked(member)) {
      setPicked((current) => current.filter((p) => p.userId !== member.userId));
    } else if (!full) {
      setPicked((current) => [...current, member]);
    }
    // Picked from a search: clear it, ready for the next name.
    setSearch('');
    setHighlighted(0);
  }

  function start() {
    if (picked.length > 0) onChoose(picked.map((p) => p.userId));
  }

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="subtle" className="text-xs" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" className="text-xs" disabled={picked.length === 0} onClick={start}>
            {actionLabel(picked.length)}
          </Button>
        </>
      }
    >
      <div
        className={cx(FIELD, 'flex min-h-9 flex-wrap items-center gap-1 py-1 focus-within:border-[var(--color-accent)]')}
        onClick={(e) => e.currentTarget.querySelector('input')?.focus()}
      >
        {picked.map((member) => (
          <span
            key={member.userId}
            className="inline-flex items-center gap-1 rounded bg-[var(--color-accent)]/15 py-0.5 pl-1.5 pr-0.5 text-xs font-medium text-[var(--color-accent)]"
          >
            {member.name}
            <button
              type="button"
              aria-label={`Remove ${member.name}`}
              onClick={() => toggle(member)}
              className="grid h-4 w-4 place-items-center rounded hover:bg-[var(--color-accent)]/20"
            >
              <Icon name="x" />
            </button>
          </span>
        ))}
        <input
          autoFocus
          className="min-w-32 flex-1 bg-transparent outline-none"
          placeholder={picked.length === 0 ? 'Find someone by name or email' : full ? '' : 'Add someone else'}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setHighlighted(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && matches.length > 0) {
              e.preventDefault();
              setHighlighted((index + 1) % matches.length);
            } else if (e.key === 'ArrowUp' && matches.length > 0) {
              e.preventDefault();
              setHighlighted((index - 1 + matches.length) % matches.length);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              // With nothing typed, Enter means done; otherwise it picks.
              if (!search.trim() && picked.length > 0) start();
              else if (matches[index]) toggle(matches[index]);
            } else if (e.key === 'Backspace' && !search && picked.length > 0) {
              e.preventDefault();
              setPicked((current) => current.slice(0, -1));
            }
          }}
        />
      </div>
      {note && <p className="mt-1.5 text-xs text-[var(--color-muted)]">{note}</p>}
      {full && (
        <p className="mt-1.5 text-xs text-[var(--color-muted)]">
          A conversation can have up to {MAX_DIRECT_PEOPLE} people, you included.
        </p>
      )}
      <div className="scroll-thin -mx-1 mt-2 max-h-72 overflow-y-auto px-1">
        {members.isLoading ? (
          <Spinner />
        ) : matches.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-[var(--color-muted)]">
            {alone
              ? excludeIds.length > 0
                ? 'Everyone in this workspace is already in the conversation.'
                : 'No one else is in this workspace yet. Invite people from Settings → Members.'
              : 'No one matches that.'}
          </p>
        ) : (
          matches.map((member, i) => {
            const status = presence[member.userId] ?? 'offline';
            const selected = isPicked(member);
            return (
              <button
                key={member.userId}
                aria-pressed={selected}
                disabled={full && !selected}
                onMouseEnter={() => setHighlighted(i)}
                onClick={() => toggle(member)}
                className={cx(
                  'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left disabled:opacity-50',
                  i === index && 'bg-[var(--color-surface)]',
                )}
              >
                <PresenceAvatar
                  name={member.name}
                  url={member.avatarUrl}
                  seed={member.userId}
                  size="lg"
                  status={status}
                  ring={i === index ? 'var(--color-surface)' : 'var(--color-raised)'}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{member.name}</span>
                  <span className="block truncate text-[11px] text-[var(--color-muted)]">{member.email}</span>
                </span>
                {selected ? (
                  <Icon name="check-lg" className="shrink-0 text-[var(--color-accent)]" />
                ) : (
                  <span className="shrink-0 text-[11px] text-[var(--color-muted)]">{STATUS_LABEL[status]}</span>
                )}
              </button>
            );
          })
        )}
      </div>
    </Modal>
  );
}
