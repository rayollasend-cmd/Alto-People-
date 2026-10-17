/**
 * An associate's headshot URL. The route 404s when no photo is on file and
 * Avatar falls back to initials, so an id is all a row needs. Prefer an
 * API-provided `photoUrl` when the row has one — it carries a `?v=`
 * cache-buster that this bare path doesn't.
 */
export function associatePhotoUrl(associateId: string | null | undefined): string | undefined {
  return associateId ? `/api/associates/${associateId}/photo` : undefined;
}
