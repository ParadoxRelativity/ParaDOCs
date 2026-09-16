import { app as electronApp } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import { ensureDir, paths, resourcePath } from './paths.js';
import { createPGliteDriver, type LocalDatabase } from './pgliteDriver.js';

/**
 * A local workspace is the whole ParaDOCs server running inside the desktop
 * app: the same Fastify routes, the same migrations, the same collaboration
 * layer, with PGlite standing in for Postgres and files on disk under the
 * app's data directory. It listens on loopback so the window's proxy can talk
 * to it exactly as it talks to a remote server, which keeps one code path in
 * the renderer for both kinds of connection.
 *
 * Collaboration still runs, because that is how the editor persists; it is
 * simply an audience of one.
 */

export interface LocalServer {
  origin: string;
  /** Session token for the workspace's single account, ready to be set as a cookie. */
  sessionToken: string;
  close: () => Promise<void>;
}

/**
 * The session secret signs cookies for local workspaces. It is generated once
 * and kept in the user's data directory, so a restart does not log them out.
 */
function sessionSecret(): string {
  try {
    const existing = fs.readFileSync(paths.secretFile, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {
    // No secret yet; fall through and make one.
  }
  const secret = crypto.randomBytes(32).toString('hex');
  ensureDir(path.dirname(paths.secretFile));
  fs.writeFileSync(paths.secretFile, secret, { mode: 0o600 });
  return secret;
}

export async function startLocalServer(connectionId: string): Promise<LocalServer> {
  const dir = ensureDir(paths.localDir(connectionId));
  const uploadDir = ensureDir(path.join(dir, 'uploads'));

  // The API reads its configuration from the environment at import time, so
  // every value has to be in place before the first import below.
  process.env.DATABASE_URL = 'pglite://local'; // unused: the driver is injected
  process.env.SESSION_SECRET = sessionSecret();
  process.env.UPLOAD_DIR = uploadDir;
  process.env.SECURE_COOKIES = 'false'; // loopback http
  process.env.LOG_LEVEL ??= 'warn';
  // A local workspace is one person on one machine. Anyone who could reach an
  // invite endpoint here already has the user's account.
  process.env.ALLOW_REGISTRATION = 'true';
  // The server reports the app's version: it is the same release, and its own
  // manifest is not on disk inside the package.
  process.env.PARADOCS_VERSION = electronApp.getVersion();

  const [{ buildApp }, { createCollabServer }, { createChatServer }, { useDriver, closeDb }, { runMigrations }] =
    await Promise.all([
      import('@paradocs/api/app'),
      import('@paradocs/api/collab'),
      import('@paradocs/api/chat'),
      import('@paradocs/api/db/pool'),
      import('@paradocs/api/db/migrate'),
    ]);

  let database: LocalDatabase | undefined;
  try {
    database = await createPGliteDriver(path.join(dir, 'pgdata'));
    useDriver(database);
    await runMigrations(database, resourcePath('migrations'));

    const app = await buildApp();
    const collab = createCollabServer(app.log);
    collab.attach(app.server);
    const chat = createChatServer(app.log);
    chat.attach(app.server);
    await app.listen({ port: 0, host: '127.0.0.1' });

    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Local server did not report a port.');
    const origin = `http://127.0.0.1:${address.port}`;

    const sessionToken = await signIn(origin, database);

    let closed = false;
    return {
      origin,
      sessionToken,
      close: async () => {
        if (closed) return;
        closed = true;
        // Closing Hocuspocus first flushes any debounced document saves.
        await collab.close();
        await chat.close();
        await app.close();
        await closeDb();
      },
    };
  } catch (err) {
    await database?.close().catch(() => {});
    throw err;
  }
}

/**
 * A local workspace belongs to whoever is sitting at the machine. Asking them
 * to invent an account and a password to read their own files would be
 * ceremony that protects nothing — the database sits unencrypted beside it.
 *
 * So the first launch registers the single account through the server's own
 * registration route, which is what builds the starter workspace and folders,
 * and every launch afterwards mints a session directly. The generated password
 * is never stored or shown: nothing signs in with it.
 */
async function signIn(origin: string, db: LocalDatabase): Promise<string> {
  const { rows } = await db.query<{ id: string }>('SELECT id FROM users ORDER BY created_at LIMIT 1');
  let userId = rows[0]?.id;

  if (!userId) {
    const response = await fetch(`${origin}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: localAccountName(),
        // Never used to sign in; it only satisfies the account model.
        email: 'you@paradocs.local',
        password: crypto.randomBytes(24).toString('hex'),
      }),
    });
    if (!response.ok) {
      throw new Error(`Could not prepare the workspace (${response.status}): ${await response.text()}`);
    }
    const created = await db.query<{ id: string }>('SELECT id FROM users ORDER BY created_at LIMIT 1');
    userId = created.rows[0]?.id;
    if (!userId) throw new Error('The workspace was created without an account.');
  }

  const token = crypto.randomBytes(32).toString('hex');
  await db.query(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, now() + interval '30 days')`,
    [token, userId],
  );
  return token;
}

function localAccountName(): string {
  try {
    return os.userInfo().username || 'Me';
  } catch {
    return 'Me';
  }
}
