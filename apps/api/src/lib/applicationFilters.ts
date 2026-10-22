import type { Prisma } from '@prisma/client';

/**
 * Onboarding drafts gone quiet (role walk HR 2 / HR 15): an invite nobody
 * has moved in a week. One predicate for the applications list's "Idle
 * drafts" filter, the Inbox's count and the HR home's item, so the number
 * on the row is the list it opens.
 */
export const IDLE_DRAFT_DAYS = 7;

export function idleDraftsWhere(now: Date = new Date()): Prisma.ApplicationWhereInput {
  return { status: 'DRAFT', updatedAt: { lt: new Date(now.getTime() - IDLE_DRAFT_DAYS * 86_400_000) } };
}
