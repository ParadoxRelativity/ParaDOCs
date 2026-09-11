import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Everything the app writes lives under Electron's per-OS userData directory
 * (~/Library/Application Support/ParaDOCs on macOS, %APPDATA%\ParaDOCs on
 * Windows), so uninstalling never strands data somewhere surprising and a
 * backup of one folder captures every local workspace.
 */
export const userData = app.getPath('userData');

export const paths = {
  userData,
  connectionsFile: path.join(userData, 'connections.json'),
  windowStateFile: path.join(userData, 'window-state.json'),
  /** The workspaces each connection listed last, for when it cannot be asked. */
  workspaceCacheFile: path.join(userData, 'workspace-cache.json'),
  secretFile: path.join(userData, 'session-secret'),
  /** One self-contained directory per local workspace: database + uploads. */
  localRoot: path.join(userData, 'local'),
  localDir: (id: string) => path.join(userData, 'local', id),
};

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Paths inside the application bundle.
 *
 * Anchored to `app.getAppPath()` — the project directory in development, the
 * asar when packaged — rather than to `import.meta.dirname`. Code splitting
 * moves functions into chunk files at build time, so a path derived from the
 * calling module's own directory silently resolves one level too deep the
 * moment the bundler decides to split differently.
 */
export function bundlePath(...segments: string[]): string {
  return path.join(app.getAppPath(), 'dist', ...segments);
}

/**
 * Resources copied next to the bundle at build time: the built web client and
 * the SQL migrations.
 */
export function resourcePath(...segments: string[]): string {
  return bundlePath('resources', ...segments);
}
