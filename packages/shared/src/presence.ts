import { z } from 'zod';

/**
 * Whether someone is around.
 *
 * As a choice, `online` means "work it out for me": the server shows such a
 * person as away once every window they have open has gone quiet. `offline` as
 * a choice is appearing offline while still signed in.
 */
export const PRESENCE_STATUSES = ['online', 'away', 'busy', 'offline'] as const;
export type PresenceStatus = (typeof PRESENCE_STATUSES)[number];

export interface PresenceSettings {
  status: PresenceStatus;
  /** Minutes without activity before someone set to online shows as away. 0 never does. */
  awayAfterMinutes: number;
}

export const MAX_AWAY_AFTER_MINUTES = 24 * 60;

export const updatePresenceSchema = z
  .object({
    status: z.enum(PRESENCE_STATUSES).optional(),
    awayAfterMinutes: z.number().int().min(0).max(MAX_AWAY_AFTER_MINUTES).optional(),
  })
  .refine((v) => v.status !== undefined || v.awayAfterMinutes !== undefined, {
    message: 'Nothing to update',
  });
