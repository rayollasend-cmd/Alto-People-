import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability, type Role } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';

vi.mock('@/lib/shiftWindowsApi', () => ({
  getShiftCoverageGaps: vi.fn(),
  listClientShiftWindows: vi.fn(),
  setSupervisorShiftWindows: vi.fn(),
}));

import { getShiftCoverageGaps, listClientShiftWindows, type ShiftCoverageGaps } from '@/lib/shiftWindowsApi';
import { ShiftLeadsCard } from '@/components/ShiftLeadsCard';

const gaps: ShiftCoverageGaps = {
  total: 3,
  covered: 1,
  clients: [
    {
      clientId: 'c1',
      clientName: 'Coastal Resort Holdings',
      uncovered: [
        { locationId: 'l1', locationName: 'Front Beach 218', label: 'Morning', startMinute: 360, endMinute: 840 },
        { locationId: 'l1', locationName: 'Front Beach 218', label: 'Swing', startMinute: 840, endMinute: 1320 },
      ],
      noShift: ['u-omar'],
      supervisors: [
        { userId: 'u-dana', name: 'Dana Reyes', email: 'dana@altohr.com', windows: [{ locationId: 'l1', locationName: 'Front Beach 218', label: 'Overnight' }] },
        { userId: 'u-omar', name: 'Omar Diaz', email: 'omar@altohr.com', windows: [] },
      ],
    },
  ],
};

function renderCard(data: ShiftCoverageGaps, props: { hideWhenClear?: boolean } = {}, role: Role = 'WORKFORCE_MANAGER') {
  vi.mocked(getShiftCoverageGaps).mockResolvedValue(data);
  vi.mocked(listClientShiftWindows).mockResolvedValue({ stores: [] });
  const caps = ROLE_CAPABILITIES[role];
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider
        value={{
          isInitializing: false,
          isOffline: false,
          user: { id: 'me', email: 'wf@altohr.com', role, status: 'ACTIVE', clientId: null, associateId: null },
          role,
          capabilities: new Set<Capability>(caps),
          signIn: vi.fn(),
          signOut: vi.fn(),
          can: (c: Capability) => caps.has(c),
        }}
      >
        <MemoryRouter>
          <ShiftLeadsCard {...props} />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

describe('<ShiftLeadsCard> — every shift has a lead', () => {
  it('names the shifts nobody leads and the supervisors with no shift', async () => {
    renderCard(gaps);
    expect(await screen.findByText('1 of 3 shifts led')).toBeInTheDocument();
    expect(screen.getByText('Coastal Resort Holdings')).toBeInTheDocument();
    expect(screen.getByText(/6:00 AM – 2:00 PM · Front Beach 218/)).toBeInTheDocument();
    expect(screen.getAllByText('No lead')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /Omar Diaz · No shift/ })).toBeInTheDocument();
  });

  it('opens the shift picker for a supervisor, one tap', async () => {
    const user = userEvent.setup();
    renderCard(gaps);
    await user.click(await screen.findByRole('button', { name: /Omar Diaz/ }));
    expect(await screen.findByRole('heading', { name: 'Omar Diaz’s shift' })).toBeInTheDocument();
    expect(listClientShiftWindows).toHaveBeenCalledWith('c1');
  });

  it('says so when every shift has a lead — or stays out of the way', async () => {
    const clear = { total: 3, covered: 3, clients: [] };
    const { unmount } = renderCard(clear);
    expect(await screen.findByText('Every named shift has a lead.')).toBeInTheDocument();
    unmount();
    const { container } = renderCard(clear, { hideWhenClear: true });
    await vi.waitFor(() => expect(getShiftCoverageGaps).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
