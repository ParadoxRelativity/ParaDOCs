import { createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import type { Duplex } from 'node:stream';

/**
 * Serves the bundled web client and reverse-proxies the API to a ParaDOCs
 * server, which is exactly what the Vite dev server does. The renderer
 * therefore sees the same single-origin layout as a browser hitting a
 * self-hosted deployment: relative `/api` fetches, `/uploads` files and the
 * `/collab` websocket all work with no web-side changes, and the session
 * cookie is a plain same-origin cookie rather than a third-party one.
 */

// /rtc is voice signalling, which the server relays to LiveKit. Its websocket
// would be forwarded anyway, but the plain request LiveKit's client makes to
// learn why a join failed must come here too: to anywhere else it is a
// cross-origin fetch, which this window's content security policy refuses.
const PROXIED = ['/api', '/uploads', '/collab', '/chat', '/rtc'];

function isProxied(url: string): boolean {
  const pathname = url.split('?')[0];
  return PROXIED.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

/**
 * The proxy holds no credentials itself — cookies live in the Chromium
 * partition — but it would still relay unauthenticated requests to the target
 * for anything that can reach the port. Requiring a loopback Host defeats DNS
 * rebinding, where a hostile page resolves its own name to 127.0.0.1 and calls
 * this server from a real browser tab.
 */
function hostAllowed(header: string | undefined, port: number): boolean {
  if (!header) return false;
  const host = header.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  const declaredPort = header.match(/:(\d+)$/)?.[1];
  if (declaredPort && Number(declaredPort) !== port) return false;
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/**
 * The cookie was minted for an https origin but is being replayed to the
 * renderer over http://127.0.0.1. `Secure` would make Chromium drop it, a
 * `Domain` from the server never matches loopback, and `SameSite=None` is only
 * legal alongside `Secure`. The hop from here to the server keeps its TLS.
 */
function rewriteCookie(cookie: string): string {
  return cookie
    .split(';')
    .filter((part) => {
      const name = part.trim().toLowerCase();
      return name !== 'secure' && !name.startsWith('domain=');
    })
    .map((part) => (part.trim().toLowerCase() === 'samesite=none' ? ' SameSite=Lax' : part))
    .join(';');
}

/**
 * Scripts may come only from the bundled client, so a document that manages to
 * carry markup cannot execute anything. The permissive entries are the ones the
 * product needs by design: documents embed images, audio and video by URL, and
 * the canvas embeds whole pages in iframes.
 *
 * `scriptHashes` covers the client's own inline scripts — it sets the colour
 * theme before first paint, which has to run inline to avoid a flash of the
 * wrong theme. Hashing them keeps the policy strict where allowing
 * 'unsafe-inline' would open the very hole this closes.
 */
function contentSecurityPolicy(scriptHashes: string[]): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval'${scriptHashes.map((h) => ` '${h}'`).join('')}`,
    // The editor and its menus set element styles directly.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https: http:",
    "media-src 'self' data: blob: https: http:",
    "font-src 'self' data:",
    // Same-origin REST plus the collaboration websocket.
    "connect-src 'self' ws: wss:",
    "frame-src https: http:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/** Hashes every inline <script> in the built index.html, for the CSP above. */
function inlineScriptHashes(webDist: string): string[] {
  let html: string;
  try {
    html = fs.readFileSync(path.join(webDist, 'index.html'), 'utf8');
  } catch {
    return [];
  }
  const hashes: string[] = [];
  for (const match of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    hashes.push(`sha256-${createHash('sha256').update(match[1], 'utf8').digest('base64')}`);
  }
  return hashes;
}

export interface ProxyHandle {
  port: number;
  origin: string;
  close: () => Promise<void>;
}

export interface ProxyOptions {
  /** Origin of the ParaDOCs server this window talks to. */
  target: string;
  /** Directory holding the built web client. */
  webDist: string;
  /** The port to use if it is free; any free port otherwise. */
  port?: number;
}

export async function startProxy({ target, webDist, port: preferredPort }: ProxyOptions): Promise<ProxyHandle> {
  const targetUrl = new URL(target);
  const csp = contentSecurityPolicy(inlineScriptHashes(webDist));
  const agent = targetUrl.protocol === 'https:' ? https : http;

  const server = http.createServer((req, res) => {
    if (!hostAllowed(req.headers.host, (server.address() as { port: number }).port)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    if (isProxied(req.url ?? '/')) forward(req, res);
    else serveStatic(req, res);
  });

  function forward(req: http.IncomingMessage, res: http.ServerResponse): void {
    const upstreamUrl = new URL(req.url ?? '/', targetUrl);
    const headers = { ...req.headers, host: targetUrl.host };
    // Loopback is not the real origin; sending it would fail a server-side
    // origin check and tells the server nothing useful.
    delete headers.origin;
    delete headers.referer;

    const upstream = agent.request(
      upstreamUrl,
      { method: req.method, headers: headers as http.OutgoingHttpHeaders },
      (upstreamRes) => {
        const out = { ...upstreamRes.headers };
        const cookies = upstreamRes.headers['set-cookie'];
        if (cookies) out['set-cookie'] = cookies.map(rewriteCookie);
        res.writeHead(upstreamRes.statusCode ?? 502, out);
        upstreamRes.pipe(res);
      },
    );

    upstream.on('error', (err: NodeJS.ErrnoException) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: `Cannot reach ${targetUrl.origin} (${err.code ?? err.message})` }));
    });

    req.pipe(upstream);
  }

  function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
    const pathname = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const resolved = path.join(webDist, path.normalize(pathname));
    // Never serve outside the bundled client, whatever the path contains.
    const file = resolved.startsWith(webDist) && isFile(resolved) ? resolved : path.join(webDist, 'index.html');

    if (!isFile(file)) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('The bundled web client is missing. Rebuild the desktop app.');
      return;
    }
    const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type,
      // The renderer is reloaded on every launch and the files change with each
      // build, so caching only risks serving a stale client.
      'cache-control': 'no-store',
      ...(type.startsWith('text/html') ? { 'content-security-policy': csp } : {}),
    });
    fs.createReadStream(file).pipe(res);
  }

  // The collaboration websocket. Hocuspocus authenticates from the session
  // cookie on the handshake, so the headers must be relayed untouched.
  server.on('upgrade', (req, socket: Duplex, head: Buffer) => {
    if (!hostAllowed(req.headers.host, (server.address() as { port: number }).port)) {
      socket.destroy();
      return;
    }
    const upstreamUrl = new URL(req.url ?? '/', targetUrl);
    const upstream = agent.request(upstreamUrl, {
      method: 'GET',
      headers: { ...req.headers, host: targetUrl.host } as http.OutgoingHttpHeaders,
    });

    upstream.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
      const lines = [`HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage}`];
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        for (const item of Array.isArray(value) ? value : [value]) {
          if (item !== undefined) lines.push(`${key}: ${item}`);
        }
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (upstreamHead?.length) upstreamSocket.unshift(upstreamHead);
      upstreamSocket.pipe(socket).pipe(upstreamSocket);
      upstreamSocket.on('error', () => socket.destroy());
      socket.on('error', () => upstreamSocket.destroy());
    });

    upstream.on('response', () => socket.destroy()); // upgrade refused
    upstream.on('error', () => socket.destroy());
    if (head?.length) upstream.write(head);
    upstream.end();
  });

  // Loopback only, so nothing off this machine can reach it.
  const listen = (candidate: number) =>
    new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(candidate, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

  try {
    await listen(preferredPort ?? 0);
  } catch (err) {
    // Something else holds the port this connection used last time. Any free
    // one works; the page just starts this launch without its saved state.
    if (!preferredPort || (err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    await listen(0);
  }

  const port = (server.address() as { port: number }).port;
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}
