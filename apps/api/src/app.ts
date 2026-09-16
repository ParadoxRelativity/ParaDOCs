import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { registerErrorHandler, registerJsonBodyParser } from './lib/http.js';
import { serverVersion } from './lib/releases.js';
import { servesInline } from './lib/storage.js';
import { voiceProxyRoutes } from './lib/voiceProxy.js';
import { sessionPlugin } from './plugins/session.js';
import { authRoutes } from './routes/auth.js';
import { workspaceRoutes } from './routes/workspaces.js';
import { documentRoutes } from './routes/documents.js';
import { spreadsheetRoutes } from './routes/spreadsheets.js';
import { searchRoutes } from './routes/search.js';
import { tagRoutes } from './routes/tags.js';
import { commentRoutes } from './routes/comments.js';
import { channelRoutes } from './routes/channels.js';
import { voiceRoutes, voiceWebhookRoutes } from './routes/voice.js';
import { eventRoutes } from './routes/events.js';
import { uploadRoutes } from './routes/uploads.js';
import { inviteRoutes, memberRoutes } from './routes/members.js';
import { notificationRoutes } from './routes/notifications.js';
import { oidcRoutes } from './routes/oidc.js';
import { directRoutes } from './routes/direct.js';
import { presenceRoutes } from './routes/presence.js';
import { accessRoutes } from './routes/access.js';

export async function buildApp() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    bodyLimit: 10 * 1024 * 1024, // documents with embedded content can be large
  });

  registerErrorHandler(app);
  registerJsonBodyParser(app);

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
    setHeaders: (reply, filePath) => {
      reply.header('X-Content-Type-Options', 'nosniff');
      if (!servesInline(filePath)) {
        reply.header('Content-Disposition', 'attachment');
        reply.header('Content-Security-Policy', "sandbox; default-src 'none'");
      }
    },
  });

  // The version lets an open browser tab notice the server has been upgraded
  // underneath it.
  app.get('/api/health', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { ok: true, version: serverVersion };
  });

  // In production the API also serves the built SPA, so self-hosting is one
  // process plus Postgres. In dev this directory does not exist and Vite serves
  // the frontend instead.
  const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: '/',
      decorateReply: false,
      // The server admin page is in the same build but is only served on the
      // admin port. See admin/app.ts.
      allowedPath: (pathName) => pathName !== '/admin.html',
    });
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
    spreadsheetRoutes,
    searchRoutes,
    tagRoutes,
    commentRoutes,
    channelRoutes,
    directRoutes,
    presenceRoutes,
    voiceRoutes,
    voiceWebhookRoutes,
    eventRoutes,
    uploadRoutes,
    memberRoutes,
    accessRoutes,
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
