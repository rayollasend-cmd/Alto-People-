import { describe, expect, it } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import {
  HUMAN_ROLES,
  ROLES,
  ROLE_CAPABILITIES,
  can,
  capabilitiesOf,
  hasCapability,
  type Capability,
  type Role,
} from '@alto-people/shared';
import { requireAnyCapability, requireCapability } from '../../middleware/auth.js';
import { ALL_CAPABILITIES } from '../../lib/tenantRoles.js';

/**
 * Brief 2-3 step 3 — the equivalence proof (docs/identity-rbac-audit-
 * investigation.md §4.3). The capability gates now read `can(user, cap)`;
 * for every account WITHOUT a custom role that must answer exactly what
 * `hasCapability(archetype, cap)` answered, for every archetype × every
 * capability, through the real middlewares. It stays as the regression gate.
 */

const ROLE_LIST = Object.keys(ROLES) as Role[];

function gate(mw: ReturnType<typeof requireCapability>, user: { role: Role; capabilities?: string[] | null }): 'next' | number {
  let out: 'next' | number = 'next';
  const res = {
    status(code: number) {
      out = code;
      return this;
    },
    json() {
      return this;
    },
  } as unknown as Response;
  let called = false;
  mw({ user, get: () => '' } as unknown as Request, res, (() => (called = true)) as NextFunction);
  return called ? 'next' : out;
}

describe('RBAC equivalence: built-in roles answer exactly as before', () => {
  it('the capability catalogue is every capability any role holds', () => {
    const union = new Set(ROLE_LIST.flatMap((r) => [...ROLE_CAPABILITIES[r]]));
    expect(new Set(ALL_CAPABILITIES)).toEqual(union);
  });

  for (const role of ROLE_LIST) {
    it(`${role}: can() and both middlewares match hasCapability for all capabilities`, () => {
      expect(capabilitiesOf({ role })).toBe(ROLE_CAPABILITIES[role]);
      expect(capabilitiesOf({ role, capabilities: null })).toBe(ROLE_CAPABILITIES[role]);
      for (const cap of ALL_CAPABILITIES) {
        const before = hasCapability(role, cap);
        expect(can({ role }, cap), `${role} ${cap}`).toBe(before);
        expect(can({ role, capabilities: null }, cap)).toBe(before);
        expect(gate(requireCapability(cap), { role })).toBe(before ? 'next' : 403);
        expect(gate(requireAnyCapability(cap), { role })).toBe(before ? 'next' : 403);
      }
    });
  }

  it('no session is 401, never 403 or next', () => {
    expect(gate(requireCapability('view:dashboard'), undefined as never)).toBe(401);
  });
});

describe('a custom role narrows and never widens', () => {
  const role: Role = 'MANAGER';
  const ceiling = [...ROLE_CAPABILITIES[role]];
  const kept = ceiling.slice(0, 3);

  it('holds only what it lists', () => {
    for (const cap of ceiling) {
      expect(can({ role, capabilities: kept }, cap)).toBe(kept.includes(cap));
      expect(gate(requireCapability(cap), { role, capabilities: kept })).toBe(kept.includes(cap) ? 'next' : 403);
    }
  });

  it('a capability outside the archetype is ignored even if stored', () => {
    const outside = ALL_CAPABILITIES.find((c) => !ROLE_CAPABILITIES[role].has(c)) as Capability;
    expect(outside).toBeDefined();
    expect(can({ role, capabilities: [...kept, outside] }, outside)).toBe(false);
    expect(capabilitiesOf({ role, capabilities: [...kept, outside] }).has(outside)).toBe(false);
  });

  it('an empty custom role holds nothing (it is not "no custom role")', () => {
    expect(capabilitiesOf({ role, capabilities: [] }).size).toBe(0);
    expect(gate(requireAnyCapability(...kept), { role, capabilities: [] })).toBe(403);
  });

  it('every human role can be narrowed the same way', () => {
    for (const r of HUMAN_ROLES) {
      const one = [...ROLE_CAPABILITIES[r]][0]!;
      expect([...capabilitiesOf({ role: r, capabilities: [one] })]).toEqual([one]);
    }
  });
});
