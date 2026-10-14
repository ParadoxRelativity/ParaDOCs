/**
 * Schedules: who is on, and when.
 *
 * A schedule stores rules, never shifts. Its layers say how time is handed out
 * — a rotation handing off between people, a pattern of shifts worked by
 * crews, each person's regular hours — and its overrides say where someone
 * else covers. `resolveSchedule` turns those into the shifts for a stretch of
 * time. The API, the web app, notifications, the calendar feed and the AI
 * tools all ask it, so they cannot disagree about who is on.
 *
 * Times of day are in the schedule's own time zone, so a 09:00 handoff stays at
 * 09:00 through daylight saving changes. Instants are ISO strings.
 */

import { DateTime } from 'luxon';
import { z } from 'zod';

export const SCHEDULE_LAYER_KINDS = ['rotation', 'pattern', 'recurring'] as const;
export type ScheduleLayerKind = (typeof SCHEDULE_LAYER_KINDS)[number];

/** A time of day, 'HH:mm'. */
export const timeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 09:00');
/** A calendar date, 'YYYY-MM-DD'. */
export const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-01-31');
/** A date and time in the schedule's zone, 'YYYY-MM-DDTHH:mm'. */
export const localDateTimeSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/, 'Use a date and time like 2026-01-31T09:00');

/** Days of the week, 1 Monday to 7 Sunday. */
const weekdaysSchema = z.array(z.number().int().min(1).max(7)).min(1).max(7);

/**
 * Part of the week a layer covers, on each of `days` from `start` to `end`.
 * An end at or before the start runs into the next day; the same time at both
 * ends is the whole day.
 */
export const scheduleWindowSchema = z.object({ days: weekdaysSchema, start: timeOfDaySchema, end: timeOfDaySchema });
export type ScheduleWindow = z.infer<typeof scheduleWindowSchema>;

/** Handing off between the layer's people in turn, every `length`, from `start`. */
export const rotationConfigSchema = z.object({
  start: localDateTimeSchema,
  length: z.object({ unit: z.enum(['hours', 'days', 'weeks']), count: z.number().int().min(1).max(366) }),
  /** When given, the layer covers only these parts of the week; the rest falls through. */
  restrictions: z.array(scheduleWindowSchema).max(50).default([]),
});
export type RotationConfig = z.infer<typeof rotationConfigSchema>;

const idSchema = z.string().min(1).max(40);

/** A kind of shift in a pattern, such as Day 07:00–19:00. */
export const shiftTypeSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(60),
  start: timeOfDaySchema,
  end: timeOfDaySchema,
});
export type ShiftType = z.infer<typeof shiftTypeSchema>;

/** A group working a pattern together, starting `offset` days into its cycle. */
export const crewSchema = z.object({ id: idSchema, name: z.string().trim().min(1).max(60), offset: z.number().int().min(0) });
export type Crew = z.infer<typeof crewSchema>;

/**
 * A cycle of days, each running one shift type or none, worked by crews at
 * different points in it. Day one of the cycle is `start`. A shift that runs
 * past midnight belongs to the day it starts.
 */
export const patternConfigSchema = z.object({
  start: localDateSchema,
  shiftTypes: z.array(shiftTypeSchema).min(1).max(10),
  cycle: z.array(idSchema.nullable()).min(1).max(366),
  crews: z.array(crewSchema).min(1).max(20),
});
export type PatternConfig = z.infer<typeof patternConfigSchema>;

/** Someone's regular hours: on each of `days`, from `start` to `end`, between `from` and `until` inclusive. */
export const recurringEntrySchema = scheduleWindowSchema.extend({
  id: idSchema,
  userId: z.string().uuid(),
  label: z.string().trim().max(60).optional(),
  from: localDateSchema.optional(),
  until: localDateSchema.optional(),
});
export type RecurringEntry = z.infer<typeof recurringEntrySchema>;

/** A single shift for someone. */
export const oneOffShiftSchema = z.object({
  id: idSchema,
  userId: z.string().uuid(),
  start: localDateTimeSchema,
  end: localDateTimeSchema,
  label: z.string().trim().max(60).optional(),
});
export type OneOffShift = z.infer<typeof oneOffShiftSchema>;

export const recurringConfigSchema = z.object({
  entries: z.array(recurringEntrySchema).max(500).default([]),
  oneOffs: z.array(oneOffShiftSchema).max(1000).default([]),
});
export type RecurringConfig = z.infer<typeof recurringConfigSchema>;

export type LayerConfig = RotationConfig | PatternConfig | RecurringConfig;

/** The config schema for each kind of layer. */
export const LAYER_CONFIG_SCHEMAS = {
  rotation: rotationConfigSchema,
  pattern: patternConfigSchema,
  recurring: recurringConfigSchema,
} as const;

/** Someone in a rotation, in turn order, or on one of a pattern's crews. */
export interface LayerMember {
  userId: string;
  position: number;
  crew: string | null;
}

/** One version of a layer, as the resolver needs it. */
export interface ResolverLayer {
  id: string;
  /** Shared by every version of the same layer. */
  lineageId: string;
  kind: ScheduleLayerKind;
  name?: string;
  /** Higher wins. */
  position: number;
  config: LayerConfig;
  effectiveFrom: string;
  effectiveUntil: string | null;
  members: LayerMember[];
}

/** Someone covering a window instead of `replacedUserId`, or as extra cover when that is null. */
export interface ResolverOverride {
  id: string;
  userId: string;
  replacedUserId: string | null;
  startsAt: string;
  endsAt: string;
}

/** Who is on, from `start` until `end`. */
export interface Shift {
  start: string;
  end: string;
  userId: string;
  /** The layer version it came from; null for extra cover an override added. */
  layerId: string | null;
  lineageId: string | null;
  label?: string;
  /** Set when an override put this person here. */
  overrideId?: string;
  /** Who the layers had here, when an override replaced them. */
  overriddenFrom?: string | null;
}

/** An interval in epoch milliseconds, [start, end). */
interface Span {
  start: number;
  end: number;
}

interface RawShift extends Span {
  userId: string;
  layerId: string | null;
  lineageId: string | null;
  label?: string;
  overrideId?: string;
  overriddenFrom?: string | null;
}

const ms = (iso: string) => DateTime.fromISO(iso, { setZone: true }).toMillis();
const iso = (millis: number) => DateTime.fromMillis(millis, { zone: 'utc' }).toISO()!;

function atTime(day: DateTime, time: string): DateTime {
  const [hour, minute] = time.split(':').map(Number);
  return day.set({ hour, minute, second: 0, millisecond: 0 });
}

/** A window's span on `day`: past midnight when it ends at or before it starts. */
function windowOn(day: DateTime, start: string, end: string): Span {
  const from = atTime(day, start);
  const until = end > start ? atTime(day, end) : atTime(day.plus({ days: 1 }), end);
  return { start: from.toMillis(), end: until.toMillis() };
}

/** Every calendar day in `zone` that a shift starting on it could reach into [from, to). */
function daysAround(zone: string, from: number, to: number): DateTime[] {
  const days: DateTime[] = [];
  let day = DateTime.fromMillis(from, { zone }).startOf('day').minus({ days: 1 });
  const last = DateTime.fromMillis(to, { zone }).startOf('day');
  while (day <= last) {
    days.push(day);
    day = day.plus({ days: 1 });
  }
  return days;
}

/** Whole calendar days from `a` to `b`, which daylight saving cannot skew. */
function dayNumber(day: DateTime): number {
  return Math.round(DateTime.utc(day.year, day.month, day.day).toMillis() / 86_400_000);
}

const overlaps = (a: Span, from: number, to: number) => a.start < to && a.end > from;

function rotationShifts(layer: ResolverLayer, config: RotationConfig, zone: string, from: number, to: number): RawShift[] {
  const people = [...layer.members].sort((a, b) => a.position - b.position);
  if (people.length === 0) return [];
  const anchor = DateTime.fromISO(config.start, { zone });
  const { unit, count } = config.length;
  const step = (i: number) =>
    anchor.plus(unit === 'hours' ? { hours: i * count } : unit === 'days' ? { days: i * count } : { weeks: i * count }).toMillis();
  const approx = { hours: 3_600_000, days: 86_400_000, weeks: 604_800_000 }[unit] * count;

  // The turn running at `from`, found roughly and then exactly.
  let i = Math.max(0, Math.floor((from - anchor.toMillis()) / approx) - 1);
  while (step(i + 1) <= from) i += 1;
  while (i > 0 && step(i) > from) i -= 1;

  const shifts: RawShift[] = [];
  for (; step(i) < to; i += 1) {
    const span = { start: step(i), end: step(i + 1) };
    const person = people[i % people.length];
    const pieces = config.restrictions.length ? restrict(span, config.restrictions, zone) : [span];
    for (const piece of pieces) {
      if (overlaps(piece, from, to)) shifts.push({ ...piece, userId: person.userId, layerId: layer.id, lineageId: layer.lineageId });
    }
  }
  return shifts;
}

/** The parts of `span` inside the restriction windows. */
function restrict(span: Span, windows: ScheduleWindow[], zone: string): Span[] {
  const allowed: Span[] = [];
  for (const day of daysAround(zone, span.start, span.end)) {
    for (const window of windows) {
      if (!window.days.includes(day.weekday)) continue;
      const w = windowOn(day, window.start, window.end);
      const start = Math.max(span.start, w.start);
      const end = Math.min(span.end, w.end);
      if (end > start) allowed.push({ start, end });
    }
  }
  return union(allowed);
}

function patternShifts(layer: ResolverLayer, config: PatternConfig, zone: string, from: number, to: number): RawShift[] {
  const types = new Map(config.shiftTypes.map((t) => [t.id, t]));
  const first = dayNumber(DateTime.fromISO(config.start, { zone }));
  const shifts: RawShift[] = [];
  for (const day of daysAround(zone, from, to)) {
    const index = dayNumber(day) - first;
    if (index < 0) continue;
    for (const crew of config.crews) {
      const type = types.get(config.cycle[(index + crew.offset) % config.cycle.length] ?? '');
      if (!type) continue;
      const span = windowOn(day, type.start, type.end);
      if (!overlaps(span, from, to)) continue;
      for (const member of layer.members) {
        if (member.crew !== crew.id) continue;
        shifts.push({ ...span, userId: member.userId, layerId: layer.id, lineageId: layer.lineageId, label: type.name });
      }
    }
  }
  return shifts;
}

function recurringShifts(layer: ResolverLayer, config: RecurringConfig, zone: string, from: number, to: number): RawShift[] {
  const shifts: RawShift[] = [];
  const base = { layerId: layer.id, lineageId: layer.lineageId };
  for (const day of daysAround(zone, from, to)) {
    const date = day.toISODate()!;
    for (const entry of config.entries) {
      if (!entry.days.includes(day.weekday)) continue;
      if ((entry.from && date < entry.from) || (entry.until && date > entry.until)) continue;
      const span = windowOn(day, entry.start, entry.end);
      if (overlaps(span, from, to)) shifts.push({ ...span, ...base, userId: entry.userId, label: entry.label });
    }
  }
  for (const shift of config.oneOffs) {
    const span = { start: DateTime.fromISO(shift.start, { zone }).toMillis(), end: DateTime.fromISO(shift.end, { zone }).toMillis() };
    if (span.end > span.start && overlaps(span, from, to)) shifts.push({ ...span, ...base, userId: shift.userId, label: shift.label });
  }
  return shifts;
}

/** The shifts one layer version gives over [from, to), cut to when the version is in effect. */
function versionShifts(layer: ResolverLayer, zone: string, from: number, to: number): RawShift[] {
  const effectiveFrom = ms(layer.effectiveFrom);
  const effectiveUntil = layer.effectiveUntil ? ms(layer.effectiveUntil) : Infinity;
  const start = Math.max(from, effectiveFrom);
  const end = Math.min(to, effectiveUntil);
  if (end <= start) return [];
  const raw =
    layer.kind === 'rotation'
      ? rotationShifts(layer, layer.config as RotationConfig, zone, start, end)
      : layer.kind === 'pattern'
        ? patternShifts(layer, layer.config as PatternConfig, zone, start, end)
        : recurringShifts(layer, layer.config as RecurringConfig, zone, start, end);
  return raw
    .map((s) => ({ ...s, start: Math.max(s.start, effectiveFrom), end: Math.min(s.end, effectiveUntil) }))
    .filter((s) => s.end > s.start);
}

/** Overlapping or touching spans merged, in order. */
function union(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const merged: Span[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

/** `span` with the parts inside `holes` (merged and in order) taken out. */
function subtract(span: Span, holes: Span[]): Span[] {
  const pieces: Span[] = [];
  let cursor = span.start;
  for (const hole of holes) {
    if (hole.end <= cursor) continue;
    if (hole.start >= span.end) break;
    if (hole.start > cursor) pieces.push({ start: cursor, end: hole.start });
    cursor = Math.max(cursor, hole.end);
  }
  if (cursor < span.end) pieces.push({ start: cursor, end: span.end });
  return pieces;
}

const sameRun = (a: RawShift, b: RawShift) =>
  a.end === b.start &&
  a.userId === b.userId &&
  a.lineageId === b.lineageId &&
  a.label === b.label &&
  a.overrideId === b.overrideId &&
  a.overriddenFrom === b.overriddenFrom;

/** Sorted, with a shift that carries straight on from the one before joined to it. */
function tidy(shifts: RawShift[]): Shift[] {
  const sorted = [...shifts].sort((a, b) => a.start - b.start || a.userId.localeCompare(b.userId));
  const joined: RawShift[] = [];
  for (const shift of sorted) {
    let before: RawShift | undefined;
    for (let i = joined.length - 1; i >= 0 && !before; i -= 1) if (sameRun(joined[i], shift)) before = joined[i];
    if (before) before.end = shift.end;
    else joined.push({ ...shift });
  }
  return joined.map(({ start, end, ...rest }) => {
    const shift: Shift = { start: iso(start), end: iso(end), ...rest };
    if (shift.label === undefined) delete shift.label;
    if (shift.overrideId === undefined) delete shift.overrideId;
    if (shift.overriddenFrom === undefined) delete shift.overriddenFrom;
    return shift;
  });
}

/** Each layer's own shifts over [from, to), before priority and overrides: one timeline row per layer. */
export function resolveLayers(
  schedule: { timeZone: string },
  layers: ResolverLayer[],
  from: string,
  to: string,
): Map<string, Shift[]> {
  const rows = new Map<string, RawShift[]>();
  for (const layer of layers) {
    const shifts = versionShifts(layer, schedule.timeZone, ms(from), ms(to));
    rows.set(layer.lineageId, [...(rows.get(layer.lineageId) ?? []), ...shifts]);
  }
  return new Map([...rows].map(([lineage, shifts]) => [lineage, tidy(shifts)]));
}

/**
 * Who is actually on over [from, to): each layer's shifts, with higher layers
 * winning where they overlap lower ones, and then the overrides, in the order
 * given, each handing its window of the replaced person's time to someone
 * else (or adding cover when it replaces nobody).
 *
 * Shifts reaching into the range are returned whole rather than cut at its
 * edges, so "on until" is right. It is pure: no clock, no database.
 */
export function resolveSchedule(
  schedule: { timeZone: string },
  layers: ResolverLayer[],
  overrides: ResolverOverride[],
  from: string,
  to: string,
): Shift[] {
  const start = ms(from);
  const end = ms(to);
  // Overrides can reach past the range, and so can the shifts they split, so
  // the layers are read over enough to cover both.
  const reach = { start, end };
  for (const o of overrides) {
    const window = { start: ms(o.startsAt), end: ms(o.endsAt) };
    if (!overlaps(window, start, end)) continue;
    reach.start = Math.min(reach.start, window.start);
    reach.end = Math.max(reach.end, window.end);
  }

  const byPosition = new Map<number, RawShift[]>();
  for (const layer of layers) {
    const shifts = versionShifts(layer, schedule.timeZone, reach.start, reach.end);
    byPosition.set(layer.position, [...(byPosition.get(layer.position) ?? []), ...shifts]);
  }

  let final: RawShift[] = [];
  let covered: Span[] = [];
  for (const position of [...byPosition.keys()].sort((a, b) => b - a)) {
    const shifts = byPosition.get(position)!;
    for (const shift of shifts) {
      for (const piece of subtract(shift, covered)) final.push({ ...shift, ...piece });
    }
    covered = union([...covered, ...shifts]);
  }

  for (const override of overrides) {
    const window = { start: ms(override.startsAt), end: ms(override.endsAt) };
    const tag = { overrideId: override.id, userId: override.userId };
    if (!override.replacedUserId) {
      final.push({ ...window, ...tag, layerId: null, lineageId: null, overriddenFrom: null });
      continue;
    }
    const next: RawShift[] = [];
    for (const shift of final) {
      if (shift.userId !== override.replacedUserId || !overlaps(shift, window.start, window.end)) {
        next.push(shift);
        continue;
      }
      const inside = { start: Math.max(shift.start, window.start), end: Math.min(shift.end, window.end) };
      for (const outside of subtract(shift, [inside])) next.push({ ...shift, ...outside });
      next.push({ ...shift, ...inside, ...tag, overriddenFrom: shift.overriddenFrom ?? shift.userId });
    }
    final = next;
  }

  return tidy(final.filter((s) => overlaps(s, start, end)));
}

/** The shifts running at `at`. */
export function shiftsAt(shifts: Shift[], at: string): Shift[] {
  const t = ms(at);
  return shifts.filter((s) => ms(s.start) <= t && ms(s.end) > t);
}

/** Whether `userId` is on for the whole of [from, to) in these shifts. */
export function coversWindow(shifts: Shift[], userId: string, from: string, to: string): boolean {
  const mine = union(shifts.filter((s) => s.userId === userId).map((s) => ({ start: ms(s.start), end: ms(s.end) })));
  return subtract({ start: ms(from), end: ms(to) }, mine).length === 0;
}

/** The stretches of [from, to) that nobody covers. */
export function coverageGaps(shifts: Shift[], from: string, to: string): { start: string; end: string }[] {
  const covered = union(shifts.map((s) => ({ start: ms(s.start), end: ms(s.end) })));
  return subtract({ start: ms(from), end: ms(to) }, covered).map((s) => ({ start: iso(s.start), end: iso(s.end) }));
}

/** Whether a string names a time zone this runtime knows. */
export function isTimeZone(zone: string): boolean {
  return DateTime.local().setZone(zone).isValid;
}

// --- the API ------------------------------------------------------------------

export const SCHEDULE_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#64748b'] as const;

const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a color like #3b82f6');
const timeZoneSchema = z.string().min(1).max(64).refine(isTimeZone, 'Choose a time zone such as Europe/London');

export const scheduleMemberInputSchema = z.object({ userId: z.string().uuid(), manager: z.boolean().default(false) });

export const createScheduleSchema = z.object({
  name: z.string().trim().min(1, 'Give it a name').max(100),
  description: z.string().max(2000).optional(),
  timeZone: timeZoneSchema,
  color: colorSchema.optional(),
  /** Off unless asked for: a replacement someone takes applies straight away. */
  requiresApproval: z.boolean().optional(),
  members: z.array(scheduleMemberInputSchema).max(500).optional(),
});
export type CreateScheduleInput = z.infer<typeof createScheduleSchema>;

export const updateScheduleSchema = createScheduleSchema.omit({ members: true }).partial();
export type UpdateScheduleInput = z.infer<typeof updateScheduleSchema>;

export const setScheduleMembersSchema = z.object({ members: z.array(scheduleMemberInputSchema).max(500) });

/** Teams and people who may override this schedule's shifts. */
export const setOverrideGrantsSchema = z.object({
  entries: z
    .array(
      z
        .object({ teamId: z.string().uuid().optional(), userId: z.string().uuid().optional() })
        .refine((e) => Boolean(e.teamId) !== Boolean(e.userId), 'Each line names a team or a person'),
    )
    .max(200),
});

/** What the viewer may do with one schedule, worked out by the server. */
export interface ScheduleAbilities {
  edit: boolean;
  override: boolean;
  approve: boolean;
  /** Ask for cover on their own shifts, and take others'. Only for people on it. */
  request: boolean;
  delete: boolean;
  /** Change who may override it. */
  grantOverride: boolean;
}

export interface ScheduleSummary {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  timeZone: string;
  color: string;
  requiresApproval: boolean;
  access: 'open' | 'allow' | 'deny';
  memberCount: number;
  /** Whether the viewer is on it. */
  isMember: boolean;
  isManager: boolean;
}

export interface ScheduleMember {
  userId: string;
  name: string;
  avatarUrl: string | null;
  manager: boolean;
}

export interface ScheduleLayer {
  id: string;
  lineageId: string;
  kind: ScheduleLayerKind;
  name: string;
  position: number;
  config: LayerConfig;
  effectiveFrom: string;
  effectiveUntil: string | null;
  members: LayerMember[];
}

export interface OverrideGrant {
  kind: 'team' | 'user';
  id: string;
  name: string;
}

export interface Schedule extends ScheduleSummary {
  createdBy: string | null;
  members: ScheduleMember[];
  /** Every version of every layer; the resolver picks what is in effect when. */
  layers: ScheduleLayer[];
  overrideGrants: OverrideGrant[];
  can: ScheduleAbilities;
}

const layerMemberInputSchema = z.object({ userId: z.string().uuid(), crew: idSchema.nullish() });

/**
 * A new layer. `config` is checked against its kind's schema separately, as
 * `parseLayerConfig` does, so the error names the field that is wrong.
 */
export const createLayerSchema = z.object({
  kind: z.enum(SCHEDULE_LAYER_KINDS),
  name: z.string().trim().min(1, 'Give it a name').max(60),
  config: z.unknown(),
  members: z.array(layerMemberInputSchema).max(200).default([]),
  /** When it starts to count. Now, when left out. */
  effectiveFrom: z.string().datetime({ offset: true }).optional(),
});
export type CreateLayerInput = z.input<typeof createLayerSchema>;

/** A change to a layer, from `effectiveFrom` (now, when left out) onward. */
export const updateLayerSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  config: z.unknown().optional(),
  members: z.array(layerMemberInputSchema).max(200).optional(),
  effectiveFrom: z.string().datetime({ offset: true }).optional(),
});
export type UpdateLayerInput = z.input<typeof updateLayerSchema>;

/** The layers' order, highest first, by lineage. */
export const orderLayersSchema = z.object({ lineageIds: z.array(z.string().uuid()).max(50) });

/** A layer's settings checked against its kind, or the problem with them. */
export function parseLayerConfig(
  kind: ScheduleLayerKind,
  config: unknown,
): { ok: true; config: LayerConfig } | { ok: false; error: string } {
  const result = LAYER_CONFIG_SCHEMAS[kind].safeParse(config);
  if (!result.success) {
    const issue = result.error.issues[0];
    return { ok: false, error: `${issue.path.join('.') || 'config'}: ${issue.message}` };
  }
  if (kind === 'pattern') {
    const pattern = result.data as PatternConfig;
    const types = new Set(pattern.shiftTypes.map((t) => t.id));
    if (pattern.cycle.some((day) => day !== null && !types.has(day))) {
      return { ok: false, error: 'Every day of the cycle must run one of the shift types, or none' };
    }
  }
  return { ok: true, config: result.data };
}

/** Each layer's own shifts, for the timeline's rows. */
export interface LayerShifts {
  lineageId: string;
  name: string;
  kind: ScheduleLayerKind;
  shifts: Shift[];
}

/** What GET /schedules/:id/shifts answers: who is on, and each layer on its own. */
export interface ScheduleShifts {
  from: string;
  to: string;
  shifts: Shift[];
  layers: LayerShifts[];
}

/** The versions of each layer in effect at `at`, or the last one where none is. */
export function currentLayers(layers: ScheduleLayer[], at: string): ScheduleLayer[] {
  const byLineage = new Map<string, ScheduleLayer[]>();
  for (const layer of layers) byLineage.set(layer.lineageId, [...(byLineage.get(layer.lineageId) ?? []), layer]);
  const t = ms(at);
  const picked: ScheduleLayer[] = [];
  for (const versions of byLineage.values()) {
    const sorted = [...versions].sort((a, b) => ms(a.effectiveFrom) - ms(b.effectiveFrom));
    const running = sorted.find((v) => ms(v.effectiveFrom) <= t && (!v.effectiveUntil || ms(v.effectiveUntil) > t));
    const upcoming = sorted.find((v) => ms(v.effectiveFrom) > t);
    // A layer ended for good before `at` is not current at all.
    const chosen = running ?? upcoming;
    if (chosen) picked.push(chosen);
  }
  return picked.sort((a, b) => b.position - a.position);
}

/** One of the viewer's own shifts, with the schedule it is on. */
export interface MyShift extends Shift {
  scheduleId: string;
  scheduleName: string;
  color: string;
  timeZone: string;
}
