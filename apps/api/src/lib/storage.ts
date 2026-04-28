import { mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Phase 9 storage: local filesystem at apps/api/uploads/. The DocumentRecord.s3Key
// column holds the relative path (e.g. "f3a8.../filename.pdf"). When we wire S3
// in a future phase, the column name stays — only the resolver here changes.

const __dirname = dirname(fileURLToPath(import.meta.url));
export const UPLOAD_ROOT = resolve(__dirname, '../../uploads');
export const PROFILE_PHOTO_DIR = 'profile-photos';

if (!existsSync(UPLOAD_ROOT)) {
  mkdirSync(UPLOAD_ROOT, { recursive: true });
}
const profilePhotoFull = resolve(UPLOAD_ROOT, PROFILE_PHOTO_DIR);
if (!existsSync(profilePhotoFull)) {
  mkdirSync(profilePhotoFull, { recursive: true });
}

export function resolveStoragePath(relativeKey: string): string {
  // Defense-in-depth: never let a stored key escape UPLOAD_ROOT.
  const full = resolve(UPLOAD_ROOT, relativeKey);
  if (!full.startsWith(UPLOAD_ROOT)) {
    throw new Error('storage path escape attempt');
  }
  return full;
}
