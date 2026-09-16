import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyBaseLogger } from 'fastify';
import {
  compareVersions,
  isVersion,
  type AdminVersionStatus,
  type ReleaseInfo,
  type ServerUpdateNotification,
} from '@paradocs/shared';

/**
 * Which version this server is, and whether a newer one has been released.
 *
 * A release is one tag that builds both the desktop app and the server image,
 * and the release workflow refuses a tag that disagrees with
 * apps/desktop/package.json — so that manifest, which the image carries, is the
 * release version. PARADOCS_VERSION overrides it; the desktop app sets it for
 * the server it runs locally, where the manifest is not on disk.
 *
 * Checking asks GitHub for the newest published release. Drafts and
 * prereleases are not returned there, so nobody is told about a release before
 * it is published. A server that should not reach GitHub sets UPDATE_CHECK to
 * false; a fork points UPDATE_CHECK_REPO at its own repository.
 */

function readVersion(): string | null {
  const fromEnv = process.env.PARADOCS_VERSION?.trim();
  if (fromEnv) return fromEnv;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(fs.readFileSync(path.resolve(here, '../../../desktop/package.json'), 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : null;
  } catch {
    return null;
  }
}

export const serverVersion = readVersion();

const SIX_HOURS = 6 * 60 * 60 * 1000;
const REPO = process.env.UPDATE_CHECK_REPO?.trim() || 'ParadoxRelativity/ParaDOCs';
const checksEnabled =
  process.env.UPDATE_CHECK?.trim().toLowerCase() !== 'false' && serverVersion !== null && isVersion(serverVersion);

let latest: ReleaseInfo | null = null;
let checkedAt: string | null = null;
let lastError: string | null = null;
let inFlight: Promise<void> | null = null;

function updateAvailable(): boolean {
  return Boolean(serverVersion && latest && compareVersions(latest.version, serverVersion) > 0);
}

export function versionStatus(): AdminVersionStatus {
  return {
    currentVersion: serverVersion,
    checksEnabled,
    latest,
    updateAvailable: updateAvailable(),
    checkedAt,
    error: lastError,
  };
}

/** The release to tell administrators about, if there is one. */
export function availableServerUpdate(): ServerUpdateNotification | null {
  if (!serverVersion || !latest || !updateAvailable()) return null;
  return { currentVersion: serverVersion, release: latest };
}

async function fetchLatest(): Promise<ReleaseInfo | null> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': `ParaDOCs-server/${serverVersion}`,
    },
    signal: AbortSignal.timeout(15_000),
  });
  // Nothing published yet is the normal state before a first release.
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);

  const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown; published_at?: unknown };
  const version = typeof body.tag_name === 'string' ? body.tag_name.replace(/^v/, '') : '';
  if (!isVersion(version)) throw new Error(`The newest release is tagged "${String(body.tag_name)}", which is not a version`);
  const url =
    typeof body.html_url === 'string' && body.html_url.startsWith('https://')
      ? body.html_url
      : `https://github.com/${REPO}/releases/tag/v${version}`;
  return { version, url, publishedAt: typeof body.published_at === 'string' ? body.published_at : null };
}

/** Asks the release channel now. Concurrent callers share one request. */
export function checkForServerUpdate(log: FastifyBaseLogger): Promise<AdminVersionStatus> {
  if (!checksEnabled) return Promise.resolve(versionStatus());
  inFlight ??= (async () => {
    try {
      const found = await fetchLatest();
      const wasAvailable = updateAvailable();
      latest = found;
      lastError = null;
      checkedAt = new Date().toISOString();
      if (!wasAvailable && updateAvailable()) {
        log.info({ current: serverVersion, available: found?.version, url: found?.url }, 'a newer ParaDOCs release is available');
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      log.warn({ err: lastError }, 'could not check for a newer ParaDOCs release');
    } finally {
      inFlight = null;
    }
  })();
  return inFlight.then(versionStatus);
}

/** Checks shortly after start, then every six hours. Does nothing when checks are off. */
export function scheduleServerUpdateChecks(log: FastifyBaseLogger): void {
  if (!checksEnabled) {
    log.info({ version: serverVersion }, 'checking for newer releases is off');
    return;
  }
  const run = () => void checkForServerUpdate(log);
  setTimeout(run, 30_000).unref();
  setInterval(run, SIX_HOURS).unref();
}
