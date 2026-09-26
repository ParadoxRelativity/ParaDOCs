import { z } from 'zod';
import type { ReleaseInfo } from './version.js';

/**
 * Server administration, served on its own port. These are settings for the
 * whole server, set by whoever runs it, as opposed to anything a workspace
 * owner controls.
 */

/** The longest retention ceiling on offer: ten years. */
export const MAX_RETENTION_DAYS = 3650;

export interface ServerSettings {
  /** Whether anyone may create an account. The first account always can. */
  allowRegistration: boolean;
  /**
   * The oldest a message in a text channel may be, in days, before it is
   * permanently deleted. Null keeps messages for as long as their channel
   * exists. Direct messages are not affected.
   */
  messageRetentionMaxDays: number | null;
  /**
   * Whether people can sign in to the app with an email and password. Off
   * leaves only single sign-on. The admin page always takes passwords, so an
   * administrator can turn this back on, and it cannot be turned off without
   * a single sign-on provider that works.
   */
  passwordSignIn: boolean;
  /**
   * Whether queues can take in work from outside through the intake webhook,
   * each with tokens of its own. Off, the webhook refuses everything and the
   * tokens queues already have are kept but do nothing.
   */
  intakeWebhooks: boolean;
}

export const updateServerSettingsSchema = z
  .object({
    allowRegistration: z.boolean().optional(),
    messageRetentionMaxDays: z.number().int().min(1).max(MAX_RETENTION_DAYS).nullable().optional(),
    passwordSignIn: z.boolean().optional(),
    intakeWebhooks: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((value) => value !== undefined), { message: 'Nothing to update' });

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  isServerAdmin: boolean;
  disabled: boolean;
  createdAt: string;
  /** When they last signed in to the app, if their session is still around. */
  lastSignInAt: string | null;
  workspaceCount: number;
}

export interface AdminStatus {
  /** The administrator signed in on this port, if any. */
  user: { id: string; email: string; name: string } | null;
  /**
   * No administrator exists yet. The first person to sign in with an existing
   * account, or to create one here, becomes one.
   */
  setupRequired: boolean;
}

/** The version this server runs, and what the release channel has. */
export interface AdminVersionStatus {
  /** Null when the server cannot tell, such as a development run with no manifest. */
  currentVersion: string | null;
  /** Off when UPDATE_CHECK is false, or when there is no version to compare. */
  checksEnabled: boolean;
  /** The newest published release, once a check has found one. */
  latest: ReleaseInfo | null;
  updateAvailable: boolean;
  /** When a check last got an answer, whether or not it found anything. */
  checkedAt: string | null;
  /** Why the last check failed, if it did. */
  error: string | null;
}

export const adminCreateUserSchema = z.object({
  email: z.string().email().max(254),
  name: z.string().min(1).max(80),
  password: z.string().min(10, 'password must be at least 10 characters').max(200),
  isServerAdmin: z.boolean().optional(),
});

export const adminUpdateUserSchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
    email: z.string().email().max(254).optional(),
    isServerAdmin: z.boolean().optional(),
    disabled: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((value) => value !== undefined), { message: 'Nothing to update' });

export const adminSetPasswordSchema = z.object({
  password: z.string().min(10, 'password must be at least 10 characters').max(200),
});

export type AdminCreateUserInput = z.infer<typeof adminCreateUserSchema>;
export type AdminUpdateUserInput = z.infer<typeof adminUpdateUserSchema>;
export type UpdateServerSettingsInput = z.infer<typeof updateServerSettingsSchema>;
