/**
 * Upload limits and formats — one source of truth for both apps.
 *
 * These were six uncoordinated copies (four web tasks, two API routers).
 * The values happened to agree, but nothing kept them agreeing, and one
 * surface had already drifted: the I-9 task's picker offered `image/*`
 * while the server accepted only the four types below, so an iPhone
 * photo (HEIC by default) passed the file picker and was rejected on
 * upload — on the most compliance-critical form in the product.
 *
 * Follows the ORG_LOGO_* pattern, which is the one duplication in this
 * repo structurally incapable of drifting.
 */

/** Server-enforced ceiling for associate document/I-9 uploads. */
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

/** Ceiling for profile photos (smaller — these are avatars). */
export const PROFILE_PHOTO_MAX_BYTES = 5 * 1024 * 1024;

/**
 * The only content types the document pipeline accepts. Magic bytes are
 * verified server-side too — this list is what the UI may OFFER, and it
 * must never be wider than what the server will take.
 */
export const UPLOAD_ALLOWED_MIMES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
] as const;

/** Ready-made value for an <input type="file"> accept attribute. */
export const UPLOAD_ACCEPT_ATTR = UPLOAD_ALLOWED_MIMES.join(',');

/** Kiosk PIN shape — duplicated as a literal regex across four files. */
export const KIOSK_PIN_LENGTH = 4;
export const KIOSK_PIN_REGEX = /^\d{4}$/;

/** Human-readable byte size: 1.4 MB, 812 KB, 40 B. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
