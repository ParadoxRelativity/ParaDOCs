import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';

/**
 * Headers every response from the app's port carries, and the content security
 * policy on the web client's page.
 *
 * The policy is the one the desktop app already puts on this same build (see
 * apps/desktop/src/main/proxy.ts): scripts only from the bundle, so markup that
 * finds its way into a document cannot run. The permissive entries are there by
 * design — documents and canvases embed pictures, media and whole pages by URL.
 */

/** Hashes every inline <script> in the built page, for script-src. */
function inlineScriptHashes(indexHtml: string): string[] {
  let html: string;
  try {
    html = fs.readFileSync(indexHtml, 'utf8');
  } catch {
    return [];
  }
  const hashes: string[] = [];
  for (const match of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    hashes.push(`'sha256-${createHash('sha256').update(match[1], 'utf8').digest('base64')}'`);
  }
  return hashes;
}

/**
 * A LiveKit server browsers dial directly, rather than through this server's
 * /rtc relay. Its client fetches over http(s) from there to explain a failed
 * join, so that origin has to be reachable too.
 */
function livekitOrigin(): string | null {
  if (!config.livekit.url) return null;
  try {
    return new URL(config.livekit.url.replace(/^ws/, 'http')).origin;
  } catch {
    return null;
  }
}

function contentSecurityPolicy(indexHtml: string): string {
  const livekit = livekitOrigin();
  return [
    "default-src 'self'",
    ["script-src 'self' 'wasm-unsafe-eval'", ...inlineScriptHashes(indexHtml)].join(' '),
    // The editor and its menus set element styles directly.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https: http:",
    "media-src 'self' data: blob: https: http:",
    "font-src 'self' data:",
    ["connect-src 'self' ws: wss:", livekit].filter(Boolean).join(' '),
    "frame-src https: http:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function registerSecurityHeaders(app: FastifyInstance, indexHtml: string): void {
  const csp = contentSecurityPolicy(indexHtml);
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    // The app is never meant to be framed, so no page can dress it up as its
    // own and trick someone into clicking.
    reply.header('X-Frame-Options', 'DENY');
    // Uploads set their own, stricter policy where they need one.
    const type = String(reply.getHeader('content-type') ?? '');
    if (type.startsWith('text/html') && !req.url.startsWith('/uploads/')) {
      reply.header('Content-Security-Policy', csp);
    }
    return payload;
  });
}
