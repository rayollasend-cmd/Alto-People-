/**
 * Build the cache-busted profile-photo URL the API returns for an associate.
 *
 * Returns null when the associate has no photo on file so the Avatar
 * component falls back to initials. We append `?v=<unix-ms>` so a fresh
 * upload invalidates the browser/edge caches without changing the path.
 */
export function profilePhotoUrlFor(input: {
  id: string;
  photoS3Key: string | null;
  photoUpdatedAt: Date | null;
}): string | null {
  if (!input.photoS3Key) return null;
  const v = input.photoUpdatedAt?.getTime() ?? 0;
  return `/api/associates/${input.id}/photo?v=${v}`;
}

/** The same for a login's own photo (a staff account with no associate). */
export function userPhotoUrlFor(input: {
  id: string;
  photoS3Key: string | null;
  photoUpdatedAt: Date | null;
}): string | null {
  if (!input.photoS3Key) return null;
  const v = input.photoUpdatedAt?.getTime() ?? 0;
  return `/api/users/${input.id}/photo?v=${v}`;
}

/** Select for accountPhotoUrlFor — spread into a User select. */
export const ACCOUNT_PHOTO_SELECT = {
  id: true,
  photoS3Key: true,
  photoUpdatedAt: true,
  associate: { select: { id: true, photoS3Key: true, photoUpdatedAt: true } },
} as const;

/**
 * A login's face: the associate headshot when they have one on file, else
 * the photo on the account itself. Staff accounts (HR, recruiters,
 * managers) have no associate, so without the fallback they were initials
 * everywhere — the Topbar, messages, the relay.
 */
export function accountPhotoUrlFor(user: {
  id: string;
  photoS3Key?: string | null;
  photoUpdatedAt?: Date | null;
  associate?: { id: string; photoS3Key: string | null; photoUpdatedAt: Date | null } | null;
}): string | null {
  return (
    (user.associate ? profilePhotoUrlFor(user.associate) : null) ??
    userPhotoUrlFor({
      id: user.id,
      photoS3Key: user.photoS3Key ?? null,
      photoUpdatedAt: user.photoUpdatedAt ?? null,
    })
  );
}
