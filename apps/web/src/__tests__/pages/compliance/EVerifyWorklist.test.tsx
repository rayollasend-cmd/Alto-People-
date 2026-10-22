import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { EVerifyRosterRow } from '@alto-people/shared';
import { ymdLocal } from '@/lib/format';

vi.mock('@/lib/auth', async () => {
  const React = await import('react');
  const auth = { user: { id: 'u1', role: 'HR_ADMINISTRATOR', email: 'hr@altohr.com' }, can: () => true };
  return { AuthContext: React.createContext(auth), useAuth: () => auth };
});
vi.mock('@/lib/roles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/roles')>()),
  hasCapability: () => false,
}));
vi.mock('@/lib/storeScope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/storeScope')>()),
  useStoreScope: () => ({ enabled: false, clientId: null, setClientId: () => {} }),
}));
vi.mock('@/lib/complianceApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/complianceApi')>()),
  listEVerifyRoster: vi.fn(),
}));
vi.mock('@/components/DocumentViewer', () => ({ DocumentThumbnails: () => null, DocumentViewer: () => null }));
vi.mock('@/pages/compliance/providers/EVerifyProviderPanel', () => ({ EVerifyProviderPanel: () => null }));

import { listEVerifyRoster } from '@/lib/complianceApi';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { EVerifyTab } from '@/pages/compliance/EVerifyTab';

const day = (n: number) => {
  const d = new Date();
  return ymdLocal(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n));
};

function row(id: string, name: string, over: Partial<EVerifyRosterRow>): EVerifyRosterRow {
  return {
    associateId: id,
    associateName: name,
    associateEmail: `${name.split(' ')[0]!.toLowerCase()}@example.com`,
    clientId: null,
    clientName: null,
    hireDate: day(-5),
    ssnLast4: null,
    caseNumber: null,
    status: null,
    caseOpenedAt: null,
    closedAt: null,
    dueBy: day(5),
    overdue: false,
    blockers: [],
    ready: true,
    ...over,
  } as EVerifyRosterRow;
}

function LocationProbe() {
  const l = useLocation();
  return <output data-testid="loc">{l.search}</output>;
}

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <EVerifyTab canManage={false} />
          <LocationProbe />
        </TooltipProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('E-Verify worklist (HR walk 3 and 22)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(listEVerifyRoster).mockResolvedValue({
      rows: [
        row('a1', 'Ana Alvarez', { dueBy: day(-1), overdue: true }),
        row('a2', 'Maria Lopez', { status: 'TENTATIVE_NONCONFIRMATION', caseNumber: '2026123', caseOpenedAt: new Date().toISOString(), dueBy: day(-3) }),
        row('a3', 'Zed Young', { dueBy: day(0) }),
        row('a4', 'Bea Boone', { dueBy: day(3) }),
      ],
      counts: { total: 4, authorized: 0, pending: 0, nonconfirmation: 1, notRun: 3, overdue: 1, blocked: 0 },
      truncated: false,
    } as Awaited<ReturnType<typeof listEVerifyRoster>>);
  });

  it('?status=issue opens on the mismatches only, then drops the param', async () => {
    renderAt('/compliance?tab=everify&status=issue');
    expect(await screen.findByText('Maria Lopez')).toBeInTheDocument();
    expect(screen.queryByText('Ana Alvarez')).toBeNull();
    expect(screen.queryByText('Bea Boone')).toBeNull();
    expect(screen.getByTestId('loc').textContent).toBe('?tab=everify');
    // A visit's view, not a saved choice.
    expect(window.localStorage.getItem('alto:list.everify.status.v1')).not.toBe('"issue"');
  });

  it('the KPI numbers are filters, and the list leads with the deadline soonest', async () => {
    renderAt('/compliance?tab=everify');
    expect(await screen.findByText('Ana Alvarez')).toBeInTheDocument();
    const names = ['Ana Alvarez', 'Zed Young', 'Bea Boone'].map((n) => screen.getByText(n));
    // Overdue first, A–Z no longer: Zed (today) sits above Bea (in 3 days).
    expect(names[1]!.compareDocumentPosition(names[2]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(screen.getByTitle('Show overdue'));
    expect(screen.getByText('Ana Alvarez')).toBeInTheDocument();
    expect(screen.queryByText('Bea Boone')).toBeNull();
    expect(screen.getByTitle('Show overdue')).toHaveAttribute('aria-pressed', 'true');
  });

  it('the deadline strip counts each day and a day narrows the list', async () => {
    renderAt('/compliance?tab=everify');
    await screen.findByText('Ana Alvarez');
    const table = screen.getByRole('table', { name: 'Case deadlines' });
    const cells = within(table).getAllByRole('row').map((r) => r.textContent);
    // Maria's case is already open, so only three open deadlines.
    expect(cells).toContain('Overdue1');
    expect(cells).toContain('Today1');
    expect(screen.getByText('1 overdue, 1 due today, 1 due this week.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Today · 1' }));
    expect(screen.getByText('Zed Young')).toBeInTheDocument();
    expect(screen.queryByText('Ana Alvarez')).toBeNull();
    expect(screen.queryByText('Bea Boone')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Clear the day filter' }));
    expect(screen.getByText('Bea Boone')).toBeInTheDocument();
  });
});
