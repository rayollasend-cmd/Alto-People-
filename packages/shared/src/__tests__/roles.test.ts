import { describe, expect, it } from 'vitest';
import {
  HUMAN_ROLES,
  ROLES,
  ROLE_CAPABILITIES,
  hasCapability,
  type Capability,
  type Role,
} from '../roles.js';

const ALL_VIEWS: Capability[] = [
  'view:dashboard',
  'view:onboarding',
  'view:time',
  'view:scheduling',
  'view:payroll',
  'view:documents',
  'view:communications',
  'view:clients',
  'view:analytics',
  'view:compliance',
  'view:performance',
  'view:recruiting',
];

const ALL_MANAGE: Capability[] = [
  'manage:onboarding',
  'invite:onboarding',
  'manage:time',
  'manage:scheduling',
  'process:payroll',
  'manage:documents',
  'manage:communications',
  'manage:clients',
  'manage:compliance',
  'manage:performance',
  'manage:recruiting',
];

const ALL_CAPS: Capability[] = [...ALL_VIEWS, ...ALL_MANAGE];

describe('hasCapability', () => {
  it('EXECUTIVE_CHAIRMAN has every view, no manage', () => {
    for (const v of ALL_VIEWS) expect(hasCapability('EXECUTIVE_CHAIRMAN', v)).toBe(true);
    for (const m of ALL_MANAGE) expect(hasCapability('EXECUTIVE_CHAIRMAN', m)).toBe(false);
  });

  it('HR_ADMINISTRATOR has every capability', () => {
    for (const c of ALL_CAPS) expect(hasCapability('HR_ADMINISTRATOR', c)).toBe(true);
  });

  // Per product policy, OPERATIONS_MANAGER, MANAGER, INTERNAL_RECRUITER and
  // MARKETING_MANAGER all share the HR_ADMINISTRATOR capability surface.
  // The role label still differs so audit logs reflect functional capacity.
  // WORKFORCE_MANAGER was in this list until `3cf2e12d` gave it its own
  // charter — see the dedicated test below.
  it.each([
    'OPERATIONS_MANAGER',
    'MANAGER',
    'INTERNAL_RECRUITER',
    'MARKETING_MANAGER',
  ] as const)('%s mirrors HR_ADMINISTRATOR capability set', (role) => {
    for (const c of ALL_CAPS) expect(hasCapability(role, c)).toBe(true);
    expect(hasCapability(role, 'view:hr-admin')).toBe(true);
    expect(hasCapability(role, 'view:audit')).toBe(true);
  });

  it('WORKFORCE_MANAGER holds the field-leadership charter, not an admin clone', () => {
    // `3cf2e12d` right-sized this from a FULL_ADMIN clone with a label to
    // the owner's charter: the corporate connection to the store floor.
    // The two halves below are the charter's own words — what the role is
    // for, and what was explicitly handed to somebody else.
    for (const c of [
      'view:recruiting', 'manage:recruiting',
      'view:onboarding', 'manage:onboarding', 'invite:onboarding',
      'view:org', 'manage:org',
      'view:scheduling', 'manage:scheduling',
      'view:time', 'manage:time', 'view:time-live',
      'view:performance', 'manage:performance',
      'view:compliance', 'manage:compliance',
      'view:communications', 'manage:communications',
      'view:ops', 'manage:ops-library',
      'manage:transport',
    ] as const satisfies readonly Capability[]) {
      expect(hasCapability('WORKFORCE_MANAGER', c)).toBe(true);
    }

    // Money is Finance's; the keys to the building are HR Admin's.
    for (const c of [
      'view:payroll', 'process:payroll', 'void:payroll', 'export:payroll-pii',
      'view:comp', 'manage:comp',
      'view:clients', 'manage:clients',
      'view:hr-admin', 'view:audit', 'view:executive',
      'view:integrations', 'manage:integrations',
    ] as const satisfies readonly Capability[]) {
      expect(hasCapability('WORKFORCE_MANAGER', c)).toBe(false);
    }
  });

  it('LIVE_ASN has zero capabilities', () => {
    for (const c of ALL_CAPS) expect(hasCapability('LIVE_ASN', c)).toBe(false);
    expect(ROLE_CAPABILITIES.LIVE_ASN.size).toBe(0);
  });

  it('ASSOCIATE has personal views only, no manage caps, no clients', () => {
    expect(hasCapability('ASSOCIATE', 'view:dashboard')).toBe(true);
    expect(hasCapability('ASSOCIATE', 'view:onboarding')).toBe(true);
    expect(hasCapability('ASSOCIATE', 'view:payroll')).toBe(true);
    expect(hasCapability('ASSOCIATE', 'view:clients')).toBe(false);
    expect(hasCapability('ASSOCIATE', 'view:analytics')).toBe(false);
    // ASSOCIATE must not see the org-wide HR admin lists (separation,
    // discipline, succession, ramp, probation, agreements, document
    // templates, goals/PIPs/360s).
    expect(hasCapability('ASSOCIATE', 'view:hr-admin')).toBe(false);
    // view:communications is required for ASSOCIATE — they need to read
    // their own IN_APP inbox via /communications/me/inbox. Send/broadcast
    // paths are still locked behind manage:communications.
    expect(hasCapability('ASSOCIATE', 'view:communications')).toBe(true);
    for (const m of ALL_MANAGE) expect(hasCapability('ASSOCIATE', m)).toBe(false);
  });

  it('CLIENT_PORTAL is read-only and scoped (cannot view onboarding)', () => {
    expect(hasCapability('CLIENT_PORTAL', 'view:dashboard')).toBe(true);
    expect(hasCapability('CLIENT_PORTAL', 'view:scheduling')).toBe(true);
    expect(hasCapability('CLIENT_PORTAL', 'view:analytics')).toBe(true);
    expect(hasCapability('CLIENT_PORTAL', 'view:onboarding')).toBe(false);
    expect(hasCapability('CLIENT_PORTAL', 'view:payroll')).toBe(false);
    for (const m of ALL_MANAGE) expect(hasCapability('CLIENT_PORTAL', m)).toBe(false);
  });

  it('FINANCE_ACCOUNTANT owns the hours→pay cycle end to end', () => {
    // This role grew by four deliberate owner decisions, each recorded
    // against the capability in roles.ts: finance runs the whole cycle,
    // so it holds the schedule that feeds the hours and the hours that
    // feed the pay — not just read access to the result.
    for (const c of [
      'view:dashboard',
      'view:time', 'manage:time', 'view:time-live',
      'view:scheduling', 'manage:scheduling',
      'view:payroll', 'process:payroll',
      'view:comp',
      'view:analytics',
      // SOW bill rates and per-client statements are the client side of
      // the money cycle; associate lookup starts every pay question.
      'view:clients', 'view:org',
      'settle:reimbursement',
      // Inbox READ only, so payment-failure alerts are deliverable at all.
      'view:communications',
    ] as const satisfies readonly Capability[]) {
      expect(hasCapability('FINANCE_ACCOUNTANT', c)).toBe(true);
    }

    // The boundaries that still hold. Each read above has a write that
    // does not come with it — that is the whole shape of this role.
    for (const c of [
      'manage:clients', 'manage:org', 'manage:comp', 'manage:communications',
      // Voiding a disbursed run reverses a QBO journal entry and marks
      // paystubs VOIDED — settling a run is finance's, reversing a
      // disbursed one is not. (export:payroll-pii was on this line until
      // 2026-09-21; finance holds it now, see the holders test above.)
      'void:payroll',
      // Nothing on the HR side of the house.
      'view:onboarding', 'manage:onboarding', 'view:recruiting', 'view:hr-admin',
      'approve:reimbursement',
    ] as const satisfies readonly Capability[]) {
      expect(hasCapability('FINANCE_ACCOUNTANT', c)).toBe(false);
    }
  });

  it('SHIFT_SUPERVISOR can invite + monitor onboarding but not review it', () => {
    // Sends the invite and watches checklist progress for their own client.
    expect(hasCapability('SHIFT_SUPERVISOR', 'view:onboarding')).toBe(true);
    expect(hasCapability('SHIFT_SUPERVISOR', 'invite:onboarding')).toBe(true);
    // But never the HR review surface: approve/reject an application,
    // complete I-9 Section 2, or edit onboarding templates all ride on
    // manage:onboarding. Applicant PII is gated on the same capability in
    // the API's assertCanModifyApplication.
    expect(hasCapability('SHIFT_SUPERVISOR', 'manage:onboarding')).toBe(false);
    // Unchanged surface — scheduling + time for one client, nothing else.
    expect(hasCapability('SHIFT_SUPERVISOR', 'manage:time')).toBe(true);
    expect(hasCapability('SHIFT_SUPERVISOR', 'manage:scheduling')).toBe(true);
    expect(hasCapability('SHIFT_SUPERVISOR', 'view:payroll')).toBe(false);
    expect(hasCapability('SHIFT_SUPERVISOR', 'view:hr-admin')).toBe(false);
    expect(hasCapability('SHIFT_SUPERVISOR', 'view:clients')).toBe(false);
    expect(hasCapability('SHIFT_SUPERVISOR', 'view:analytics')).toBe(false);
    expect(hasCapability('SHIFT_SUPERVISOR', 'manage:documents')).toBe(false);
  });

  // The external payroll sheet pairs a full SSN with a full bank account and
  // routing number for every worker in a range. It is deliberately NOT part
  // of FULL_ADMIN — same call as void:payroll. The trap it guards against is
  // specific: the Time router's usual guard is manage:time, which
  // SHIFT_SUPERVISOR holds, so reusing that would have handed floor
  // supervisors their client's identity documents.
  it('export:payroll-pii is held by HR and Finance, and nobody else', () => {
    // Was HR alone. Finance was added (owner decision, 2026-09-21) when the
    // payroll census and new-hire report — full SSN, bank routing and
    // account, DOB, home address for every associate — were moved off
    // process:payroll, which SIX roles hold. Finance runs the pay cycle, so
    // locking them out would have broken payroll to close the hole; the
    // capability widened by one role instead of the export staying open to
    // four who have no use for it.
    const holders = HUMAN_ROLES.filter((r) =>
      hasCapability(r, 'export:payroll-pii'),
    );
    expect(holders.slice().sort()).toEqual(['FINANCE_ACCOUNTANT', 'HR_ADMINISTRATOR']);
  });

  it('export:audit-packet is the owner and HR, and is the one export a read-only role holds', () => {
    // I-9 images and SSN cards for a whole roster. It sat on view:hr-admin,
    // which is in ALL_VIEWS — so a marketing manager could pull every
    // worker's identity documents. HR is here because HR hands the packet
    // to the auditor; restricting it to the chairman would lock the tool
    // away from the person who uses it.
    const holders = HUMAN_ROLES.filter((r) => hasCapability(r, 'export:audit-packet'));
    expect(holders.slice().sort()).toEqual(['EXECUTIVE_CHAIRMAN', 'HR_ADMINISTRATOR']);
    for (const role of ['MARKETING_MANAGER', 'INTERNAL_RECRUITER', 'MANAGER', 'SHIFT_SUPERVISOR'] as const) {
      expect(hasCapability(role, 'export:audit-packet'), role).toBe(false);
    }
  });

  it('view:payroll-documents is the oversight set, and never reaches an SSN on its own', () => {
    // Someone else's paystub, and the 941/940 working sheets. This exists
    // because the two PDF routes were guarding themselves with a hardcoded
    // list of four role names, which no test could see and which drifts
    // the moment the matrix changes. The holders are exactly that list.
    const holders = HUMAN_ROLES.filter((r) => hasCapability(r, 'view:payroll-documents'));
    expect(holders.slice().sort()).toEqual([
      'EXECUTIVE_CHAIRMAN',
      'FINANCE_ACCOUNTANT',
      'HR_ADMINISTRATOR',
      'OPERATIONS_MANAGER',
    ]);

    // It is deliberately NOT process:payroll: running the pay cycle is a
    // job six roles do, and "may run payroll" is not "may pull up this
    // named person's paystub".
    for (const role of ['MARKETING_MANAGER', 'INTERNAL_RECRUITER', 'MANAGER'] as const) {
      expect(hasCapability(role, 'process:payroll'), role).toBe(true);
      expect(hasCapability(role, 'view:payroll-documents'), role).toBe(false);
    }

    // And holding it is not enough for an SSN-bearing form: the W-2 route
    // also demands export:payroll-pii, which two of these four hold. If
    // that ever became a subset relation, the escalation would be dead
    // code and the chairman would be reading SSNs.
    expect(hasCapability('EXECUTIVE_CHAIRMAN', 'export:payroll-pii')).toBe(false);
    expect(hasCapability('OPERATIONS_MANAGER', 'export:payroll-pii')).toBe(false);
  });

  it('no role can reach the PII export via manage:time', () => {
    for (const role of HUMAN_ROLES) {
      if (
        hasCapability(role, 'manage:time') &&
        !hasCapability(role, 'export:payroll-pii')
      ) {
        // This is the expected state for every role except HR_ADMINISTRATOR;
        // the assertion documents that manage:time is NOT sufficient.
        expect(hasCapability(role, 'export:payroll-pii')).toBe(false);
      }
    }
    expect(hasCapability('SHIFT_SUPERVISOR', 'manage:time')).toBe(true);
    expect(hasCapability('SHIFT_SUPERVISOR', 'export:payroll-pii')).toBe(false);
    expect(hasCapability('OPERATIONS_MANAGER', 'export:payroll-pii')).toBe(false);
    expect(hasCapability('MARKETING_MANAGER', 'export:payroll-pii')).toBe(false);
    // FINANCE_ACCOUNTANT is no longer asserted here: it holds BOTH now, by
    // owner decision. That does not weaken the property this test exists
    // for — the danger was never "some role has both", it was that the
    // CLIENT-SCOPED floor roles could reach a full-SSN export through the
    // guard the Time routes happen to use. Stated directly:
    for (const role of ['SHIFT_SUPERVISOR', 'FLOOR_SUPERVISOR', 'CLIENT_PORTAL'] as const) {
      expect(hasCapability(role, 'export:payroll-pii'), role).toBe(false);
      expect(hasCapability(role, 'export:audit-packet'), role).toBe(false);
    }
  });

  // The web UI gates invite-shaped affordances (bulk invite, nudge, resend,
  // the progress KPI strip) on invite:onboarding ALONE, on the assumption
  // that it is a strict superset of manage:onboarding. If someone ever adds
  // manage:onboarding to a role without invite:onboarding, that role would
  // silently lose those buttons — fail here instead.
  it('every manage:onboarding holder also holds invite:onboarding', () => {
    for (const role of HUMAN_ROLES) {
      if (hasCapability(role, 'manage:onboarding')) {
        expect(hasCapability(role, 'invite:onboarding')).toBe(true);
      }
    }
  });
});

describe('HUMAN_ROLES', () => {
  it('contains every role except LIVE_ASN', () => {
    const all = Object.keys(ROLES) as Role[];
    expect(HUMAN_ROLES).not.toContain('LIVE_ASN');
    expect(new Set(HUMAN_ROLES)).toEqual(new Set(all.filter((r) => r !== 'LIVE_ASN')));
    expect(HUMAN_ROLES).toHaveLength(all.length - 1);
  });
});

describe('ROLE_CAPABILITIES exhaustiveness', () => {
  it('every role declares a capability set (even empty)', () => {
    const roles = Object.keys(ROLES) as Role[];
    for (const r of roles) {
      expect(ROLE_CAPABILITIES[r]).toBeInstanceOf(Set);
    }
  });
});
