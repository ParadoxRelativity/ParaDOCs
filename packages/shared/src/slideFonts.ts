/**
 * The fonts a slide can use, and what to draw when a deck asks for one we do
 * not have.
 *
 * Decks lean on Office fonts that cannot be shipped. The bundled families are
 * metric-compatible with them (Carlito with Calibri, Caladea with Cambria,
 * Liberation with Arial, Times New Roman and Courier New), so text wraps and
 * breaks lines where the author saw it. The .pptx importer (PARA-95) maps what
 * a file names through {@link mapOfficeFont}.
 */

export interface SlideFont {
  /** What is stored on a slide, and shown in the font list. */
  family: string;
  /** The CSS font-family value: the family, then what stands in for it. */
  stack: string;
  /** Bundled fonts are served with the app; system fonts are whatever the device has. */
  source: 'bundled' | 'system';
  /** The Office font this one is metric-compatible with, when it is. */
  replaces?: string[];
}

const SANS = 'ui-sans-serif, system-ui, sans-serif';
const SERIF = 'ui-serif, Georgia, serif';
const MONO = 'ui-monospace, Menlo, Consolas, monospace';

export const SLIDE_FONTS: SlideFont[] = [
  { family: 'Inter', stack: `Inter, ${SANS}`, source: 'bundled' },
  { family: 'Carlito', stack: `Carlito, Calibri, ${SANS}`, source: 'bundled', replaces: ['Calibri'] },
  { family: 'Caladea', stack: `Caladea, Cambria, ${SERIF}`, source: 'bundled', replaces: ['Cambria'] },
  { family: 'Liberation Sans', stack: `'Liberation Sans', Arial, Helvetica, ${SANS}`, source: 'bundled', replaces: ['Arial', 'Helvetica'] },
  { family: 'Liberation Serif', stack: `'Liberation Serif', 'Times New Roman', Times, ${SERIF}`, source: 'bundled', replaces: ['Times New Roman'] },
  { family: 'Liberation Mono', stack: `'Liberation Mono', 'Courier New', ${MONO}`, source: 'bundled', replaces: ['Courier New'] },
  { family: 'Arial', stack: `Arial, 'Liberation Sans', ${SANS}`, source: 'system' },
  { family: 'Verdana', stack: `Verdana, Geneva, ${SANS}`, source: 'system' },
  { family: 'Georgia', stack: `Georgia, ${SERIF}`, source: 'system' },
  { family: 'Trebuchet MS', stack: `'Trebuchet MS', ${SANS}`, source: 'system' },
  { family: 'Impact', stack: `Impact, 'Arial Narrow Bold', ${SANS}`, source: 'system' },
  { family: 'Courier New', stack: `'Courier New', 'Liberation Mono', ${MONO}`, source: 'system' },
];

/** Office font names, lower case, and the bundled family that draws them in the same space. */
const OFFICE_FONT_MAP: Record<string, string> = {
  calibri: 'Carlito',
  'calibri light': 'Carlito',
  cambria: 'Caladea',
  'cambria math': 'Caladea',
  arial: 'Liberation Sans',
  'arial narrow': 'Liberation Sans',
  'arial black': 'Liberation Sans',
  helvetica: 'Liberation Sans',
  'helvetica neue': 'Liberation Sans',
  'segoe ui': 'Inter',
  'segoe ui light': 'Inter',
  'san francisco': 'Inter',
  '.sf ns text': 'Inter',
  'times new roman': 'Liberation Serif',
  times: 'Liberation Serif',
  'courier new': 'Liberation Mono',
  courier: 'Liberation Mono',
  consolas: 'Liberation Mono',
  'lucida console': 'Liberation Mono',
  'palatino linotype': 'Caladea',
  'book antiqua': 'Caladea',
  garamond: 'Caladea',
  'century schoolbook': 'Caladea',
  'trebuchet ms': 'Carlito',
  tahoma: 'Carlito',
  'gill sans mt': 'Carlito',
  corbel: 'Carlito',
  candara: 'Carlito',
};

/**
 * The family to store for a font name found in another program's file: the
 * bundled stand-in when there is one, a family already on the list as itself,
 * and anything else as written (the device may have it, and the stack falls
 * back to a generic family if it does not).
 */
export function mapOfficeFont(name: string | undefined | null): string {
  const trimmed = (name ?? '').trim().replace(/^["']|["']$/g, '');
  if (!trimmed) return SLIDE_FONTS[0].family;
  const own = SLIDE_FONTS.find((font) => font.family.toLowerCase() === trimmed.toLowerCase() && font.source === 'bundled');
  if (own) return own.family;
  return OFFICE_FONT_MAP[trimmed.toLowerCase()] ?? trimmed;
}

/** The CSS font-family for a stored family name. An unknown name is quoted and followed by a generic fallback. */
export function fontStack(family: string | undefined | null): string {
  if (!family) return SLIDE_FONTS[0].stack;
  const known = SLIDE_FONTS.find((font) => font.family === family);
  if (known) return known.stack;
  const mapped = OFFICE_FONT_MAP[family.toLowerCase()];
  const safe = family.replace(/["\\;{}<>]/g, '');
  return `'${safe}'${mapped ? `, ${fontStack(mapped)}` : `, ${SANS}`}`;
}

export const FONT_SIZES = [12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 48, 54, 60, 72, 96, 120];
