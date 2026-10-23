import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { ROLE_CAPABILITIES, type AuditSearchEntry, type Capability } from '@alto-people/shared';
import { AuthContext, DEFAULT_TENANT } from '@/lib/auth';
import { ConfirmProvider } from '@/lib/confirm';

vi.mock('@/lib/auditApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auditApi')>()),
  searchAuditLogs: vi.fn(),
  getAuditActor: vi.fn(async (id: string) => ({ actors: [{ id, email: 'maria@example.com', name: 'Maria Lopez' }] })),
  searchAuditActors: vi.fn(async () => ({ actors: [] })),
}));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(async (path: string) => {
    if (path === '/audit/integrity')
      return { checks: [{ id: 'c1', ok: true, rows: 798, headSeq: '798', checkedAt: new Date().toISOString(), breaks: [] }], retentionYears: 7, minRetentionYears: 7, archives: [], sink: null };
    if (path.startsWith('/saved-views')) return { views: [] };
    return {};
  }),
}));

import { searchAuditLogs } from '@/lib/auditApi';
import { AuditHome } from '@/pages/audit/AuditHome';

const ADMIN = '11111111-1111-4111-8111-111111111111';
const MARIA = '22222222-2222-4222-8222-222222222222';
const now = new Date().toISOString();
const rows: AuditSearchEntry[] = [
  { id: '00000000-0000-4000-8000-0000000000a1', action: 'auth.login', actorUserId: ADMIN, actorEmail: 'admin@example.com', actorName: 'Avery Admin', entityType: 'User', entityId: ADMIN, entityLabel: 'Avery Admin', entityHref: null, clientId: null, metadata: null, createdAt: now },
  { id: '00000000-0000-4000-8000-0000000000a2', action: 'associate.pii_viewed', actorUserId: ADMIN, actorEmail: 'admin@example.com', actorName: 'Avery Admin', entityType: 'Associate', entityId: MARIA, entityLabel: 'Maria Lopez', entityHref: `/people/${MARIA}`, clientId: null, metadata: null, createdAt: now },
  { id: '00000000-0000-4000-8000-0000000000a3', action: 'payroll.schedule.rule_add', actorUserId: null, actorEmail: null, actorName: null, entityType: 'PayrollSchedule', entityId: '5f4d1dea-c053-4aa6-8408-974b6b65aec6', entityLabel: null, entityHref: null, clientId: null, metadata: null, createdAt: now },
];

let lastLocation = '';
function Probe() {
  const l = useLocation();
  lastLocation = l.pathname + l.search;
  return null;
}

function renderAudit(route = '/audit', caps: ReadonlySet<Capability> = ROLE_CAPABILITIES.HR_ADMINISTRATOR): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrap = (ui: ReactNode) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[route]}>
        <AuthContext.Provider
          value={{
            isInitializing: false,
            isOffline: false,
            user: { id: ADMIN, email: 'admin@example.com', role: 'HR_ADMINISTRATOR' } as never,
            role: 'HR_ADMINISTRATOR',
            primaryRole: 'HR_ADMINISTRATOR',
            availableRoles: ['HR_ADMINISTRATOR'],
            capabilities: caps,
            tenant: DEFAULT_TENANT,
            signIn: vi.fn(),
            submitMfaChallenge: vi.fn(),
            signOut: vi.fn(),
            refreshUser: vi.fn(),
            switchRole: vi.fn(),
            can: (c: Capability) => caps.has(c),
          }}
        >
          <ConfirmProvider>
            {ui}
            <Probe />
          </ConfirmProvider>
        </AuthContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  render(wrap(<AuditHome />));
}

beforeEach(() => {
  vi.mocked(searchAuditLogs).mockReset();
  vi.mocked(searchAuditLogs).mockResolvedValue({ entries: rows, nextBefore: null });
});

describe('Audit log (F500 G4)', () => {
  it('opens on the chain status line, then the log; the settings wait at the foot, closed', async () => {
    renderAudit();
    const status = await screen.findByTestId('audit-integrity');
    expect(status).toHaveTextContent('Chain verified');
    expect(status).toHaveTextContent('798 rows');
    expect(within(status).getByRole('button', { name: 'Check now' })).toBeInTheDocument();
    // Retention and the SIEM form are behind the Settings disclosure.
    const settings = await screen.findByRole('button', { name: /Settings/ });
    expect(settings).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText(/Keep rows for/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Endpoint/)).not.toBeInTheDocument();
    // The status line comes before the grid in the page.
    const grid = await screen.findByRole('table');
    expect(status.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(grid.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await userEvent.click(settings);
    expect(screen.getByLabelText(/Keep rows for/)).toBeInTheDocument();
  });

  it('says each event and record in words, not keys and UUIDs', async () => {
    renderAudit();
    const grid = await screen.findByRole('table');
    expect(within(grid).getByText('Signed in')).toBeInTheDocument();
    expect(within(grid).queryByText('auth.login')).not.toBeInTheDocument();
    expect(within(grid).getByText('Own account')).toBeInTheDocument();
    expect(within(grid).getByRole('link', { name: 'Maria Lopez' })).toHaveAttribute('href', `/people/${MARIA}`);
    expect(within(grid).getByText('Payroll schedule rule add')).toBeInTheDocument();
    // An unnamed record reads as its kind and a short id, never the whole UUID.
    expect(within(grid).getByText('Payroll schedule 5f4d1dea…')).toBeInTheDocument();
    expect(within(grid).getByText('System')).toBeInTheDocument();
  });

  it('hides the API request trail by default and shows it on request, in the URL', async () => {
    renderAudit();
    await waitFor(() => expect(searchAuditLogs).toHaveBeenCalled());
    expect(vi.mocked(searchAuditLogs).mock.calls[0]![0]).toMatchObject({ hideSystem: '1', limit: 100 });
    await userEvent.click(screen.getByRole('button', { name: 'Hide system requests' }));
    await waitFor(() => expect(lastLocation).toContain('system=1'));
    await waitFor(() => expect(vi.mocked(searchAuditLogs).mock.lastCall![0].hideSystem).toBeUndefined());
  });

  it('reads an investigation from the link: actor, category and dates', async () => {
    renderAudit(`/audit?actor=${MARIA}&cat=exports&from=2026-10-01&to=2026-10-07`);
    await waitFor(() => expect(searchAuditLogs).toHaveBeenCalled());
    const f = vi.mocked(searchAuditLogs).mock.calls[0]![0]!;
    expect(f).toMatchObject({ actorUserId: MARIA, category: 'exports', hideSystem: '1' });
    expect(new Date(f.since!).getDate()).toBe(1);
    expect(new Date(f.before!).getDate()).toBe(8); // the day after "to", exclusive
    expect(await screen.findByText('Actor: Maria Lopez')).toBeInTheDocument();
    expect((screen.getByRole('combobox', { name: 'Category' }) as HTMLSelectElement).value).toBe('exports');
  });

  it('has one export (the header menu) and one search — the grid adds neither', async () => {
    renderAudit();
    await screen.findByRole('table');
    expect(screen.getAllByRole('searchbox')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /^Export$/i, hidden: false })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Export/ })).toHaveLength(1);
  });

  it('the one search goes to the server, debounced, and into the URL', async () => {
    renderAudit();
    await screen.findByRole('table');
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search the audit log' }), 'pii');
    await waitFor(() => expect(lastLocation).toContain('q=pii'));
    await waitFor(() => expect(vi.mocked(searchAuditLogs).mock.lastCall![0].q).toBe('pii'));
  });
});
