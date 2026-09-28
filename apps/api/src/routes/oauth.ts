import crypto from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { MCP_PATH, oauthDecisionSchema, type OAuthRequestInfo } from '@paradocs/shared';
import { query, transaction } from '../db/pool.js';
import {
  ACCESS_TOKEN_PREFIX,
  ACCESS_TOKEN_SECONDS,
  IDLE_DAYS,
  REFRESH_TOKEN_PREFIX,
  hashSecret,
  newSecret,
  publicOrigin,
} from '../lib/aiTokens.js';
import { HttpError, badRequest, forbidden, notFound, parse } from '../lib/http.js';
import { oauthLimits } from '../lib/rateLimit.js';
import { getServerSettings } from '../lib/serverSettings.js';
import { assertMemberOf } from './aiConnections.js';

/**
 * Signing an assistant in, for clients that connect with nothing but the MCP
 * server's address: claude.ai and the Claude apps on any plan, ChatGPT, and
 * others. It is OAuth 2.1 as the MCP specification asks for it — metadata
 * discovery (RFC 9728, RFC 8414), clients registering themselves (RFC 7591),
 * and the authorization code flow with PKCE — with ParaDOCs as both the
 * authorization server and the resource.
 *
 * The client sends the person to the consent page, where they sign in to
 * ParaDOCs if they have not, and choose what the assistant may reach. What they
 * approve becomes an AI connection, listed and revocable in their settings
 * alongside any keys. Clients are public: none is given a secret, so PKCE is
 * what binds a code to the client that asked for it.
 */

/** How long an approval waits to be exchanged for tokens. */
const CODE_SECONDS = 10 * 60;
/** The one scope there is. What an assistant may do is chosen on the consent page. */
const SCOPE = 'paradocs';

function resourceUrl(req: FastifyRequest): string {
  return `${publicOrigin(req)}${MCP_PATH}`;
}

async function assertEnabled(): Promise<void> {
  if (!(await getServerSettings()).aiConnections) throw notFound();
}

/**
 * Where a client may ask to be sent back to: any https address, a loopback
 * http one (Claude Code and other local clients listen on localhost), or an
 * app's own scheme, such as cursor://. Never one that runs script or reads files.
 */
function acceptableRedirect(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) && !['javascript:', 'data:', 'vbscript:', 'file:', 'blob:'].includes(url.protocol);
}

interface ClientRow {
  id: string;
  name: string;
  redirect_uris: string[];
}

async function findClient(clientId: unknown): Promise<ClientRow | null> {
  if (typeof clientId !== 'string' || !clientId || clientId.length > 200) return null;
  const { rows } = await query<ClientRow>('SELECT id, name, redirect_uris FROM oauth_clients WHERE id = $1', [clientId]);
  return rows[0] ?? null;
}

/** A client and one of its own redirect addresses, or a refusal that sends nobody anywhere. */
async function checkedClient(clientId: unknown, redirectUri: unknown): Promise<ClientRow> {
  const client = await findClient(clientId);
  if (!client) throw badRequest('That app is not registered with this server. Try connecting it again.');
  if (typeof redirectUri !== 'string' || !client.redirect_uris.includes(redirectUri)) {
    throw badRequest('That app asked to be sent back to an address it did not register.');
  }
  return client;
}

/** An OAuth error as the protocol spells it, which clients read instead of the app's own. */
function oauthError(reply: FastifyReply, status: number, error: string, description: string) {
  reply.header('Cache-Control', 'no-store');
  return reply.status(status).send({ error, error_description: description });
}

/** A person's browser landed here with a request that cannot go on; they get a page to read. */
function page(reply: FastifyReply, status: number, heading: string, text: string) {
  const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  return reply
    .status(status)
    .type('text/html; charset=utf-8')
    .send(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
        `<title>${escape(heading)}</title></head><body><h1>${escape(heading)}</h1><p>${escape(text)}</p></body></html>`,
    );
}

function withParams(uri: string, params: Record<string, string | undefined>): string {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value);
  return url.href;
}

function s256(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

/** New tokens for a connection, replacing its refresh token. */
async function issueTokens(connectionId: string) {
  const access = newSecret(ACCESS_TOKEN_PREFIX);
  const refresh = newSecret(REFRESH_TOKEN_PREFIX);
  await transaction(async (client) => {
    await client.query('UPDATE ai_connections SET token_hash = $2, last_used_at = now() WHERE id = $1', [
      connectionId,
      hashSecret(refresh),
    ]);
    await client.query(
      `INSERT INTO ai_access_tokens (token_hash, connection_id, expires_at)
       VALUES ($1, $2, now() + ($3 || ' seconds')::interval)`,
      [hashSecret(access), connectionId, String(ACCESS_TOKEN_SECONDS)],
    );
  });
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_SECONDS,
    refresh_token: refresh,
    scope: SCOPE,
  };
}

type Fields = Record<string, unknown>;
const field = (body: Fields, name: string) => (typeof body[name] === 'string' ? (body[name] as string) : undefined);

/** Called by clients from anywhere, some of them in a browser, and trusting nothing but what they send. */
const OPEN_CORS = { cors: { origin: '*', credentials: false } };

/**
 * The endpoints a client calls itself. The token endpoint takes form-encoded
 * bodies, as OAuth has it, so they sit in a context of their own and the form
 * parser reaches nothing that trusts the session cookie.
 */
const clientEndpoints: FastifyPluginAsync = async (app) => {
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  for (const path of ['/oauth/register', '/oauth/token', '/oauth/revoke']) {
    app.options(path, { config: OPEN_CORS }, async (_req, reply) => reply.status(204).send());
  }

  app.post('/oauth/register', { config: OPEN_CORS, bodyLimit: 64 * 1024 }, async (req, reply) => {
    await assertEnabled();
    oauthLimits.check(req.ip);
    const body = (req.body ?? {}) as Fields;
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
    if (uris.length === 0 || uris.length > 10 || !uris.every((u) => typeof u === 'string' && u.length <= 2000)) {
      return oauthError(reply, 400, 'invalid_redirect_uri', 'Give between one and ten redirect_uris');
    }
    const bad = (uris as string[]).find((u) => !acceptableRedirect(u));
    if (bad) {
      return oauthError(reply, 400, 'invalid_redirect_uri', `${bad} is not allowed: use https, a localhost address, or an app scheme`);
    }
    const name = (field(body, 'client_name') ?? 'AI assistant').trim().slice(0, 80) || 'AI assistant';
    const id = `pdc_${crypto.randomBytes(16).toString('base64url')}`;
    await query('INSERT INTO oauth_clients (id, name, redirect_uris) VALUES ($1, $2, $3)', [id, name, uris]);
    reply.status(201).header('Cache-Control', 'no-store');
    return {
      client_id: id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name,
      redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      // Every client is public, whatever it asked for; PKCE stands in for a secret.
      token_endpoint_auth_method: 'none',
    };
  });

  app.post('/oauth/token', { config: OPEN_CORS, bodyLimit: 64 * 1024 }, async (req, reply) => {
    await assertEnabled();
    oauthLimits.check(req.ip);
    const body = (req.body ?? {}) as Fields;
    const grant = field(body, 'grant_type');

    if (grant === 'authorization_code') {
      const code = field(body, 'code');
      const verifier = field(body, 'code_verifier');
      if (!code || !verifier) return oauthError(reply, 400, 'invalid_request', 'Send code and code_verifier');
      // Taken as it is read, so a code works once however many ask at the same time.
      const { rows } = await query<{
        client_id: string;
        user_id: string;
        redirect_uri: string;
        code_challenge: string;
        workspace_id: string | null;
        can_write: boolean;
        expired: boolean;
      }>(
        `DELETE FROM oauth_codes WHERE code_hash = $1
         RETURNING client_id, user_id, redirect_uri, code_challenge, workspace_id, can_write, expires_at < now() AS expired`,
        [hashSecret(code)],
      );
      const found = rows[0];
      if (!found || found.expired) return oauthError(reply, 400, 'invalid_grant', 'That code is not valid or has expired');
      const clientId = field(body, 'client_id');
      if (clientId && clientId !== found.client_id) return oauthError(reply, 400, 'invalid_grant', 'That code was for another app');
      const redirect = field(body, 'redirect_uri');
      if (redirect && redirect !== found.redirect_uri) return oauthError(reply, 400, 'invalid_grant', 'redirect_uri does not match');
      if (s256(verifier) !== found.code_challenge) return oauthError(reply, 400, 'invalid_grant', 'code_verifier does not match');

      const client = await findClient(found.client_id);
      const { rows: made } = await query<{ id: string }>(
        `INSERT INTO ai_connections (user_id, kind, name, client_id, workspace_id, can_write, token_hash, hint)
         VALUES ($1, 'oauth', $2, $3, $4, $5, $6, '') RETURNING id`,
        [
          found.user_id,
          client?.name ?? 'AI assistant',
          found.client_id,
          found.workspace_id,
          found.can_write,
          // Replaced straight away by the first refresh token.
          hashSecret(newSecret(REFRESH_TOKEN_PREFIX)),
        ],
      );
      reply.header('Cache-Control', 'no-store');
      return issueTokens(made[0].id);
    }

    if (grant === 'refresh_token') {
      const refresh = field(body, 'refresh_token');
      if (!refresh) return oauthError(reply, 400, 'invalid_request', 'Send refresh_token');
      const { rows } = await query<{ id: string; client_id: string }>(
        `SELECT c.id, c.client_id FROM ai_connections c JOIN users u ON u.id = c.user_id
          WHERE c.token_hash = $1 AND c.kind = 'oauth' AND u.disabled_at IS NULL
            AND COALESCE(c.last_used_at, c.created_at) > now() - ($2 || ' days')::interval`,
        [hashSecret(refresh), String(IDLE_DAYS)],
      );
      const found = rows[0];
      const clientId = field(body, 'client_id');
      if (!found || (clientId && clientId !== found.client_id)) {
        return oauthError(reply, 400, 'invalid_grant', 'That refresh token is not valid. Connect again.');
      }
      reply.header('Cache-Control', 'no-store');
      return issueTokens(found.id);
    }

    return oauthError(reply, 400, 'unsupported_grant_type', 'Use authorization_code or refresh_token');
  });

  /** RFC 7009. Always succeeds, so it says nothing about which tokens exist. */
  app.post('/oauth/revoke', { config: OPEN_CORS, bodyLimit: 64 * 1024 }, async (req, reply) => {
    oauthLimits.check(req.ip);
    const token = field((req.body ?? {}) as Fields, 'token');
    if (token?.startsWith(REFRESH_TOKEN_PREFIX)) {
      await query(`DELETE FROM ai_connections WHERE token_hash = $1 AND kind = 'oauth'`, [hashSecret(token)]);
    } else if (token?.startsWith(ACCESS_TOKEN_PREFIX)) {
      await query('DELETE FROM ai_access_tokens WHERE token_hash = $1', [hashSecret(token)]);
    }
    reply.status(200).send();
  });
};

/** Discovery documents, which clients look for at the root of the server. */
export const oauthDiscoveryRoutes: FastifyPluginAsync = async (app) => {
  const protectedResource = async (req: FastifyRequest) => {
    await assertEnabled();
    return {
      resource: resourceUrl(req),
      authorization_servers: [publicOrigin(req)],
      bearer_methods_supported: ['header'],
      scopes_supported: [SCOPE],
      resource_name: 'ParaDOCs',
    };
  };
  app.get('/.well-known/oauth-protected-resource', { config: OPEN_CORS }, (req) => protectedResource(req));
  app.get(`/.well-known/oauth-protected-resource${MCP_PATH}`, { config: OPEN_CORS }, (req) => protectedResource(req));

  app.get('/.well-known/oauth-authorization-server', { config: OPEN_CORS }, async (req) => {
    await assertEnabled();
    const origin = publicOrigin(req);
    return {
      issuer: origin,
      authorization_endpoint: `${origin}/api/oauth/authorize`,
      token_endpoint: `${origin}/api/oauth/token`,
      registration_endpoint: `${origin}/api/oauth/register`,
      revocation_endpoint: `${origin}/api/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [SCOPE],
    };
  });
};

export const oauthRoutes: FastifyPluginAsync = async (app) => {
  await app.register(clientEndpoints);

  /**
   * Where a client sends the person. What it asks for is checked here, then
   * the person is passed to the consent page in the app, which signs them in
   * first if need be. A client or address that does not check out is never
   * redirected to: the person is told, and goes nowhere.
   */
  app.get<{ Querystring: Record<string, string> }>('/oauth/authorize', async (req, reply) => {
    const q = req.query;
    try {
      await assertEnabled();
      await checkedClient(q.client_id, q.redirect_uri);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      const text = err.statusCode === 404 ? 'AI connections are turned off on this server.' : err.message;
      return page(reply, err.statusCode, 'Could not connect', text);
    }
    const refuse = (error: string, description: string) =>
      reply.redirect(withParams(q.redirect_uri, { error, error_description: description, state: q.state }));
    if (q.response_type !== 'code') return refuse('unsupported_response_type', 'Only the code flow is supported');
    if (!q.code_challenge || q.code_challenge_method !== 'S256') {
      return refuse('invalid_request', 'PKCE with S256 is required');
    }
    const forward = new URLSearchParams({
      client_id: q.client_id,
      redirect_uri: q.redirect_uri,
      code_challenge: q.code_challenge,
      code_challenge_method: 'S256',
      ...(q.state !== undefined ? { state: q.state } : {}),
    });
    return reply.redirect(`/connect-ai?${forward}`);
  });

  /** What the consent page shows about the client asking. */
  app.get<{ Querystring: Record<string, string> }>(
    '/oauth/client',
    { preHandler: app.requireAuth },
    async (req): Promise<OAuthRequestInfo> => {
      if (req.ai) throw forbidden();
      await assertEnabled();
      const client = await checkedClient(req.query.client_id, req.query.redirect_uri);
      return { clientName: client.name, redirectHost: new URL(req.query.redirect_uri).host || req.query.redirect_uri };
    },
  );

  /**
   * The person's answer, from the consent page, signed in with their session.
   * It says where to send them next: back to the client, with a code to
   * exchange for tokens if they approved.
   */
  app.post('/oauth/authorize', { preHandler: app.requireAuth }, async (req) => {
    if (req.ai) throw forbidden('An AI connection cannot approve AI connections');
    await assertEnabled();
    const input = parse(oauthDecisionSchema, req.body ?? {});
    await checkedClient(input.clientId, input.redirectUri);
    if (!input.approve) {
      return { redirectTo: withParams(input.redirectUri, { error: 'access_denied', state: input.state }) };
    }
    await assertMemberOf(req.user!.id, input.workspaceId);
    const code = crypto.randomBytes(32).toString('base64url');
    await query(
      `INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, workspace_id, can_write, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() + ($8 || ' seconds')::interval)`,
      [
        hashSecret(code),
        input.clientId,
        req.user!.id,
        input.redirectUri,
        input.codeChallenge,
        input.workspaceId ?? null,
        input.canWrite,
        String(CODE_SECONDS),
      ],
    );
    return { redirectTo: withParams(input.redirectUri, { code, state: input.state, iss: publicOrigin(req) }) };
  });
};

/** Clears what has run out: codes and access tokens past their time, and clients nobody ever connected. */
export async function sweepOAuth(): Promise<void> {
  await query('DELETE FROM oauth_codes WHERE expires_at < now()');
  await query('DELETE FROM ai_access_tokens WHERE expires_at < now()');
  await query(
    `DELETE FROM oauth_clients c
      WHERE c.created_at < now() - interval '30 days'
        AND NOT EXISTS (SELECT 1 FROM ai_connections a WHERE a.client_id = c.id)
        AND NOT EXISTS (SELECT 1 FROM oauth_codes o WHERE o.client_id = c.id)`,
  );
}

