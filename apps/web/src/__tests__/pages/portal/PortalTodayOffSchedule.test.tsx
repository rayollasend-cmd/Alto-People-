import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { ymdLocal } from '@/lib/format';

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));

import { apiFetch } from '@/lib/api';
import { PortalToday } from '@/pages/portal/PortalToday';

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const at = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

function renderToday() {
  const today = ymdLocal();
  vi.mocked(apiFetch).mockResolvedValue({
    client: { id: 'c1', name: 'Coastal' },
    store: null,
    date: today,
    today,
    generatedAt: new Date().toISOString(),
    target: 4,
    roster: [
      {
        shiftId: 's1', associateId: 'a1', name: 'Ann Lee', position: 'Server', isLead: false,
        clockInAt: at(-1), clockOutAt: null, startsAt: at(-1), endsAt: at(6), timezone: tz,
        locationName: null, state: 'on-floor',
      },
    ],
    onFloorNow: [
      { associateId: 'a1', name: 'Ann Lee', clockInAt: at(-1), position: 'Server' },
      { associateId: 'w1', name: 'Wes Park', clockInAt: at(-0.5), position: null },
    ],
    summary: { expected: 1, worked: 1, onFloor: 1, missed: 0, open: 0 },
  });
  const caps = ROLE_CAPABILITIES.SHIFT_SUPERVISOR;
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider
        value={{
          isInitializing: false,
          isOffline: false,
          user: { id: 'u', email: 'dana@altohr.com', role: 'SHIFT_SUPERVISOR', status: 'ACTIVE', clientId: 'c1', associateId: null },
          role: 'SHIFT_SUPERVISOR',
          capabilities: new Set<Capability>(caps),
          signIn: vi.fn(),
          signOut: vi.fn(),
          can: (c: Capability) => caps.has(c),
        }}
      >
        <MemoryRouter initialEntries={['/today']}>
          <PortalToday />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

describe('<PortalToday> — everyone on the floor has a face', () => {
  it('counts every clock-in and shows the ones outside a scheduled shift', async () => {
    const user = userEvent.setup();
    renderToday();
    expect(await screen.findByText(/2 on the floor now/)).toBeInTheDocument();
    expect(screen.getByText('On the floor outside a scheduled shift')).toBeInTheDocument();
    // Only the walk-in is in that group — Ann is on her shift's wave.
    await user.click(screen.getByRole('button', { name: /Wes Park/ }));
    expect(screen.getAllByText(/Wes Park · In /).length).toBeGreaterThan(0);
    // Ann is on her shift wave, not in the off-schedule group.
    expect(screen.getAllByRole('button', { name: /^Ann Lee/ })).toHaveLength(1);
  });
});
