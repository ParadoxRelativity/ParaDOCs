import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { forbidden, registerErrorHandler, registerJsonBodyParser } from '../lib/http.js';
import { adminRoutes } from './routes.js';
import { ADMIN_API_PREFIX, ADMIN_COOKIE, ADMIN_HEADER, resolveAdminSession } from './session.js';

/**
 * Nothing loads from anywhere else, and the page cannot be framed. Inline
 * styles are allowed because React sets some; inline script is not.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Server administration: settings for the whole server and every account on
 * it. It is a separate Fastify instance on its own port, so it can be kept off
 * the public interface entirely — by default it listens on loopback only — and
 * none of its routes exist on the app's port at all.
 */
export async function buildAdminApp() {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

  registerErrorHandler(app);
  registerJsonBodyParser(app);
  await app.register(cookie);
  app.decorateRequest('admin', null);

  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith(`${ADMIN_API_PREFIX}/`)) return;
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers[ADMIN_HEADER] !== '1') {
      throw forbidden('This request did not come from the admin page');
    }
    const token = req.cookies?.[ADMIN_COOKIE];
    if (token) req.admin = await resolveAdminSession(token);
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    reply.header('X-Frame-Options', 'DENY');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  // The admin page is a second entry in the web build. In dev it does not exist
  // here, and Vite serves it at /admin.html instead.
  const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../web/dist');
  const page = path.join(webDist, 'admin.html');
  if (fs.existsSync(page)) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: '/',
      index: 'admin.html',
      // The admin page and the bundles it loads, but not the app's own page,
      // which would only fail here without the app's API behind it.
      allowedPath: (pathName) => pathName === '/' || pathName === '/admin.html' || pathName.startsWith('/assets/'),
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        reply.status(404).send({ error: 'Not found' });
        return;
      }
      reply.type('text/html').send(fs.createReadStream(page));
    });
  } else {
    app.get('/', async (_req, reply) =>
      reply
        .type('text/plain')
        .send('The admin page has not been built. In development, open /admin.html on the Vite dev server.'),
    );
  }

  await app.register(adminRoutes, { prefix: ADMIN_API_PREFIX });

  return app;
}
