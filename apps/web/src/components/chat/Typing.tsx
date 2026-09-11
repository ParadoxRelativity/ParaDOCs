import type { ReactNode } from 'react';
import { useTypists } from '../../lib/typing';
import { cx } from '../../lib/util';

export function TypingDots({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cx('inline-flex items-center gap-[3px]', className)}>
      {[0, 160, 320].map((delay) => (
        <span
          key={delay}
          className="paradocs-typing-dot h-1 w-1 rounded-full bg-current"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  );
}

/**
 * Who else is typing here, on the line above the message box. The line keeps
 * its height when nobody is, so the conversation does not jump each time
 * someone starts or stops.
 */
export function TypingIndicator({ channelId }: { channelId: string }) {
  const typists = useTypists(channelId);
  return (
    <div
      aria-live="polite"
      className="flex h-5 shrink-0 items-center gap-1.5 px-5 text-[11px] text-[var(--color-muted)]"
    >
      {typists.length > 0 && (
        <>
          <TypingDots />
          <span className="truncate">{describe(typists.map((t) => t.name))}</span>
        </>
      )}
    </div>
  );
}

function describe(names: string[]): ReactNode {
  const name = (value: string) => <span className="font-semibold text-[var(--color-ink)]">{value}</span>;
  if (names.length === 1) return <>{name(names[0])} is typing…</>;
  if (names.length === 2) {
    return (
      <>
        {name(names[0])} and {name(names[1])} are typing…
      </>
    );
  }
  if (names.length === 3) {
    return (
      <>
        {name(names[0])}, {name(names[1])} and {name(names[2])} are typing…
      </>
    );
  }
  return 'Several people are typing…';
}
