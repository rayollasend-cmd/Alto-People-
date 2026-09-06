/**
 * Decode a picked/captured image file into an <img>, surviving what
 * phones actually produce:
 *   1. object URL + decode() — the fast path, no pixel copy;
 *   2. createImageBitmap(file) → canvas → JPEG data URL — some browsers
 *      decode via the bitmap path what the element path rejects;
 *   3. HEIC/HEIF (iPhone & Samsung library photos — no browser ships a
 *      native decoder, the format is patent-encumbered): converted to
 *      JPEG in the browser via a lazily-loaded wasm decoder (heic2any),
 *      the same lazy-chunk pattern as the OpenCV scanner.
 * Throws only when the file is genuinely unreadable — callers show
 * retake-with-the-camera guidance instead of a silent dead end.
 */

/** `ftyp` brands that mark HEIC/HEIF containers. */
const HEIC_BRANDS = new Set([
  'heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1',
]);

async function decodeBlob(file: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  const el = new Image();
  el.src = url;
  try {
    await el.decode();
    return el;
  } catch {
    URL.revokeObjectURL(url);
  }
  const bmp = await createImageBitmap(file);
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('canvas 2d unavailable');
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const el2 = new Image();
  el2.src = c.toDataURL('image/jpeg', 0.95);
  await el2.decode();
  return el2;
}

/** HEIC by declared type, filename, or the container's ftyp brand —
 *  Android pickers often hand HEIC over with an empty MIME type. */
export async function isHeicLike(file: Blob): Promise<boolean> {
  const name =
    'name' in file ? String((file as File).name).toLowerCase() : '';
  if (/image\/hei[cf]/i.test(file.type) || /\.hei[cf]$/.test(name)) return true;
  if (file.type && file.type !== 'application/octet-stream') return false;
  try {
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    if (head.length < 12) return false;
    const ascii = (o: number) =>
      String.fromCharCode(head[o]!, head[o + 1]!, head[o + 2]!, head[o + 3]!);
    return ascii(4) === 'ftyp' && HEIC_BRANDS.has(ascii(8));
  } catch {
    return false;
  }
}

/** Should this pick route through the image crop/scan step? MIME first,
 *  filename as backup — Android pickers hand HEIC over with an empty
 *  type, which used to skip the crop (and its HEIC conversion) entirely. */
export function isImagePick(file: File): boolean {
  return (
    file.type.startsWith('image/') ||
    /\.(heic|heif|jpe?g|png|webp|gif|bmp)$/i.test(file.name)
  );
}

export async function loadImageFile(file: Blob): Promise<HTMLImageElement> {
  try {
    return await decodeBlob(file);
  } catch {
    /* fall through to the HEIC converter */
  }
  if (await isHeicLike(file)) {
    const { default: heic2any } = await import('heic2any');
    const out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
    const jpeg = Array.isArray(out) ? out[0] : out;
    if (jpeg) return decodeBlob(jpeg);
  }
  throw new Error('undecodable image');
}
