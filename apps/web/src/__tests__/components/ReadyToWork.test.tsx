import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { HandoffStatus, ReadyToScheduleItem } from '@/lib/readyToWorkApi';

vi.mock('@/lib/readyToWorkApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/readyToWorkApi')>()),
  getMyReadyToWork: vi.fn(),
  listReadyToSchedule: vi.fn(),
  getReadyToWorkStatus: vi.fn(),
}));

import { getMyReadyToWork, getReadyToWorkStatus, listReadyToSchedule } from '@/lib/readyToWorkApi';
import { I18nProvider } from '@/lib/i18n';
import { ReadyToWorkCard } from '@/components/ReadyToWorkCard';
import { ReadyToScheduleCard } from '@/components/ReadyToScheduleCard';
import { ReadyToWorkLine } from '@/components/ReadyToWorkLine';

const status: HandoffStatus = {
  associate: { id: 'a1', name: 'Maria Lopez', email: 'maria@example.com', phone: '850-555-0101', position: 'Server', hireDate: '2026-09-20' },
  client: { id: 'c1', name: 'Acme Resort' },
  store: { id: 'l1', name: 'Northgate', addressLine1: '1 Harbor Blvd', addressLine2: null, city: 'Destin', state: 'FL', zip: '32541', timezone: 'America/Chicago' },
  supervisors: [
    { userId: 'u1', name: 'Dana Lead', email: 'dana@example.com', phone: '850-555-0202', windows: ['Day'] },
    { userId: 'u2', name: 'Sam Night', email: 'sam@example.com', phone: null, windows: ['Overnight'] },
  ],
  fallbackToClient: false,
  issuedAt: '2026-09-25T14:00:00.000Z',
  supervisorsNotifiedAt: '2026-09-25T14:00:00.000Z',
  nudgedAt: null,
  firstShiftAt: null,
  firstPunchAt: null,
  closed: false,
};

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <I18nProvider>{ui}</I18nProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('ReadyToWorkCard — the associate’s first-day kit', () => {
  it('names the store, lists the supervisors with a way to reach them, and says what happens next', async () => {
    vi.mocked(getMyReadyToWork).mockResolvedValue(status);
    wrap(<ReadyToWorkCard />);
    expect(await screen.findByText('Northgate')).toBeInTheDocument();
    expect(screen.getByText(/1 Harbor Blvd/)).toBeInTheDocument();
    expect(screen.getByText('Dana Lead')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /850-555-0202/ })).toHaveAttribute('href', 'tel:850-555-0202');
    expect(screen.getByRole('link', { name: /sam@example.com/ })).toHaveAttribute('href', 'mailto:sam@example.com');
    expect(screen.getByText(/What happens next/)).toBeInTheDocument();
  });

  it('renders nothing before the number is issued', async () => {
    vi.mocked(getMyReadyToWork).mockResolvedValue(null);
    wrap(<ReadyToWorkCard />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('ready-to-work-card')).not.toBeInTheDocument();
  });
});

describe('ReadyToScheduleCard — the supervisor’s queue', () => {
  it('lists each hire with their card and a Scheduling link on their row', async () => {
    const items: ReadyToScheduleItem[] = [
      { associate: status.associate, store: { id: 'l1', name: 'Northgate' }, issuedAt: status.issuedAt, nudgedAt: null, fallbackToClient: false },
    ];
    vi.mocked(listReadyToSchedule).mockResolvedValue(items);
    wrap(<ReadyToScheduleCard />);
    expect(await screen.findByText('Maria Lopez')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Schedule/ })).toHaveAttribute('href', '/scheduling?associate=a1');
    expect(screen.getByRole('link', { name: /850-555-0101/ })).toHaveAttribute('href', 'tel:850-555-0101');
  });

  it('renders nothing when the queue is empty', async () => {
    vi.mocked(listReadyToSchedule).mockResolvedValue([]);
    wrap(<ReadyToScheduleCard />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('ready-to-schedule-card')).not.toBeInTheDocument();
  });
});

describe('ReadyToWorkLine — HR’s closure line', () => {
  it('says who was told and that no first shift exists yet', async () => {
    vi.mocked(getReadyToWorkStatus).mockResolvedValue(status);
    wrap(<ReadyToWorkLine associateId="a1" />);
    expect(await screen.findByText(/Dana Lead, Sam Night/)).toBeInTheDocument();
    expect(screen.getByText(/No first shift yet/)).toBeInTheDocument();
  });

  it('shows the first shift once it exists', async () => {
    vi.mocked(getReadyToWorkStatus).mockResolvedValue({ ...status, firstShiftAt: '2026-09-30T13:00:00.000Z', closed: true });
    wrap(<ReadyToWorkLine associateId="a1" />);
    expect(await screen.findByText(/First shift/)).toBeInTheDocument();
  });

  it('says the number is not issued yet when there is no handoff', async () => {
    vi.mocked(getReadyToWorkStatus).mockResolvedValue(null);
    wrap(<ReadyToWorkLine associateId="a1" />);
    expect(await screen.findByText(/not issued yet/)).toBeInTheDocument();
  });
});
