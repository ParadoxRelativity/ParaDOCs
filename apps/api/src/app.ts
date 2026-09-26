import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { notFound, registerErrorHandler, registerJsonBodyParser } from './lib/http.js';
import { registerSecurityHeaders } from './lib/securityHeaders.js';
import { serverVersion } from './lib/releases.js';
import { servesInline } from './lib/storage.js';
import { voiceProxyRoutes } from './lib/voiceProxy.js';
import { resolveMediaToken, sessionPlugin } from './plugins/session.js';
import { mayReadUpload } from './lib/uploadAccess.js';
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
import { roleRoutes } from './routes/roles.js';
import { notificationRoutes } from './routes/notifications.js';
import { oidcRoutes } from './routes/oidc.js';
import { directRoutes } from './routes/direct.js';
import { presenceRoutes } from './routes/presence.js';
import { accessRoutes } from './routes/access.js';
import { projectRoutes } from './routes/projects.js';
import { intakeRoutes } from './routes/intake.js';
import { scheduleWorkItemArchiving } from './lib/workItemArchive.js';

export async function buildApp() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    bodyLimit: 10 * 1024 * 1024, // documents with embedded content can be large
    // So sign-in limits count each person's address rather than the proxy's.
    trustProxy: config.trustProxy,
  });

  registerErrorHandler(app);
  registerJsonBodyParser(app);

  const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  registerSecurityHeaders(app, path.join(webDist, 'index.html'));

  await app.register(cors, {
    origin: config.corsOrigins,
    credentials: true, // the session cookie must survive cross-origin dev
    // The plugin's default is GET, HEAD and POST. The mobile app calls across
    // origins for everything, so edits and deletes have to pass preflight too.
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });
  await app.register(cookie);
  await app.register(multipart);
  await app.register(sessionPlugin);

  fs.mkdirSync(config.uploadDir, { recursive: true });
  // Not served as a directory: each file goes only to those who may see what
  // it was shared in. This registration only provides reply.sendFile.
  // cacheControl off, or it would replace the route's own private caching.
  await app.register(fastifyStatic, { root: config.uploadDir, serve: false, cacheControl: false });

  app.get<{ Params: { '*': string }; Querystring: { media?: string } }>('/uploads/*', async (req, reply) => {
    const storageKey = req.params['*'];
    // A browser's cookie has already signed it in. The mobile app cannot send
    // its session with a picture, so it names a files-only token instead.
    const user = req.user ?? (req.query.media ? await resolveMediaToken(req.query.media) : null);
    // Not found either way, so an address reveals nothing to someone who may not have it.
    if (!(await mayReadUpload(user?.id ?? null, storageKey))) throw notFound();

    reply.header('X-Content-Type-Options', 'nosniff');
    // Kept by the reader's browser, never by a proxy or CDN between.
    reply.header('Cache-Control', 'private, max-age=86400');
    // Uploads are whatever people chose to share, served from this origin.
    // Pictures, audio, video and PDFs are shown in place; anything else is sent
    // as a download inside a sandbox, so an uploaded HTML or SVG file cannot
    // run script as the person who opens it.
    if (!servesInline(storageKey)) {
      reply.header('Content-Disposition', 'attachment');
      reply.header('Content-Security-Policy', "sandbox; default-src 'none'");
    }
    return reply.sendFile(storageKey);
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
    projectRoutes,
    intakeRoutes,
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
    roleRoutes,
    accessRoutes,
    inviteRoutes,
    notificationRoutes,
    oidcRoutes,
  ]) {
    await app.register(routes, { prefix: '/api' });
  }

  // Voice signalling under /rtc, relayed to LiveKit when this server has it.
  await app.register(voiceProxyRoutes);

  // Here rather than in server.ts, so the server the desktop app runs locally
  // puts finished work away too.
  scheduleWorkItemArchiving(app);

  return app;
}
