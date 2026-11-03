import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ComplianceWorkforce, EVerifyRosterResponse, EVerifyRosterRow } from '@alto-people/shared';
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
vi.mock('@/lib/csv', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/csv')>()),
  downloadCsv: vi.fn(),
}));
vi.mock('@/components/DocumentViewer', () => ({ DocumentThumbnails: () => null, DocumentViewer: () => null }));
vi.mock('@/pages/compliance/providers/EVerifyProviderPanel', () => ({ EVerifyProviderPanel: () => null }));

import { listEVerifyRoster } from '@/lib/complianceApi';
import { downloadCsv } from '@/lib/csv';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { EVerifyTab } from '@/pages/compliance/EVerifyTab';

/**
 * The E-Verify roster is one group at a time (owner, 2026-11-03): it opens
 * on the current workforce, the chips name the groups with their counts,
 * the tiles count the rows on view, a rehire whose case belongs to an
 * earlier job reads "not run", and a case left open by someone who left is
 * flagged whatever group is on view.
 */

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
    workStatus: 'ACTIVE',
    ...over,
  };
}

const CURRENT: EVerifyRosterRow[] = [
  row('c1', 'Mary Ann Lee', {}),
  // An Authorized case recorded with no opened date: never "Overdue" beside it.
  row('c2', 'Ava Authorized', { status: 'EMPLOYMENT_AUTHORIZED', caseNumber: '2026-1', overdue: true }),
  row('c3', 'Rae Rehire', { needsNewCase: true, previousCase: { caseNumber: '2025-OLD', status: 'EMPLOYMENT_AUTHORIZED', caseOpenedAt: null, closedAt: null }, overdue: true, dueBy: day(-2) }),
];
const FORMER: EVerifyRosterRow[] = [
  row('f1', 'Gil Gone', { status: 'PENDING', caseNumber: '2026-9', caseOpenedAt: new Date().toISOString(), caseOpen: true, workStatus: 'SEPARATED', leftOn: day(-30) }),
  row('f2', 'Fay Former', { status: 'EMPLOYMENT_AUTHORIZED', caseNumber: '2026-8', caseOpenedAt: new Date().toISOString(), closedAt: new Date().toISOString(), workStatus: 'SEPARATED', closureReason: 'EMPLOYEE_NO_LONGER_EMPLOYED' }),
];
const COUNTS = { current: 3, starting: 0, paused: 0, former: 2, all: 5 };
const EMPTY = { total: 0, authorized: 0, pending: 0, nonconfirmation: 0, notRun: 0, overdue: 0, blocked: 0 };

function respond(w: ComplianceWorkforce): EVerifyRosterResponse {
  const rows = w === 'former' ? FORMER : w === 'all' ? [...CURRENT, ...FORMER] : CURRENT;
  return { rows, counts: EMPTY, truncated: false, workforce: w, workforceCounts: COUNTS, formerOpenCases: 1 };
}

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <EVerifyTab canManage={false} />
        </TooltipProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('E-Verify — who the list is about', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(downloadCsv).mockReset();
    vi.mocked(listEVerifyRoster).mockImplementation(async (opts = {}) => respond(opts.workforce ?? 'current'));
  });

  it('opens on the current workforce, the chips count each group, and the tiles count the rows on view', async () => {
    renderAt('/compliance?tab=everify');
    expect(await screen.findByText('Mary Ann Lee')).toBeInTheDocument();
    expect(listEVerifyRoster).toHaveBeenCalledWith({ workforce: 'current' });
    const groups = screen.getByRole('group', { name: 'Who to show' });
    expect(within(groups).getByRole('button', { name: /^Current/ })).toHaveAttribute('aria-pressed', 'true');
    expect(within(groups).getByRole('button', { name: /^Former/ })).toHaveTextContent('2');
    expect(screen.getByText('Current workforce').nextElementSibling).toHaveTextContent('3');
    // Not run: Mary and the rehire, whose case was for an earlier job.
    expect(screen.getByTitle('Show not yet run')).toHaveTextContent('2');
    expect(screen.queryByText('Gil Gone')).toBeNull();
  });

  it('a rehire reads "not run" and says why; Overdue never sits beside a case on file', async () => {
    renderAt('/compliance?tab=everify');
    await screen.findByText('Rae Rehire');
    expect(screen.getByText('Rehired — new case needed')).toBeInTheDocument();
    const ava = screen.getByText('Ava Authorized').closest('button')!;
    expect(within(ava).getByText('Authorized')).toBeInTheDocument();
    expect(within(ava).queryByText('Overdue')).toBeNull();
    const rae = screen.getByText('Rae Rehire').closest('button')!;
    expect(within(rae).getByText('Overdue')).toBeInTheDocument();
  });

  it('a rehire who reused the earlier I-9 reads "no new case needed", not "not run"', async () => {
    vi.mocked(listEVerifyRoster).mockResolvedValue({
      rows: [row('r1', 'Reba Reused', { status: 'EMPLOYMENT_AUTHORIZED', caseNumber: '2024-1', earlierI9Reused: true })],
      counts: EMPTY,
      truncated: false,
      workforce: 'current',
      workforceCounts: COUNTS,
      formerOpenCases: 0,
    });
    renderAt('/compliance?tab=everify');
    expect(await screen.findByText('Rehire — earlier I-9 reused (no new case needed)')).toBeInTheDocument();
    expect(screen.queryByText('Rehired — new case needed')).toBeNull();
    expect(screen.getByTitle('Show not yet run')).toHaveTextContent('0');
  });

  it('a case left open by someone who left is flagged on any view, and "Show them" opens exactly those', async () => {
    renderAt('/compliance?tab=everify');
    expect(await screen.findByText(/1 person who left still has an open E-Verify case/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show them' }));
    expect(await screen.findByText('Gil Gone')).toBeInTheDocument();
    expect(listEVerifyRoster).toHaveBeenCalledWith({ workforce: 'former' });
    expect(screen.queryByText('Fay Former')).toBeNull();
    expect(screen.getByText('Case still open')).toBeInTheDocument();
    expect(screen.getByTitle(/People who left whose E-Verify case is still open/)).toHaveAttribute('aria-pressed', 'true');
  });

  it('a link to one person opens on everyone; ?workforce= picks the group for the visit', async () => {
    renderAt('/compliance?tab=everify&associateId=f1');
    await screen.findByText('Gil Gone');
    expect(listEVerifyRoster).toHaveBeenCalledWith({ workforce: 'all' });

    vi.mocked(listEVerifyRoster).mockClear();
    renderAt('/compliance?tab=everify&workforce=former&status=all');
    await waitFor(() => expect(listEVerifyRoster).toHaveBeenCalledWith({ workforce: 'former' }));
  });

  it('the CSV keeps the name whole, says each person’s employment, and names the group in the file', async () => {
    renderAt('/compliance?tab=everify');
    await screen.findByText('Mary Ann Lee');
    fireEvent.click(screen.getByRole('button', { name: /Download CSV/ }));
    const [filename, table] = vi.mocked(downloadCsv).mock.calls[0]!;
    expect(filename).toMatch(/^everify-current-\d{4}-\d{2}-\d{2}\.csv$/);
    const [head, ...body] = table as string[][];
    expect(head!.slice(0, 3)).toEqual(['Name', 'Email', 'Employment']);
    const mary = body.find((r) => r[0] === 'Mary Ann Lee')!;
    expect(mary[2]).toBe('Working');
  });
});
