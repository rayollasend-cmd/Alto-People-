import type { Request, Response } from 'express';
import sharp from 'sharp';
import { getBlobStore } from './blobStore.js';
import { HttpError } from '../middleware/error.js';

/**
 * Small WebP copies of an uploaded photo, made on first ask and kept beside
 * the original. A list that shows many photos asks for these (`?size=`), not
 * the upload: phone photos run to several MB, and a page asking for dozens
 * at once filled the connection and held its own data behind them (Nov 2026:
 * "Still loading — the server may be waking up…").
 *
 * `cover` is a square crop (`<key>.<px>.webp`, faces); `inside` keeps the
 * whole picture with its longer side at most `px` (`<key>.fit<px>.webp`,
 * evidence photos, which the page crops itself).
 */
export type ThumbnailFit = 'cover' | 'inside';

export function thumbnailKey(key: string, px: number, fit: ThumbnailFit = 'cover'): string {
  return fit === 'cover' ? `${key}.${px}.webp` : `${key}.fit${px}.webp`;
}

const inFlight = new Map<string, Promise<Buffer | null>>();

/**
 * The thumbnail's bytes, made and stored on first ask; null when the original
 * is gone. Throws when the original isn't an image sharp can read — callers
 * fall back to the original then.
 */
export async function storedThumbnail(key: string, px: number, fit: ThumbnailFit = 'cover'): Promise<Buffer | null> {
  const derived = thumbnailKey(key, px, fit);
  const store = getBlobStore();
  const stored = await store.get(derived).catch(() => null);
  if (stored) return stored;
  // A page asks for the same photo from several rows at once: make it once.
  let pending = inFlight.get(derived);
  if (!pending) {
    pending = (async () => {
      const original = await store.get(key);
      if (!original) return null;
      const small = await sharp(original)
        .rotate()
        .resize(px, px, fit === 'cover' ? { fit: 'cover' } : { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();
      await store.put(derived, small, 'image/webp').catch(() => undefined);
      return small;
    })().finally(() => inFlight.delete(derived));
    inFlight.set(derived, pending);
  }
  return pending;
}

/** Sizes an evidence photo comes in: 128 for a thumb beside a task, 640 for a grid tile or the final-zone shot. */
const EVIDENCE_SIZES: ReadonlySet<number> = new Set([128, 640]);

/**
 * Send an SOP evidence photo (OpsTaskPhoto): the upload, or with `?size=` a
 * WebP copy that fits that box. A photo is never edited after upload — a new
 * one is a new row — so a browser may keep it for a day. One that sharp can't
 * read falls back to the original rather than failing the tile.
 */
export async function sendEvidencePhoto(req: Request, res: Response, photo: { s3Key: string; mimeType: string }): Promise<void> {
  const px = Number(req.query.size);
  let blob: Buffer | null = null;
  let thumb = false;
  if (EVIDENCE_SIZES.has(px)) {
    try {
      blob = await storedThumbnail(photo.s3Key, px, 'inside');
      thumb = blob !== null;
    } catch {
      blob = null;
    }
  }
  blob ??= await getBlobStore().get(photo.s3Key);
  if (!blob) throw new HttpError(404, 'blob_missing', 'Photo file is missing.');
  res.setHeader('Content-Type', thumb ? 'image/webp' : photo.mimeType);
  res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
  // Never let a browser sniff a user-supplied image into something scriptable.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Content-Length', String(blob.length));
  res.send(blob);
}
