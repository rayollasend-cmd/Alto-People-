import { describe, expect, it, vi } from 'vitest';
import { render as rtlRender, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/lib/shiftWindowsApi', () => ({
  listClientShiftWindows: vi.fn(),
  setSupervisorShiftWindows: vi.fn(),
  setFloorSupervisorLead: vi.fn(),
  getLeadFloorTeam: vi.fn(),
}));

import {
  getLeadFloorTeam,
  listClientShiftWindows,
  setFloorSupervisorLead,
  setSupervisorShiftWindows,
} from '@/lib/shiftWindowsApi';
import { SupervisorShiftDialog } from '@/pages/admin/SupervisorShiftDialog';
import type { AdminUser } from '@/lib/usersAdminApi';

// The dialog reads through the query layer; every render gets a client.
function withQueryClient({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      {children}
    </QueryClientProvider>
  );
}
const render = (ui: Parameters<typeof rtlRender>[0], options?: Parameters<typeof rtlRender>[1]) =>
  rtlRender(ui, { wrapper: withQueryClient, ...options });

const dana: AdminUser = {
  id: 'u-dana',
  email: 'dana@altohr.com',
  role: 'SHIFT_SUPERVISOR',
  status: 'ACTIVE',
  createdAt: '2026-01-01T00:00:00.000Z',
  associateId: 'a-dana',
  associateName: 'Dana Reyes',
  clientId: 'c1',
  clientName: 'Coastal',
  locationId: null,
  locationName: null,
  regionId: null,
  regionName: null,
  lockedUntil: null,
  shiftWindows: [{ locationId: 'l1', locationName: 'Front Beach 218', label: 'Overnight' }],
  leadUserId: null,
  leadName: null,
};

const marcus: AdminUser = {
  ...dana,
  id: 'u-marcus',
  email: 'marcus@altohr.com',
  role: 'FLOOR_SUPERVISOR',
  associateId: 'a-marcus',
  associateName: 'Marcus Hill',
  shiftWindows: [],
};

const supervisors = [
  { userId: 'u-dana', name: 'Dana Reyes', windows: [{ locationId: 'l1', label: 'Overnight' }] },
  { userId: 'u-omar', name: 'Omar Diaz', windows: [{ locationId: 'l1', label: 'Morning' }] },
];

function renderDialog(stores: unknown[], onSaved = vi.fn(), readOnly = false, who: AdminUser = dana) {
  vi.mocked(listClientShiftWindows).mockResolvedValue({ stores, supervisors } as never);
  vi.mocked(setSupervisorShiftWindows).mockResolvedValue({ windows: [] });
  vi.mocked(setFloorSupervisorLead).mockResolvedValue({ leadUserId: null });
  vi.mocked(getLeadFloorTeam).mockResolvedValue({ role: 'lead', today: '2026-09-18', team: [], covers: [] });
  render(
    <MemoryRouter>
      <SupervisorShiftDialog user={who} open onOpenChange={vi.fn()} onSaved={onSaved} readOnly={readOnly} />
    </MemoryRouter>,
  );
  return { onSaved };
}

const frontBeach = {
  locationId: 'l1',
  locationName: 'Front Beach 218',
  timezone: 'America/New_York',
  windows: [
    { label: 'Morning', startMinute: 360, endMinute: 840, targetCount: 8, leads: [{ userId: 'u-omar', name: 'Omar Diaz' }] },
    { label: 'Swing', startMinute: 840, endMinute: 1320, targetCount: 8, leads: [] },
    { label: 'Overnight', startMinute: 1320, endMinute: 360, targetCount: 4, leads: [{ userId: 'u-dana', name: 'Dana Reyes' }] },
  ],
};

describe('<SupervisorShiftDialog> — a supervisor is assigned their shift', () => {
  it("lists the client's shifts with hours, who else leads each, and the gaps", async () => {
    renderDialog([frontBeach]);
    expect(await screen.findByRole('checkbox', { name: /Overnight/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Morning/ })).not.toBeChecked();
    expect(screen.getByText('10:00 PM – 6:00 AM')).toBeInTheDocument();
    expect(screen.getByText(/Also led by Omar Diaz/)).toBeInTheDocument();
    expect(screen.getByText(/Nobody leads this shift yet/)).toBeInTheDocument();
    expect(screen.getByText(/Dana Reyes leads it/)).toBeInTheDocument();
  });

  it('saves several shifts, and never none', async () => {
    const user = userEvent.setup();
    const { onSaved } = renderDialog([frontBeach]);
    await user.click(await screen.findByRole('checkbox', { name: /Swing/ }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(setSupervisorShiftWindows).toHaveBeenCalledWith('u-dana', [
      { locationId: 'l1', label: 'Overnight' },
      { locationId: 'l1', label: 'Swing' },
    ]);
    expect(onSaved).toHaveBeenCalled();
  });

  it('refuses to save with no shift picked', async () => {
    const user = userEvent.setup();
    renderDialog([frontBeach]);
    await user.click(await screen.findByRole('checkbox', { name: /Overnight/ }));
    expect(screen.getByText('Pick at least one shift.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('points to where shifts are named when the client has none yet', async () => {
    renderDialog([{ ...frontBeach, windows: [] }]);
    expect(await screen.findByText(/hasn’t named its shifts yet/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Labor costs' })).toHaveAttribute('href', '/labor-costs');
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('shows a read-only viewer the assignment without letting them change it', async () => {
    renderDialog([frontBeach], vi.fn(), true);
    expect(await screen.findByRole('checkbox', { name: /Overnight/ })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Close' }).length).toBeGreaterThan(0);
  });
});

describe('<SupervisorShiftDialog> — a floor supervisor gets their shift and their shift supervisor', () => {
  it('suggests whoever leads the shift they work, and saves both', async () => {
    const user = userEvent.setup();
    const { onSaved } = renderDialog([frontBeach], vi.fn(), false, marcus);
    expect(await screen.findByRole('heading', { name: 'Marcus Hill’s shift and shift supervisor' })).toBeInTheDocument();
    // No shift yet: nobody suggested, nothing to save.
    // The list arrives through the query cache a tick after the heading.
    expect(await screen.findByRole('button', { name: 'Save' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: /Overnight/ }));
    const danaRow = screen.getByRole('radio', { name: /Dana Reyes/ });
    expect(danaRow).toBeChecked();
    expect(screen.getByText('Suggested')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(setSupervisorShiftWindows).toHaveBeenCalledWith('u-marcus', [{ locationId: 'l1', label: 'Overnight' }]);
    expect(setFloorSupervisorLead).toHaveBeenCalledWith('u-marcus', 'u-dana');
    expect(onSaved).toHaveBeenCalled();
  });

  it('allows any shift supervisor at the client — and says when they lead a different shift', async () => {
    const user = userEvent.setup();
    renderDialog([frontBeach], vi.fn(), false, marcus);
    await user.click(await screen.findByRole('checkbox', { name: /Overnight/ }));
    await user.click(screen.getByRole('radio', { name: /Omar Diaz/ }));
    expect(screen.getByText(/Omar Diaz doesn’t lead Marcus’s shift/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(setFloorSupervisorLead).toHaveBeenCalledWith('u-marcus', 'u-omar');
  });
});
