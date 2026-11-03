import { z } from 'zod';
import type { WorkStatus } from './peopleStatus.js';

/**
 * WHO A COMPLIANCE LIST IS ABOUT (owner, 2026-11-03).
 *
 * The E-Verify, I-9, background, drug-test and J-1 lists used to start from
 * every record ever made and remove almost nothing: of 693 people on file,
 * 155 still worked here, and 351 paused people filled the lists, the
 * counts and the exports. Each list now opens on the CURRENT workforce,
 * with the other groups one chip away:
 *
 *   current   Current         hired and still here: Working, No recent
 *                             shifts, Not placed (peopleStatus.ts)
 *   starting  Starting soon   onboarding, not hired yet — kept apart from
 *                             Current (owner, 2026-11-03)
 *   paused    Paused          paused by hand; expected back
 *   former    Former          separated — still needed for retention and audits
 *   all       All             everyone on file
 *
 * The groups are read from the one status per person
 * (apps/api/src/lib/peopleStatus.ts), so a person is in the same group on
 * every list and on the People directory. The list, its counts, its CSV and
 * the Inbox count that links to it all use the same group.
 */
export const COMPLIANCE_WORKFORCES = ['current', 'starting', 'paused', 'former', 'all'] as const;
export type ComplianceWorkforce = (typeof COMPLIANCE_WORKFORCES)[number];
export type WorkforceGroup = Exclude<ComplianceWorkforce, 'all'>;
export const ComplianceWorkforceSchema = /* @__PURE__ */ (() => z.enum(COMPLIANCE_WORKFORCES))();

/** What a compliance list opens on. */
export const DEFAULT_COMPLIANCE_WORKFORCE: ComplianceWorkforce = 'current';

/** The statuses each group is made of. */
export const WORKFORCE_STATUSES: Readonly<Record<WorkforceGroup, readonly WorkStatus[]>> = {
  current: ['ACTIVE', 'PLACED_NOT_ACTIVE', 'NOT_PLACED'],
  starting: ['ONBOARDING'],
  paused: ['DEACTIVATED'],
  former: ['SEPARATED'],
};

/** The group a person's status puts them in. */
export function workforceOfStatus(s: WorkStatus): WorkforceGroup {
  if (s === 'ONBOARDING') return 'starting';
  if (s === 'DEACTIVATED') return 'paused';
  if (s === 'SEPARATED') return 'former';
  return 'current';
}

/** English labels (the web shows these on the chips). */
export const COMPLIANCE_WORKFORCE_LABELS: Readonly<Record<ComplianceWorkforce, string>> = {
  current: 'Current',
  starting: 'Starting soon',
  paused: 'Paused',
  former: 'Former',
  all: 'All',
};

/** What each group means, for a chip's title. */
export const COMPLIANCE_WORKFORCE_DEFINITIONS: Readonly<Record<ComplianceWorkforce, string>> = {
  current: 'Hired and still here: working, between shifts, or not placed yet. Not paused, not separated.',
  starting: 'Onboarding and not hired yet.',
  paused: 'Paused by hand and expected back. Pauses over 120 days become separations.',
  former: 'Separated. Kept for retention and audits.',
  all: 'Everyone on file.',
};

/** A query-string value as a group; anything else is the default. */
export function parseComplianceWorkforce(raw: unknown): ComplianceWorkforce {
  return COMPLIANCE_WORKFORCES.find((w) => w === raw) ?? DEFAULT_COMPLIANCE_WORKFORCE;
}

export function isComplianceWorkforce(v: unknown): v is ComplianceWorkforce {
  return COMPLIANCE_WORKFORCES.some((w) => w === v);
}

/** How many of a list's people are in each group (the chip counts). `all` is the whole list. */
export const WorkforceCountsSchema = /* @__PURE__ */ (() =>
  z.object({
    current: z.number().int().nonnegative(),
    starting: z.number().int().nonnegative(),
    paused: z.number().int().nonnegative(),
    former: z.number().int().nonnegative(),
    all: z.number().int().nonnegative(),
  }))();
export type WorkforceCounts = z.infer<typeof WorkforceCountsSchema>;
