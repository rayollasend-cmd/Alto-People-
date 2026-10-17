import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ProgramAlert } from '@alto-people/shared';

vi.mock('@/lib/programsApi', () => ({ listMyProgramAlerts: vi.fn() }));

import { listMyProgramAlerts } from '@/lib/programsApi';
import { ProgramAlertsCard } from '@/components/ProgramAlertsCard';

const alert = (over: Partial<ProgramAlert>): ProgramAlert => ({
  kind: 'PROGRAM_END',
  label: 'Program ends',
  dueOn: '2026-11-12',
  daysUntil: 30,
  lead: 30,
  severity: 'warn',
  programId: 'p1',
  associateId: 'a1',
  associateName: 'Maria Lopez',
  siteName: 'Destin',
  clientId: 'c1',
  programType: 'J1_SWT',
  ...over,
});

function renderCard() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <ProgramAlertsCard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.mocked(listMyProgramAlerts).mockReset());

describe('ProgramAlertsCard', () => {
  it('renders nothing when nothing is due', async () => {
    vi.mocked(listMyProgramAlerts).mockResolvedValue({ alerts: [], settings: { programEndDays: [], visaExpiryDays: [], i9ReverifyDays: [], sponsorCheckInDays: [], petitionEndDays: [] } });
    const { container } = renderCard();
    await waitFor(() => expect(listMyProgramAlerts).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('lists who, what, and when, marking the urgent ones', async () => {
    vi.mocked(listMyProgramAlerts).mockResolvedValue({
      alerts: [
        alert({}),
        alert({ kind: 'SPONSOR_CHECKIN', label: 'Sponsor check-in due', dueOn: '2026-10-13', daysUntil: 0, severity: 'critical', associateName: 'Emre Kaya', programId: 'p2' }),
      ],
      settings: { programEndDays: [30], visaExpiryDays: [], i9ReverifyDays: [], sponsorCheckInDays: [0], petitionEndDays: [] },
    });
    renderCard();
    expect(await screen.findByText('Maria Lopez')).toBeInTheDocument();
    expect(screen.getByText(/Program ends/)).toBeInTheDocument();
    expect(screen.getByText('Emre Kaya')).toBeInTheDocument();
    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.getByText('In 30d')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open programs/i })).toHaveAttribute('href', '/programs');
  });
});
