import type { EmploymentType } from '@alto-people/shared';

/**
 * Last-used invite picks, shared by NewApplicationDialog and
 * BulkInviteDialog (same localStorage key, via usePersistentState) so
 * back-to-back invites don't re-answer the same three dropdowns.
 * Persisted ids can go stale (client deleted, template hidden) — every
 * consumer must validate them against the freshly loaded lists and fall
 * back to '' instead of trusting the stored value.
 */
export interface InviteLastUsed {
  clientId: string;
  locationId: string;
  templateId: string;
  employmentType: EmploymentType;
}

export const INVITE_LAST_USED_KEY = 'alto:invite.lastUsed.v1';

export const EMPTY_INVITE_LAST_USED: InviteLastUsed = {
  clientId: '',
  locationId: '',
  templateId: '',
  employmentType: 'W2_EMPLOYEE',
};

const EMPLOYMENT_TYPES: readonly EmploymentType[] = [
  'W2_EMPLOYEE',
  'CONTRACTOR_1099_INDIVIDUAL',
  'CONTRACTOR_1099_BUSINESS',
];

export function isInviteLastUsed(v: unknown): v is InviteLastUsed {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.clientId === 'string' &&
    typeof o.locationId === 'string' &&
    typeof o.templateId === 'string' &&
    typeof o.employmentType === 'string' &&
    (EMPLOYMENT_TYPES as readonly string[]).includes(o.employmentType)
  );
}
