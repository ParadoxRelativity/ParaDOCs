import type { MessageReaction } from '@paradocs/shared';
import { cx } from '../../lib/util';
import Icon from '../Icon';

/** "You, Ann and 2 others reacted with 👍" */
function describe(reaction: MessageReaction, selfId: string): string {
  const names = reaction.users.map((user) => (user.id === selfId ? 'You' : user.name));
  // Yourself first: it is the part you are checking for.
  names.sort((a, b) => Number(b === 'You') - Number(a === 'You'));
  const shown = names.slice(0, 3);
  const rest = names.length - shown.length;
  const people =
    rest > 0
      ? `${shown.join(', ')} and ${rest} ${rest === 1 ? 'other' : 'others'}`
      : shown.length > 1
        ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`
        : shown[0];
  return `${people} reacted with ${reaction.emoji}`;
}

/** The reactions under a message. Clicking one joins it, or takes yours back. */
export function Reactions({
  reactions,
  selfId,
  canReact,
  onToggle,
  onAdd,
}: {
  reactions: MessageReaction[];
  selfId: string;
  canReact: boolean;
  onToggle: (emoji: string, on: boolean) => void;
  onAdd: (anchor: HTMLElement) => void;
}) {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {reactions.map((reaction) => {
        const mine = reaction.users.some((user) => user.id === selfId);
        return (
          <button
            key={reaction.emoji}
            type="button"
            aria-pressed={mine}
            disabled={!canReact}
            title={describe(reaction, selfId)}
            onClick={() => onToggle(reaction.emoji, !mine)}
            className={cx(
              'inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs tabular-nums transition-colors disabled:cursor-default',
              mine
                ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/15 font-medium text-[var(--color-accent)]'
                : 'border-[var(--color-line)] bg-[var(--color-surface)] hover:border-[var(--color-muted)]',
            )}
          >
            <span className="text-sm leading-none">{reaction.emoji}</span>
            {reaction.users.length}
          </button>
        );
      })}
      {canReact && (
        <button
          type="button"
          title="Add reaction"
          aria-label="Add reaction"
          onClick={(e) => onAdd(e.currentTarget)}
          className="inline-flex h-6 items-center gap-0.5 rounded-full border border-[var(--color-line)] px-2 text-xs text-[var(--color-muted)] hover:border-[var(--color-muted)] hover:text-[var(--color-ink)]"
        >
          <Icon name="emoji-smile" />
          <Icon name="plus" />
        </button>
      )}
    </div>
  );
}
