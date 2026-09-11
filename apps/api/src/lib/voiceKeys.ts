import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface VoiceKeys {
  apiKey: string;
  apiSecret: string;
}

/**
 * The API key pair this server and LiveKit share, kept in a file both can read.
 *
 * LiveKit reads its keys from the file, so voice needs nothing generated or
 * copied into .env: the first start writes a fresh pair and every later start
 * reads it back. Keys given in the environment take precedence, and are written
 * to the file so LiveKit agrees with them.
 */
export function ensureVoiceKeys(file: string, fromEnv: VoiceKeys): VoiceKeys {
  const keys = fromEnv.apiKey ? fromEnv : (readKeys(file) ?? generate());
  const contents = `${keys.apiKey}: ${keys.apiSecret}\n`;

  let current: string | null = null;
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch {
    // Not written yet.
  }
  if (current !== contents) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents, { mode: 0o600 });
  }
  // LiveKit refuses a key file that anyone else can read.
  fs.chmodSync(file, 0o600);
  return keys;
}

function readKeys(file: string): VoiceKeys | null {
  try {
    const match = /^\s*([^:\s]+)\s*:\s*(\S+)\s*$/m.exec(fs.readFileSync(file, 'utf8'));
    return match ? { apiKey: match[1], apiSecret: match[2] } : null;
  } catch {
    return null;
  }
}

function generate(): VoiceKeys {
  // Hex keeps the secret a plain YAML scalar whatever bytes come out.
  return { apiKey: 'paradocs', apiSecret: crypto.randomBytes(32).toString('hex') };
}
