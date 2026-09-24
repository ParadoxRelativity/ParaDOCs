import * as oidc from 'openid-client';
import type { AdminOidcProvider, OidcNewAccountMode, OidcStatus } from '@paradocs/shared';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { open } from './secretBox.js';
import { getServerSettings } from './serverSettings.js';

/**
 * The single sign-on providers this server offers: those set up on the admin
 * page, plus one given in the environment when OIDC_ISSUER and OIDC_CLIENT_ID
 * are set (on only with OIDC_ENABLED=true). Read from the database each time, like server settings, so every
 * process sees an administrator's change at once.
 */

export const SECRET_PURPOSE = 'oidc-client-secret';

export interface OidcProvider {
  id: string | null;
  slug: string;
  name: string;
  issuer: string;
  clientId: string;
  /** Null for a public client. */
  clientSecret: string | null;
  /** A secret is stored but cannot be decrypted, most likely because SESSION_SECRET changed. */
  secretUnreadable: boolean;
  scopes: string;
  newAccounts: OidcNewAccountMode;
  allowedDomains: string[];
  trustEmails: boolean;
  enabled: boolean;
  fromEnvironment: boolean;
  /** Set only for the environment's provider, from OIDC_REDIRECT_URI. */
  redirectUri: string | null;
}

function environmentProvider(): OidcProvider | null {
  const env = config.oidc;
  if (!env.issuer || !env.clientId) return null;
  return {
    id: null,
    slug: env.slug,
    name: env.providerName,
    issuer: env.issuer,
    clientId: env.clientId,
    clientSecret: env.clientSecret || null,
    secretUnreadable: false,
    scopes: env.scopes,
    newAccounts: env.newAccounts,
    allowedDomains: env.allowedDomains,
    trustEmails: env.trustEmails,
    // Shown on the admin page either way, so it is clear why it is off.
    enabled: env.enabled,
    fromEnvironment: true,
    redirectUri: env.redirectUri || null,
  };
}

interface ProviderRow {
  id: string;
  slug: string;
  name: string;
  issuer: string;
  client_id: string;
  client_secret_enc: string | null;
  scopes: string;
  new_accounts: OidcNewAccountMode;
  allowed_domains: string[];
  trust_emails: boolean;
  enabled: boolean;
}

function fromRow(row: ProviderRow): OidcProvider {
  const secret = row.client_secret_enc ? open(row.client_secret_enc, SECRET_PURPOSE) : null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    issuer: row.issuer,
    clientId: row.client_id,
    clientSecret: secret,
    secretUnreadable: Boolean(row.client_secret_enc) && secret === null,
    scopes: row.scopes,
    newAccounts: row.new_accounts,
    allowedDomains: row.allowed_domains,
    trustEmails: row.trust_emails,
    enabled: row.enabled,
    fromEnvironment: false,
    redirectUri: null,
  };
}

const PROVIDER_COLUMNS = `id, slug, name, issuer, client_id, client_secret_enc, scopes, new_accounts,
  allowed_domains, trust_emails, enabled`;

/** Every provider, enabled or not: the environment's first, then the admin page's in its order. */
export async function listProviders(): Promise<OidcProvider[]> {
  const { rows } = await query<ProviderRow>(
    `SELECT ${PROVIDER_COLUMNS} FROM oidc_providers ORDER BY position, lower(name), id`,
  );
  const env = environmentProvider();
  const stored = rows.map(fromRow).filter((p) => p.slug !== env?.slug);
  return env ? [env, ...stored] : stored;
}

export async function findProvider(slug: string): Promise<OidcProvider | null> {
  const env = environmentProvider();
  if (env?.slug === slug) return env;
  const { rows } = await query<ProviderRow>(`SELECT ${PROVIDER_COLUMNS} FROM oidc_providers WHERE slug = $1`, [slug]);
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function findStoredProvider(id: string): Promise<OidcProvider | null> {
  const { rows } = await query<ProviderRow>(`SELECT ${PROVIDER_COLUMNS} FROM oidc_providers WHERE id = $1`, [id]);
  return rows[0] ? fromRow(rows[0]) : null;
}

export function environmentSlug(): string | null {
  return environmentProvider()?.slug ?? null;
}

/**
 * Whether the app takes passwords. Turned off on the admin page for single
 * sign-on only, but only while a provider is on: should the last one go —
 * say its OIDC_* settings are removed — passwords come back rather than
 * leaving nobody able to sign in.
 */
export async function passwordSignInAllowed(log?: { warn: (obj: object, msg: string) => void }): Promise<boolean> {
  if ((await getServerSettings()).passwordSignIn) return true;
  if ((await listProviders()).some((p) => p.enabled)) return false;
  log?.warn({}, 'password sign-in is set off, but no single sign-on provider is on, so passwords are allowed');
  return true;
}

/** What the sign-in screen offers. */
export async function oidcStatus(): Promise<OidcStatus> {
  const providers = (await listProviders()).filter((p) => p.enabled);
  return { providers: providers.map(({ slug, name }) => ({ slug, name })) };
}

/**
 * Where the provider sends people back to. `requestOrigin` stands in for
 * PUBLIC_URL when that is unset; the provider refuses any address not
 * registered with it, so a forged Host header only makes sign-in fail.
 */
export function redirectUriFor(provider: OidcProvider, requestOrigin: string): string {
  if (provider.redirectUri) return provider.redirectUri;
  return `${config.publicUrl || requestOrigin}/api/auth/oidc/${provider.slug}/callback`;
}

export function toAdminProvider(provider: OidcProvider, requestOrigin: string): AdminOidcProvider {
  return {
    id: provider.id,
    slug: provider.slug,
    name: provider.name,
    issuer: provider.issuer,
    clientId: provider.clientId,
    hasClientSecret: provider.clientSecret !== null || provider.secretUnreadable,
    scopes: provider.scopes,
    newAccounts: provider.newAccounts,
    allowedDomains: provider.allowedDomains,
    trustEmails: provider.trustEmails,
    enabled: provider.enabled,
    fromEnvironment: provider.fromEnvironment,
    redirectUri: redirectUriFor(provider, requestOrigin),
  };
}

// --- discovery ---------------------------------------------------------------

/**
 * A provider's discovered metadata and keys, kept for an hour. The fingerprint
 * is what the configuration was built from, so an edit on the admin page is
 * picked up at once without anyone having to clear anything.
 */
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const discovered = new Map<string, { fingerprint: string; at: number; config: oidc.Configuration }>();

/** Fetches a provider's discovery document and builds a client for it. */
export async function discover(provider: Pick<OidcProvider, 'issuer' | 'clientId' | 'clientSecret'>) {
  const issuer = new URL(provider.issuer);
  return oidc.discovery(
    issuer,
    provider.clientId,
    undefined,
    provider.clientSecret ? oidc.ClientSecretPost(provider.clientSecret) : oidc.None(),
    {
      timeout: 10,
      // An issuer on plain HTTP is what the administrator typed in, such as a
      // provider on the same private network; the library refuses it otherwise.
      execute: issuer.protocol === 'http:' ? [oidc.allowInsecureRequests] : [],
    },
  );
}

export async function clientFor(provider: OidcProvider): Promise<oidc.Configuration> {
  if (provider.secretUnreadable) {
    throw new Error(
      `The client secret for ${provider.name} can no longer be read, most likely because SESSION_SECRET changed. ` +
        'Enter it again on the server admin page.',
    );
  }
  const fingerprint = JSON.stringify([provider.issuer, provider.clientId, provider.clientSecret]);
  const cached = discovered.get(provider.slug);
  if (cached && cached.fingerprint === fingerprint && Date.now() - cached.at < DISCOVERY_TTL_MS) {
    return cached.config;
  }
  const fresh = await discover(provider);
  discovered.set(provider.slug, { fingerprint, at: Date.now(), config: fresh });
  return fresh;
}

export function forgetClient(slug: string): void {
  discovered.delete(slug);
}
