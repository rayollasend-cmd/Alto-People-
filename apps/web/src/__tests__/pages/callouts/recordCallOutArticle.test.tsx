import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { withArticle } from '@/lib/validationCopy';

vi.mock('@/lib/callOutsApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/callOutsApi')>()),
  listCallOuts: vi.fn().mockResolvedValue({ range: 'today', total: 0, covered: 0, looking: 0, uncovered: 0, late: 0, truncated: false, items: [] }),
  recordCallOutFor: vi.fn(),
}));
vi.mock('@/lib/schedulingApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/schedulingApi')>()),
  getAutoFillBatch: vi.fn().mockResolvedValue({ byShift: {} }),
  assignShift: vi.fn(),
  listShifts: vi.fn(async () => ({ shifts: [], truncated: false })),
}));

import { CallOutsDesk } from '@/pages/callouts/CallOutsDesk';

/** Role walk, ops 24: "For a associate" — the article follows the noun. */
describe('record a call-out dialog', () => {
  it('picks the article by sound', () => {
    expect(withArticle('associate')).toBe('an associate');
    expect(withArticle('team member')).toBe('a team member');
  });

  it('reads "For an associate"', async () => {
    const role = 'HR_ADMINISTRATOR' as const;
    const caps = ROLE_CAPABILITIES[role];
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <AuthContext.Provider
          value={{ isInitializing: false, isOffline: false, user: { id: 'u', email: 'hr@x.com', role, status: 'ACTIVE', clientId: null, associateId: null }, role, capabilities: new Set<Capability>(caps), signIn: vi.fn(), signOut: vi.fn(), can: (c: Capability) => caps.has(c) } as never}
        >
          <MemoryRouter initialEntries={['/call-outs']}>
            <CallOutsDesk />
          </MemoryRouter>
        </AuthContext.Provider>
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Record a call-out/ }));
    expect(await screen.findByText(/^For an associate who called you directly/)).toBeInTheDocument();
  });
});
