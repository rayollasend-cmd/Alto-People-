import { mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../config/env.js';

// Phase 9 storage: local filesystem rooted at UPLOAD_ROOT. The
// DocumentRecord.s3Key column holds the relative path (e.g.
// "f3a8.../filename.pdf"). When we wire S3 in a future phase, the column
// name stays — only the resolver here changes.
//
// Production note: Railway's container filesystem is ephemeral. Set
// UPLOAD_DIR on the Railway service to point at a mounted Volume so
// uploads survive redeploys. When unset, we fall back to the colocated
// `apps/api/uploads/` directory which is fine for local dev but loses
// every file on each Railway redeploy. See apps/api/STORAGE.md.

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_UPLOAD_ROOT = resolve(__dirname, '../../uploads');

export const UPLOAD_ROOT = env.UPLOAD_DIR
  ? resolve(env.UPLOAD_DIR)
  : DEFAULT_UPLOAD_ROOT;
export const PROFILE_PHOTO_DIR = 'profile-photos';

if (!existsSync(UPLOAD_ROOT)) {
  // Best-effort create. On a fresh Railway container with a Volume
  // mounted at UPLOAD_DIR the path already exists; on local dev the
  // colocated default needs creating.
  mkdirSync(UPLOAD_ROOT, { recursive: true });
}
const profilePhotoFull = resolve(UPLOAD_ROOT, PROFILE_PHOTO_DIR);
if (!existsSync(profilePhotoFull)) {
  mkdirSync(profilePhotoFull, { recursive: true });
}

if (env.NODE_ENV === 'production' && !env.UPLOAD_DIR) {
  // Loud warning, not a hard exit — the system is still functional, but
  // every uploaded file will be lost on next redeploy. Operators should
  // set UPLOAD_DIR to a mounted Volume path before going live.
  console.warn(
    '[storage] WARNING: UPLOAD_DIR is not set in production. ' +
      'Document and profile-photo uploads will be written to the container ' +
      'filesystem and LOST on every redeploy. Mount a Railway Volume and ' +
      'point UPLOAD_DIR at it. See apps/api/STORAGE.md.',
  );
}

export function resolveStoragePath(relativeKey: string): string {
  // Defense-in-depth: never let a stored key escape UPLOAD_ROOT.
  const full = resolve(UPLOAD_ROOT, relativeKey);
  if (!full.startsWith(UPLOAD_ROOT)) {
    throw new Error('storage path escape attempt');
  }
  return full;
}
