import http, { type IncomingMessage, type Server } from 'node:http';
import https from 'node:https';
import type { Duplex } from 'node:stream';
import type { FastifyBaseLogger, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { voiceEnabled } from '../routes/voice.js';

/**
 * LiveKit's signalling, served from this server's own address.
 *
 * Browsers open a websocket under /rtc to join a call, and fetch a URL under it
 * to find out why when that fails. Both are relayed here to the LiveKit
 * container, so voice works on whatever address the app does — plain HTTP on a
 * port, or HTTPS behind Caddy — with no second hostname, certificate or
 * published port. Call media does not come through here: it goes straight to
 * LiveKit's own UDP and TCP ports.
 */
const RTC_PATH = '/rtc';

function isSignalling(url: string | undefined): boolean {
  const pathname = (url ?? '').split('?')[0];
  return pathname === RTC_PATH || pathname.startsWith(`${RTC_PATH}/`);
}

/** Where signalling is relayed to, or null when this server does not relay it. */
function upstreamFor(requestUrl: string | undefined): URL | null {
  if (!config.livekit.internalUrl || !voiceEnabled()) return null;
  return new URL(requestUrl ?? RTC_PATH, config.livekit.internalUrl);
}

function clientFor(url: URL) {
  return url.protocol === 'https:' ? https : http;
}

/** The status line and headers of a response, as raw HTTP for a socket. */
function head(res: IncomingMessage): string {
  const lines = [`HTTP/1.1 ${res.statusCode} ${res.statusMessage}`];
  for (let i = 0; i < res.rawHeaders.length; i += 2) lines.push(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}`);
  return `${lines.join('\r\n')}\r\n\r\n`;
}

/** Plain requests under /rtc, such as the one explaining a refused connection. */
export const voiceProxyRoutes: FastifyPluginAsync = async (app) => {
  function relay(req: FastifyRequest, reply: FastifyReply) {
    const target = upstreamFor(req.raw.url);
    if (!target) {
      reply.status(404).send({ error: 'Not found' });
      return;
    }
    reply.hijack();
    const upstream = clientFor(target).request(
      target,
      { method: req.raw.method, headers: { ...req.raw.headers, host: target.host } },
      (res) => {
        reply.raw.writeHead(res.statusCode ?? 502, res.headers);
        res.pipe(reply.raw);
      },
    );
    upstream.on('error', (err) => {
      req.log.warn({ err }, 'voice service unreachable');
      if (!reply.raw.headersSent) reply.raw.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      reply.raw.end('The voice service is not reachable');
    });
    upstream.end();
  }

  app.get(RTC_PATH, relay);
  app.get(`${RTC_PATH}/*`, relay);
};

/** The signalling websocket itself. */
export function attachVoiceProxy(server: Server, log: FastifyBaseLogger): void {
  server.on('upgrade', (req, socket: Duplex, earlyData: Buffer) => {
    // Other upgrade listeners — collaboration, chat — handle their own paths.
    if (!isSignalling(req.url)) return;

    const target = upstreamFor(req.url);
    if (!target) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }

    const upstream = clientFor(target).request(target, {
      method: 'GET',
      headers: { ...req.headers, host: target.host },
    });

    upstream.on('upgrade', (res, upstreamSocket, upstreamData) => {
      socket.write(head(res));
      if (upstreamData.length) socket.write(upstreamData);
      if (earlyData.length) upstreamSocket.write(earlyData);
      upstreamSocket.pipe(socket).pipe(upstreamSocket);
      upstreamSocket.on('error', () => socket.destroy());
      socket.on('error', () => upstreamSocket.destroy());
      upstreamSocket.on('close', () => socket.destroy());
      socket.on('close', () => upstreamSocket.destroy());
    });

    // LiveKit declined the websocket, for instance over an expired token.
    upstream.on('response', (res) => {
      socket.write(head(res));
      res.pipe(socket);
    });

    upstream.on('error', (err) => {
      log.warn({ err }, 'voice service unreachable');
      socket.destroy();
    });
    upstream.end();
  });
}
