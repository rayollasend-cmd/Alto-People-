/**
 * An associate's headshot URL. The route 404s when no photo is on file and
 * Avatar falls back to initials, so an id is all a row needs. Prefer an
 * API-provided `photoUrl` when the row has one — it carries a `?v=`
 * cache-buster that this bare path doesn't.
 */
export function associatePhotoUrl(associateId: string | null | undefined): string | undefined {
  return associateId ? `/api/associates/${associateId}/photo` : undefined;
}

/**
 * A login's face: the linked associate's headshot when there is one, else
 * the staff account's own photo. A userId alone is enough for anyone who
 * signs in — an associate, a recruiter, a driver, an admin. Same 404 →
 * initials contract as associatePhotoUrl.
 */
export function userPhotoUrl(userId: string | null | undefined): string | undefined {
  return userId ? `/api/users/${userId}/photo` : undefined;
}

/**
 * The best photo a row can offer, in order: the API's `photoUrl` (it has
 * the cache-buster), then the associate headshot, then the login's face.
 * Undefined when the row carries none of them — Avatar shows initials.
 */
export function personPhotoUrl(p: {
  photoUrl?: string | null;
  associateId?: string | null;
  userId?: string | null;
}): string | undefined {
  return p.photoUrl || associatePhotoUrl(p.associateId) || userPhotoUrl(p.userId);
}
