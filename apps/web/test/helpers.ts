import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMParser } from '@xmldom/xmldom';
import { parseSlideFile, type ParseOptions } from '../src/lib/slideImportParse';
import type { ImportedDeck } from '../src/lib/slideImportTypes';

const here = dirname(fileURLToPath(import.meta.url));
export const fixturePath = (name: string) => join(here, 'fixtures', 'slides', name);

/** Reads a checked-in fixture deck through the same entry point the app uses, with the XML parser a worker has. */
export async function importFixture(name: string, options: Partial<ParseOptions> = {}): Promise<ImportedDeck> {
  const bytes = readFileSync(fixturePath(name));
  return parseSlideFile(
    new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    name,
    { parseXml: (text) => new DOMParser().parseFromString(text, 'text/xml') as unknown as Document, ...options },
  );
}
