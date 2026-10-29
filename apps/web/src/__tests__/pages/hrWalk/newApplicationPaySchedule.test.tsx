import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAs } from '../hrPack/harness';

/**
 * Role walk HR 23: the new-application dialog says which pay schedule
 * will pay the hire as soon as the client (and store) are chosen — the
 * same rules approval uses, read before the hire exists — so "no schedule
 * covers this hire" is found here, not on payday.
 */

vi.mock('@/lib/onboardingApi', () => ({
  createApplication: vi.fn(),
  listClients: vi.fn().mockResolvedValue({
    clients: [{ id: 'c1', name: 'Coastal Resort', industry: 'hospitality', status: 'ACTIVE', state: 'FL' }],
  }),
  listClientOptions: vi.fn().mockResolvedValue({
    clients: [{ id: 'c1', name: 'Coastal Resort', industry: 'hospitality', status: 'ACTIVE', state: 'FL' }],
  }),
  listTemplates: vi.fn().mockResolvedValue({ templates: [] }),
  payScheduleForHire: vi.fn(),
}));
vi.mock('@/lib/clientsApi', () => ({
  listClientLocations: vi.fn().mockResolvedValue({ locations: [{ id: 's1', name: 'Front Beach 218', state: 'FL' }] }),
}));
vi.mock('@/lib/orgApi', () => ({
  listShiftPositions: vi.fn().mockResolvedValue({ shiftPositions: [] }),
  listSites: vi.fn().mockResolvedValue({ sites: [] }),
}));

import { payScheduleForHire } from '@/lib/onboardingApi';
import { NewApplicationDialog } from '@/pages/onboarding/NewApplicationDialog';

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(payScheduleForHire).mockReset();
});

describe('<NewApplicationDialog> — the pay schedule for the hire (HR 23)', () => {
  it('names the schedule the rules choose, and why', async () => {
    vi.mocked(payScheduleForHire).mockResolvedValue({
      schedule: { id: 'ps1', name: 'Biweekly · Sat–Fri', because: 'Client: Coastal Resort' },
      conflict: null,
    });
    renderAs('HR_ADMINISTRATOR', <NewApplicationDialog open onOpenChange={vi.fn()} onCreated={vi.fn()} />);
    await screen.findByRole('option', { name: /Coastal Resort/ });
    await userEvent.selectOptions(screen.getByLabelText(/^client/i), 'c1');
    expect(await screen.findByText('Biweekly · Sat–Fri')).toBeInTheDocument();
    expect(screen.getByText(/Client: Coastal Resort/)).toBeInTheDocument();
    await waitFor(() => expect(payScheduleForHire).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'c1' })));
  });

  it('says plainly when no schedule covers the hire', async () => {
    vi.mocked(payScheduleForHire).mockResolvedValue({ schedule: null, conflict: null });
    renderAs('HR_ADMINISTRATOR', <NewApplicationDialog open onOpenChange={vi.fn()} onCreated={vi.fn()} />);
    await screen.findByRole('option', { name: /Coastal Resort/ });
    await userEvent.selectOptions(screen.getByLabelText(/^client/i), 'c1');
    expect(await screen.findByText(/No pay schedule covers this hire — you choose one at approval/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Pay schedules' })).toHaveAttribute('href', '/payroll/schedules');
  });

  it('a role that only invites never asks (the lookup is HR’s)', async () => {
    renderAs('SHIFT_SUPERVISOR', <NewApplicationDialog open onOpenChange={vi.fn()} onCreated={vi.fn()} />);
    await screen.findByLabelText(/first name/i);
    expect(payScheduleForHire).not.toHaveBeenCalled();
  });
});
