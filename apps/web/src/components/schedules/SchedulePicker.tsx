import { useEffect, useState } from 'react';
import type { ScheduleSummary } from '@paradocs/shared';
import { useSchedules } from '../../api/hooks';
import { cx } from '../../lib/util';
import { Modal } from '../Modal';
import { Button } from '../ui';
import { ScheduleDot } from './scheduleUi';

/** Choosing a schedule to link, from those the reader can see. */
export function SchedulePicker({
  workspaceId,
  confirmLabel,
  onPick,
  onCancel,
}: {
  workspaceId: string;
  confirmLabel: string;
  onPick: (schedule: ScheduleSummary) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState('');
  const schedules = useSchedules(workspaceId);
  const [cursor, setCursor] = useState(0);
  const needle = query.trim().toLowerCase();
  const items = (schedules.data ?? []).filter((s) => s.name.toLowerCase().includes(needle));
  useEffect(() => setCursor(0), [needle]);
  const chosen = items[cursor];

  return (
    <Modal
      title="Link a schedule"
      onClose={onCancel}
      wide
      footer={
        <>
          <Button variant="subtle" className="text-xs" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" className="text-xs" disabled={!chosen} onClick={() => chosen && onPick(chosen)}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setCursor((c) => Math.min(c + 1, items.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setCursor((c) => Math.max(c - 1, 0));
          } else if (e.key === 'Enter' && chosen) {
            e.preventDefault();
            onPick(chosen);
          }
        }}
        placeholder="Search by name"
        className="w-full rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-2.5 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
      />
      <ul className="scroll-thin mt-2 max-h-72 overflow-y-auto rounded-md border border-[var(--color-line)]">
        {items.map((schedule, index) => (
          <li key={schedule.id}>
            <button
              onMouseEnter={() => setCursor(index)}
              onClick={() => setCursor(index)}
              onDoubleClick={() => onPick(schedule)}
              className={cx(
                'flex w-full items-center gap-2 px-3 py-2 text-left text-sm',
                index === cursor ? 'bg-[var(--color-accent-soft)]' : 'hover:bg-[var(--color-surface)]',
              )}
            >
              <ScheduleDot color={schedule.color} />
              <span className="min-w-0 flex-1 truncate">{schedule.name}</span>
              <span className="shrink-0 text-xs text-[var(--color-muted)]">{schedule.timeZone.replace(/_/g, ' ')}</span>
            </button>
          </li>
        ))}
        {schedules.isSuccess && items.length === 0 && <li className="px-3 py-2 text-xs text-[var(--color-muted)]">No schedules match.</li>}
      </ul>
    </Modal>
  );
}
