import fs from 'node:fs';
import path from 'node:path';

/**
 * A tiny JSON file store. Writes go to a temp file and are renamed over the
 * target, so a crash mid-write can never leave a truncated file that loses
 * every configured server.
 */
export function readJson<T>(file: string, fallback: T): T {
  try {
    return { ...fallback, ...(JSON.parse(fs.readFileSync(file, 'utf8')) as T) };
  } catch {
    return fallback;
  }
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}
