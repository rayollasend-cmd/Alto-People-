import { describe, expect, it } from 'vitest';
import type { Role } from '@prisma/client';
import {
  scopeBackgroundChecks,
  scopeDrugTests,
  scopePayrollItems,
  scopePayrollRuns,
  scopePayrollSchedules,
  scopeQualifications,
  scopeWhere,
} from '../../lib/scope.js';
import type { SessionUser } from '../../types/express.js';

/**
 * The helpers that used to ignore a site/region binding: an Ops lead bound
 * to one store now gets that store's pay, checks and qualifications — and
 * an unbound office account still gets everything.
 */

const user = (role: Role, scopeSiteIds: string[] = []): SessionUser =>
  ({
    id: 'u',
    email: 'u@example.com',
    role,
    primaryRole: role,
    availableRoles: [role],
    status: 'ACTIVE',
    clientId: null,
    locationId: null,
    regionId: null,
    associateId: null,
    tokenVersion: 0,
    firstName: null,
    lastName: null,
    photoUrl: null,
    timezone: null,
    mfaEnabled: false,
    tenantId: '00000000-0000-4000-8000-000000000001',
    scopeSiteIds,
    scopeRegionIds: [],
  }) as unknown as SessionUser;

const bound = user('OPERATIONS_MANAGER', ['site-a']);
const open = user('OPERATIONS_MANAGER');

describe('internal site binding in every helper', () => {
  it('narrows pay, checks and qualifications for a bound account', () => {
    expect(JSON.stringify(scopePayrollItems(bound))).toContain('site-a');
    expect(JSON.stringify(scopePayrollRuns(bound))).toContain('site-a');
    expect(JSON.stringify(scopePayrollSchedules(bound))).toContain('site-a');
    expect(JSON.stringify(scopeBackgroundChecks(bound))).toContain('site-a');
    expect(JSON.stringify(scopeDrugTests(bound))).toContain('site-a');
    expect(JSON.stringify(scopeQualifications(bound))).toContain('site-a');
  });

  it('leaves an unbound office account the whole tenant', () => {
    expect(scopePayrollItems(open)).toEqual({});
    expect(scopePayrollRuns(open)).toEqual({});
    expect(scopeBackgroundChecks(open)).toEqual({});
    expect(scopeDrugTests(open)).toEqual({});
    expect(scopeQualifications(open)).toEqual({});
  });
});

describe('scopeWhere', () => {
  it('ANDs the parts so two constraints on one key both hold, and drops the empty ones', () => {
    const w = scopeWhere<Record<string, unknown>>({ assignments: { some: { locationId: 'a' } } }, false, null, {}, { assignments: { some: { locationId: 'b' } } });
    expect(w).toEqual({ AND: [{ assignments: { some: { locationId: 'a' } } }, { assignments: { some: { locationId: 'b' } } }] });
  });
});
