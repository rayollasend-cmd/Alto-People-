import { basename } from 'node:path';

const FILENAME_MAX = 200;

// Multer's `originalname` is browser-supplied. Most browsers send a basename,
// but a malicious client can send path components, control chars, or null
// bytes. Run every uploaded filename through this before persisting it to
// the DB or putting it on a Content-Disposition header.
export function sanitizeUploadFilename(raw: string | undefined | null): string {
  const name = (raw ?? '').trim();
  if (!name) return 'upload';
  return basename(name)
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[\\/]/g, '')
    .slice(0, FILENAME_MAX) || 'upload';
}

// Build a Content-Disposition value that survives non-ASCII filenames and
// can't be tricked into header injection via embedded CRLF or quotes. Pairs
// `filename=` (ASCII fallback) with RFC 5987 `filename*=` for Unicode.
export function safeContentDisposition(
  filename: string,
  inline: boolean,
): string {
  const sanitized = sanitizeUploadFilename(filename);
  const ascii = sanitized.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  const encoded = encodeURIComponent(sanitized);
  const dispo = inline ? 'inline' : 'attachment';
  return `${dispo}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

// Lightweight magic-byte check. The browser-supplied MIME on multer's
// `file.mimetype` is trusted by `fileFilter`, but the actual bytes might
// be anything (a .pdf renamed from .exe, a polyglot, etc). For the small
// set we accept, we can verify the leading bytes match the declared type.
//
// Returns null if the file matches its declared MIME, or an error string.
export function verifyFileMagic(
  buffer: Buffer,
  declaredMime: string,
): string | null {
  if (buffer.length < 4) {
    return 'File is too small to be a valid document.';
  }
  const head = buffer.subarray(0, 12);
  switch (declaredMime) {
    case 'application/pdf':
      // %PDF-
      if (head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) {
        return null;
      }
      return 'File contents do not match a PDF.';
    case 'image/png':
      // 89 50 4E 47 0D 0A 1A 0A
      if (
        head[0] === 0x89 &&
        head[1] === 0x50 &&
        head[2] === 0x4e &&
        head[3] === 0x47 &&
        head[4] === 0x0d &&
        head[5] === 0x0a &&
        head[6] === 0x1a &&
        head[7] === 0x0a
      ) {
        return null;
      }
      return 'File contents do not match a PNG.';
    case 'image/jpeg':
      // FF D8 FF
      if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
        return null;
      }
      return 'File contents do not match a JPEG.';
    case 'image/webp':
      // RIFF....WEBP
      if (
        head[0] === 0x52 &&
        head[1] === 0x49 &&
        head[2] === 0x46 &&
        head[3] === 0x46 &&
        head[8] === 0x57 &&
        head[9] === 0x45 &&
        head[10] === 0x42 &&
        head[11] === 0x50
      ) {
        return null;
      }
      return 'File contents do not match a WebP image.';
    default:
      return null;
  }
}
