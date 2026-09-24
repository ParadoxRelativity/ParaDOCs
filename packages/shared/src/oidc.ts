import { z } from 'zod';

/**
 * Single sign-on through OpenID Connect providers. A server can have several;
 * each is set up on the server admin page, or one can be given in the
 * environment (the OIDC_* settings), which the admin page shows but cannot
 * change.
 */

/** A provider as the sign-in screen sees it: enough to draw its button. */
export interface OidcProviderSummary {
  slug: string;
  name: string;
}

export interface OidcStatus {
  /** The providers someone can sign in with, in the order the admin page set. */
  providers: OidcProviderSummary[];
}

/**
 * Who a provider may make a new account for, when someone signs in with it
 * who has no account here yet.
 *
 * - `registration`: whoever could register with a password; closing
 *   registration on the admin page closes it here too.
 * - `always`: anyone the provider signs in, even with registration closed. The
 *   provider is the gatekeeper, so this suits a company's own identity
 *   provider, not a public one — or pair it with allowed domains.
 * - `never`: only people who already have an account here.
 */
export const OIDC_NEW_ACCOUNT_MODES = ['registration', 'always', 'never'] as const;
export type OidcNewAccountMode = (typeof OIDC_NEW_ACCOUNT_MODES)[number];

export interface AdminOidcProvider {
  /** Null for the provider given in the environment. */
  id: string | null;
  slug: string;
  name: string;
  issuer: string;
  clientId: string;
  /** Whether a client secret is stored. The secret itself is never sent back. */
  hasClientSecret: boolean;
  scopes: string;
  newAccounts: OidcNewAccountMode;
  /** Email domains allowed to sign in, lower case. Empty allows every domain. */
  allowedDomains: string[];
  /**
   * Takes the provider's emails as verified even when it does not say so, as
   * Microsoft Entra ID never does. Only allowed with allowed domains.
   */
  trustEmails: boolean;
  enabled: boolean;
  /** Configured through OIDC_* settings, so the admin page cannot change it. */
  fromEnvironment: boolean;
  /** The address to register with the provider as this client's redirect URI. */
  redirectUri: string;
}

const slug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'use lower-case letters, digits and hyphens, up to 40 characters');

const domain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, 'not a domain name');

const scopes = z
  .string()
  .trim()
  .max(500)
  .refine((v) => v.split(/\s+/).includes('openid'), { message: 'must include openid' });

const issuer = z
  .string()
  .trim()
  .url()
  .max(500)
  .refine((v) => /^https?:\/\//i.test(v), { message: 'must be an http or https address' });

export const TRUST_NEEDS_DOMAINS =
  'Trusting a provider\'s emails needs allowed domains, so it cannot vouch for addresses outside them';

const name = z.string().trim().min(1).max(60);
const clientId = z.string().trim().min(1).max(500);
const clientSecret = z.string().min(1).max(2000);

export const adminCreateOidcProviderSchema = z.object({
  slug,
  name,
  issuer,
  clientId,
  /** Omitted for a public client, which proves itself with PKCE alone. */
  clientSecret: clientSecret.optional(),
  scopes: scopes.optional(),
  newAccounts: z.enum(OIDC_NEW_ACCOUNT_MODES).optional(),
  allowedDomains: z.array(domain).max(50).optional(),
  trustEmails: z.boolean().optional(),
  enabled: z.boolean().optional(),
}).refine((v) => !v.trustEmails || (v.allowedDomains?.length ?? 0) > 0, {
  message: TRUST_NEEDS_DOMAINS,
  path: ['allowedDomains'],
});

/** The slug is fixed once made: it is in the redirect URI registered with the provider. */
export const adminUpdateOidcProviderSchema = z
  .object({
    name: name.optional(),
    issuer: issuer.optional(),
    clientId: clientId.optional(),
    /** A new secret, or null to remove the stored one. Omitted keeps it. */
    clientSecret: clientSecret.nullable().optional(),
    scopes: scopes.optional(),
    newAccounts: z.enum(OIDC_NEW_ACCOUNT_MODES).optional(),
    allowedDomains: z.array(domain).max(50).optional(),
    trustEmails: z.boolean().optional(),
    enabled: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((value) => value !== undefined), { message: 'Nothing to update' });

export type AdminCreateOidcProviderInput = z.infer<typeof adminCreateOidcProviderSchema>;
export type AdminUpdateOidcProviderInput = z.infer<typeof adminUpdateOidcProviderSchema>;

/**
 * Redeems what a native app was handed at the end of signing in through the
 * system browser: the one-time code, and the verifier only that app knows.
 */
export const oidcHandoffSchema = z.object({
  code: z.string().min(20).max(200),
  verifier: z.string().min(43).max(128),
});

/**
 * Why a single sign-on did not finish. The server sends back only the code,
 * as `sso_error` on the address it ends on, and the sign-in screen shows the
 * text for it. Anyone can make a link with `sso_error` on it, so the address
 * never carries text of its own to show.
 */
export const OIDC_ERROR_MESSAGES = {
  expired: 'Sign-in took too long, or was started in another browser. Try again.',
  invalid_link: 'That sign-in link is not valid. Try again.',
  unavailable: 'That sign-in option is not available on this server.',
  domain: 'That email address cannot sign in here with this provider.',
  no_email: 'The provider did not share an email address, which this server needs to sign you in.',
  unverified: 'The provider has not confirmed that this email address is yours, so it cannot be used to sign in here.',
  no_account: 'There is no account on this server for that email address. Ask the server administrator for one.',
  disabled: 'This account has been disabled. Contact the server administrator.',
  cancelled: 'Sign-in was cancelled.',
  refused: 'The provider refused the sign-in. Try again.',
  busy: 'Too many sign-in attempts. Wait a minute and try again.',
  failed: 'Sign-in with that provider failed. Try again, or contact the server administrator.',
} as const;

export type OidcErrorCode = keyof typeof OIDC_ERROR_MESSAGES;

/** The text for an `sso_error` code; anything unknown gets a general message. */
export function oidcErrorMessage(code: string | null | undefined): string {
  return code && Object.hasOwn(OIDC_ERROR_MESSAGES, code)
    ? OIDC_ERROR_MESSAGES[code as OidcErrorCode]
    : 'Sign-in did not finish. Try again.';
}
