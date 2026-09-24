import { useMemo, useState } from 'react';
import { useActivity, useCreateEvent, useDeleteEvent, useEvents } from '../../api/hooks';
import { cx, toISODate, todayISO } from '../../lib/util';
import { IconButton } from '../ui';
import Icon from '../Icon';

interface Props {
  workspaceId: string;
  documentId: string | null;
  /** Whether their role lets them add and remove events. */
  canEdit: boolean;
}

export default function CalendarPanel({ workspaceId, documentId, canEdit }: Props) {
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [selected, setSelected] = useState(todayISO());
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');

  const monthStart = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
  const from = toISODate(monthStart);
  const to = toISODate(monthEnd);

  const events = useEvents(workspaceId, from, to);
  const activity = useActivity(workspaceId, from, to);
  const createEvent = useCreateEvent(workspaceId);
  const deleteEvent = useDeleteEvent(workspaceId);

  const activityByDay = useMemo(
    () => new Map((activity.data ?? []).map((a) => [a.day, a])),
    [activity.data],
  );
  const eventsByDay = useMemo(() => {
    const map = new Map<string, typeof events.data>();
    for (const event of events.data ?? []) {
      const day = toISODate(new Date(event.startAt));
      map.set(day, [...(map.get(day) ?? []), event]);
    }
    return map;
  }, [events.data]);

  // Calendar grid starts on Sunday of the week containing the 1st.
  const gridStart = new Date(monthStart);
  gridStart.setDate(gridStart.getDate() - gridStart.getDay());
  const days = Array.from({ length: 42 }, (_, i) => {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + i);
    return date;
  });

  const selectedEvents = eventsByDay.get(selected) ?? [];
  const today = todayISO();

  function submitEvent(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    createEvent.mutate({
      title: title.trim(),
      // All-day events anchor at local midnight of the selected day.
      startAt: new Date(`${selected}T09:00:00`).toISOString(),
      allDay: false,
      documentId,
    });
    setTitle('');
    setAdding(false);
  }

  return (
    <div className="p-3">
      <div className="mb-2 flex items-center justify-between">
        <IconButton
          label="Previous month"
          onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}
        >
          <Icon name="chevron-left" />
        </IconButton>
        <span className="text-sm font-medium">
          {cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
        </span>
        <IconButton
          label="Next month"
          onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}
        >
          <Icon name="chevron-right" />
        </IconButton>
      </div>

      <div className="mb-1 grid grid-cols-7 text-center text-[10px] font-medium text-[var(--color-muted)]">
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
          <span key={i}>{d}</span>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-0.5">
        {days.map((date) => {
          const iso = toISODate(date);
          const inMonth = date.getMonth() === cursor.getMonth();
          const act = activityByDay.get(iso);
          const dayEvents = eventsByDay.get(iso);
          return (
            <button
              key={iso}
              onClick={() => setSelected(iso)}
              title={act ? `${act.created} created, ${act.updated} updated` : undefined}
              className={cx(
                'relative aspect-square rounded text-xs transition-colors',
                !inMonth && 'text-[var(--color-muted)] opacity-40',
                iso === selected
                  ? 'bg-[var(--color-accent)] font-semibold text-white'
                  : 'hover:bg-[var(--color-surface)]',
                iso === today && iso !== selected && 'font-semibold text-[var(--color-accent)]',
              )}
            >
              {date.getDate()}
              <span className="absolute inset-x-0 bottom-0.5 flex justify-center gap-0.5">
                {act && act.updated > 0 && (
                  <Dot selected={iso === selected} color="var(--color-muted)" />
                )}
                {dayEvents?.length ? <Dot selected={iso === selected} color="#f59e0b" /> : null}
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-3 border-t border-[var(--color-line)] pt-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-medium">
            {new Date(`${selected}T00:00:00`).toLocaleDateString(undefined, {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
            })}
          </span>
          {canEdit && (
            <IconButton label="Add event" onClick={() => setAdding((v) => !v)}>
              <Icon name="plus-lg" />
            </IconButton>
          )}
        </div>

        {adding && (
          <form onSubmit={submitEvent} className="mb-2">
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Event title, then Enter"
              className="w-full rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)] px-2 py-1 text-sm outline-none focus:border-[var(--color-accent)]"
            />
          </form>
        )}

        <div className="space-y-1">
          {selectedEvents.map((event) => (
            <div key={event.id} className="group flex items-center gap-1.5 rounded px-1 py-1 hover:bg-[var(--color-surface)]">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: event.color }} />
              <span className="min-w-0 flex-1 truncate text-xs">{event.title}</span>
              <span className="shrink-0 text-[10px] text-[var(--color-muted)]">
                {event.allDay
                  ? 'all day'
                  : new Date(event.startAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
              </span>
              {canEdit && (
              <button
                onClick={() => deleteEvent.mutate(event.id)}
                aria-label={`Delete event ${event.title}`}
                className="hidden text-[var(--color-muted)] hover:text-red-500 group-hover:block"
              >
                <Icon name="trash3" />
              </button>
              )}
            </div>
          ))}
          {selectedEvents.length === 0 && !adding && (
            <p className="text-xs text-[var(--color-muted)]">No events.</p>
          )}
        </div>
      </div>
    </div>
  );
}

const Dot = ({ color, selected }: { color: string; selected: boolean }) => (
  <span className="h-1 w-1 rounded-full" style={{ background: selected ? 'white' : color }} />
);
