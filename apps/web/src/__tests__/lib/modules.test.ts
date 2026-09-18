import { describe, expect, it } from 'vitest';
import { ROLE_CAPABILITIES, type Capability, type Role } from '@alto-people/shared';
import { visibleModules, type ModuleKey } from '@/lib/modules';

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
  // The role carries the FULL admin capability surface (identical to
  // Marketing / Workforce Manager), so without curation the sidebar dumped
  // the whole console. This pins the recruiter's nav to exactly the six
  // areas they own plus the two personal-baseline utilities.
  it('shows exactly the six recruiter areas plus My profile + Messages', () => {
    const keys = keysFor('INTERNAL_RECRUITER');
    expect(new Set(keys)).toEqual(
      new Set<ModuleKey>([
        'me',
        'messages',
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
      'region',
    ] as ModuleKey[]) {
      expect(keys.has(portalKey)).toBe(false);
    }
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
        'scheduling',
        'approvals',
        'time-attendance',
        'ops',
        'marketplace',
        'time-off',
        'onboarding',
        'kiosk',
        'hr-cases',
        'agreements',
        'learning',
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
  // Watch-only: the live board, their own profile, and messages — nothing
  // to decide, nothing to spend.
  it('shows exactly the live board plus the personal baseline', () => {
    expect(new Set(keysFor('FLOOR_SUPERVISOR'))).toEqual(
      new Set<ModuleKey>(['me', 'messages', 'time-attendance']),
    );
  });
});
