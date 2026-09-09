import type { Block } from '@blocknote/core';
import { normalizeBlocks as normalize } from '@paradocs/shared';

/** Typed wrapper over the shared normalizer, so the editor gets Block[]. */
export function normalizeBlocks(input: unknown): Block[] | undefined {
  return normalize(input) as Block[] | undefined;
}
