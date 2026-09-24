import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import * as oidc from 'openid-client';
import { oidcHandoffSchema, type OidcErrorCode } from '@paradocs/shared';
import { config } from '../config.js';
import { query, transaction } from '../db/pool.js';
import type { DbClient } from '../db/driver.js';
import { createAccount } from '../lib/accounts.js';
import { forbidden, parse, unauthorized } from '../lib/http.js';
import { clientFor, findProvider, oidcStatus, redirectUriFor, type OidcProvider } from '../lib/oidcProviders.js';
import { ssoLimits } from '../lib/rateLimit.js';
import { open, seal } from '../lib/secretBox.js';
import { getServerSettings } from '../lib/serverSettings.js';
import { uploadUrlSql } from '../lib/storage.js';
import { createSession, issueSession } from '../plugins/session.js';

/**
 * Single sign-on through OpenID Connect: the authorization code flow with
 * PKCE, a state and a nonce, for each provider in lib/oidcProviders.ts.
 *
 * In a browser it starts at /oidc/:slug/login, goes to the provider, and comes
 * back to /oidc/:slug/callback, which signs in with a cookie exactly as
 * routes/auth.ts does and sends the page home.
 *
 * The desktop and mobile apps cannot receive that cookie: their pages are not
 * the server's origin. They open the same login in the system browser with a
 * `handoff` challenge, and the callback ends instead on a page that asks the
 * person to go back to the app, through a paradocs://auth link carrying a
 * one-time code. The app redeems the code at /oidc/handoff with the verifier
 * behind the challenge, which never left the app, so a code caught by some
 * other app registered for the same scheme is useless to it.
 *
 * That does not stop another app registered for paradocs:// from starting a
 * sign-in of its own, with its own challenge: a provider the person is already
 * signed in to finishes without asking anything, and the code would go
 * straight to that app. So the code is handed over only when the person taps
 * the link, on a page that says which account and server it is for; the app
 * that opened the browser cannot tap it for them (RFC 8252, section 8.6).
 */

/** Holds one sign-in in progress, sealed so the browser can neither read nor alter it. */
const ATTEMPT_COOKIE = 'paradocs_oidc';
const ATTEMPT_PURPOSE = 'oidc-attempt';
const ATTEMPT_TTL_SECONDS = 10 * 60;

/**
 * How long a native app has to redeem its code. It does so the moment it
 * arrives, but the person has to read the page and tap through first.
 */
const HANDOFF_TTL_SECONDS = 5 * 60;

/** Where the system browser hands a native sign-in back to the app. */
const APP_RETURN = 'paradocs://auth';

interface Attempt {
  slug: string;
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  /** The native app's S256 challenge, when it is a native sign-in. */
  handoff: string | null;
  expiresAt: number;
}

const S256 = /^[A-Za-z0-9_-]{43}$/;

function requestOrigin(req: FastifyRequest): string {
  return `${req.protocol}://${req.host}`;
}

function attemptCookieOptions() {
  return {
    httpOnly: true,
    // Lax still goes along with the provider's top-level redirect back here.
    sameSite: 'lax' as const,
    secure: config.secureCookies,
    path: '/api/auth/oidc',
    maxAge: ATTEMPT_TTL_SECONDS,
  };
}

function readAttempt(req: FastifyRequest): Attempt | null {
  const sealed = req.cookies?.[ATTEMPT_COOKIE];
  if (!sealed) return null;
  const json = open(sealed, ATTEMPT_PURPOSE);
  if (!json) return null;
  try {
    const attempt = JSON.parse(json) as Attempt;
    return attempt.expiresAt > Date.now() ? attempt : null;
  } catch {
    return null;
  }
}

/**
 * A sign-in that cannot go on. The code is what the person is told; the
 * message, which can name them and the provider, is only logged.
 */
class SignInRefused extends Error {
  constructor(
    readonly code: OidcErrorCode,
    message: string = code,
  ) {
    super(message);
  }
}

/**
 * Ends a sign-in that failed. A browser goes back to the app, and a native
 * sign-in to the app that started it, carrying only an error code for the
 * sign-in screen to explain.
 */
function fail(reply: FastifyReply, handoff: boolean, error: OidcErrorCode) {
  const params = new URLSearchParams({ sso_error: error });
  reply.header('Cache-Control', 'no-store');
  return reply.redirect(handoff ? `${APP_RETURN}?${params}` : `/?${params}`);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * The end of a native sign-in: a page with a link that hands the code to the
 * app. Never followed by itself, so the person has to say it was them.
 */
function confirmHandoff(reply: FastifyReply, details: { code: string; email: string; server: string }) {
  const href = escapeHtml(`${APP_RETURN}?${new URLSearchParams({ code: details.code })}`);
  const email = escapeHtml(details.email);
  const server = escapeHtml(details.server);
  reply
    .header('Cache-Control', 'no-store')
    // Nothing else may load, and no other page may frame it and trick a tap.
    .header(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    )
    .header('X-Frame-Options', 'DENY')
    .header('Referrer-Policy', 'no-referrer')
    .type('text/html; charset=utf-8');
  return reply.send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Continue to ParaDOCs</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; display: grid; min-height: 100vh; place-items: center; }
  main { max-width: 26rem; padding: 1.5rem; }
  h1 { font-size: 1.25rem; margin: 0 0 .75rem; }
  a.button { display: block; text-align: center; padding: .75rem 1rem; border-radius: .5rem;
             background: #2563eb; color: #fff; text-decoration: none; font-weight: 600; margin: 1.25rem 0; }
  p.note { font-size: .875rem; opacity: .75; }
</style>
</head>
<body>
<main>
  <h1>Continue to the ParaDOCs app?</h1>
  <p>You signed in as <strong>${email}</strong> on <strong>${server}</strong>.</p>
  <a class="button" href="${href}">Open ParaDOCs</a>
  <p class="note">If you did not just start signing in from the ParaDOCs app, close this page: another app
  may be trying to sign in as you.</p>
</main>
</body>
</html>`);
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

// --- who signed in -----------------------------------------------------------

interface Identity {
  issuer: string;
  subject: string;
  email: string | null;
  /** The provider says the email is theirs: email_verified, or Entra's xms_edov. */
  emailVerified: boolean;
  name: string | null;
}

async function identityFrom(
  client: oidc.Configuration,
  tokens: Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>,
): Promise<Identity> {
  const claims = tokens.claims();
  if (!claims) throw new SignInRefused('failed', 'the provider did not send an ID token');
  let profile: Record<string, unknown> = { ...claims };

  // Some providers leave the email out of the ID token and give it only from
  // the userinfo endpoint.
  if (typeof profile.email !== 'string' && client.serverMetadata().userinfo_endpoint) {
    const info = await oidc.fetchUserInfo(client, tokens.access_token, claims.sub);
    profile = { ...info, ...profile };
  }

  const email = typeof profile.email === 'string' ? profile.email.trim() : null;
  // Some providers send the claim as a string. Microsoft Entra ID sends no
  // email_verified, but can be set to send xms_edov ("email domain owner
  // verified"), which says the same.
  const verified = [profile.email_verified, profile.xms_edov].some((v) => v === true || v === 'true');
  const given = [profile.given_name, profile.family_name].filter((p) => typeof p === 'string').join(' ');
  const name =
    [profile.name, given, profile.preferred_username].find((n): n is string => typeof n === 'string' && !!n.trim()) ??
    null;

  return {
    issuer: client.serverMetadata().issuer,
    subject: claims.sub,
    email: email || null,
    emailVerified: verified,
    name: name?.trim().slice(0, 80) ?? null,
  };
}

function domainAllowed(provider: OidcProvider, email: string | null): boolean {
  if (provider.allowedDomains.length === 0) return true;
  const domain = email?.split('@').pop()?.toLowerCase();
  return Boolean(domain && provider.allowedDomains.includes(domain));
}

/**
 * The account an identity signs in to. In order: the account already linked
 * to it; an account with the same email, when the provider vouches that the
 * email is theirs; or a new account, when the provider may make one.
 */
async function accountFor(
  provider: OidcProvider,
  identity: Identity,
  log: FastifyRequest['log'],
): Promise<{ id: string; created: boolean }> {
  if (!domainAllowed(provider, identity.email)) {
    throw identity.email
      ? new SignInRefused('domain', `${identity.email} is outside the provider's allowed domains`)
      : new SignInRefused('no_email', 'the provider did not share an email address');
  }

  return transaction(async (client: DbClient) => {
    const { rows: linked } = await client.query<{ user_id: string }>(
      'SELECT user_id FROM auth_identities WHERE provider = $1 AND subject = $2',
      [identity.issuer, identity.subject],
    );
    if (linked[0]) {
      await client.query('UPDATE auth_identities SET email = $3 WHERE provider = $1 AND subject = $2', [
        identity.issuer,
        identity.subject,
        identity.email,
      ]);
      return { id: linked[0].user_id, created: false };
    }

    if (!identity.email) {
      throw new SignInRefused('no_email', 'the provider did not share an email address');
    }
    // Linking or creating by email trusts that the email belongs to whoever
    // signed in. Without the provider saying so, anyone who could put
    // someone else's address on an account there could take theirs here.
    // An administrator can vouch for a provider instead, but only within its
    // allowed domains, which domainAllowed has already checked.
    const trusted = provider.trustEmails && provider.allowedDomains.length > 0;
    if (!identity.emailVerified && !trusted) {
      throw new SignInRefused('unverified', `the provider has not verified ${identity.email}`);
    }

    const link = async (userId: string) => {
      await client.query(
        `INSERT INTO auth_identities (user_id, provider, subject, email) VALUES ($1, $2, $3, $4)
         ON CONFLICT (provider, subject) DO NOTHING`,
        [userId, identity.issuer, identity.subject, identity.email],
      );
    };

    const { rows: existing } = await client.query<{ id: string }>(
      'SELECT id FROM users WHERE lower(email) = lower($1)',
      [identity.email],
    );
    if (existing[0]) {
      await link(existing[0].id);
      log.info({ userId: existing[0].id, provider: provider.slug }, 'single sign-on linked to an existing account');
      return { id: existing[0].id, created: false };
    }

    if (!(await mayCreateAccount(client, provider))) {
      throw new SignInRefused('no_account', `no account for ${identity.email}, and the provider may not make one`);
    }
    const user = await createAccount(client, {
      email: identity.email,
      name: identity.name ?? identity.email.split('@')[0],
      passwordHash: null,
    });
    await link(user.id);
    log.info({ userId: user.id, provider: provider.slug }, 'account created by single sign-on');
    return { id: user.id, created: true };
  });
}

async function mayCreateAccount(client: DbClient, provider: OidcProvider): Promise<boolean> {
  if (provider.newAccounts === 'always') return true;
  if (provider.newAccounts === 'never') return false;
  if ((await getServerSettings()).allowRegistration) return true;
  // As with registration, the very first account is always allowed.
  const { rows } = await client.query<{ count: number }>('SELECT count(*)::int AS count FROM users');
  return rows[0].count === 0;
}

// --- routes ------------------------------------------------------------------

export const oidcRoutes: FastifyPluginAsync = async (app) => {
  app.get('/auth/oidc/status', async () => oidcStatus());

  app.get<{ Params: { slug: string }; Querystring: { handoff?: string } }>(
    '/auth/oidc/:slug/login',
    async (req, reply) => {
      const handoff = req.query.handoff ?? null;
      if (handoff !== null && !S256.test(handoff)) {
        // Not a real app; there is nowhere sensible to send this but home.
        return fail(reply, false, 'invalid_link');
      }
      const native = handoff !== null;

      try {
        ssoLimits.check(req.ip);
        const provider = await findProvider(req.params.slug);
        if (!provider?.enabled) throw new SignInRefused('unavailable', `no enabled provider "${req.params.slug}"`);
        const client = await clientFor(provider);

        const attempt: Attempt = {
          slug: provider.slug,
          state: oidc.randomState(),
          nonce: oidc.randomNonce(),
          verifier: oidc.randomPKCECodeVerifier(),
          redirectUri: redirectUriFor(provider, requestOrigin(req)),
          handoff,
          expiresAt: Date.now() + ATTEMPT_TTL_SECONDS * 1000,
        };
        const target = oidc.buildAuthorizationUrl(client, {
          redirect_uri: attempt.redirectUri,
          scope: provider.scopes,
          state: attempt.state,
          nonce: attempt.nonce,
          code_challenge: await oidc.calculatePKCECodeChallenge(attempt.verifier),
          code_challenge_method: 'S256',
        });

        reply.setCookie(ATTEMPT_COOKIE, seal(JSON.stringify(attempt), ATTEMPT_PURPOSE), attemptCookieOptions());
        reply.header('Cache-Control', 'no-store');
        return reply.redirect(target.href);
      } catch (err) {
        return fail(reply, native, failureCode(err, req));
      }
    },
  );

  // The unslugged address is what OIDC_REDIRECT_URI pointed at before there
  // could be more than one provider; the attempt says which one it was.
  const callback = async (req: FastifyRequest<{ Params: { slug?: string } }>, reply: FastifyReply) => {
    const attempt = readAttempt(req);
    reply.clearCookie(ATTEMPT_COOKIE, { path: attemptCookieOptions().path });
    if (!attempt || (req.params.slug && req.params.slug !== attempt.slug)) {
      return fail(reply, false, 'expired');
    }
    const native = attempt.handoff !== null;

    try {
      const provider = await findProvider(attempt.slug);
      if (!provider?.enabled) throw new SignInRefused('unavailable', `no enabled provider "${attempt.slug}"`);
      const client = await clientFor(provider);

      // Exactly the redirect URI the provider was given, with what it sent back.
      const current = new URL(attempt.redirectUri);
      current.search = new URL(req.url, 'http://callback').search;
      const tokens = await oidc.authorizationCodeGrant(client, current, {
        pkceCodeVerifier: attempt.verifier,
        expectedState: attempt.state,
        expectedNonce: attempt.nonce,
        idTokenExpected: true,
      });

      const identity = await identityFrom(client, tokens);
      const account = await accountFor(provider, identity, req.log);
      const { rows } = await query<{ email: string; disabled: boolean }>(
        'SELECT email, disabled_at IS NOT NULL AS disabled FROM users WHERE id = $1',
        [account.id],
      );
      if (!rows[0] || rows[0].disabled) throw new SignInRefused('disabled', `account ${account.id} is disabled`);

      if (attempt.handoff) {
        const code = randomBytes(32).toString('base64url');
        await query('DELETE FROM oidc_handoffs WHERE expires_at < now()');
        await query(
          `INSERT INTO oidc_handoffs (code_hash, user_id, challenge, expires_at)
           VALUES ($1, $2, $3, now() + ($4 || ' seconds')::interval)`,
          [hash(code), account.id, attempt.handoff, String(HANDOFF_TTL_SECONDS)],
        );
        return confirmHandoff(reply, { code, email: rows[0].email, server: config.publicUrl || requestOrigin(req) });
      }

      const session = await createSession(account.id);
      issueSession(req, reply, session);
      reply.header('Cache-Control', 'no-store');
      return reply.redirect('/');
    } catch (err) {
      return fail(reply, native, failureCode(err, req));
    }
  };
  app.get('/auth/oidc/callback', callback);
  app.get('/auth/oidc/:slug/callback', callback);

  /** A native app trades its one-time code, and the verifier only it holds, for a session. */
  app.post('/auth/oidc/handoff', async (req, reply) => {
    ssoLimits.check(req.ip);
    const input = parse(oidcHandoffSchema, req.body);

    // Deleted as it is read, so a code works once however many try it.
    const { rows } = await query<{ user_id: string; challenge: string; live: boolean }>(
      `DELETE FROM oidc_handoffs WHERE code_hash = $1
       RETURNING user_id, challenge, expires_at > now() AS live`,
      [hash(input.code)],
    );
    const handoff = rows[0];
    const given = Buffer.from(hash(input.verifier));
    const expected = Buffer.from(handoff?.challenge ?? '');
    if (!handoff?.live || given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw unauthorized('That sign-in has expired. Try again.');
    }

    const { rows: users } = await query<{
      id: string;
      email: string;
      name: string;
      avatarUrl: string | null;
      disabled: boolean;
    }>(
      `SELECT id, email, name, ${uploadUrlSql('avatar_key')} AS "avatarUrl", disabled_at IS NOT NULL AS disabled
         FROM users WHERE id = $1`,
      [handoff.user_id],
    );
    const user = users[0];
    if (!user || user.disabled) throw forbidden('This account has been disabled. Contact the server administrator.');

    const session = await createSession(user.id);
    return {
      user: { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl },
      ...issueSession(req, reply, session),
    };
  });
};

/**
 * What to tell the person, as a code the sign-in screen explains. The details,
 * which can carry things not meant for them, are logged.
 */
function failureCode(err: unknown, req: FastifyRequest): OidcErrorCode {
  if (err instanceof SignInRefused) {
    req.log.info({ reason: err.code, detail: err.message }, 'single sign-on refused');
    return err.code;
  }
  if ((err as { statusCode?: number }).statusCode === 429) return 'busy';
  if (err instanceof oidc.AuthorizationResponseError) {
    req.log.info({ error: err.error, description: err.error_description }, 'single sign-on refused by provider');
    return err.error === 'access_denied' ? 'cancelled' : 'refused';
  }
  req.log.error({ err }, 'single sign-on failed');
  return 'failed';
}
