// Turn whatever image a person picks into a logo the server will accept
// (docs/FILES.md §4.2): a square PNG, at most 512 px, drawn fresh on a canvas.
//
// Re-encoding here rather than uploading the original does three jobs at once:
// an SVG becomes pixels, so no document that can carry script is ever stored
// or served; EXIF — location included — does not survive a canvas; and a 6 MB
// phone photo becomes tens of kilobytes, well inside the 1 MB limit.

const SIDE = 512;

/** Load through an <img> rather than createImageBitmap, which refuses SVG. */
function load(file: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not an image we can read.')); };
    img.src = url;
  });
}

/**
 * Fit the image inside a transparent square, centred, never upscaled past its
 * own size — a small mark stays crisp rather than being blown up and blurred.
 */
export async function toLogoPng(file: Blob): Promise<Uint8Array> {
  const img = await load(file);
  const w = img.naturalWidth || SIDE, h = img.naturalHeight || SIDE;
  const scale = Math.min(1, SIDE / Math.max(w, h));
  const side = Math.max(1, Math.round(Math.max(w, h) * scale));
  const canvas = document.createElement('canvas');
  canvas.width = side; canvas.height = side;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not prepare the image.');
  const dw = Math.round(w * scale), dh = Math.round(h * scale);
  ctx.drawImage(img, Math.round((side - dw) / 2), Math.round((side - dh) / 2), dw, dh);
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Could not prepare the image.');
  return new Uint8Array(await blob.arrayBuffer());
}
