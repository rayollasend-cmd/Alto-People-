import { describe, expect, it } from 'vitest';
import type { Role } from '@prisma/client';
import { scopeApplications, scopeClients, scopeTemplates } from '../../lib/scope.js';
import type { SessionUser } from '../../types/express.js';

const baseUser = (role: Role, overrides: Partial<SessionUser> = {}): SessionUser => ({
  id: 'user-id',
  email: `${role.toLowerCase()}@example.com`,
  role,
  status: 'ACTIVE',
  clientId: null,
  associateId: null,
  tokenVersion: 0,
  ...overrides,
});

describe('scopeClients', () => {
  it('returns base soft-delete filter for HR_ADMINISTRATOR', () => {
    expect(scopeClients(baseUser('HR_ADMINISTRATOR'))).toEqual({ deletedAt: null });
  });

  it('returns base for ASSOCIATE (the route still gates by capability)', () => {
    expect(scopeClients(baseUser('ASSOCIATE'))).toEqual({ deletedAt: null });
  });

  it('CLIENT_PORTAL with clientId is restricted to that client', () => {
    expect(scopeClients(baseUser('CLIENT_PORTAL', { clientId: 'client-A' }))).toEqual({
      deletedAt: null,
      id: 'client-A',
    });
  });

  it('CLIENT_PORTAL without clientId falls back to base (defense-in-depth)', () => {
    expect(scopeClients(baseUser('CLIENT_PORTAL', { clientId: null }))).toEqual({
      deletedAt: null,
    });
  });

  it('returns base for EXECUTIVE_CHAIRMAN', () => {
    expect(scopeClients(baseUser('EXECUTIVE_CHAIRMAN'))).toEqual({ deletedAt: null });
  });
});

describe('scopeApplications', () => {
  it('HR_ADMINISTRATOR sees every non-deleted application', () => {
    expect(scopeApplications(baseUser('HR_ADMINISTRATOR'))).toEqual({ deletedAt: null });
  });

  it('CLIENT_PORTAL with clientId is restricted to that client', () => {
    expect(scopeApplications(baseUser('CLIENT_PORTAL', { clientId: 'client-A' }))).toEqual({
      deletedAt: null,
      clientId: 'client-A',
    });
  });

  it('ASSOCIATE with associateId is restricted to their own applications', () => {
    expect(scopeApplications(baseUser('ASSOCIATE', { associateId: 'assoc-A' }))).toEqual({
      deletedAt: null,
      associateId: 'assoc-A',
    });
  });

  it('ASSOCIATE without associateId falls back to base (no leak via missing scope)', () => {
    expect(scopeApplications(baseUser('ASSOCIATE', { associateId: null }))).toEqual({
      deletedAt: null,
    });
  });
});

describe('scopeTemplates', () => {
  it('returns empty filter for HR_ADMINISTRATOR (sees all templates)', () => {
    expect(scopeTemplates(baseUser('HR_ADMINISTRATOR'))).toEqual({});
  });

  it('CLIENT_PORTAL sees global + own-client templates', () => {
    expect(scopeTemplates(baseUser('CLIENT_PORTAL', { clientId: 'client-A' }))).toEqual({
      OR: [{ clientId: null }, { clientId: 'client-A' }],
    });
  });

  it('CLIENT_PORTAL without clientId falls back to all (route still authz-gates)', () => {
    expect(scopeTemplates(baseUser('CLIENT_PORTAL', { clientId: null }))).toEqual({});
  });
});
