import { buildApp } from './app.js';
import { config } from './config.js';
import { closeDb, query } from './db/pool.js';
import { createCollabServer } from './collab/server.js';
import { createChatServer } from './chat/server.js';
import { attachVoiceProxy } from './lib/voiceProxy.js';

const app = await buildApp();

// Collaborative editing shares the HTTP server, so self-hosting stays one port.
const collab = createCollabServer(app.log);
collab.attach(app.server);

// Chat rides the same HTTP server on its own path, so self-hosting stays one port.
const chat = createChatServer(app.log);
chat.attach(app.server);

// Voice signalling too, relayed to LiveKit, so voice needs no port of its own.
attachVoiceProxy(app.server, app.log);

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

// Expired sessions are dead weight; sweep them hourly.
const sweep = setInterval(() => {
  query('DELETE FROM sessions WHERE expires_at < now()').catch((err) =>
    app.log.warn({ err }, 'session sweep failed'),
  );
}, 60 * 60 * 1000);
sweep.unref();

try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    // Closing Hocuspocus flushes any debounced document saves.
    await collab.close();
    await chat.close();
    await app.close();
    await closeDb();
    process.exit(0);
  });
}
