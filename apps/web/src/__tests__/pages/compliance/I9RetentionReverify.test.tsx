import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { I9Verification } from '@alto-people/shared';
import { ymdLocal } from '@/lib/format';

vi.mock('@/lib/complianceApi', () => ({ listI9s: vi.fn(), upsertI9: vi.fn() }));
vi.mock('@/lib/i9Api', () => ({ listI9Documents: vi.fn(), submitI9Section2: vi.fn() }));
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), apiFetch: vi.fn() }));

import { listI9s } from '@/lib/complianceApi';
import { apiFetch } from '@/lib/api';
import { I9Tab } from '@/pages/compliance/I9Tab';

const day = (n: number) => {
  const d = new Date();
  return ymdLocal(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n));
};

function row(id: string, name: string, over: Partial<I9Verification> = {}): I9Verification {
  return {
    id,
    associateId: `${id}-a`,
    associateName: name,
    associateEmail: `${name.split(' ')[0]!.toLowerCase()}@example.com`,
    applicationId: null,
    section1CompletedAt: '2026-01-02T12:00:00.000Z',
    section2CompletedAt: '2026-01-05T12:00:00.000Z',
    section2VerifierUserId: null,
    section2VerifierEmail: null,
    documentList: 'LIST_A',
    supportingDocIds: [],
    startDate: '2026-01-02',
    workAuthExpiresAt: null,
    retainUntil: '2029-01-02',
    reverifyDueAt: null,
    ...over,
  };
}

function LocationProbe() {
  return <output data-testid="loc">{useLocation().search}</output>;
}

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <I9Tab canManage />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('I-9 retention and reverification (audit #14)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(listI9s).mockResolvedValue({
      i9s: [
        row('i1', 'Ana Active'),
        row('i2', 'Rita Reverify', { workAuthExpiresAt: day(20), reverifyDueAt: day(20) }),
        row('i3', 'Sam Section', { section2CompletedAt: null, startDate: day(0) }),
      ],
    });
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      if (path === '/compliance/i9?status=retention') {
        return { i9s: [row('i9', 'Gone Grant', { retainUntil: day(-30) })] } as never;
      }
      throw new Error(`unmocked ${path}`);
    });
  });

  it('a person past retention shows under Past retention and nowhere else', async () => {
    renderAt('/compliance?tab=i9');
    fireEvent.click(await screen.findByRole('button', { name: 'All' }));
    expect(await screen.findByText('Ana Active')).toBeInTheDocument();
    expect(screen.queryByText('Gone Grant')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Past retention' }));
    expect(await screen.findByText('Gone Grant')).toBeInTheDocument();
    expect(screen.getByText('Retain until')).toBeInTheDocument();
    expect(screen.queryByText('Ana Active')).toBeNull();
    expect(screen.queryByText('Rita Reverify')).toBeNull();
  });

  it('?status=work_auth opens on reverification due, once, and shows the date', async () => {
    renderAt('/compliance?tab=i9&status=work_auth');
    expect(await screen.findByText('Rita Reverify')).toBeInTheDocument();
    expect(screen.queryByText('Ana Active')).toBeNull();
    expect(screen.getByText('Reverify by')).toBeInTheDocument();
    expect(screen.getByTestId('loc').textContent).toBe('?tab=i9');
  });

  it('the deadline strip counts Section 2 and reverification clocks', async () => {
    renderAt('/compliance?tab=i9');
    await screen.findByText('Sam Section');
    // Sam's Section 2 is due in 3 business days; Rita's reverification in 20 (past the strip).
    expect(screen.getByRole('table', { name: 'I-9 deadlines' })).toBeInTheDocument();
  });
});
