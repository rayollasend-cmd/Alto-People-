import { ROLE_LABELS, type Role } from '@alto-people/shared';

/**
 * What a person is called in the app (F500 G5): their associate name, else
 * the name their account was given, else "Role · email" — never the email's
 * local part ("ops — Operations Manager") or the bare address shown twice
 * ("manager@altohr.com — manager@altohr.com"). One rule for messages, the
 * Out of office picker and the activity feed.
 */
export interface NamedUser {
  email: string;
  role?: Role | string | null;
  displayName?: string | null;
  associate?: { firstName: string; lastName: string } | null;
}

/** The person's own name, when one is on file (associate, then the account). */
export function realName(u: NamedUser): string | null {
  const assoc = u.associate ? `${u.associate.firstName} ${u.associate.lastName}`.trim() : '';
  return assoc || u.displayName?.trim() || null;
}

export function personDisplayName(u: NamedUser): string {
  const named = realName(u);
  if (named) return named;
  const label = u.role ? (ROLE_LABELS as Record<string, string>)[u.role] ?? null : null;
  return label ? `${label} · ${u.email}` : u.email;
}
