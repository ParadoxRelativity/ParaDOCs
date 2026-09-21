/**
 * Where the server is, for a client that is not served by it.
 *
 * In a browser, and in the desktop app's loopback proxy, the page and the API
 * share an origin: every path is relative and the session is a cookie. The
 * mobile app serves this same build from inside itself instead, so it has to
 * be told which server to talk to, send every request there, and carry the
 * session as a bearer token, since a webview will not keep a cookie from
 * another origin.
 *
 * Everything here is a no-op off the mobile app: `serverOrigin` is null and
 * every URL comes back as it went in.
 */

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
}

const capacitor = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;

/** True inside the iOS or Android app. */
export const isNativeApp = Boolean(capacitor?.isNativePlatform?.());

/** 'ios', 'android', or 'web'. */
export const nativePlatform = capacitor?.getPlatform?.() ?? 'web';

const ORIGIN_KEY = 'paradocs.server';
const TOKEN_KEY = 'paradocs.sessionToken';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage blocked: the choice lasts until the app is closed.
  }
}

let origin: string | null = isNativeApp ? read(ORIGIN_KEY) : null;
let token: string | null = isNativeApp ? read(TOKEN_KEY) : null;

/** The server this client talks to across origins, or null when it is its own page's. */
export function serverOrigin(): string | null {
  return origin;
}

/**
 * Chooses the server. Signing in is per server, so any session held for the
 * previous one is dropped with it.
 */
export function setServerOrigin(next: string | null) {
  if (next !== origin) setSessionToken(null);
  origin = next;
  write(ORIGIN_KEY, next);
}

export function sessionToken(): string | null {
  return token;
}

export function setSessionToken(next: string | null) {
  token = next;
  write(TOKEN_KEY, next);
}

/**
 * Normalises what someone types into a server field. People paste
 * "docs.example.com", "docs.example.com/", or a full document URL; all three
 * mean the same server. Mirrors the desktop app's own rule.
 */
export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Enter a server address.');
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error(`"${input}" is not a valid server address.`);
  }
  if (!parsed.hostname) throw new Error(`"${input}" is not a valid server address.`);
  return parsed.origin;
}

/** An address on the server: `/api/...`, `/uploads/...`. Relative when the page is the server's own. */
export function serverUrl(path: string): string {
  return origin ? `${origin}${path}` : path;
}

/** A websocket address on the server, such as `/chat`. */
export function socketUrl(path: string): string {
  const base = origin ?? `${window.location.protocol}//${window.location.host}`;
  return `${base.replace(/^http/, 'ws')}${path}`;
}

/**
 * Headers that authenticate a request. Empty in a browser, where the cookie
 * goes along by itself.
 */
export function authHeaders(): Record<string, string> {
  if (!origin) return {};
  // Asks for a session token in the body when signing in, where a browser
  // would be given a cookie; see the server's routes/auth.ts.
  const headers: Record<string, string> = { 'x-paradocs-session': 'token' };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

/** The subprotocol a websocket offers, followed by the token: see the server's session plugin. */
const BEARER_PROTOCOL = 'paradocs.bearer';

/** Opens a websocket to the server, authenticated however this client is. */
export function openSocket(url: string): WebSocket {
  return token ? new WebSocket(url, [BEARER_PROTOCOL, token]) : new WebSocket(url);
}

/**
 * A WebSocket class that authenticates itself, for libraries that construct
 * their own sockets from a URL.
 */
export const AuthenticatedWebSocket = class extends WebSocket {
  constructor(url: string | URL) {
    super(url, token ? [BEARER_PROTOCOL, token] : undefined);
  }
};

/**
 * The server hands out file addresses as paths, `/uploads/...`, and documents
 * store them that way. Across origins those have to name the server to load,
 * and a path this page's own origin would serve is not the file.
 */
const UPLOADS = '/uploads/';

/** A path the server gave, made loadable from this page. */
export function assetUrl<T extends string | null | undefined>(url: T): T {
  if (!origin || !url || !url.startsWith(UPLOADS)) return url;
  return `${origin}${url}` as T;
}

/**
 * The reverse of `assetUrl`, for anything sent back: what the server keeps
 * stays a path, so it still resolves if the server moves to another address.
 */
export function serverPath(url: string): string {
  return origin && url.startsWith(`${origin}${UPLOADS}`) ? url.slice(origin.length) : url;
}

/**
 * Rewrites every upload path in a response so pictures, attachments and
 * avatars load across origins, without each place that shows one having to
 * know. A no-op when the page is the server's own.
 */
export function fromServer<T>(value: T): T {
  if (!origin) return value;
  return mapStrings(value, assetUrl) as T;
}

/** Puts upload addresses in a request body back into the paths the server stores. */
export function toServer<T>(value: T): T {
  if (!origin) return value;
  return mapStrings(value, serverPath) as T;
}

function mapStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn));
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = mapStrings(item, fn);
    return out;
  }
  return value;
}

/**
 * The origin to put in a link meant for someone else: an invitation, or a
 * link to a work item. The mobile app's own origin only means anything inside
 * the app, so there it is the server's.
 */
export function shareOrigin(): string {
  return origin ?? window.location.origin;
}
