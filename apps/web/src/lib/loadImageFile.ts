/**
 * Decode a picked/captured image file into an <img>, surviving formats
 * the plain `<img src=objectURL>` path chokes on:
 *   1. object URL + decode() — the fast path, no pixel copy;
 *   2. createImageBitmap(file) → canvas → JPEG data URL — some browsers
 *      decode via the bitmap path what the element path rejects.
 * Throws only when the browser genuinely cannot decode the file (e.g.
 * HEIC on Chrome) — callers show retake-with-the-camera guidance
 * instead of the old silent dead end.
 */
export async function loadImageFile(file: Blob): Promise<HTMLImageElement> {
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
