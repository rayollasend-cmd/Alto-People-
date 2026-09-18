import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/schedulingApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/schedulingApi')>()),
  listUnconfirmedShifts: vi.fn(),
  nudgeUnconfirmedShifts: vi.fn(),
}));

import { listUnconfirmedShifts } from '@/lib/schedulingApi';
import { AdminUnconfirmedPanel } from '@/pages/scheduling/AdminApprovalPanels';

const tonight = new Date(Date.now() + 2 * 3_600_000);
tonight.setMinutes(0, 0, 0);
const later = new Date(tonight.getTime() + 8 * 3_600_000);
const row = (id: string, name: string, position: string, startsAt: Date, phone: string | null = null) => ({
  shiftId: id,
  position,
  clientName: 'Coastal Resort Holdings',
  startsAt: startsAt.toISOString(),
  associateId: `a-${id}`,
  associateName: name,
  phone,
});

function renderPanel() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <AdminUnconfirmedPanel />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('<AdminUnconfirmedPanel> — the chase list as faces', () => {
  it('groups the crew by start time instead of repeating "Unconfirmed" per person', async () => {
    vi.mocked(listUnconfirmedShifts).mockResolvedValue({
      shifts: [
        row('s1', 'Nia Okafor', 'Shift Lead', tonight, '850-555-0101'),
        row('s2', 'Victor Diaz', 'Overnight Porter', tonight),
        row('s3', 'Imani Young', 'Front Desk', later),
      ],
    });
    const user = userEvent.setup();
    renderPanel();

    expect(await screen.findByText('Not confirmed yet')).toBeInTheDocument();
    expect(screen.getByText(/2 to confirm/)).toBeInTheDocument();
    expect(screen.getByText(/1 to confirm/)).toBeInTheDocument();
    expect(screen.queryByText(/^Unconfirmed$/i)).not.toBeInTheDocument();
    // One client across every row — it isn't repeated.
    expect(screen.queryByText(/Coastal Resort Holdings/)).not.toBeInTheDocument();

    // A face is a button named for the person; tapping it reveals the number.
    await user.click(screen.getByRole('button', { name: /Nia Okafor · Shift Lead/ }));
    const live = screen.getByText('Nia Okafor').closest('[aria-live]') as HTMLElement;
    expect(within(live).getByRole('link', { name: /Call 850-555-0101/ })).toHaveAttribute(
      'href',
      'tel:850-555-0101',
    );
  });

  it('stays out of the way when everyone confirmed', async () => {
    vi.mocked(listUnconfirmedShifts).mockResolvedValue({ shifts: [] });
    const { container } = renderPanel();
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });
});
