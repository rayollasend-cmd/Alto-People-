import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { PLATFORM_OPERATOR_TENANT_ID, ROLE_CAPABILITIES, type Capability, type Role } from '@alto-people/shared';
import { AuthContext, DEFAULT_TENANT } from '@/lib/auth';
import { useSettingsRail } from '@/pages/settings/settingsRail';

/**
 * Settings & trust holds the governance of agents, not the agents: the rail
 * points "Agents & gates" at /admin/agents, and the workforce roster — a
 * People page — is not a Settings page at all.
 */
function railFor(role: Role, tenantId = DEFAULT_TENANT.id) {
  const caps = ROLE_CAPABILITIES[role];
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AuthContext.Provider
      value={
        {
          user: { id: 'u1', email: 'x@example.com', role, status: 'ACTIVE' },
          tenant: { ...DEFAULT_TENANT, id: tenantId },
          loading: false,
          can: (c: Capability) => caps.has(c),
        } as never
      }
    >
      {children}
    </AuthContext.Provider>
  );
  return renderHook(() => useSettingsRail(), { wrapper }).result.current;
}

describe('useSettingsRail', () => {
  it('Agents & gates is the governance page, and the roster is not in the rail', () => {
    const rail = railFor('HR_ADMINISTRATOR');
    const agents = rail.find((i) => i.key === 'agents');
    expect(agents?.label).toBe('Agents & gates');
    expect(agents?.to).toBe('/admin/agents');
    expect(agents?.section).toBe('Access & trust');
    expect(rail.find((i) => i.to === '/workers')).toBeUndefined();
    expect(rail.find((i) => i.to === '/agents')).toBeUndefined();
  });

  it('Roles & permissions is its own entry, beside Users & access — not a tab inside it (audit Tier 3)', () => {
    const rail = railFor('HR_ADMINISTRATOR');
    const roles = rail.find((i) => i.key === 'roles');
    expect(roles).toMatchObject({ label: 'Roles & permissions', to: '/admin/roles', section: 'Access & trust' });
    const keys = rail.map((i) => i.key);
    expect(keys.indexOf('roles')).toBe(keys.indexOf('users') + 1);
    expect(railFor('ASSOCIATE').find((i) => i.key === 'roles')).toBeUndefined();
  });

  it("keeps the platform's own tools to the platform operator (F500 audit 2026-10-26)", () => {
    const platformKeys = ['reliability', 'product-analytics', 'design-system', 'compliance-evidence', 'platform-support'];
    // A customer's HR admin holds the same capabilities through their role, and sees none of them.
    const customer = railFor('HR_ADMINISTRATOR', '7d4a1c2e-0000-4000-8000-00000000abcd').map((i) => i.key);
    for (const key of platformKeys) expect(customer, key).not.toContain(key);
    const operator = railFor('HR_ADMINISTRATOR', PLATFORM_OPERATOR_TENANT_ID).map((i) => i.key);
    for (const key of platformKeys) expect(operator, key).toContain(key);
  });

  it('gives a customer Service health — the public status page — in place of the platform tools, with distinct icons', () => {
    const customer = railFor('HR_ADMINISTRATOR', '7d4a1c2e-0000-4000-8000-00000000abcd');
    expect(customer.find((i) => i.key === 'service-health')).toMatchObject({ to: '/status', section: 'Platform', leaves: true });
    const operator = railFor('HR_ADMINISTRATOR', PLATFORM_OPERATOR_TENANT_ID);
    const icon = (k: string) => operator.find((i) => i.key === k)?.icon;
    expect(icon('reliability')).not.toBe(icon('product-analytics'));
    expect(icon('developers')).toBeDefined();
  });

  it('is hidden from a role without view:org', () => {
    const rail = railFor('ASSOCIATE');
    expect(rail.find((i) => i.key === 'agents')).toBeUndefined();
  });
});
