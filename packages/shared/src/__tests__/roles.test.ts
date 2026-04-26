import { describe, expect, it } from 'vitest';
import {
  HUMAN_ROLES,
  ROLES,
  ROLE_CAPABILITIES,
  hasCapability,
  type Capability,
  type Role,
} from '../roles';

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

  it('OPERATIONS_MANAGER has every view but cannot process payroll', () => {
    for (const v of ALL_VIEWS) expect(hasCapability('OPERATIONS_MANAGER', v)).toBe(true);
    expect(hasCapability('OPERATIONS_MANAGER', 'process:payroll')).toBe(false);
    // But other manage caps yes
    expect(hasCapability('OPERATIONS_MANAGER', 'manage:onboarding')).toBe(true);
    expect(hasCapability('OPERATIONS_MANAGER', 'manage:scheduling')).toBe(true);
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

  it('FINANCE_ACCOUNTANT views payroll + analytics only', () => {
    expect(hasCapability('FINANCE_ACCOUNTANT', 'view:payroll')).toBe(true);
    expect(hasCapability('FINANCE_ACCOUNTANT', 'view:analytics')).toBe(true);
    expect(hasCapability('FINANCE_ACCOUNTANT', 'view:onboarding')).toBe(false);
    expect(hasCapability('FINANCE_ACCOUNTANT', 'process:payroll')).toBe(false);
  });

  it('INTERNAL_RECRUITER manages onboarding and recruiting, no payroll/scheduling', () => {
    expect(hasCapability('INTERNAL_RECRUITER', 'view:recruiting')).toBe(true);
    expect(hasCapability('INTERNAL_RECRUITER', 'manage:recruiting')).toBe(true);
    expect(hasCapability('INTERNAL_RECRUITER', 'manage:onboarding')).toBe(true);
    expect(hasCapability('INTERNAL_RECRUITER', 'view:payroll')).toBe(false);
    expect(hasCapability('INTERNAL_RECRUITER', 'manage:scheduling')).toBe(false);
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
