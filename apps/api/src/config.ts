import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ensureVoiceKeys } from './lib/voiceKeys.js';

// The .env lives at the repo root so API and web read one file.
const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, '../../../.env') });

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}. Copy .env.example to .env.`);
  return value;
}

/**
 * Voice and video settings. Optional: with no LiveKit server to reach, the
 * feature turns itself off and the client says so, rather than offering a call
 * that cannot connect.
 */
function livekitSettings() {
  const fromEnv = {
    apiKey: process.env.LIVEKIT_API_KEY?.trim() ?? '',
    apiSecret: process.env.LIVEKIT_API_SECRET?.trim() ?? '',
  };
  if (Boolean(fromEnv.apiKey) !== Boolean(fromEnv.apiSecret)) {
    throw new Error('Set both LIVEKIT_API_KEY and LIVEKIT_API_SECRET, or neither.');
  }

  // With a key file, as in the Docker deployment, the keys are generated on
  // first start and shared with LiveKit through it.
  const keyFile = process.env.LIVEKIT_KEY_FILE?.trim() ?? '';
  let keys = fromEnv;
  if (keyFile) {
    try {
      keys = ensureVoiceKeys(keyFile, fromEnv);
    } catch (err) {
      // Voice is one feature; a volume that cannot be written must not stop
      // documents and chat from starting.
      console.error(`Voice is off: could not use the key file ${keyFile}: ${(err as Error).message}`);
      keys = { apiKey: '', apiSecret: '' };
    }
  }

  return {
    enabled: process.env.VOICE_ENABLED?.trim().toLowerCase() !== 'false',
    /**
     * What browsers dial. Unset, they dial this server's own address and it
     * relays signalling to `internalUrl`. Set it only for a LiveKit server
     * browsers reach some other way, such as in local development.
     */
    url: process.env.LIVEKIT_URL?.trim() ?? '',
    /** Where this server reaches LiveKit itself, such as http://livekit:7880. */
    internalUrl: process.env.LIVEKIT_INTERNAL_URL?.trim() ?? '',
    apiKey: keys.apiKey,
    apiSecret: keys.apiSecret,
  };
}

/**
 * The server admin page: settings for the whole server and every account on
 * it. It listens on a port of its own so it can be kept internal, and by
 * default only this machine can reach it.
 */
function adminSettings() {
  const port = Number(process.env.ADMIN_PORT?.trim() || 4001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('ADMIN_PORT must be a port number, such as 4001.');
  }
  return {
    enabled: process.env.ADMIN_ENABLED?.trim().toLowerCase() !== 'false',
    port,
    host: process.env.ADMIN_HOST?.trim() || '127.0.0.1',
    secureCookies: process.env.ADMIN_SECURE_COOKIES === 'true',
  };
}

function megabytes(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback * 1024 * 1024;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a number of megabytes greater than zero, such as 25.`);
  }
  return Math.floor(value * 1024 * 1024);
}

/**
 * Whether to believe X-Forwarded-For about who a request came from. Behind
 * Caddy or another reverse proxy every request arrives from the proxy, so
 * per-address limits would count the whole server as one address. Only set it
 * when nothing can reach the app except through the proxy, or anyone can claim
 * any address. `true`, or the proxy's addresses as a comma-separated list.
 */
function trustProxySetting(): boolean | string {
  const raw = process.env.TRUST_PROXY?.trim() ?? '';
  if (!raw || raw.toLowerCase() === 'false') return false;
  return raw.toLowerCase() === 'true' ? true : raw;
}

/** Where the iOS and Android apps serve their bundled client from. */
const MOBILE_APP_ORIGINS = ['capacitor://localhost', 'https://localhost'];

export const config = {
  databaseUrl: required('DATABASE_URL'),
  port: Number(process.env.API_PORT ?? 4000),
  sessionSecret: required('SESSION_SECRET'),
  corsOrigins: [
    ...(process.env.CORS_ORIGIN ?? 'http://localhost:5173')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    // The mobile app's pages are served from inside the app, from these
    // origins, and call this server across origins. It signs in with a bearer
    // token rather than a cookie, so allowing them lends it no browser
    // credentials. A server that wants no mobile access sets ALLOW_MOBILE_APP=false.
    ...(process.env.ALLOW_MOBILE_APP === 'false' ? [] : MOBILE_APP_ORIGINS),
  ],
  secureCookies: process.env.SECURE_COOKIES === 'true',
  trustProxy: trustProxySetting(),
  uploadDir: path.resolve(here, '../../..', process.env.UPLOAD_DIR ?? './data/uploads'),
  /**
   * The largest file anyone can upload, whether to chat, a document or a
   * canvas. It is set for the whole server by whoever runs it, never per
   * workspace. Profile pictures keep their own, smaller cap.
   */
  maxUploadBytes: megabytes('MAX_UPLOAD_MB', 25),
  /**
   * Whether open registration starts on. The admin page can change it, after
   * which this is no longer consulted; see lib/serverSettings.ts.
   */
  allowRegistration: process.env.ALLOW_REGISTRATION !== 'false',
  sessionTtlDays: 30,
  livekit: livekitSettings(),
  admin: adminSettings(),

  // OIDC is stubbed in Phase 1; these are read so deployments can be configured
  // ahead of the implementation landing. See routes/oidc.ts.
  oidc: {
    issuer: process.env.OIDC_ISSUER ?? '',
    clientId: process.env.OIDC_CLIENT_ID ?? '',
    clientSecret: process.env.OIDC_CLIENT_SECRET ?? '',
    redirectUri: process.env.OIDC_REDIRECT_URI ?? '',
    providerName: process.env.OIDC_PROVIDER_NAME ?? 'SSO',
  },
};

if (config.sessionSecret.length < 32) {
  throw new Error('SESSION_SECRET must be at least 32 characters. See .env.example for how to generate one.');
}
