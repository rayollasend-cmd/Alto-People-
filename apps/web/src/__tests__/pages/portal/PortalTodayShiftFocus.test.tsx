import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, minuteOfDayInZone, type Capability, type Role } from '@alto-people/shared';
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
const mod = (h: number) => minuteOfDayInZone(new Date(Date.now() + h * 3_600_000), tz);

// "Early" began 6h ago; "Late" starts in 2h. Each wave is one named window.
const early = { locationId: 'l1', label: 'Early', startMinute: mod(-7), endMinute: mod(-5), leads: ['Omar Diaz'] };
const late = { locationId: 'l1', label: 'Late', startMinute: mod(1), endMinute: mod(3), leads: ['Dana Reyes'] };
const row = (id: string, name: string, from: number, state: string) => ({
  shiftId: id, associateId: `a-${id}`, name, position: 'Server', isLead: false,
  clockInAt: state === 'on-floor' ? at(from) : null, clockOutAt: null,
  startsAt: at(from), endsAt: at(from + 8), timezone: tz,
  locationId: 'l1', locationName: 'Front Beach 218', state,
});

function renderToday(role: Role) {
  try {
    sessionStorage.removeItem('alto.floor.focus');
  } catch {
    /* no storage in this env */
  }
  const today = ymdLocal();
  vi.mocked(apiFetch).mockImplementation(async (path: string) => {
    if (path === '/me/shift-windows')
      return { windows: [{ ...late, locationName: 'Front Beach 218', timezone: tz, targetCount: 3 }] };
    return {
      client: { id: 'c1', name: 'Coastal' },
      store: { id: 'l1', name: 'Front Beach 218', timezone: tz },
      date: today,
      today,
      generatedAt: new Date().toISOString(),
      target: 4,
      roster: [row('e1', 'Ann Lee', -6, 'on-floor'), row('l1', 'Cy Dale', 2, 'confirmed')],
      onFloorNow: [{ associateId: 'a-e1', name: 'Ann Lee', clockInAt: at(-6), position: 'Server' }],
      summary: { expected: 2, worked: 1, onFloor: 1, missed: 0, open: 0 },
      windowLeads: [early, late],
    };
  });
  const caps = ROLE_CAPABILITIES[role];
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider
        value={{
          isInitializing: false,
          isOffline: false,
          user: { id: 'u', email: 'x@example.com', role, status: 'ACTIVE', clientId: 'c1', associateId: null },
          role,
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

describe('<PortalToday> — shifts by name, with their lead', () => {
  it("the store manager sees each shift's name and who leads it", async () => {
    renderToday('CLIENT_PORTAL');
    expect(await screen.findByText('Lead · Omar Diaz')).toBeInTheDocument();
    expect(screen.getByText('Lead · Dana Reyes')).toBeInTheDocument();
    expect(screen.getByText('Early')).toBeInTheDocument();
    expect(screen.getByText('Late')).toBeInTheDocument();
    // No focus toggle for a store account.
    expect(screen.queryByRole('radio', { name: /My shift/ })).not.toBeInTheDocument();
  });

  it('a supervisor opens on their shift and can widen to the whole store', async () => {
    const user = userEvent.setup();
    renderToday('SHIFT_SUPERVISOR');
    expect(await screen.findByText('Lead · Dana Reyes')).toBeInTheDocument();
    expect(screen.queryByText('Early')).not.toBeInTheDocument();
    // Ann is on the floor, but on Early — not on Dana's shift.
    expect(screen.getByText(/0 on the floor now/)).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Whole store' }));
    expect(await screen.findByText('Early')).toBeInTheDocument();
    expect(screen.getByText(/1 on the floor now/)).toBeInTheDocument();
  });
});
