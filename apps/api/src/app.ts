import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { HttpError, registerErrorHandler } from './lib/http.js';
import { servesInline } from './lib/storage.js';
import { voiceProxyRoutes } from './lib/voiceProxy.js';
import { sessionPlugin } from './plugins/session.js';
import { authRoutes } from './routes/auth.js';
import { workspaceRoutes } from './routes/workspaces.js';
import { documentRoutes } from './routes/documents.js';
import { searchRoutes } from './routes/search.js';
import { tagRoutes } from './routes/tags.js';
import { commentRoutes } from './routes/comments.js';
import { channelRoutes } from './routes/channels.js';
import { voiceRoutes } from './routes/voice.js';
import { eventRoutes } from './routes/events.js';
import { uploadRoutes } from './routes/uploads.js';
import { inviteRoutes, memberRoutes } from './routes/members.js';
import { notificationRoutes } from './routes/notifications.js';
import { oidcRoutes } from './routes/oidc.js';

export async function buildApp() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    bodyLimit: 10 * 1024 * 1024, // documents with embedded content can be large
  });

  registerErrorHandler(app);

  // Several endpoints take no body but are still POSTed with a JSON content-type
  // (logout, invite accept). Fastify rejects an empty body outright, so treat it
  // as an empty object rather than a 400.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = (body as string).trim();
    if (!text) return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch {
      done(new HttpError(400, 'Body is not valid JSON', 'bad_request'), undefined);
    }
  });

  await app.register(cors, {
    origin: config.corsOrigins,
    credentials: true, // the session cookie must survive cross-origin dev
  });
  await app.register(cookie);
  await app.register(multipart);
  await app.register(sessionPlugin);

  fs.mkdirSync(config.uploadDir, { recursive: true });
  await app.register(fastifyStatic, {
    root: config.uploadDir,
    prefix: '/uploads/',
    // Uploads are whatever people chose to share, served from this origin.
    // Pictures, audio, video and PDFs are shown in place; anything else is sent
    // as a download inside a sandbox, so an uploaded HTML or SVG file cannot
    // run script as the person who opens it.
    setHeaders: (res, filePath) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (!servesInline(filePath)) {
        res.setHeader('Content-Disposition', 'attachment');
        res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
      }
    },
  });

  app.get('/api/health', async () => ({ ok: true, version: '0.1.0' }));

  // In production the API also serves the built SPA, so self-hosting is one
  // process plus Postgres. In dev this directory does not exist and Vite serves
  // the frontend instead.
  const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/', decorateReply: false });
    app.setNotFoundHandler((req, reply) => {
      // API misses stay JSON; everything else falls through to the SPA router.
      if (req.url.startsWith('/api/') || req.url.startsWith('/uploads/')) {
        reply.status(404).send({ error: 'Not found' });
        return;
      }
      reply.type('text/html').send(fs.createReadStream(path.join(webDist, 'index.html')));
    });
    app.log.info('serving web client from %s', webDist);
  }

  for (const routes of [
    authRoutes,
    workspaceRoutes,
    documentRoutes,
    searchRoutes,
    tagRoutes,
    commentRoutes,
    channelRoutes,
    voiceRoutes,
    eventRoutes,
    uploadRoutes,
    memberRoutes,
    inviteRoutes,
    notificationRoutes,
    oidcRoutes,
  ]) {
    await app.register(routes, { prefix: '/api' });
  }

  // Voice signalling under /rtc, relayed to LiveKit when this server has it.
  await app.register(voiceProxyRoutes);

  return app;
}
