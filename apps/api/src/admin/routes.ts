import type { FastifyPluginAsync } from 'fastify';
import {
  adminCreateOidcProviderSchema,
  adminCreateUserSchema,
  adminSetPasswordSchema,
  adminUpdateOidcProviderSchema,
  adminUpdateUserSchema,
  loginSchema,
  registerSchema,
  TRUST_NEEDS_DOMAINS,
  updateServerSettingsSchema,
  type AdminStatus,
  type AdminVersionStatus,
  type AdminUser,
} from '@paradocs/shared';
import { config } from '../config.js';
import { query, transaction } from '../db/pool.js';
import type { DbClient } from '../db/driver.js';
import { hashPassword, verifyPassword } from '../lib/auth.js';
import { badRequest, conflict, forbidden, notFound, parse, unauthorized } from '../lib/http.js';
import { UUID } from '../lib/access.js';
import { createAccount } from '../lib/accounts.js';
import { signedOut } from '../lib/accountEvents.js';
import { sweepExpiredMessages } from '../lib/retention.js';
import { getServerSettings, updateServerSettings } from '../lib/serverSettings.js';
import { checkForServerUpdate, versionStatus } from '../lib/releases.js';
import { removeStoredFiles } from '../lib/storage.js';
import { registrationLimits, signInLimits } from '../lib/rateLimit.js';
import {
  SECRET_PURPOSE,
  discover,
  environmentSlug,
  findStoredProvider,
  forgetClient,
  listProviders,
  toAdminProvider,
} from '../lib/oidcProviders.js';
import { seal } from '../lib/secretBox.js';
import { ADMIN_COOKIE, endAdminSession, startAdminSession } from './session.js';

const ADMIN_USER_COLUMNS = `u.id, u.email, u.name,
  u.is_server_admin AS "isServerAdmin",
  (u.disabled_at IS NOT NULL) AS disabled,
  u.created_at AS "createdAt",
  (SELECT max(s.created_at) FROM sessions s WHERE s.user_id = u.id) AS "lastSignInAt",
  (SELECT count(*)::int FROM workspace_members m WHERE m.user_id = u.id) AS "workspaceCount"`;

/** Past this, the list asks for a search rather than sending every account. */
const USER_LIST_LIMIT = 500;

/** Whether an enabled administrator exists, other than the account in $1 when given. */
const HAS_ADMINISTRATOR = `SELECT EXISTS (
  SELECT 1 FROM users WHERE is_server_admin AND disabled_at IS NULL AND id IS DISTINCT FROM $1::uuid
) AS present`;

/**
 * Serializes changes to who administers the server, so two people claiming a
 * fresh server at once cannot both win, and two demotions at once cannot
 * between them remove the last administrator.
 */
async function lockAdministrators(client: DbClient): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('paradocs.server_admins'))`);
}

/**
 * Where people reach the app, for the redirect URI shown on the admin page.
 * This request came to the admin port, so the address it used is no guide.
 */
function appOrigin(): string {
  return config.publicUrl || `http://localhost:${config.port}`;
}

/** Refuses a provider whose discovery document cannot be fetched, so a typo shows up on saving. */
async function checkDiscovery(provider: { issuer: string; clientId: string; clientSecret: string | null }) {
  try {
    await discover(provider);
  } catch (err) {
    throw badRequest(`Could not read ${provider.issuer}/.well-known/openid-configuration: ${(err as Error).message}`);
  }
}

/**
 * Refuses to leave the app taking only single sign-on without a provider that
 * works: at least one must be on, and its discovery document reachable now.
 */
async function assertSsoWorks(): Promise<void> {
  const enabled = (await listProviders()).filter((p) => p.enabled);
  if (enabled.length === 0) {
    throw badRequest('Turn on a single sign-on provider before turning off password sign-in.');
  }
  for (const provider of enabled) {
    // Fetched afresh rather than from the cache: the question is whether it works now.
    if (provider.secretUnreadable) continue;
    try {
      await discover(provider);
      return;
    } catch {
      // Try the next one.
    }
  }
  throw badRequest(
    `None of the single sign-on providers can be reached right now (${enabled.map((p) => p.name).join(', ')}), ` +
      'so password sign-in stays on.',
  );
}

/** While the app takes only single sign-on, the last provider that is on cannot go. */
async function assertNotLastProvider(id: string): Promise<void> {
  if ((await getServerSettings()).passwordSignIn) return;
  const others = (await listProviders()).filter((p) => p.enabled && p.id !== id);
  if (others.length === 0) {
    throw badRequest(
      'This is the only single sign-on provider and password sign-in is off, so nobody could sign in. ' +
        'Turn password sign-in back on under Server settings first.',
    );
  }
}

/** Accounts not linked to any provider yet: they sign in with single sign-on only once it links them by email. */
async function unlinkedAccounts(): Promise<number> {
  const { rows } = await query<{ count: number }>(
    `SELECT count(*)::int AS count FROM users u
      WHERE u.disabled_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM auth_identities i WHERE i.user_id = u.id)`,
  );
  return rows[0].count;
}

function providerId(id: string): string {
  if (!UUID.test(id)) throw notFound('Provider not found');
  return id;
}

function accountId(id: string): string {
  if (!UUID.test(id)) throw notFound('Account not found');
  return id;
}

async function loadUser(id: string): Promise<AdminUser> {
  const { rows } = await query<AdminUser>(`SELECT ${ADMIN_USER_COLUMNS} FROM users u WHERE u.id = $1`, [id]);
  if (!rows[0]) throw notFound('Account not found');
  return rows[0];
}

export const adminRoutes: FastifyPluginAsync = async (app) => {
  app.get('/status', async (req): Promise<AdminStatus> => {
    const { rows } = await query<{ present: boolean }>(HAS_ADMINISTRATOR, [null]);
    return { user: req.admin, setupRequired: !rows[0].present };
  });

  /**
   * Signs in to the admin page. Only administrators may — except while the
   * server has none, when the first existing account to sign in here becomes
   * its administrator.
   */
  app.post('/login', async (req, reply): Promise<AdminStatus> => {
    const input = parse(loginSchema, req.body);
    signInLimits.check(req.ip, input.email);
    const { rows } = await query<{
      id: string;
      email: string;
      name: string;
      password_hash: string | null;
      is_server_admin: boolean;
      disabled: boolean;
    }>(
      `SELECT id, email, name, password_hash, is_server_admin, disabled_at IS NOT NULL AS disabled
         FROM users WHERE lower(email) = lower($1)`,
      [input.email],
    );
    const row = rows[0];
    // Hash even when the user is missing, so timing does not reveal which emails exist.
    const ok = await verifyPassword(input.password, row?.password_hash ?? 'scrypt$00$00');
    if (!row || !ok) {
      signInLimits.failed(input.email);
      throw unauthorized('Incorrect email or password');
    }
    signInLimits.succeeded(input.email);
    if (row.disabled) throw forbidden('This account is disabled');

    if (!row.is_server_admin) {
      const claimed = await transaction(async (client) => {
        await lockAdministrators(client);
        const { rows: admins } = await client.query<{ present: boolean }>(HAS_ADMINISTRATOR, [null]);
        if (admins[0].present) return false;
        await client.query('UPDATE users SET is_server_admin = true WHERE id = $1', [row.id]);
        return true;
      });
      if (!claimed) throw forbidden('This account is not a server administrator');
      req.log.warn({ userId: row.id, email: row.email }, 'first server administrator claimed by signing in');
    }

    await startAdminSession(reply, row.id);
    return { user: { id: row.id, email: row.email, name: row.name }, setupRequired: false };
  });

  /** Creates the first administrator as a new account. Only while the server has none. */
  app.post('/setup', async (req, reply): Promise<AdminStatus> => {
    const input = parse(registerSchema, req.body);
    registrationLimits.check(req.ip);
    const passwordHash = await hashPassword(input.password);
    const user = await transaction(async (client) => {
      await lockAdministrators(client);
      const { rows } = await client.query<{ present: boolean }>(HAS_ADMINISTRATOR, [null]);
      if (rows[0].present) throw conflict('This server already has an administrator. Sign in instead.');
      return createAccount(client, { email: input.email, name: input.name, passwordHash, isServerAdmin: true });
    });
    req.log.warn({ userId: user.id, email: user.email }, 'first server administrator created');

    await startAdminSession(reply, user.id);
    reply.status(201);
    return { user, setupRequired: false };
  });

  app.post('/logout', async (req, reply) => {
    await endAdminSession(req, reply);
    reply.status(204);
  });

  // Everything below needs a signed-in administrator.
  await app.register(async (admin) => {
    admin.addHook('preHandler', async (req) => {
      if (!req.admin) throw unauthorized('Sign in as a server administrator');
    });

    admin.get('/settings', async () => getServerSettings());

    admin.patch('/settings', async (req) => {
      const input = parse(updateServerSettingsSchema, req.body);
      // Checked only when it changes, so other settings can be saved while a
      // provider is down.
      if (input.passwordSignIn === false && (await getServerSettings()).passwordSignIn) await assertSsoWorks();
      const settings = await updateServerSettings(input, req.admin!.id);
      req.log.info({ admin: req.admin!.email, changes: input }, 'server settings changed');
      // Applied now rather than at the next hourly sweep, so the server does
      // what the page says as soon as it is saved.
      if (input.messageRetentionMaxDays) {
        sweepExpiredMessages(app.log).catch((err) => app.log.error({ err }, 'message retention sweep failed'));
      }
      return settings;
    });

    // --- single sign-on providers ---------------------------------------------

    admin.get('/oidc-providers', async () => {
      const providers = await listProviders();
      return {
        providers: providers.map((p) => toAdminProvider(p, appOrigin())),
        // New providers' redirect URIs start with this; a guess when PUBLIC_URL is unset.
        redirectBase: `${appOrigin()}/api/auth/oidc/`,
        publicUrlSet: Boolean(config.publicUrl),
        unlinkedAccounts: await unlinkedAccounts(),
      };
    });

    admin.post('/oidc-providers', async (req, reply) => {
      const input = parse(adminCreateOidcProviderSchema, req.body);
      if (input.slug === environmentSlug()) {
        throw conflict(`"${input.slug}" is used by the provider set in the environment`);
      }
      await checkDiscovery({ issuer: input.issuer, clientId: input.clientId, clientSecret: input.clientSecret ?? null });
      const { rows } = await query<{ id: string }>(
        `INSERT INTO oidc_providers
           (slug, name, issuer, client_id, client_secret_enc, scopes, new_accounts, allowed_domains, enabled,
            trust_emails, position)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6, 'openid email profile'), COALESCE($7, 'registration'),
                 COALESCE($8, '{}'::text[]), COALESCE($9, true), COALESCE($10, false),
                 (SELECT COALESCE(max(position) + 1, 0) FROM oidc_providers))
         RETURNING id`,
        [
          input.slug,
          input.name,
          input.issuer,
          input.clientId,
          input.clientSecret ? seal(input.clientSecret, SECRET_PURPOSE) : null,
          input.scopes ?? null,
          input.newAccounts ?? null,
          input.allowedDomains ?? null,
          input.enabled ?? null,
          input.trustEmails ?? null,
        ],
      );
      req.log.info({ admin: req.admin!.email, provider: input.slug }, 'single sign-on provider added');
      reply.status(201);
      return toAdminProvider((await findStoredProvider(rows[0].id))!, appOrigin());
    });

    admin.patch<{ Params: { id: string } }>('/oidc-providers/:id', async (req) => {
      const id = providerId(req.params.id);
      const input = parse(adminUpdateOidcProviderSchema, req.body);
      const current = await findStoredProvider(id);
      if (!current) throw notFound('Provider not found');
      if (input.enabled === false) await assertNotLastProvider(id);

      const next = {
        issuer: input.issuer ?? current.issuer,
        clientId: input.clientId ?? current.clientId,
        clientSecret: input.clientSecret === undefined ? current.clientSecret : input.clientSecret,
      };
      // Checked against the result, so clearing the domains of a trusted
      // provider is refused as well as trusting one that has none.
      const trustEmails = input.trustEmails ?? current.trustEmails;
      const allowedDomains = input.allowedDomains ?? current.allowedDomains;
      if (trustEmails && allowedDomains.length === 0) throw badRequest(TRUST_NEEDS_DOMAINS);

      const reconnects =
        next.issuer !== current.issuer || next.clientId !== current.clientId || input.clientSecret !== undefined;
      if (reconnects) await checkDiscovery(next);

      await query(
        `UPDATE oidc_providers
            SET name = COALESCE($2, name),
                issuer = COALESCE($3, issuer),
                client_id = COALESCE($4, client_id),
                client_secret_enc = CASE WHEN $5::boolean THEN $6 ELSE client_secret_enc END,
                scopes = COALESCE($7, scopes),
                new_accounts = COALESCE($8, new_accounts),
                allowed_domains = COALESCE($9, allowed_domains),
                enabled = COALESCE($10, enabled),
                trust_emails = COALESCE($11, trust_emails),
                updated_at = now()
          WHERE id = $1`,
        [
          id,
          input.name ?? null,
          input.issuer ?? null,
          input.clientId ?? null,
          input.clientSecret !== undefined,
          input.clientSecret ? seal(input.clientSecret, SECRET_PURPOSE) : null,
          input.scopes ?? null,
          input.newAccounts ?? null,
          input.allowedDomains ?? null,
          input.enabled ?? null,
          input.trustEmails ?? null,
        ],
      );
      forgetClient(current.slug);
      req.log.info(
        { admin: req.admin!.email, provider: current.slug, changes: { ...input, clientSecret: undefined } },
        'single sign-on provider changed',
      );
      return toAdminProvider((await findStoredProvider(id))!, appOrigin());
    });

    /**
     * Removes a provider. Accounts it made keep working for anyone with a
     * password, and its links stay: set the same issuer up again and they
     * sign in as before.
     */
    admin.delete<{ Params: { id: string } }>('/oidc-providers/:id', async (req, reply) => {
      const id = providerId(req.params.id);
      await assertNotLastProvider(id);
      const { rows } = await query<{ slug: string }>('DELETE FROM oidc_providers WHERE id = $1 RETURNING slug', [id]);
      if (!rows[0]) throw notFound('Provider not found');
      forgetClient(rows[0].slug);
      req.log.warn({ admin: req.admin!.email, provider: rows[0].slug }, 'single sign-on provider removed');
      reply.status(204);
    });

    admin.get('/version', async (): Promise<AdminVersionStatus> => versionStatus());

    /** Asks the release channel now, rather than waiting for the next scheduled check. */
    admin.post('/version/check', async (): Promise<AdminVersionStatus> => checkForServerUpdate(app.log));

    admin.get<{ Querystring: { q?: string } }>('/users', async (req) => {
      const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 200) : '';
      const pattern = q ? `%${q.replace(/[\\%_]/g, '\\$&')}%` : null;
      const filter = '($1::text IS NULL OR u.name ILIKE $1 OR u.email ILIKE $1)';
      const [{ rows: users }, { rows: counted }] = await Promise.all([
        query<AdminUser>(
          `SELECT ${ADMIN_USER_COLUMNS} FROM users u
            WHERE ${filter}
            ORDER BY u.is_server_admin DESC, lower(u.name), u.id
            LIMIT ${USER_LIST_LIMIT}`,
          [pattern],
        ),
        query<{ total: number }>(`SELECT count(*)::int AS total FROM users u WHERE ${filter}`, [pattern]),
      ]);
      return { users, total: counted[0].total };
    });

    admin.post('/users', async (req, reply) => {
      const input = parse(adminCreateUserSchema, req.body);
      const passwordHash = await hashPassword(input.password);
      const created = await transaction((client) =>
        createAccount(client, {
          email: input.email,
          name: input.name,
          passwordHash,
          isServerAdmin: input.isServerAdmin,
        }),
      );
      req.log.info({ admin: req.admin!.email, userId: created.id }, 'account created by server administrator');
      reply.status(201);
      return loadUser(created.id);
    });

    admin.patch<{ Params: { id: string } }>('/users/:id', async (req) => {
      const id = accountId(req.params.id);
      const input = parse(adminUpdateUserSchema, req.body);
      const self = id === req.admin!.id;
      if (self && input.isServerAdmin === false) {
        throw badRequest('You cannot remove your own administrator access. Another administrator can.');
      }
      if (self && input.disabled === true) throw badRequest('You cannot disable your own account');

      await transaction(async (client) => {
        await lockAdministrators(client);
        const { rows } = await client.query<{ is_server_admin: boolean; disabled: boolean }>(
          'SELECT is_server_admin, disabled_at IS NOT NULL AS disabled FROM users WHERE id = $1 FOR UPDATE',
          [id],
        );
        const current = rows[0];
        if (!current) throw notFound('Account not found');

        if (input.email) {
          const dup = await client.query('SELECT 1 FROM users WHERE lower(email) = lower($1) AND id <> $2', [
            input.email,
            id,
          ]);
          if (dup.rowCount) throw conflict('Another account already uses that email');
        }

        // The server must never be left with nobody able to administer it.
        const stopsAdministering =
          current.is_server_admin && !current.disabled && (input.isServerAdmin === false || input.disabled === true);
        if (stopsAdministering) {
          const { rows: others } = await client.query<{ present: boolean }>(HAS_ADMINISTRATOR, [id]);
          if (!others[0].present) throw badRequest('The server must keep at least one administrator');
        }

        await client.query(
          `UPDATE users
              SET name = COALESCE($2, name),
                  email = COALESCE($3, email),
                  is_server_admin = COALESCE($4::boolean, is_server_admin),
                  disabled_at = CASE WHEN $5::boolean IS NULL THEN disabled_at
                                     WHEN $5::boolean THEN COALESCE(disabled_at, now())
                                     ELSE NULL END
            WHERE id = $1`,
          [id, input.name ?? null, input.email ?? null, input.isServerAdmin ?? null, input.disabled ?? null],
        );
        if (input.disabled === true) await client.query('DELETE FROM sessions WHERE user_id = $1', [id]);
        if (input.disabled === true || input.isServerAdmin === false) {
          await client.query('DELETE FROM admin_sessions WHERE user_id = $1', [id]);
        }
      });

      if (input.disabled === true) signedOut(id);
      req.log.info({ admin: req.admin!.email, userId: id, changes: input }, 'account changed by server administrator');
      return loadUser(id);
    });

    /** Sets a new password and signs the account out of the app everywhere. */
    admin.post<{ Params: { id: string } }>('/users/:id/password', async (req, reply) => {
      const id = accountId(req.params.id);
      const input = parse(adminSetPasswordSchema, req.body);
      const hash = await hashPassword(input.password);
      // An administrator setting their own password stays signed in here.
      const keep = req.cookies?.[ADMIN_COOKIE] ?? '';
      await transaction(async (client) => {
        const updated = await client.query('UPDATE users SET password_hash = $2 WHERE id = $1', [id, hash]);
        if (!updated.rowCount) throw notFound('Account not found');
        await client.query('DELETE FROM sessions WHERE user_id = $1', [id]);
        await client.query('DELETE FROM admin_sessions WHERE user_id = $1 AND token <> $2', [id, keep]);
      });
      signedOut(id);
      req.log.info({ admin: req.admin!.email, userId: id }, 'password set by server administrator');
      reply.status(204);
    });

    /** Ends every app session the account has, and closes its open connections. */
    admin.post<{ Params: { id: string } }>('/users/:id/sign-out', async (req, reply) => {
      const id = accountId(req.params.id);
      await loadUser(id);
      await query('DELETE FROM sessions WHERE user_id = $1', [id]);
      signedOut(id);
      reply.status(204);
    });

    /**
     * Deletes an account, and with it the workspaces it created. Refused while
     * other people use one of those workspaces, or one it is the only owner of:
     * deleting the account would take their work with it, or leave a workspace
     * nobody can manage. Disabling is the answer there.
     */
    admin.delete<{ Params: { id: string } }>('/users/:id', async (req, reply) => {
      const id = accountId(req.params.id);
      if (id === req.admin!.id) throw badRequest('You cannot delete your own account');

      const files = await transaction(async (client) => {
        const { rows: target } = await client.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [id]);
        if (!target.length) throw notFound('Account not found');

        const { rows: shared } = await client.query<{ name: string }>(
          `SELECT w.name FROM workspaces w
            WHERE EXISTS (SELECT 1 FROM workspace_members o WHERE o.workspace_id = w.id AND o.user_id <> $1)
              AND (w.owner_id = $1
                   OR (EXISTS (SELECT 1 FROM workspace_members m
                                WHERE m.workspace_id = w.id AND m.user_id = $1 AND m.role = 'owner')
                       AND NOT EXISTS (SELECT 1 FROM workspace_members m
                                        WHERE m.workspace_id = w.id AND m.user_id <> $1 AND m.role = 'owner')))
            ORDER BY lower(w.name)`,
          [id],
        );
        if (shared.length) {
          throw conflict(
            `Other people use workspaces this account created or is the only owner of: ` +
              `${shared.map((w) => w.name).join(', ')}. Disable the account instead.`,
          );
        }

        // The rows for these files cascade away, so the files are collected first.
        const { rows: stored } = await client.query<{ storage_key: string }>(
          `SELECT a.storage_key FROM attachments a
             JOIN workspaces w ON w.id = a.workspace_id WHERE w.owner_id = $1
           UNION ALL
           SELECT a.storage_key FROM message_attachments a
             JOIN channels c ON c.id = a.channel_id
             JOIN workspaces w ON w.id = c.workspace_id WHERE w.owner_id = $1
           UNION ALL
           SELECT a.storage_key FROM work_item_attachments a
             JOIN work_items i ON i.id = a.work_item_id
             JOIN projects p ON p.id = i.project_id
             JOIN workspaces w ON w.id = p.workspace_id WHERE w.owner_id = $1
           UNION ALL
           SELECT avatar_key FROM workspaces WHERE owner_id = $1 AND avatar_key IS NOT NULL
           UNION ALL
           SELECT avatar_key FROM users WHERE id = $1 AND avatar_key IS NOT NULL`,
          [id],
        );
        await client.query('DELETE FROM users WHERE id = $1', [id]);
        return stored.map((f) => f.storage_key);
      });

      signedOut(id);
      await removeStoredFiles(files, req.log);
      req.log.warn({ admin: req.admin!.email, userId: id }, 'account deleted by server administrator');
      reply.status(204);
    });
  });
};
