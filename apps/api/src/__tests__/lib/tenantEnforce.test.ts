import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Request, Response } from 'express';
import { adoptFromResult, guardTenantQuery } from '../../lib/tenantGuard.js';
import { ALTO_TENANT_ID, adoptTenant, currentTenantId, runWithTenant, tenantContext, tenantMiddleware, withIdentityScope } from '../../lib/tenant.js';

/**
 * The tenant wall in enforce mode. A signed-in request is its user's tenant;
 * an anonymous one (a public link, a webhook, a sign-in) binds to the tenant
 * of the first record it resolves by a key; nothing runs with no tenant.
 */

const OTHER = '22222222-2222-4222-8222-222222222222';
type Args = { where?: Record<string, unknown>; select?: Record<string, unknown> };

/** Run `fn` inside the context an anonymous request gets (tenantMiddleware with no user). */
function asAnonymous<T>(fn: () => Promise<T> | T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    tenantMiddleware({} as Request, {} as Response, () => {
      Promise.resolve().then(fn).then(resolve, reject);
    });
  });
}

let previous: string | undefined;
beforeEach(() => {
  previous = process.env.TENANCY_MODE;
  process.env.TENANCY_MODE = 'enforce';
});
afterEach(() => {
  process.env.TENANCY_MODE = previous;
});

describe('enforce: anonymous requests', () => {
  it('the first single-record lookup is not narrowed, and its record binds the request', async () => {
    await asAnonymous(async () => {
      const args = guardTenantQuery('Associate', 'findUnique', { where: { id: 'x' }, select: { id: true } }) as Args;
      expect(args.where).toEqual({ id: 'x' });
      // tenantId is selected so the result can bind the request.
      expect(args.select).toEqual({ id: true, tenantId: true });
      adoptFromResult('Associate', 'findUnique', { id: 'x', tenantId: OTHER });
      expect(currentTenantId()).toBe(OTHER);
      // Everything after runs as that tenant.
      const later = guardTenantQuery('Shift', 'findMany', { where: { status: 'OPEN' } }) as Args;
      expect(later.where).toEqual({ status: 'OPEN', tenantId: OTHER });
    });
  });

  it('a list read before any record is resolved stays narrowed to the default tenant', async () => {
    await asAnonymous(async () => {
      const args = guardTenantQuery('Associate', 'findMany', { where: { lastName: 'Lopez' } }) as Args;
      expect(args.where).toEqual({ lastName: 'Lopez', tenantId: ALTO_TENANT_ID });
    });
  });

  it('once bound, a second record from another tenant cannot move the request', async () => {
    await asAnonymous(async () => {
      adoptFromResult('Associate', 'findFirst', { tenantId: OTHER });
      adoptFromResult('Associate', 'findFirst', { tenantId: ALTO_TENANT_ID });
      expect(currentTenantId()).toBe(OTHER);
      expect(adoptTenant(ALTO_TENANT_ID)).toBe(false);
    });
  });

  it('identity resolution sees every tenant, and adoption happens back in the request', async () => {
    await asAnonymous(async () => {
      await withIdentityScope(() => {
        expect(tenantContext()?.platform).toBe(true);
        // A platform scope never adopts.
        expect(adoptTenant(OTHER)).toBe(false);
      });
      expect(adoptTenant(OTHER)).toBe(true);
      expect(currentTenantId()).toBe(OTHER);
    });
  });
});

describe('enforce: signed-in and background work', () => {
  it('a session is its tenant: reads are narrowed and a lookup never re-binds it', async () => {
    await runWithTenant(OTHER, 'session', async () => {
      const args = guardTenantQuery('Associate', 'findUnique', { where: { id: 'x' } }) as Args;
      expect(args.where).toEqual({ id: 'x', tenantId: OTHER });
      adoptFromResult('Associate', 'findUnique', { tenantId: ALTO_TENANT_ID });
      expect(currentTenantId()).toBe(OTHER);
    });
  });

  it('a query with no tenant in context is refused', () => {
    // TENANCY_UNSCOPED=platform (the fixtures' escape hatch) would turn this
    // into the platform scope; production never sets it.
    const unscoped = process.env.TENANCY_UNSCOPED;
    delete process.env.TENANCY_UNSCOPED;
    try {
      expect(() => guardTenantQuery('Associate', 'findMany', {})).toThrow(/no tenant in context/);
    } finally {
      if (unscoped !== undefined) process.env.TENANCY_UNSCOPED = unscoped;
    }
  });

  it('shared reference data is exempt', () => {
    expect(() => guardTenantQuery('Tenant', 'findMany', {})).not.toThrow();
  });
});
