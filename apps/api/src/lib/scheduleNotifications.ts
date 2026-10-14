import type { ScheduleOverride, ScheduleRequest } from '@paradocs/shared';

/**
 * Telling people when their shifts change. Overrides and requests call in
 * here; what is sent, and how, is decided here alone.
 */

/** An override was made or taken away: the covered and covering people hear of it. */
export async function overrideChanged(_override: ScheduleOverride, _change: 'created' | 'removed', _actorId: string): Promise<void> {
  // Delivered from PARA-83.
}

/** Something happened to a replacement request: the people it concerns hear of it. */
export async function requestChanged(
  _request: ScheduleRequest,
  _change: 'created' | 'cancelled' | 'accepted' | 'approved' | 'declined',
  _actorId: string,
): Promise<void> {
  // Delivered from PARA-83.
}
