import { useState } from 'react';
import { PATTERN_PRESETS, type Crew, type PatternConfig, type ShiftType } from '@paradocs/shared';
import { cx } from '../../lib/util';
import Icon from '../Icon';
import { FIELD, FIELD_BASE } from '../SettingsParts';
import { Button, IconButton } from '../ui';
import { PeopleOrder, type KindFieldsProps } from './LayerEditor';

const TYPE_COLORS = ['#f59e0b', '#6366f1', '#10b981', '#ef4444', '#06b6d4', '#a855f7', '#84cc16', '#ec4899', '#64748b', '#14b8a6'];

/** A short id for something new in the form, unlikely to clash with the others. */
const newId = (taken: string[]) => {
  for (let i = 1; ; i += 1) if (!taken.includes(`s${i}`)) return `s${i}`;
};

/**
 * A shift pattern: kinds of shift, a cycle of days saying which runs on each,
 * and crews working the cycle from different points in it. A preset fills the
 * form, which can then be changed.
 */
export function PatternFields({ schedule, draft, people, onChange }: KindFieldsProps) {
  const config = draft.config as PatternConfig;
  const setConfig = (patch: Partial<PatternConfig>) => onChange({ ...draft, config: { ...config, ...patch } });
  const [preset, setPreset] = useState('');
  const typeColor = (id: string) => TYPE_COLORS[config.shiftTypes.findIndex((t) => t.id === id) % TYPE_COLORS.length];

  const setType = (index: number, patch: Partial<ShiftType>) =>
    setConfig({ shiftTypes: config.shiftTypes.map((t, i) => (i === index ? { ...t, ...patch } : t)) });
  const removeType = (id: string) =>
    setConfig({ shiftTypes: config.shiftTypes.filter((t) => t.id !== id), cycle: config.cycle.map((d) => (d === id ? null : d)) });
  const setLength = (length: number) => {
    const n = Math.min(366, Math.max(1, length || 1));
    setConfig({ cycle: Array.from({ length: n }, (_, i) => config.cycle[i] ?? null) });
  };
  /** A day in the cycle moves on to the next shift type, then to off. */
  const cycleDay = (index: number) => {
    const ids = [null, ...config.shiftTypes.map((t) => t.id)];
    const next = ids[(ids.indexOf(config.cycle[index]) + 1) % ids.length];
    setConfig({ cycle: config.cycle.map((d, i) => (i === index ? next : d)) });
  };
  const setCrew = (index: number, patch: Partial<Crew>) => setConfig({ crews: config.crews.map((c, i) => (i === index ? { ...c, ...patch } : c)) });
  const crewMembers = (crewId: string) => draft.members.filter((m) => m.crew === crewId).map((m) => m.userId);
  const setCrewMembers = (crewId: string, userIds: string[]) =>
    onChange({
      ...draft,
      // Someone is on one crew at a time: joining this one takes them off another.
      members: [...draft.members.filter((m) => m.crew !== crewId && !userIds.includes(m.userId)), ...userIds.map((userId) => ({ userId, crew: crewId }))],
    });

  function applyPreset(id: string) {
    const chosen = PATTERN_PRESETS.find((p) => p.id === id);
    setPreset(id);
    if (!chosen) return;
    // People stay on the crew of the same name, where there is one.
    const crewIds = new Set(chosen.config.crews.map((c) => c.id));
    onChange({
      ...draft,
      config: { start: config.start, ...structuredClone(chosen.config) },
      members: draft.members.filter((m) => m.crew && crewIds.has(m.crew)),
    });
  }

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs text-[var(--color-muted)]">
          Start from a preset
          <select value={preset} onChange={(e) => applyPreset(e.target.value)} className={cx(FIELD, 'mt-1')}>
            <option value="">Choose a pattern…</option>
            {PATTERN_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {preset && <span className="mt-1 block">{PATTERN_PRESETS.find((p) => p.id === preset)?.hint}</span>}
        </label>
        <label className="block text-xs text-[var(--color-muted)]">
          Day one of the cycle
          <input type="date" value={config.start} onChange={(e) => e.target.value && setConfig({ start: e.target.value })} className={cx(FIELD, 'mt-1')} />
        </label>
      </div>

      <div className="text-xs text-[var(--color-muted)]">
        <span className="mb-1 block">Shifts</span>
        <div className="space-y-1.5">
          {config.shiftTypes.map((type, index) => (
            <div key={type.id} className="flex items-center gap-2">
              <span className="h-3 w-3 shrink-0 rounded-sm" style={{ background: typeColor(type.id) }} />
              <input value={type.name} maxLength={60} onChange={(e) => setType(index, { name: e.target.value })} className={cx(FIELD_BASE, 'w-28 py-1 text-xs')} aria-label="Shift name" />
              <input type="time" value={type.start} onChange={(e) => setType(index, { start: e.target.value })} className={cx(FIELD_BASE, 'py-1 text-xs')} aria-label="Starts" />
              <span>to</span>
              <input type="time" value={type.end} onChange={(e) => setType(index, { end: e.target.value })} className={cx(FIELD_BASE, 'py-1 text-xs')} aria-label="Ends" />
              {type.end <= type.start && <span className="text-[11px]">next day</span>}
              {config.shiftTypes.length > 1 && (
                <IconButton label={`Remove ${type.name}`} className="h-6 w-6" onClick={() => removeType(type.id)}>
                  <Icon name="x-lg" />
                </IconButton>
              )}
            </div>
          ))}
          {config.shiftTypes.length < 10 && (
            <Button
              variant="subtle"
              className="py-1 text-xs"
              onClick={() => setConfig({ shiftTypes: [...config.shiftTypes, { id: newId(config.shiftTypes.map((t) => t.id)), name: 'Shift', start: '09:00', end: '17:00' }] })}
            >
              <Icon name="plus-lg" /> Add a shift
            </Button>
          )}
        </div>
      </div>

      <div className="text-xs text-[var(--color-muted)]">
        <div className="mb-1 flex items-center gap-2">
          <span>Cycle of</span>
          <input type="number" min={1} max={366} value={config.cycle.length} onChange={(e) => setLength(Number(e.target.value))} className={cx(FIELD_BASE, 'w-16 py-1 text-xs')} aria-label="Days in the cycle" />
          <span>days. Click a day to change what runs on it.</span>
        </div>
        <div className="flex flex-wrap gap-0.5">
          {config.cycle.map((day, index) => {
            const type = config.shiftTypes.find((t) => t.id === day);
            return (
              <button
                key={index}
                type="button"
                onClick={() => cycleDay(index)}
                title={`Day ${index + 1}: ${type?.name ?? 'off'}`}
                aria-label={`Day ${index + 1}: ${type?.name ?? 'off'}`}
                className={cx('h-7 w-7 rounded text-[10px] font-semibold', type ? 'text-white' : 'border border-dashed border-[var(--color-line)]')}
                style={type ? { background: typeColor(type.id) } : undefined}
              >
                {type ? type.name.charAt(0) : index + 1}
              </button>
            );
          })}
        </div>
      </div>

      <div className="text-xs text-[var(--color-muted)]">
        <span className="mb-1 block">Crews, each starting some days into the cycle</span>
        <div className="space-y-2">
          {config.crews.map((crew, index) => (
            <div key={crew.id} className="rounded-lg border border-[var(--color-line)] p-2">
              <div className="mb-1.5 flex items-center gap-2">
                <input value={crew.name} maxLength={60} onChange={(e) => setCrew(index, { name: e.target.value })} className={cx(FIELD_BASE, 'w-28 py-1 text-xs')} aria-label="Crew name" />
                <span>starts on day</span>
                <input
                  type="number"
                  min={1}
                  max={config.cycle.length}
                  value={crew.offset + 1}
                  onChange={(e) => setCrew(index, { offset: Math.max(0, (Number(e.target.value) || 1) - 1) })}
                  className={cx(FIELD_BASE, 'w-16 py-1 text-xs')}
                  aria-label="Starts on day"
                />
                <span className="flex-1" />
                {config.crews.length > 1 && (
                  <IconButton
                    label={`Remove crew ${crew.name}`}
                    className="h-6 w-6"
                    onClick={() => onChange({ ...draft, config: { ...config, crews: config.crews.filter((c) => c.id !== crew.id) }, members: draft.members.filter((m) => m.crew !== crew.id) })}
                  >
                    <Icon name="x-lg" />
                  </IconButton>
                )}
              </div>
              <PeopleOrder schedule={schedule} people={people} value={crewMembers(crew.id)} onChange={(ids) => setCrewMembers(crew.id, ids)} />
            </div>
          ))}
          {config.crews.length < 20 && (
            <Button
              variant="subtle"
              className="py-1 text-xs"
              onClick={() => setConfig({ crews: [...config.crews, { id: newId(config.crews.map((c) => c.id)), name: `Crew ${config.crews.length + 1}`, offset: 0 }] })}
            >
              <Icon name="plus-lg" /> Add a crew
            </Button>
          )}
        </div>
      </div>
    </>
  );
}
