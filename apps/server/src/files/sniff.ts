// What a file actually IS, from its bytes (docs/FILES.md §4.3).
//
// The declared media type is a claim made by whoever uploaded it. This reads
// the magic bytes, and for images the dimensions from the header, so a "PNG"
// that is an HTML page — or a 40,000-pixel-wide decompression bomb — is known
// before it is ever marked ready. Header parsing only: nothing here decodes a
// pixel.

export interface Sniffed {
  mediaType: string;
  width: number | null;
  height: number | null;
}

const ascii = (b: Buffer, at: number, len: number) => b.toString('latin1', at, at + len);

function png(b: Buffer): Sniffed | null {
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47 || b.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  if (ascii(b, 12, 4) !== 'IHDR') return null;
  return { mediaType: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function gif(b: Buffer): Sniffed | null {
  const sig = ascii(b, 0, 6);
  if (b.length < 10 || (sig !== 'GIF87a' && sig !== 'GIF89a')) return null;
  return { mediaType: 'image/gif', width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
}

function jpeg(b: Buffer): Sniffed | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;
  // Walk the segments to the first start-of-frame. SOF0..SOF15, less the three
  // markers in that range that are not frames (DHT, JPG, DAC).
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i += 1; continue; }
    const marker = b[i + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { mediaType: 'image/jpeg', height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return { mediaType: 'image/jpeg', width: null, height: null };
}

function webp(b: Buffer): Sniffed | null {
  if (b.length < 30 || ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WEBP') return null;
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8 ') {
    return { mediaType: 'image/webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return { mediaType: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    return { mediaType: 'image/webp', width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  }
  return { mediaType: 'image/webp', width: null, height: null };
}

const pdf = (b: Buffer): Sniffed | null =>
  ascii(b, 0, 5) === '%PDF-' ? { mediaType: 'application/pdf', width: null, height: null } : null;

/** The file's real type. Unrecognised bytes are `application/octet-stream`, never the claim. */
export function sniff(bytes: Buffer): Sniffed {
  return png(bytes) ?? jpeg(bytes) ?? gif(bytes) ?? webp(bytes) ?? pdf(bytes)
    ?? { mediaType: 'application/octet-stream', width: null, height: null };
}
