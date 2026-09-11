import type { EmojiMartData } from '@emoji-mart/data';
import { isEmoji } from '@paradocs/shared';

export interface EmojiOption {
  id: string;
  name: string;
  native: string;
}

let catalogue: Promise<EmojiMartData> | null = null;
let loaded: EmojiMartData | null = null;

/**
 * The emoji catalogue, fetched the first time something needs it. It is large,
 * and most visits never open a picker or type a shortcode.
 */
export function loadEmojiData(): Promise<EmojiMartData> {
  catalogue ??= import('@emoji-mart/data').then((module) => {
    loaded = (module as { default?: EmojiMartData }).default ?? (module as unknown as EmojiMartData);
    return loaded;
  });
  return catalogue;
}

/** Emoji whose shortcode, name or keywords match, best matches first. */
export async function searchEmoji(query: string, limit = 8): Promise<EmojiOption[]> {
  const data = await loadEmojiData();
  const needle = query.toLowerCase();
  const aliased = data.aliases[needle];

  const matches: { option: EmojiOption; score: number }[] = [];
  for (const emoji of Object.values(data.emojis)) {
    let score: number;
    if (emoji.id === needle || emoji.id === aliased) score = 0;
    else if (emoji.id.startsWith(needle)) score = 1;
    else if (emoji.id.includes(needle) || emoji.name.toLowerCase().includes(needle)) score = 2;
    else if (emoji.keywords.some((keyword) => keyword.startsWith(needle))) score = 3;
    else continue;
    matches.push({ score, option: { id: emoji.id, name: emoji.name, native: emoji.skins[0].native } });
  }

  matches.sort((a, b) => a.score - b.score || a.option.id.length - b.option.id.length);
  return matches.slice(0, limit).map((match) => match.option);
}

/**
 * Turns a shortcode typed out in full, like `:tada:`, into its emoji. Only once
 * the catalogue has loaded, which typing the start of one already does; before
 * that the text is left as written.
 */
export function replaceShortcodes(text: string): string {
  const data = loaded;
  if (!data) return text;
  return text.replace(/(^|[\s(]):([a-z0-9_+-]+):(?=$|[\s.,!?)])/gi, (match, lead: string, code: string) => {
    const id = code.toLowerCase();
    const emoji = data.emojis[id] ?? data.emojis[data.aliases[id]];
    return emoji ? `${lead}${emoji.skins[0].native}` : match;
  });
}

/**
 * How many emoji a message is made of when it is nothing but emoji, and 0
 * otherwise. A short run of them is shown large, the way chat apps do.
 */
export function emojiOnly(text: string): number {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 64) return 0;
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let count = 0;
  for (const { segment } of segmenter.segment(trimmed)) {
    if (/^\s+$/.test(segment)) continue;
    if (!isEmoji(segment)) return 0;
    count++;
  }
  return count;
}
