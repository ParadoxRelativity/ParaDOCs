/**
 * Slides copied in PowerPoint, as a page can read them.
 *
 * Besides its own clipboard formats (which no page can see), PowerPoint puts
 * the copied slides on the clipboard as a web custom format, `ppt/slides`, for
 * Office on the web to paste. Its value is JSON whose `data` is the slides as a
 * .pptx package in base64: the same package the desktop app's
 * "PowerPoint 14.0 Slides Package" format holds, with its parts under
 * `clipboard/` rather than `ppt/`, which the .pptx reader follows from the
 * package's own relationships. Chrome, Edge, Firefox and the desktop app
 * (Electron) expose custom formats to a paste event; Safari does not, so there
 * a paste of slides lands as the picture PowerPoint puts beside them.
 */

export const POWERPOINT_SLIDES_MIME = 'ppt/slides';

/** What a page will decode: far more than a deck of slides holds, short of exhausting the tab. */
const MAX_PACKAGE_CHARS = 400 * 1024 * 1024;

interface SlidesClip {
  objectCount?: number;
  isDataCompressed?: boolean;
  data?: string;
}

/** Whether the clipboard says it holds PowerPoint slides (they may still turn out unreadable). */
export function hasPowerPointSlides(data: DataTransfer): boolean {
  return [...data.types].includes(POWERPOINT_SLIDES_MIME);
}

/**
 * The copied slides as .pptx bytes, or null when the clipboard holds none this
 * can read. Another program wrote it, so anything malformed is simply not slides.
 */
export function readPowerPointSlides(data: DataTransfer): Uint8Array | null {
  if (!hasPowerPointSlides(data)) return null;
  return decodeSlidesClip(data.getData(POWERPOINT_SLIDES_MIME));
}

export function decodeSlidesClip(raw: string): Uint8Array | null {
  if (!raw || raw.length > MAX_PACKAGE_CHARS) return null;
  let clip: SlidesClip;
  try {
    clip = JSON.parse(raw) as SlidesClip;
  } catch {
    return null;
  }
  // A compressed package is in a form PowerPoint does not document; it has not been seen from a copy of slides.
  if (!clip || typeof clip.data !== 'string' || clip.isDataCompressed) return null;
  let binary: string;
  try {
    binary = atob(clip.data);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  // A zip package starts with a local file header, PK\x03\x04.
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04 ? bytes : null;
}
