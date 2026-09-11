import { useRef, useState } from 'react';
import { cx } from '../lib/util';
import Icon, { type IconName } from './Icon';
import { Popover } from './Popover';

export interface AppEntry {
  id: string;
  label: string;
  icon: IconName;
  /** Ordinary unread, drawn in the accent color. */
  badge?: number;
  /** Things addressed to you. Louder than `badge`, and shown instead of it. */
  mentions?: number;
}

/**
 * How many columns the grid uses.
 *
 * One app sits alone and two stack, which reads as a pair rather than a row.
 * Beyond that it fills two columns, and three once there are more than six —
 * so the grid grows 2×2, 2×3, 3×3 as apps are added.
 */
export function columnsFor(count: number): number {
  if (count <= 2) return 1;
  if (count <= 6) return 2;
  return 3;
}

/**
 * Which half of the workspace the sidebar is showing — the knowledge base, or
 * chat — chosen from a grid of apps rather than a row of tabs, so that adding
 * a third and fourth app needs no new room in the sidebar.
 */
export function AppLauncher({
  apps,
  currentId,
  onSelect,
}: {
  apps: AppEntry[];
  currentId: string;
  onSelect: (id: string) => void;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const tiles = useRef<(HTMLButtonElement | null)[]>([]);

  const current = apps.find((app) => app.id === currentId) ?? apps[0];
  // What is waiting in the apps you are not looking at, so the button carries
  // what the tabs used to say.
  const elsewhere = apps.filter((app) => app.id !== currentId);
  const waiting = elsewhere.reduce((total, app) => total + (app.badge ?? 0), 0);
  const urgent = elsewhere.some((app) => (app.mentions ?? 0) > 0);
  const columns = columnsFor(apps.length);

  /** Arrow keys walk the grid, as the pointer would. */
  function onGridKey(event: React.KeyboardEvent) {
    const steps: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns };
    const step = steps[event.key];
    const from = tiles.current.findIndex((tile) => tile === document.activeElement);
    if (step === undefined || from === -1) return;
    event.preventDefault();
    const to = from + step;
    if (to >= 0 && to < apps.length) tiles.current[to]?.focus();
  }

  return (
    <>
      <button
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        aria-label={`${current?.label ?? 'Apps'} — switch app`}
        title="Switch app"
        className={cx(
          'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm',
          anchor ? 'bg-[var(--color-line)]/70' : 'hover:bg-[var(--color-line)]/50',
        )}
      >
        <Icon name="grid-3x3-gap-fill" className="text-[var(--color-muted)]" />
        <span className="min-w-0 flex-1 truncate text-left font-medium">{current?.label}</span>
        {waiting > 0 && <Badge count={waiting} urgent={urgent} />}
        <Icon name="chevron-down" className="text-[10px] text-[var(--color-muted)]" />
      </button>

      {anchor && (
        <Popover anchor={anchor} placement="below" onClose={() => setAnchor(null)}>
          <div
            role="menu"
            aria-label="Apps"
            onKeyDown={onGridKey}
            className="grid gap-1 p-2"
            style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
          >
            {apps.map((app, index) => {
              const active = app.id === currentId;
              const count = app.mentions || app.badge || 0;
              return (
                <button
                  key={app.id}
                  ref={(element) => {
                    tiles.current[index] = element;
                  }}
                  role="menuitem"
                  autoFocus={active}
                  aria-current={active}
                  onClick={() => {
                    setAnchor(null);
                    onSelect(app.id);
                  }}
                  className={cx(
                    'relative flex w-24 flex-col items-center gap-1.5 rounded-lg px-2 py-3',
                    'outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]',
                    active
                      ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                      : 'hover:bg-[var(--color-surface)]',
                  )}
                >
                  <Icon name={app.icon} className="text-xl" />
                  <span className="max-w-full truncate text-xs font-medium">{app.label}</span>
                  {count > 0 && (
                    <span className="absolute right-2 top-2">
                      <Badge count={count} urgent={(app.mentions ?? 0) > 0} />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </Popover>
      )}
    </>
  );
}

function Badge({ count, urgent }: { count: number; urgent: boolean }) {
  return (
    <span
      className={cx(
        'rounded-full px-1.5 text-[11px] font-semibold text-white',
        urgent ? 'bg-amber-500' : 'bg-[var(--color-accent)]',
      )}
    >
      {urgent && '@'}
      {count > 99 ? '99+' : count}
    </span>
  );
}
