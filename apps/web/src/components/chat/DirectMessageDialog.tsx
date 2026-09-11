import { useMemo, useState } from 'react';
import type { PresenceStatus } from '@paradocs/shared';
import { useMembers } from '../../api/hooks';
import { cx } from '../../lib/util';
import { Modal } from '../Modal';
import { PresenceAvatar, STATUS_LABEL } from '../Presence';
import { FIELD } from '../SettingsParts';
import { Button, Spinner } from '../ui';

/** Picks someone in the workspace to talk to one-to-one. */
export function DirectMessageDialog({
  workspaceId,
  presence,
  onChoose,
  onClose,
}: {
  workspaceId: string;
  presence: Record<string, PresenceStatus>;
  onChoose: (userId: string) => void;
  onClose: () => void;
}) {
  const members = useMembers(workspaceId);
  const [search, setSearch] = useState('');
  const [highlighted, setHighlighted] = useState(0);

  const matches = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (members.data ?? [])
      .filter((m) => !m.isSelf)
      .filter((m) => !needle || m.name.toLowerCase().includes(needle) || m.email.toLowerCase().includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }, [members.data, search]);
  const index = Math.min(highlighted, Math.max(matches.length - 1, 0));
  const alone = (members.data ?? []).every((m) => m.isSelf);

  return (
    <Modal
      title="New direct message"
      description="Talk one-to-one with someone in this workspace."
      onClose={onClose}
      footer={
        <Button variant="subtle" className="text-xs" onClick={onClose}>
          Cancel
        </Button>
      }
    >
      <input
        autoFocus
        className={FIELD}
        placeholder="Find someone by name or email"
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
          } else if (e.key === 'Enter' && matches[index]) {
            e.preventDefault();
            onChoose(matches[index].userId);
          }
        }}
      />
      <div className="scroll-thin -mx-1 mt-2 max-h-72 overflow-y-auto px-1">
        {members.isLoading ? (
          <Spinner />
        ) : matches.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-[var(--color-muted)]">
            {alone
              ? 'No one else is in this workspace yet. Invite people from Settings → Members.'
              : 'No one matches that.'}
          </p>
        ) : (
          matches.map((member, i) => {
            const status = presence[member.userId] ?? 'offline';
            return (
              <button
                key={member.userId}
                onMouseEnter={() => setHighlighted(i)}
                onClick={() => onChoose(member.userId)}
                className={cx(
                  'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left',
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
                <span className="shrink-0 text-[11px] text-[var(--color-muted)]">{STATUS_LABEL[status]}</span>
              </button>
            );
          })
        )}
      </div>
    </Modal>
  );
}
