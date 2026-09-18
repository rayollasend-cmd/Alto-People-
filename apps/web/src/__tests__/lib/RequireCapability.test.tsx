import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ROLE_CAPABILITIES, type Capability, type Role } from '@alto-people/shared';

let role: Role = 'SHIFT_SUPERVISOR';
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    user: { role },
    can: (c: Capability) => ROLE_CAPABILITIES[role].has(c),
  }),
}));

import { RequireCapability } from '@/lib/RequireCapability';

/** The /labor-costs route guard, exactly as App.tsx mounts it. */
function renderLaborCosts(as: Role) {
  role = as;
  return render(
    <MemoryRouter initialEntries={['/labor-costs']}>
      <RequireCapability
        cap="manage:scheduling"
        anyOf={['view:executive', 'process:payroll']}
        notClientBounded
      >
        <div>labor board</div>
      </RequireCapability>
    </MemoryRouter>,
  );
}

describe('RequireCapability — notClientBounded (the /labor-costs guard)', () => {
  // The shift supervisor holds manage:scheduling, which alone would open
  // the page by URL; labor cost is org economics, so the route refuses
  // client-bound roles outright.
  it('shows the shift supervisor the not-found page', () => {
    renderLaborCosts('SHIFT_SUPERVISOR');
    expect(screen.queryByText('labor board')).toBeNull();
    expect(screen.getByText('Page not found')).toBeTruthy();
  });

  it('still opens for the org roles that read labor cost', () => {
    for (const r of ['HR_ADMINISTRATOR', 'FINANCE_ACCOUNTANT', 'EXECUTIVE_CHAIRMAN'] as Role[]) {
      const { unmount } = renderLaborCosts(r);
      expect(screen.getByText('labor board')).toBeTruthy();
      unmount();
    }
  });
});
