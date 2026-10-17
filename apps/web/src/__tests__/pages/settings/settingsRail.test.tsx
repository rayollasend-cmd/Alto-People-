import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ROLE_CAPABILITIES, type Capability, type Role } from '@alto-people/shared';
import { AuthContext, DEFAULT_TENANT } from '@/lib/auth';
import { useSettingsRail } from '@/pages/settings/settingsRail';

/**
 * Settings & trust holds the governance of agents, not the agents: the rail
 * points "Agents & gates" at /admin/agents, and the workforce roster — a
 * People page — is not a Settings page at all.
 */
function railFor(role: Role) {
  const caps = ROLE_CAPABILITIES[role];
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AuthContext.Provider
      value={
        {
          user: { id: 'u1', email: 'x@example.com', role, status: 'ACTIVE' },
          tenant: DEFAULT_TENANT,
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

  it('is hidden from a role without view:org', () => {
    const rail = railFor('ASSOCIATE');
    expect(rail.find((i) => i.key === 'agents')).toBeUndefined();
  });
});
