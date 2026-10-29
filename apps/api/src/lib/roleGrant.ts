import { ROLE_LABELS, can, capabilitiesOf, roleEscalation, type CapabilityHolder, type Role } from '@alto-people/shared';
import { HttpError } from '../middleware/error.js';

/**
 * Never grant more than you hold — the API's one door for it (fix wave
 * 2026-10-29, PEOPLE-1/2). A role change, a staff invite, onboarding's
 * "Hire as" (create AND re-invite), and a directory group's role mapping
 * all answer to roleEscalation (packages/shared/src/roles.ts): the role's
 * capabilities must be a subset of the caller's own.
 */
export function assertMayGrantRole(actor: CapabilityHolder, role: Role, label: string = ROLE_LABELS[role]): void {
  const over = roleEscalation(actor, role);
  if (over.length > 0) {
    throw new HttpError(403, 'role_escalation_forbidden', `You cannot grant ${label}: it holds capabilities you don't have (${over.join(', ')}).`);
  }
}

/** The same rule for an explicit capability list (a custom role that narrows its archetype). */
export function assertMayGrantCapabilities(actor: CapabilityHolder, caps: Iterable<string>, label: string): void {
  const mine = capabilitiesOf(actor) as ReadonlySet<string>;
  const over = [...caps].filter((c) => !mine.has(c));
  if (over.length > 0) {
    throw new HttpError(403, 'role_escalation_forbidden', `You cannot grant ${label}: it holds capabilities you don't have (${over.join(', ')}).`);
  }
}

/**
 * Acting on an account MORE privileged than your own is off-limits too:
 * re-inviting a pending manager, resetting an owner's password. True when
 * the target's role holds nothing the caller lacks.
 */
export function atOrBelow(actor: CapabilityHolder, targetRole: Role): boolean {
  return roleEscalation(actor, targetRole).length === 0;
}

/**
 * The identity desk: single sign-on, the domains, directory provisioning
 * (SCIM tokens and group → role mappings), two-step and session policy,
 * the staff networks. An org administrator's (manage:org) AND HR-admin
 * reach (view:hr-admin) — the workforce manager holds manage:org for the
 * field org but no org-admin surface (PEOPLE-2), and the read-only
 * chairman holds view:hr-admin but no writes.
 */
export const IDENTITY_CAPABILITIES = ['manage:org', 'view:hr-admin'] as const;

export function mayManageIdentity(user: CapabilityHolder): boolean {
  return IDENTITY_CAPABILITIES.every((c) => can(user, c));
}
