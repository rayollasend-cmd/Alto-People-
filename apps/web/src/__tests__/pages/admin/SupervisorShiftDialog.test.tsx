import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/lib/shiftWindowsApi', () => ({
  listClientShiftWindows: vi.fn(),
  setSupervisorShiftWindows: vi.fn(),
}));

import { listClientShiftWindows, setSupervisorShiftWindows } from '@/lib/shiftWindowsApi';
import { SupervisorShiftDialog } from '@/pages/admin/SupervisorShiftDialog';
import type { AdminUser } from '@/lib/usersAdminApi';

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
};

function renderDialog(stores: unknown[], onSaved = vi.fn(), readOnly = false) {
  vi.mocked(listClientShiftWindows).mockResolvedValue({ stores } as never);
  vi.mocked(setSupervisorShiftWindows).mockResolvedValue({ windows: [] });
  render(
    <MemoryRouter>
      <SupervisorShiftDialog user={dana} open onOpenChange={vi.fn()} onSaved={onSaved} readOnly={readOnly} />
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
