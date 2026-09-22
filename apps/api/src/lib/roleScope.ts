import type { Prisma } from '@prisma/client';
import type { Role } from '@alto-people/shared';

/**
 * "Who can do this job" — across both the primary role and the second
 * hats an account holds.
 *
 * Once one account could be a shift supervisor AND a driver, every query
 * shaped `where: { role: 'DRIVER' }` quietly became wrong: it is the list
 * of people whose MAIN job is driving, and the director assigning a van,
 * the dispatch board, and the seat-request fan-out all need the list of
 * people who can drive at all. A supervisor who drives on Sundays exists
 * to be dispatched; if nothing can see them, granting the role was
 * decoration.
 *
 * Use these anywhere a query enumerates people BY ROLE. They are not for
 * authorization — a request is authorized against the one role the caller
 * is wearing, which is `req.user.role` and nothing else.
 */

/** Accounts that act as `role`, whether it is their main job or a second one. */
export function actsAs(role: Role): Prisma.UserWhereInput {
  return { OR: [{ role }, { additionalRoles: { has: role } }] };
}

/** Accounts that act as any of `roles`. */
export function actsAsAny(roles: Role[]): Prisma.UserWhereInput {
  return { OR: [{ role: { in: roles } }, { additionalRoles: { hasSome: roles } }] };
}

/** True for a loaded user row — the in-memory twin of `actsAs`. */
export function userActsAs(
  user: { role: Role; additionalRoles?: readonly Role[] | null },
  role: Role,
): boolean {
  return user.role === role || (user.additionalRoles ?? []).includes(role);
}
