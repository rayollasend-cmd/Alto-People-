import type { Prisma } from '@prisma/client';

// Reported 2026-05-02: scheduling pickers were listing every Associate
// regardless of role or status, including managers (who use a separate
// system) and terminated/uninvited people. Schedulable pool requires:
//   1. User account ACTIVE with ASSOCIATE role (excludes MANAGER, OPS,
//      HR_*, CLIENT_PORTAL, plus INVITED-but-not-yet-accepted, DISABLED).
//   2. At least one APPROVED Application — i.e. the associate has been
//      onboarded and accepted by HR. Reported 2026-05-07: pickers were
//      still showing test/junk rows whose User was ACTIVE but whose
//      onboarding was either DRAFT or never completed; mirrors the
//      `DirectoryStatus = 'ACTIVE'` derivation in /people/directory.
// Phase 131 — schedulable if there's EITHER an approved Application
// (backward-compatible legacy gate) OR an open AssociateAssignment.
// The latter catches any future case where placement diverges from
// the original application (e.g. cross-client transfer that opens an
// Assignment without re-onboarding).
//
// Schedulability comes from EMPLOYMENT, not portal-login state. This used
// to require user.status === ACTIVE, which silently hid working associates
// from every roster, grid row, and shift picker whenever their account was
// INVITED — including fully-approved people who never set a password, whom
// the resend-invite flow demotes from ACTIVE back to INVITED (reported
// 2026-07-31: a team member vanished from the week grid). Whether someone
// can LOG IN says nothing about whether they work Tuesday's shift. Only a
// deliberately DISABLED account (offboarding) hides someone; associates
// linked to management-role accounts stay out of associate rosters as
// before, and an associate with no portal account at all is schedulable.
export const SCHEDULABLE_USER_FILTER: Prisma.AssociateWhereInput = {
  OR: [
    { user: null },
    { user: { is: { role: 'ASSOCIATE', status: { not: 'DISABLED' } } } },
  ],
};

// Employment-state stamps beat everything: a separated or manually-
// deactivated associate is out of the pool even when they have no portal
// account at all (the { user: null } arm of SCHEDULABLE_USER_FILTER would
// otherwise keep them schedulable forever — which is exactly how kiosk-only
// associates stayed on store rosters after deactivation). Rehire
// (re-invite) clears separatedAt; Reactivate clears deactivatedAt.
export const EMPLOYED: Prisma.AssociateWhereInput = {
  deletedAt: null,
  separatedAt: null,
  deactivatedAt: null,
};

export const ACTIVE_ASSOCIATE_FILTER: Prisma.AssociateWhereInput = {
  ...EMPLOYED,
  AND: [SCHEDULABLE_USER_FILTER],
  OR: [
    { applications: { some: { status: 'APPROVED' } } },
    { assignments: { some: { endedAt: null } } },
  ],
};
