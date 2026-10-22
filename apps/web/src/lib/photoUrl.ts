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
 *
 * The API says `photoUrl: null` only when it looked and there is no photo
 * on file (profilePhotoUrlFor / accountPhotoUrlFor), so a null is an
 * answer, not a gap: no guessed URL, no request, no 404. The bare-path
 * fallback is for rows whose payload doesn't carry the field at all
 * (`undefined`). `hasPhoto: false` says the same thing for a list that
 * only knows yes/no.
 */
export function personPhotoUrl(p: {
  photoUrl?: string | null;
  associateId?: string | null;
  userId?: string | null;
  hasPhoto?: boolean;
}): string | undefined {
  if (p.hasPhoto === false || p.photoUrl === null) return undefined;
  return p.photoUrl || associatePhotoUrl(p.associateId) || userPhotoUrl(p.userId);
}

/*
 * Photo URLs that came back missing (404, a dead blob) this session. A
 * person with no photo is on the directory, the schedule, the inbox — and
 * every row used to ask again: ~24 failed requests on one Users page.
 * Avatar remembers the first failure and never requests that URL again
 * until the page reloads or a photo is uploaded (forgetMissingPhotos). A
 * fresh upload's API URL carries a new ?v=, so it is a different key anyway.
 */
const missingPhotos = new Set<string>();

export function markPhotoMissing(src: string): void {
  missingPhotos.add(src);
}

export function isPhotoKnownMissing(src: string): boolean {
  return missingPhotos.has(src);
}

/** After a photo upload: a face that was missing is asked for again. */
export function forgetMissingPhotos(): void {
  missingPhotos.clear();
}
