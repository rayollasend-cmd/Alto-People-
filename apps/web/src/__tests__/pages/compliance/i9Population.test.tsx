import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { I9Verification } from '@alto-people/shared';

/**
 * The I-9 tab and the scorecard count one population (F500, G4 compliance
 * P1): the scorecard read "I-9 Section 1 + Section 2: 0/10" over the ten
 * placed people while the tab read "Associates 1 · Complete 1" over the one
 * I-9 record on file — a person still onboarding. The tab now lists the
 * placed people with no I-9 at all and its "I-9 complete" is the
 * scorecard's number: 0 / 10.
 */

vi.mock('@/lib/complianceApi', () => ({ listI9s: vi.fn(), upsertI9: vi.fn() }));
vi.mock('@/lib/i9Api', () => ({ listI9Documents: vi.fn(), submitI9Section2: vi.fn() }));
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(async () => ({ i9s: [] })),
}));

import { listI9s } from '@/lib/complianceApi';
import { I9Tab, notStartedRow } from '@/pages/compliance/I9Tab';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PLACED = ['Aaliyah Brooks', 'Dana Reyes', 'Gerodney Lee', 'Jay Patel', 'Kim Nguyen', 'Leo Ramos', 'Marcus Hill', 'Nia Carter', 'Rosa Vega', 'Tomas Ortiz'];

const maria: I9Verification = {
  id: uuid(900),
  associateId: uuid(901),
  associateName: 'Maria Lopez',
  associateEmail: 'maria@example.com',
  applicationId: uuid(902),
  section1CompletedAt: '2026-10-01T15:00:00.000Z',
  section2CompletedAt: '2026-10-02T15:00:00.000Z',
  section2VerifierUserId: null,
  section2VerifierEmail: null,
  documentList: 'LIST_A',
  supportingDocIds: [],
  placed: false,
};

function renderTab() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <I9Tab canManage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(listI9s).mockResolvedValue({
    i9s: [maria],
    notStarted: PLACED.map((name, i) => ({
      associateId: uuid(i),
      associateName: name,
      associateEmail: `${name.split(' ')[0]!.toLowerCase()}@example.com`,
      clientId: uuid(500),
      clientName: 'Coastal Resort Holdings',
      hireDate: '2026-09-01',
    })),
  });
});

describe('<I9Tab> reads the scorecard’s population', () => {
  it('"I-9 complete" is 0 of the 10 placed, and the placed people with no I-9 are listed', async () => {
    renderTab();
    const complete = await screen.findByText('I-9 complete');
    expect(complete.parentElement).toHaveTextContent('0/ 10');
    const none = screen.getByTitle('Show no i-9 on file');
    expect(none).toHaveTextContent('10');
    // The default (pending) view lists them, each marked.
    expect(await screen.findByText('Aaliyah Brooks')).toBeInTheDocument();
    expect(screen.getAllByText('No I-9 on file').length).toBeGreaterThanOrEqual(10);
    // The onboarding person's finished I-9 is not a placed complete.
    expect(screen.queryByText('Maria Lopez')).not.toBeInTheDocument();
  });

  it('the "No I-9 on file" tile is the filter for exactly those people', async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(await screen.findByTitle('Show no i-9 on file'));
    for (const name of PLACED) expect(screen.getByText(name)).toBeInTheDocument();
    expect(screen.queryByText('Maria Lopez')).not.toBeInTheDocument();
  });

  it('marks a record for someone still onboarding', async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('Aaliyah Brooks');
    await user.click(screen.getByRole('button', { name: 'All' }));
    const row = (await screen.findByText('Maria Lopez')).closest('tr')!;
    expect(within(row).getByText('Onboarding')).toBeInTheDocument();
  });

  it('"Section 2 pending" counts exactly the Pending view, people with no I-9 included', async () => {
    renderTab();
    const tile = await screen.findByTitle('Show section 2 pending');
    // The ten placed people with no I-9 (Maria's is complete).
    expect(tile).toHaveTextContent('10');
    expect(tile).toHaveAttribute('aria-pressed', 'true');
    await screen.findByText('Aaliyah Brooks');
    const table = screen.getByRole('table', { name: 'I-9 records' });
    // One header row plus one row per pending person.
    expect(within(table).getAllByRole('row').length - 1).toBe(10);
    expect(screen.getByTitle('Show no i-9 on file')).toHaveTextContent('10');
  });

  it('says how late Section 2 is in words, not "overdue 55d"', async () => {
    renderTab();
    await screen.findByText('Aaliyah Brooks');
    expect(screen.getAllByText(/^\d[\d,]* days overdue$/).length).toBe(10);
    expect(screen.queryByText(/overdue \d+d/)).not.toBeInTheDocument();
  });

  it('a not-started row opens like any other: nothing done, Section 2 due from the hire date', () => {
    const row = notStartedRow({ associateId: uuid(1), associateName: 'Dana Reyes', associateEmail: null, clientId: null, clientName: null, hireDate: '2026-09-01' });
    expect(row).toMatchObject({ id: uuid(1), associateId: uuid(1), section1CompletedAt: null, section2CompletedAt: null, startDate: '2026-09-01', placed: true, associateEmail: '' });
  });
});
