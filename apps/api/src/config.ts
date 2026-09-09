import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The .env lives at the repo root so API and web read one file.
const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, '../../../.env') });

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}. Copy .env.example to .env.`);
  return value;
}

export const config = {
  databaseUrl: required('DATABASE_URL'),
  port: Number(process.env.API_PORT ?? 4000),
  sessionSecret: required('SESSION_SECRET'),
  corsOrigins: (process.env.CORS_ORIGIN ?? 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  secureCookies: process.env.SECURE_COOKIES === 'true',
  uploadDir: path.resolve(here, '../../..', process.env.UPLOAD_DIR ?? './data/uploads'),
  allowRegistration: process.env.ALLOW_REGISTRATION !== 'false',
  sessionTtlDays: 30,
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
