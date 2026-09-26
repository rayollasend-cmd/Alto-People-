import { describe, expect, it } from 'vitest';
import { ROLE_CAPABILITIES, type Capability, type Role } from '@alto-people/shared';
import { MODULES, visibleModules, type ModuleKey } from '@/lib/modules';

/** A `can()` backed by the real capability matrix for a given role — the
 *  same source of truth the app's AuthProvider derives `can` from. */
function canFor(role: Role): (c: Capability) => boolean {
  const caps = ROLE_CAPABILITIES[role];
  return (c: Capability) => caps.has(c);
}

function keysFor(role: Role, scope: { regionId?: string | null } = {}): ModuleKey[] {
  return visibleModules(role, canFor(role), scope).map((m) => m.key);
}

describe('visibleModules — INTERNAL_RECRUITER curation', () => {
  it('every role that holds a relay desk can reach the relay from the nav', () => {
    for (const role of ['HR_ADMINISTRATOR', 'OPERATIONS_MANAGER', 'INTERNAL_RECRUITER', 'WORKFORCE_MANAGER', 'FINANCE_ACCOUNTANT'] as Role[]) {
      expect(keysFor(role), role).toContain('relay');
    }
  });

  // The role carries the FULL admin capability surface (identical to
  // Marketing / Workforce Manager), so without curation the sidebar dumped
  // the whole console. This pins the recruiter's nav to exactly the six
  // areas they own, the relay (Recruiting is one of its desks), and the two
  // personal-baseline utilities.
  it('shows exactly the six recruiter areas plus the relay, My profile + Messages', () => {
    const keys = keysFor('INTERNAL_RECRUITER');
    expect(new Set(keys)).toEqual(
      new Set<ModuleKey>([
        'me',
        'messages',
        'relay',
        'recruiting',
        'onboarding',
        'people',
        'documents',
        'compliance',
        'hr-cases',
      ]),
    );
  });

  it('drops the modules the uncurated full-admin nav used to show', () => {
    const keys = new Set(keysFor('INTERNAL_RECRUITER'));
    for (const gone of [
      'payroll',
      'payroll-tax',
      'clients',
      'audit',
      'analytics',
      'scheduling',
      'time-attendance',
      'compensation',
      'org',
      'reports',
      'billing',
      'users',
    ] as ModuleKey[]) {
      expect(keys.has(gone)).toBe(false);
    }
  });

  it('never leaks a client-portal surface into the recruiter nav', () => {
    const keys = new Set(keysFor('INTERNAL_RECRUITER'));
    for (const portalKey of [
      'portal',
      'portal-today',
      'portal-schedule',
      'portal-history',
      'portal-requests',
      'portal-candidates',
      'region',
    ] as ModuleKey[]) {
      expect(keys.has(portalKey)).toBe(false);
    }
  });
});

describe('Fieldglass timesheets — its own sidebar entry', () => {
  it('for everyone who works the weekly sheet; never the watch-only, the associate, the client or the exec', () => {
    for (const role of ['FINANCE_ACCOUNTANT', 'HR_ADMINISTRATOR', 'OPERATIONS_MANAGER', 'WORKFORCE_MANAGER', 'SHIFT_SUPERVISOR'] as Role[]) {
      expect(keysFor(role), role).toContain('fieldglass');
    }
    for (const role of ['FLOOR_SUPERVISOR', 'ASSOCIATE', 'CLIENT_PORTAL', 'EXECUTIVE_CHAIRMAN'] as Role[]) {
      expect(keysFor(role), role).not.toContain('fieldglass');
    }
    const entry = MODULES.find((m) => m.key === 'fieldglass')!;
    expect(entry).toMatchObject({ path: '/time-attendance/timesheets', label: 'Fieldglass timesheets', group: 'time-and-pay' });
  });

  it('Fieldglass setup is its own entry too — finance’s (the packet carries PII), never a supervisor’s', () => {
    expect(keysFor('FINANCE_ACCOUNTANT')).toEqual(expect.arrayContaining(['fieldglass', 'fieldglass-setup']));
    expect(keysFor('HR_ADMINISTRATOR')).toContain('fieldglass-setup');
    for (const role of ['SHIFT_SUPERVISOR', 'FLOOR_SUPERVISOR', 'WORKFORCE_MANAGER', 'ASSOCIATE', 'CLIENT_PORTAL'] as Role[]) {
      expect(keysFor(role), role).not.toContain('fieldglass-setup');
    }
    expect(MODULES.find((m) => m.key === 'fieldglass-setup')).toMatchObject({
      path: '/fieldglass',
      label: 'Fieldglass setup',
      requires: 'process:payroll',
      group: 'time-and-pay',
    });
  });
});

describe('visibleModules — SHIFT_SUPERVISOR curation', () => {
  // The role had no curation branch, so its capability slice rendered 24
  // rows — employee perks, a 403ing Reimbursements page, the company
  // holiday calendar, and a margin page. This pins the nav to the store
  // floor plus the personal baseline.
  it('shows exactly the floor surfaces plus the personal baseline', () => {
    const keys = keysFor('SHIFT_SUPERVISOR');
    expect(new Set(keys)).toEqual(
      new Set<ModuleKey>([
        'me',
        'messages',
        'floor-today',
        'scheduling',
        'approvals',
        'time-attendance',
        'fieldglass',
        'ops',
        'marketplace',
        'time-off',
        'onboarding',
        'kiosk',
        'hr-cases',
        'agreements',
        'learning',
        'rides',
      ]),
    );
  });

  it('drops the perks, dead ends, company config and money rows', () => {
    const keys = new Set(keysFor('SHIFT_SUPERVISOR'));
    for (const gone of [
      'pulse',
      'career',
      'equity',
      'tuition',
      'volunteer',
      'internal-jobs',
      'help-center',
      'reimbursements',
      'holidays',
      'labor-costs',
      'communications',
    ] as ModuleKey[]) {
      expect(keys.has(gone)).toBe(false);
    }
  });
});

describe('visibleModules — FLOOR_SUPERVISOR curation', () => {
  // The shift supervisor's floor without the decisions: today's faces, the
  // live board, their shift's SOP, messages and their profile — nothing to
  // approve, schedule, or spend.
  it('shows exactly the floor, the SOP, and the personal baseline', () => {
    expect(new Set(keysFor('FLOOR_SUPERVISOR'))).toEqual(
      new Set<ModuleKey>(['me', 'messages', 'floor-today', 'time-attendance', 'ops', 'rides']),
    );
  });
});

describe('visibleModules — transportation', () => {
  it('puts Ride in the associate nav', () => {
    expect(keysFor('ASSOCIATE')).toContain('rides');
    expect(keysFor('ASSOCIATE')).not.toContain('transport');
  });

  it("gives the director the command center and the personal baseline only", () => {
    expect(new Set(keysFor('TRANSPORTATION_DIRECTOR'))).toEqual(new Set<ModuleKey>(['me', 'messages', 'transport']));
  });

  it('gives the driver the personal baseline — their runs are Home', () => {
    expect(new Set(keysFor('DRIVER'))).toEqual(new Set<ModuleKey>(['me', 'messages']));
  });

  it('gives the workforce manager the command center', () => {
    expect(keysFor('WORKFORCE_MANAGER')).toContain('transport');
  });
});

describe('visibleModules — the supervisor Today page', () => {
  // /today is the portal's Day page opened on the supervisor's own client
  // (the day route opts the store supervisors in). Other manage:scheduling
  // holders have no client to open it on, so it stays out of their nav.
  it("is in the store supervisors' nav and nobody else's", () => {
    expect(keysFor('SHIFT_SUPERVISOR')).toContain('floor-today');
    expect(keysFor('FLOOR_SUPERVISOR')).toContain('floor-today');
    for (const role of ['HR_ADMINISTRATOR', 'OPERATIONS_MANAGER', 'WORKFORCE_MANAGER', 'FINANCE_ACCOUNTANT', 'CLIENT_PORTAL'] as Role[]) {
      expect(keysFor(role)).not.toContain('floor-today');
    }
  });
});
