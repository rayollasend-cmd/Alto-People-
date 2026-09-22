import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ROLE_CAPABILITIES, type Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { PageTitleProvider, usePublishPageTitle } from '@/lib/pageTitle';

/**
 * On a phone there is no other way back.
 *
 * PageHeader hides breadcrumbs below md ("the tab bar navigates"), but the
 * tab bar only moves between SECTIONS — it cannot go up out of a detail
 * screen, and tapping it throws away where you were. In a browser tab the
 * OS back gesture covers that. An installed PWA has no browser chrome at
 * all, so on /payroll/compliance in standalone there was nothing.
 */

const navigate = vi.fn();
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

import { Topbar } from '@/components/Topbar';

function Publish({ crumbs }: { crumbs: { label: string; to?: string }[] | null }) {
  usePublishPageTitle('A page', crumbs);
  return null;
}

function renderAt(
  path: string,
  crumbs: { label: string; to?: string }[] | null = null,
  historyIdx = 1,
) {
  window.history.replaceState({ idx: historyIdx }, '', path);
  const caps = ROLE_CAPABILITIES.HR_ADMINISTRATOR;
  return render(
    <AuthContext.Provider
      value={{
        isInitializing: false,
        isOffline: false,
        user: { id: 'u', email: 'hr@altohr.com', role: 'HR_ADMINISTRATOR', status: 'ACTIVE', clientId: null, associateId: null },
        role: 'HR_ADMINISTRATOR',
        capabilities: new Set<Capability>(caps),
        signIn: vi.fn(),
        signOut: vi.fn(),
        can: (c: Capability) => caps.has(c),
      }}
    >
      <PageTitleProvider>
        <TooltipProvider>
          <MemoryRouter initialEntries={[path]}>
            <Publish crumbs={crumbs} />
            <Topbar />
          </MemoryRouter>
        </TooltipProvider>
      </PageTitleProvider>
    </AuthContext.Provider>,
  );
}

beforeEach(() => {
  navigate.mockClear();
});

describe('the phone back control', () => {
  it('is not offered at a section root — that is where the logo belongs', () => {
    renderAt('/payroll');
    expect(screen.queryByRole('button', { name: /back|payroll/i })).toBeNull();
  });

  it('appears inside a section and names where it goes', () => {
    renderAt('/payroll/compliance', [{ label: 'Payroll', to: '/payroll' }, { label: 'Compliance' }]);
    expect(screen.getByRole('button', { name: 'Payroll' })).toBeInTheDocument();
  });

  it('falls back to "Back" when the page published no trail', () => {
    renderAt('/payroll/compliance');
    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
  });

  it('goes back through history when there is history to go back through', async () => {
    renderAt('/payroll/compliance', [{ label: 'Payroll', to: '/payroll' }, { label: 'Compliance' }], 3);
    await userEvent.click(screen.getByRole('button', { name: 'Payroll' }));
    expect(navigate).toHaveBeenCalledWith(-1);
  });

  it('goes UP instead when the detail screen is the first page of the session', async () => {
    // Someone followed a link from an email straight into a detail. Back
    // would leave the app, or in standalone do nothing at all.
    renderAt('/payroll/compliance', [{ label: 'Payroll', to: '/payroll' }, { label: 'Compliance' }], 0);
    await userEvent.click(screen.getByRole('button', { name: 'Payroll' }));
    expect(navigate).toHaveBeenCalledWith('/payroll');
  });

  it('still goes up with no trail to read, by dropping the last segment', async () => {
    renderAt('/payroll/compliance', null, 0);
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(navigate).toHaveBeenCalledWith('/payroll');
  });

  it('is a full-height touch target', () => {
    renderAt('/payroll/compliance');
    // 44px. A 24px chevron in the corner of a moving bus is not a control.
    expect(screen.getByRole('button', { name: 'Back' }).className).toContain('min-h-11');
  });
});
