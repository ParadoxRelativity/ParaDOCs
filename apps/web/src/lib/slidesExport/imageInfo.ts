/** What an exporter needs to know about a picture's bytes: its pixel size and a format PowerPoint opens. */
export interface ImageInfo {
  width: number;
  height: number;
  ext: 'png' | 'jpeg' | 'gif' | 'webp';
}

const u32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u16le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);

/** Reads the format and pixel size from an image's header; null when it is not a PNG, JPEG, GIF or WebP. */
export function sniffImage(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length < 24) return null;
  // PNG: signature, then IHDR with width and height.
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { ext: 'png', width: u32(bytes, 16), height: u32(bytes, 20) };
  }
  // GIF: width and height as little-endian 16-bit numbers after the signature.
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { ext: 'gif', width: u16le(bytes, 6), height: u16le(bytes, 8) };
  }
  // JPEG: walk the marker segments to the first start-of-frame.
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let o = 2;
    while (o + 9 < bytes.length) {
      if (bytes[o] !== 0xff) {
        o++;
        continue;
      }
      const marker = bytes[o + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        o += 2;
        continue;
      }
      const length = (bytes[o + 2] << 8) | bytes[o + 3];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { ext: 'jpeg', height: (bytes[o + 5] << 8) | bytes[o + 6], width: (bytes[o + 7] << 8) | bytes[o + 8] };
      }
      o += 2 + length;
    }
    return null;
  }
  // WebP: RIFF container; lossy, lossless and extended each keep the size somewhere different.
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    const kind = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
    if (kind === 'VP8X') return { ext: 'webp', width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)), height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) };
    if (kind === 'VP8 ') return { ext: 'webp', width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
    if (kind === 'VP8L') {
      const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
      return { ext: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

/** Bytes as base64, in chunks so a large picture does not overflow the call stack. */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}
