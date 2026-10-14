import { describe, expect, it } from 'vitest';
import {
  coverageGaps,
  coversWindow,
  resolveLayers,
  resolveSchedule,
  shiftsAt,
  type ResolverLayer,
  type ResolverOverride,
} from './schedules.js';

const NY = { timeZone: 'America/New_York' };
const [A, B, C, D, Z] = ['a', 'b', 'c', 'd', 'z'].map((x) => `00000000-0000-4000-8000-00000000000${x}`);

function rotation(
  people: string[],
  start: string,
  length: { unit: 'hours' | 'days' | 'weeks'; count: number },
  extra: Partial<ResolverLayer> & { restrictions?: { days: number[]; start: string; end: string }[] } = {},
): ResolverLayer {
  const { restrictions = [], ...rest } = extra;
  return {
    id: rest.id ?? 'layer',
    lineageId: rest.lineageId ?? rest.id ?? 'layer',
    kind: 'rotation',
    position: 0,
    config: { start, length, restrictions },
    effectiveFrom: '2000-01-01T00:00:00Z',
    effectiveUntil: null,
    members: people.map((userId, position) => ({ userId, position, crew: null })),
    ...rest,
  };
}

const at = (shifts: ReturnType<typeof resolveSchedule>, time: string) => shiftsAt(shifts, time).map((s) => s.userId);

describe('rotations', () => {
  it('hands off weekly on Monday at 09:00 between four people', () => {
    const layer = rotation([A, B, C, D], '2026-01-05T09:00', { unit: 'weeks', count: 1 });
    const shifts = resolveSchedule(NY, [layer], [], '2026-01-01T00:00:00Z', '2026-02-15T00:00:00Z');
    expect(at(shifts, '2026-01-05T15:00:00Z')).toEqual([A]);
    expect(at(shifts, '2026-01-12T13:59:00Z')).toEqual([A]);
    expect(at(shifts, '2026-01-12T14:00:00Z')).toEqual([B]);
    expect(at(shifts, '2026-01-26T14:00:00Z')).toEqual([D]);
    expect(at(shifts, '2026-02-02T14:00:00Z')).toEqual([A]);
    // Nobody before the rotation starts.
    expect(at(shifts, '2026-01-03T00:00:00Z')).toEqual([]);
  });

  it('keeps the 09:00 handoff when the clocks go forward', () => {
    const layer = rotation([A, B, C, D], '2026-01-05T09:00', { unit: 'weeks', count: 1 });
    const shifts = resolveSchedule(NY, [layer], [], '2026-03-03T00:00:00Z', '2026-03-10T00:00:00Z');
    const running = shifts.find((s) => s.start === '2026-03-02T14:00:00.000Z');
    // 09:00 EST to 09:00 EDT: an hour short of a week.
    expect(running?.end).toBe('2026-03-09T13:00:00.000Z');
  });

  it('keeps the 09:00 handoff when the clocks go back', () => {
    const layer = rotation([A, B], '2026-10-30T09:00', { unit: 'days', count: 1 });
    const shifts = resolveSchedule(NY, [layer], [], '2026-10-31T12:00:00Z', '2026-11-01T12:00:00Z');
    const across = shifts.find((s) => s.start === '2026-10-31T13:00:00.000Z');
    expect(across).toMatchObject({ userId: B, end: '2026-11-01T14:00:00.000Z' });
  });

  it('counts hour-long turns in real hours', () => {
    const layer = rotation([A, B], '2026-03-08T00:00', { unit: 'hours', count: 12 });
    const shifts = resolveSchedule(NY, [layer], [], '2026-03-08T05:00:00Z', '2026-03-09T05:00:00Z');
    // The second turn starts twelve real hours later: 13:00 EDT, not 12:00.
    expect(shifts.map((s) => s.start)).toEqual(['2026-03-08T05:00:00.000Z', '2026-03-08T17:00:00.000Z']);
  });

  it('covers only the restricted hours', () => {
    const layer = rotation([A], '2026-01-05T00:00', { unit: 'weeks', count: 1 }, {
      restrictions: [{ days: [1, 2, 3, 4, 5], start: '17:00', end: '09:00' }],
    });
    const shifts = resolveSchedule(NY, [layer], [], '2026-01-05T05:00:00Z', '2026-01-07T05:00:00Z');
    // Monday 17:00 to Tuesday 09:00, and Tuesday 17:00 into Wednesday.
    expect(shifts[0]).toMatchObject({ start: '2026-01-05T22:00:00.000Z', end: '2026-01-06T14:00:00.000Z' });
    expect(at(shifts, '2026-01-06T15:00:00Z')).toEqual([]);
  });
});

describe('layers', () => {
  it('lets a higher layer win and gaps fall through', () => {
    const base = rotation([A], '2026-01-05T00:00', { unit: 'weeks', count: 1 }, { id: 'base', position: 0 });
    const hours = rotation([B], '2026-01-05T00:00', { unit: 'weeks', count: 1 }, {
      id: 'hours',
      position: 1,
      restrictions: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }],
    });
    const shifts = resolveSchedule(NY, [base, hours], [], '2026-01-05T05:00:00Z', '2026-01-06T05:00:00Z');
    expect(at(shifts, '2026-01-05T13:00:00Z')).toEqual([A]);
    expect(at(shifts, '2026-01-05T15:00:00Z')).toEqual([B]);
    expect(at(shifts, '2026-01-05T23:00:00Z')).toEqual([A]);
    // Each layer's own row is untouched by the other.
    const rows = resolveLayers(NY, [base, hours], '2026-01-05T05:00:00Z', '2026-01-06T05:00:00Z');
    expect(rows.get('base')).toHaveLength(1);
  });

  it('keeps past shifts when someone is taken out of a rotation', () => {
    const before = rotation([A, B, C], '2026-01-05T09:00', { unit: 'days', count: 1 }, {
      id: 'v1',
      lineageId: 'rot',
      effectiveUntil: '2026-01-10T14:00:00Z',
    });
    const after = rotation([A, C], '2026-01-05T09:00', { unit: 'days', count: 1 }, {
      id: 'v2',
      lineageId: 'rot',
      effectiveFrom: '2026-01-10T14:00:00Z',
    });
    const shifts = resolveSchedule(NY, [before, after], [], '2026-01-05T00:00:00Z', '2026-01-14T00:00:00Z');
    // Turns 0..4 as they were: A B C A B.
    expect(at(shifts, '2026-01-09T15:00:00Z')).toEqual([B]);
    // From the change, turn 5 of A, C.
    expect(at(shifts, '2026-01-10T15:00:00Z')).toEqual([C]);
    expect(shifts.some((s) => s.userId === B && s.start >= '2026-01-10T14:00:00.000Z')).toBe(false);
  });
});

describe('overrides', () => {
  const daily = rotation([A, B], '2026-01-05T09:00', { unit: 'days', count: 1 });
  const range = ['2026-01-05T14:00:00Z', '2026-01-06T14:00:00Z'] as const;

  it('splits a shift around an override for part of it', () => {
    const override: ResolverOverride = {
      id: 'o1',
      userId: C,
      replacedUserId: A,
      startsAt: '2026-01-05T17:00:00Z',
      endsAt: '2026-01-05T19:00:00Z',
    };
    const shifts = resolveSchedule(NY, [daily], [override], ...range);
    expect(shifts.map((s) => [s.userId, s.start, s.end])).toEqual([
      [A, '2026-01-05T14:00:00.000Z', '2026-01-05T17:00:00.000Z'],
      [C, '2026-01-05T17:00:00.000Z', '2026-01-05T19:00:00.000Z'],
      [A, '2026-01-05T19:00:00.000Z', '2026-01-06T14:00:00.000Z'],
    ]);
    expect(shifts[1]).toMatchObject({ overrideId: 'o1', overriddenFrom: A });
  });

  it('can name someone who is not in the rotation', () => {
    const override = { id: 'o', userId: Z, replacedUserId: A, startsAt: range[0], endsAt: range[1] };
    const shifts = resolveSchedule(NY, [daily], [override], ...range);
    expect(shifts).toHaveLength(1);
    expect(shifts[0]).toMatchObject({ userId: Z, overriddenFrom: A });
  });

  it('adds cover when it replaces nobody', () => {
    const override = { id: 'o', userId: Z, replacedUserId: null, startsAt: '2026-01-05T17:00:00Z', endsAt: '2026-01-05T19:00:00Z' };
    const shifts = resolveSchedule(NY, [daily], [override], ...range);
    expect(at(shifts, '2026-01-05T18:00:00Z').sort()).toEqual([A, Z].sort());
  });

  it('chains: a later override can hand on time an earlier one gave', () => {
    const first = { id: 'o1', userId: B, replacedUserId: A, startsAt: range[0], endsAt: range[1] };
    const second = { id: 'o2', userId: C, replacedUserId: B, startsAt: '2026-01-05T17:00:00Z', endsAt: '2026-01-05T19:00:00Z' };
    const shifts = resolveSchedule(NY, [daily], [first, second], ...range);
    expect(at(shifts, '2026-01-05T18:00:00Z')).toEqual([C]);
    expect(shiftsAt(shifts, '2026-01-05T18:00:00Z')[0].overriddenFrom).toBe(A);
  });

  it('returns whole shifts that reach into the range', () => {
    const shifts = resolveSchedule(NY, [daily], [], '2026-01-05T20:00:00Z', '2026-01-05T21:00:00Z');
    expect(shifts).toEqual([
      expect.objectContaining({ userId: A, start: '2026-01-05T14:00:00.000Z', end: '2026-01-06T14:00:00.000Z' }),
    ]);
  });
});

describe('patterns and recurring hours', () => {
  it('runs a night shift across the spring-forward night as eleven hours', () => {
    const layer: ResolverLayer = {
      id: 'p',
      lineageId: 'p',
      kind: 'pattern',
      position: 0,
      config: {
        start: '2026-03-01',
        shiftTypes: [{ id: 'n', name: 'Night', start: '19:00', end: '07:00' }],
        cycle: ['n'],
        crews: [{ id: 'x', name: 'X', offset: 0 }],
      },
      effectiveFrom: '2000-01-01T00:00:00Z',
      effectiveUntil: null,
      members: [{ userId: A, position: 0, crew: 'x' }],
    };
    const shifts = resolveLayers(NY, [layer], '2026-03-07T12:00:00Z', '2026-03-08T12:00:00Z').get('p')!;
    const night = shifts.find((s) => s.start === '2026-03-08T00:00:00.000Z');
    expect(night).toMatchObject({ end: '2026-03-08T11:00:00.000Z', label: 'Night' });
  });

  it('gives regular hours until their end date and keeps one-off shifts', () => {
    const layer: ResolverLayer = {
      id: 'r',
      lineageId: 'r',
      kind: 'recurring',
      position: 0,
      config: {
        entries: [{ id: 'e', userId: A, days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', until: '2026-01-07' }],
        oneOffs: [{ id: 'x', userId: B, start: '2026-01-10T10:00', end: '2026-01-10T14:00', label: 'Event' }],
      },
      effectiveFrom: '2000-01-01T00:00:00Z',
      effectiveUntil: null,
      members: [],
    };
    const shifts = resolveSchedule(NY, [layer], [], '2026-01-05T00:00:00Z', '2026-01-12T00:00:00Z');
    expect(shifts.filter((s) => s.userId === A)).toHaveLength(3);
    expect(shifts.find((s) => s.userId === B)).toMatchObject({ label: 'Event', start: '2026-01-10T15:00:00.000Z' });
  });
});

describe('helpers', () => {
  it('knows whether someone covers a window, and where the gaps are', () => {
    const layer = rotation([A], '2026-01-05T00:00', { unit: 'weeks', count: 1 }, {
      restrictions: [{ days: [1], start: '09:00', end: '17:00' }],
    });
    const shifts = resolveSchedule(NY, [layer], [], '2026-01-05T05:00:00Z', '2026-01-06T05:00:00Z');
    expect(coversWindow(shifts, A, '2026-01-05T15:00:00Z', '2026-01-05T16:00:00Z')).toBe(true);
    expect(coversWindow(shifts, A, '2026-01-05T13:00:00Z', '2026-01-05T16:00:00Z')).toBe(false);
    expect(coverageGaps(shifts, '2026-01-05T05:00:00Z', '2026-01-06T05:00:00Z')).toHaveLength(2);
  });
});

describe('pattern presets', () => {
  const crewOf = ['a', 'b', 'c', 'd'];
  const people = [A, B, C, D];

  for (const id of ['panama', 'four-on-four-off', 'dupont']) {
    it(`${id} covers every hour exactly once over its cycle`, async () => {
      const { PATTERN_PRESETS } = await import('./schedules.js');
      const preset = PATTERN_PRESETS.find((p) => p.id === id)!;
      const layer: ResolverLayer = {
        id,
        lineageId: id,
        kind: 'pattern',
        position: 0,
        config: { start: '2026-03-01', ...preset.config },
        effectiveFrom: '2000-01-01T00:00:00Z',
        effectiveUntil: null,
        // One person on each crew.
        members: people.map((userId, i) => ({ userId, position: i, crew: crewOf[i] })),
      };
      // From the first morning shift, across a whole cycle and a daylight saving change.
      const from = '2026-03-01T12:00:00Z';
      const to = new Date(Date.parse(from) + preset.config.cycle.length * 86_400_000).toISOString();
      const shifts = resolveSchedule(NY, [layer], [], from, to);
      expect(coverageGaps(shifts, from, to)).toEqual([]);
      // No two crews at once: sorted, each shift ends where the next starts.
      const sorted = [...shifts].sort((a, b) => a.start.localeCompare(b.start));
      for (let i = 1; i < sorted.length; i += 1) expect(sorted[i].start >= sorted[i - 1].end).toBe(true);
    });
  }
});
