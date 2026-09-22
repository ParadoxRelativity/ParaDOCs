import { buildApp } from './app.js';
import { buildAdminApp } from './admin/app.js';
import { config } from './config.js';
import { closeDb, query } from './db/pool.js';
import { createCollabServer } from './collab/server.js';
import { createChatServer } from './chat/server.js';
import { attachVoiceProxy } from './lib/voiceProxy.js';
import { sweepExpiredMessages } from './lib/retention.js';
import { scheduleServerUpdateChecks } from './lib/releases.js';

const app = await buildApp();

// Collaborative editing shares the HTTP server, so self-hosting stays one port.
const collab = createCollabServer(app.log);
collab.attach(app.server);

// Chat rides the same HTTP server on its own path, so self-hosting stays one port.
const chat = createChatServer(app.log);
chat.attach(app.server);

// Voice signalling too, relayed to LiveKit, so voice needs no port of its own.
attachVoiceProxy(app.server, app.log);

// Server administration is the exception: it gets a port of its own, so it can
// be kept off whatever interface the app is published on.
const admin = config.admin.enabled ? await buildAdminApp() : null;

// A LIVEKIT_URL left over from before signalling was relayed sends browsers
// straight past the relay, usually to port 7880, which is no longer published.
// Joining then fails in the browser with nothing in this server's logs, so it
// is said here, once, at startup.
if (config.livekit.url && config.livekit.internalUrl) {
  app.log.warn(
    { livekitUrl: config.livekit.url },
    'LIVEKIT_URL is set, so browsers join calls at that address instead of through this server. ' +
      'Remove LIVEKIT_URL unless browsers can reach LiveKit there directly.',
  );
}

const sweepRetention = () =>
  sweepExpiredMessages(app.log).catch((err) => app.log.warn({ err }, 'message retention sweep failed'));

// Expired sessions are dead weight, and messages past the retention maximum
// must go; sweep both hourly.
const sweep = setInterval(() => {
  query('DELETE FROM sessions WHERE expires_at < now()').catch((err) =>
    app.log.warn({ err }, 'session sweep failed'),
  );
  query('DELETE FROM admin_sessions WHERE expires_at < now()').catch((err) =>
    app.log.warn({ err }, 'admin session sweep failed'),
  );
  void sweepRetention();
}, 60 * 60 * 1000);
sweep.unref();

// Started here rather than in buildApp, so the server the desktop app runs
// locally, which updates with the app, never asks. Once: it keeps its own
// schedule from here on.
scheduleServerUpdateChecks(app.log);

try {
  if (admin && config.admin.port === config.port) {
    throw new Error(`ADMIN_PORT and API_PORT are both ${config.port}. The admin page needs a port of its own.`);
  }
  await app.listen({ port: config.port, host: '0.0.0.0' });
  if (admin) {
    await admin.listen({ port: config.admin.port, host: config.admin.host });
    app.log.info({ host: config.admin.host, port: config.admin.port }, 'server admin page listening');
  }
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

void sweepRetention();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    // Closing Hocuspocus flushes any debounced document saves.
    await collab.close();
    await chat.close();
    await admin?.close();
    await app.close();
    await closeDb();
    process.exit(0);
  });
}
