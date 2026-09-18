import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ROLE_CAPABILITIES, type Capability, type Role, type Shift } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { useLaborCostVisible } from '@/lib/useLaborCostVisible';
import { ShiftHoverCard } from '@/pages/scheduling/ShiftHoverCard';

function auth(role: Role) {
  const caps = ROLE_CAPABILITIES[role];
  return {
    isInitializing: false,
    isOffline: false,
    user: { id: 'u', email: 'x@altohr.com', role, status: 'ACTIVE' as const, clientId: 'c1', associateId: null },
    role,
    capabilities: new Set<Capability>(caps),
    signIn: vi.fn(),
    signOut: vi.fn(),
    can: (c: Capability) => caps.has(c),
  };
}

function Probe() {
  return <span>{useLaborCostVisible() ? 'cost shown' : 'cost hidden'}</span>;
}

describe('useLaborCostVisible — labor cost never reaches a store-bound role', () => {
  it('hides it from the shift and floor supervisors, shows it to org roles', () => {
    for (const [role, expected] of [
      ['SHIFT_SUPERVISOR', 'cost hidden'],
      ['FLOOR_SUPERVISOR', 'cost hidden'],
      ['HR_ADMINISTRATOR', 'cost shown'],
      ['FINANCE_ACCOUNTANT', 'cost shown'],
    ] as Array<[Role, string]>) {
      const { unmount } = render(
        <AuthContext.Provider value={auth(role)}>
          <Probe />
        </AuthContext.Provider>,
      );
      expect(screen.getByText(expected)).toBeInTheDocument();
      unmount();
    }
  });

  it('the shift hover card keeps the rate but drops the projected cost for a supervisor', () => {
    const shift = {
      id: 's1',
      clientId: 'c1',
      clientName: 'Coastal',
      position: 'Server',
      startsAt: new Date().toISOString(),
      endsAt: new Date(Date.now() + 8 * 3_600_000).toISOString(),
      scheduledMinutes: 480,
      status: 'ASSIGNED',
      payRate: 17.5,
      effectivePayRate: 17.5,
      timezone: 'America/New_York',
      assignedAssociateId: 'a1',
      assignedAssociateName: 'Ann Lee',
      notes: null,
    } as unknown as Shift;
    const card = (role: Role) =>
      render(
        <AuthContext.Provider value={auth(role)}>
          <ShiftHoverCard
            shift={shift}
            anchorRect={new DOMRect(0, 0, 10, 10)}
            onClose={vi.fn()}
            onPointerEnterCard={vi.fn()}
            onPointerLeaveCard={vi.fn()}
            canManage={false}
            actions={{} as never}
          />
        </AuthContext.Provider>,
      );

    const sup = card('SHIFT_SUPERVISOR');
    expect(document.body.textContent).toMatch(/\$17\.50/);
    expect(document.body.textContent).not.toMatch(/projected/);
    sup.unmount();

    card('HR_ADMINISTRATOR');
    expect(document.body.textContent).toMatch(/projected \$140/);
  });
});
