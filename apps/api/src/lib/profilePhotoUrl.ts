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
