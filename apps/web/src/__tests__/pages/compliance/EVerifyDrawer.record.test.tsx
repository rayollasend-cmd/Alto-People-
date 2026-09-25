import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { EVerifyCaseDetail, EVerifyRosterRow } from '@alto-people/shared';

// DataGrid reads AuthContext directly (per-user column preferences), so the
// mock exports the context as well as the hook.
vi.mock('@/lib/auth', async () => {
  const React = await import('react');
  const auth = { user: { id: 'u1', role: 'HR_ADMINISTRATOR', email: 'hr@altohr.com' }, can: () => true };
  return { AuthContext: React.createContext(auth), useAuth: () => auth };
});
vi.mock('@/lib/roles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/roles')>()),
  hasCapability: () => true,
}));
vi.mock('@/lib/storeScope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/storeScope')>()),
  useStoreScope: () => ({ enabled: false, clientId: null, setClientId: () => {} }),
}));
vi.mock('@/lib/complianceApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/complianceApi')>()),
  listEVerifyRoster: vi.fn(),
  getEVerifyCase: vi.fn(),
}));
vi.mock('@/components/DocumentViewer', () => ({
  DocumentThumbnails: () => null,
  DocumentViewer: () => null,
}));

import { getEVerifyCase, listEVerifyRoster } from '@/lib/complianceApi';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { EVerifyTab } from '@/pages/compliance/EVerifyTab';

const ALICE = '00000000-0000-4000-8000-00000000aaa1';
const BOB = '00000000-0000-4000-8000-00000000bbb2';

function rosterRow(associateId: string, associateName: string, associateEmail: string): EVerifyRosterRow {
  return {
    associateId,
    associateName,
    associateEmail,
    clientId: null,
    clientName: null,
    hireDate: '2026-09-01',
    caseNumber: null,
    status: null,
    caseOpenedAt: null,
    closedAt: null,
    dueBy: '2026-09-04',
    overdue: false,
    blockers: [],
  };
}

function caseDetail(associateId: string, firstName: string, lastName: string): EVerifyCaseDetail {
  return {
    associateId,
    lastName,
    firstName,
    middleInitial: null,
    otherLastNames: [],
    dob: null,
    ssn: null,
    email: `${firstName.toLowerCase()}@example.com`,
    citizenshipStatus: null,
    alienRegistrationNumber: null,
    workAuthExpiresAt: null,
    documentList: null,
    documents: [],
    packets: [],
    otherDocuments: [],
    hireDate: '2026-09-01',
    firstClockInAt: null,
    dueBy: '2026-09-04',
    overdue: false,
    caseNumber: null,
    status: null,
    caseOpenedAt: null,
    closedAt: null,
    blockers: [],
  } as unknown as EVerifyCaseDetail;
}

/**
 * The case drawer's query was keyed ['CaseDrawer', 'detail'] with no person
 * in it, so opening a second person's case within the stale window showed
 * the first person's identity under the second person's name — on the
 * screen where a reviewer records an E-Verify result. The key now carries
 * the associate id; the long staleTime here would still replay Alice for
 * Bob if it did not.
 */
describe('E-Verify case drawer — one person, one case', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(listEVerifyRoster).mockResolvedValue({
      rows: [rosterRow(ALICE, 'Alice Ander', 'alice@example.com'), rosterRow(BOB, 'Bob Barker', 'bob@example.com')],
      counts: { total: 2, authorized: 0, pending: 0, nonconfirmation: 0, notRun: 2, overdue: 0, blocked: 0 },
      truncated: false,
    } as Awaited<ReturnType<typeof listEVerifyRoster>>);
    vi.mocked(getEVerifyCase).mockImplementation(async (associateId: string) =>
      associateId === ALICE ? caseDetail(ALICE, 'Alice', 'Ander') : caseDetail(BOB, 'Bob', 'Barker'),
    );
  });

  it('opening a second case shows the second person, not the first', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
    render(
      <MemoryRouter initialEntries={['/compliance/everify']}>
        <QueryClientProvider client={qc}>
          <TooltipProvider>
            <EVerifyTab canManage />
          </TooltipProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Alice Ander/ }));
    expect(await screen.findByRole('heading', { name: 'Alice Ander' })).toBeInTheDocument();

    // The roster sits behind the open drawer (aria-hidden by the dialog),
    // so the second row is reached with hidden: true and a plain click.
    fireEvent.click(screen.getByRole('button', { name: /Bob Barker/, hidden: true }));
    expect(await screen.findByRole('heading', { name: 'Bob Barker' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Alice Ander' })).not.toBeInTheDocument();
    expect(getEVerifyCase).toHaveBeenCalledWith(BOB);
  });
});
