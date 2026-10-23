/**
 * A job profile carries overtime exemption, the workers' comp class and the
 * tipped occupation code. Moving someone between profiles that differ on
 * any of those is a promotion — a second person (manage:comp) decides it —
 * not an org edit. One rule for the one-person org edit (PUT
 * /org/associates/:id/org) and for Mass update.
 */
export interface ProfileTraits {
  title: string;
  isExempt: boolean;
  wcClassCode: string | null;
  tippedOccupationCode: string | null;
}

/** What a move from `from` to `to` changes that only a promotion may change; empty when it is an ordinary edit. */
export function profileMoveChanges(from: ProfileTraits | null, to: ProfileTraits | null): string[] {
  const changes: string[] = [];
  if ((from?.isExempt ?? false) !== (to?.isExempt ?? false)) changes.push('overtime exemption');
  if (from?.wcClassCode && to?.wcClassCode && from.wcClassCode !== to.wcClassCode) changes.push("workers' comp class");
  if ((from?.tippedOccupationCode ?? null) !== (to?.tippedOccupationCode ?? null)) changes.push('tipped occupation code');
  return changes;
}
