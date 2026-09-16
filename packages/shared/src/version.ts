/**
 * Release versions, as the release workflow tags them: `1.2.3`, optionally
 * with a leading `v` and a prerelease suffix such as `1.2.3-beta.1`.
 */

interface Parsed {
  core: number[];
  prerelease: string | null;
}

function parse(version: string): Parsed | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version.trim());
  if (!match) return null;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] ?? null };
}

/** Whether a string is a version this module understands. */
export function isVersion(version: string): boolean {
  return parse(version) !== null;
}

/**
 * Negative when `a` is older than `b`, positive when newer, zero when the same.
 * A prerelease comes before the release it leads up to. Anything that is not a
 * version compares as equal, so a malformed tag never announces an update.
 */
export function compareVersions(a: string, b: string): number {
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return 0;
  for (let i = 0; i < 3; i++) {
    if (left.core[i] !== right.core[i]) return left.core[i]! - right.core[i]!;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}

/** Where a server announces a new release: the published release on GitHub. */
export interface ReleaseInfo {
  version: string;
  /** The release page, with its notes. Always https. */
  url: string;
  publishedAt: string | null;
}
