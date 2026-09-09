import type { FastifyPluginAsync } from 'fastify';
import { config } from '../config.js';
import { HttpError } from '../lib/http.js';

/**
 * OIDC single sign-on: stubbed in Phase 1.
 *
 * The pieces that must exist ahead of time are already here — the
 * `auth_identities` table for linking a provider subject to a local account,
 * nullable `users.password_hash` for accounts that never set one, and the
 * configuration surface below. The routes deliberately fail loudly rather than
 * half-working, so a misconfigured deployment cannot look like it is signing
 * people in when it is not.
 *
 * Implementing it means, in `/oidc/login`: build an authorization URL with PKCE
 * and a state cookie; and in `/oidc/callback`: exchange the code, verify the id
 * token, upsert into auth_identities keyed on (provider, subject), link to a
 * user by verified email or create one, then issue a session exactly as
 * routes/auth.ts does today.
 */

const NOT_IMPLEMENTED =
  'OIDC sign-in is not implemented yet. Use email and password, or follow the Phase 2 notes in the README.';

export const oidcStatus = () => ({
  /** True once an operator has configured a provider AND the flow is implemented. */
  enabled: false,
  configured: Boolean(config.oidc.issuer && config.oidc.clientId),
  providerName: config.oidc.providerName,
});

export const oidcRoutes: FastifyPluginAsync = async (app) => {
  app.get('/auth/oidc/status', async () => oidcStatus());

  app.get('/auth/oidc/login', async () => {
    throw new HttpError(501, NOT_IMPLEMENTED, 'not_implemented');
  });

  app.get('/auth/oidc/callback', async () => {
    throw new HttpError(501, NOT_IMPLEMENTED, 'not_implemented');
  });
};
