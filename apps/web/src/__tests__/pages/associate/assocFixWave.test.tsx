import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Capability } from '@alto-people/shared';
import { AuthContext, DEFAULT_TENANT } from '@/lib/auth';
import { ConfirmProvider } from '@/lib/confirm';
import { I18nProvider } from '@/lib/i18n';
import { TooltipProvider } from '@/components/ui/Tooltip';

/**
 * The associate on a phone (deep audit 2026-10-29, builder ASSOC): papers
 * that say when a file is missing and expire on the day they name; a
 * calendar on payroll's Sat→Fri week; a sign-in with no employee record
 * that asks for nothing it can't have; dependents that wait for HR say so;
 * a first-paycheck card that ends; benefits and internal jobs in Spanish.
 */

if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => undefined;
}

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));

import { apiFetch } from '@/lib/api';
import { AssociateDocumentsView } from '@/pages/documents/AssociateDocumentsView';
import { ScheduleMonthView, ScheduleWeekView } from '@/pages/scheduling/AssociateScheduleCalendar';
import { MeHome } from '@/pages/me/MeHome';
import { MyWallet } from '@/pages/me/MyWallet';
import { FirstPaycheckCard, laneShowing } from '@/components/FirstPaycheckCard';
import { BenefitsHome } from '@/pages/benefits/BenefitsHome';
import { InternalJobsHome } from '@/pages/internalJobs/InternalJobsHome';

type Route = (path: string, init?: { method?: string; body?: unknown }) => unknown;
const calls: string[] = [];
function routes(fn: Route) {
  calls.length = 0;
  vi.mocked(apiFetch).mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    const r = fn(path, init);
    if (r instanceof Error) throw r;
    return (r ?? {}) as never;
  });
}

function user(associateId: string | null) {
  return { id: 'u1', email: 'maria@example.com', role: 'ASSOCIATE', status: 'ACTIVE', clientId: null, associateId } as never;
}

function renderWith(ui: React.ReactNode, opts: { associateId?: string | null; lang?: 'en' | 'es'; path?: string } = {}) {
  const caps = new Set<Capability>(['view:dashboard', 'view:documents', 'view:scheduling', 'view:payroll']);
  if (opts.lang) window.localStorage.setItem('alto.lang', opts.lang);
  return render(
    <I18nProvider>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <AuthContext.Provider
          value={{
            isInitializing: false,
            isOffline: false,
            user: user(opts.associateId === undefined ? 'a1' : opts.associateId),
            role: 'ASSOCIATE',
            primaryRole: 'ASSOCIATE',
            availableRoles: ['ASSOCIATE'],
            capabilities: caps,
            tenant: DEFAULT_TENANT,
            signIn: vi.fn(),
            submitMfaChallenge: vi.fn(),
            signOut: vi.fn(),
            refreshUser: vi.fn(),
            switchRole: vi.fn(),
            can: (c: Capability) => caps.has(c),
          } as never}
        >
          <ConfirmProvider>
            <TooltipProvider>
              <MemoryRouter initialEntries={[opts.path ?? '/']}>{ui}</MemoryRouter>
            </TooltipProvider>
          </ConfirmProvider>
        </AuthContext.Provider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

const tz = process.env.TZ;
afterEach(() => {
  process.env.TZ = tz;
  vi.useRealTimers();
  try {
    window.localStorage.removeItem('alto.lang');
  } catch {
    /* no storage */
  }
});

const doc = (over: Record<string, unknown>) => ({
  id: '00000000-0000-4000-8000-000000000001',
  associateId: '00000000-0000-4000-8000-0000000000aa',
  associateName: 'Maria Lopez',
  clientId: null,
  kind: 'ID',
  filename: 'id-front.jpg',
  mimeType: 'image/jpeg',
  size: 120_000,
  status: 'VERIFIED',
  expiresAt: null,
  rejectionReason: null,
  verifiedById: null,
  verifierEmail: null,
  verifiedAt: null,
  createdAt: '2026-08-01T15:00:00.000Z',
  fileAvailable: true,
  ...over,
});

describe('My documents (ASSOC-8, ASSOC-9)', () => {
  beforeEach(() => {
    process.env.TZ = 'America/Los_Angeles';
  });

  it('a lost file is "needs re-upload", never "All set"; an expiry reads as the day it names west of UTC', async () => {
    routes((path) => {
      if (path.startsWith('/documents/me')) {
        return {
          documents: [
            doc({ id: '00000000-0000-4000-8000-000000000001', expiresAt: '2029-01-19T00:00:00.000Z', fileAvailable: false }),
            doc({ id: '00000000-0000-4000-8000-000000000002', kind: 'SSN_CARD', filename: 'ssn.jpg' }),
          ],
        };
      }
      if (path.startsWith('/letters')) return { letters: [] };
      return {};
    });
    renderWith(<AssociateDocumentsView />);
    expect(await screen.findByText('Action needed')).toBeInTheDocument();
    expect(screen.getByText(/1 needs re-upload · 1 verified/)).toBeInTheDocument();
    expect(screen.queryByText('All set')).not.toBeInTheDocument();
    expect(screen.getAllByText(/Jan 19, 2029/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Jan 18, 2029/)).not.toBeInTheDocument();
  });

  it('a server failure says so in plain words — never the raw "Internal error" (ASSOC-25)', async () => {
    const { ApiError } = await import('@/lib/api');
    routes((path) => (path.startsWith('/documents/me') ? new ApiError(500, 'internal', 'Internal error') : path.startsWith('/letters') ? { letters: [] } : {}));
    renderWith(<AssociateDocumentsView />);
    expect(await screen.findByText(/Couldn’t load your documents\./)).toBeInTheDocument();
    expect(screen.queryByText('Internal error')).not.toBeInTheDocument();
  });
});

describe('My schedule calendar runs on payroll’s week (ASSOC-6, CODE-15)', () => {
  beforeEach(() => {
    process.env.TZ = 'America/Chicago';
  });

  const props = { shifts: [], hasOlder: false, loadingOlder: false, onLoadOlder: () => undefined, estRate: 15 };

  it('the week view is Saturday → Friday', () => {
    routes(() => ({}));
    // Thu Oct 29 2026, 10 PM Chicago.
    renderWith(<ScheduleWeekView {...props} now={new Date(2026, 9, 29, 22, 0).getTime()} />);
    expect(screen.getByText(/Oct 24 – Oct 30/)).toBeInTheDocument();
    expect(screen.queryByText(/Oct 25 – Oct 31/)).not.toBeInTheDocument();
  });

  it('the month grid starts its rows on Saturday', () => {
    routes(() => ({}));
    renderWith(<ScheduleMonthView {...props} now={new Date(2026, 9, 29, 22, 0).getTime()} />);
    const heads = screen.getAllByText(/^(Sat|Sun|Mon|Tue|Wed|Thu|Fri)$/).map((n) => n.textContent);
    expect(heads.slice(0, 7)).toEqual(['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
  });
});

describe('a sign-in with no employee record (CRAWL-15)', () => {
  it('My profile asks for none of the seven /self/me reads and says what applies', async () => {
    routes(() => ({}));
    renderWith(<MeHome />, { associateId: null });
    expect(await screen.findByText('Your sign-in isn’t linked to an employee record')).toBeInTheDocument();
    expect(calls.filter((c) => c.includes('/self/me'))).toEqual([]);
  });

  it('My credentials says it belongs to an employee record — no "Could not load", no Retry', async () => {
    routes(() => ({}));
    renderWith(<MyWallet />, { associateId: null });
    expect(await screen.findByText('Credentials belong to an employee record')).toBeInTheDocument();
    expect(screen.queryByText(/Could not load your credentials/)).not.toBeInTheDocument();
    expect(calls.filter((c) => c.includes('/wallet') || c.includes('/badge'))).toEqual([]);
  });
});

describe('dependents that wait for HR (CODE-32)', () => {
  it('removing one with the approval switch on says "sent to HR", not "removed"', async () => {
    const { toast } = await import('sonner');
    const success = vi.spyOn(toast, 'success');
    routes((path, init) => {
      if (path === '/self/me/dependents' && !init?.method) {
        return { dependents: [{ id: 'd1', firstName: 'Luis', lastName: 'Lopez', relation: 'CHILD', dob: '2015-03-02', ssnLast4: null, isCovered: true }] };
      }
      if (path === '/self/me/dependents/d1' && init?.method === 'DELETE') return { pending: true, approvalId: 'ap1', title: 'Maria Lopez: remove a dependent' };
      if (path.startsWith('/self/me/profile')) return { firstName: 'Maria', lastName: 'Lopez' };
      if (path.startsWith('/self/me')) return {};
      return {};
    });
    renderWith(<MeHome />, { path: '/me?tab=dependents' });
    const row = await screen.findByText(/Luis/);
    const remove = within(row.closest('tr') ?? row.closest('li') ?? document.body).getAllByRole('button', { name: /Remove|Delete/ })[0]!;
    await userEvent.click(remove);
    const dialog = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    await userEvent.click(within(dialog).getAllByRole('button').find((b) => /Remove|Delete|Confirm/.test(b.textContent ?? ''))!);
    await waitFor(() => expect(success).toHaveBeenCalledWith('Sent to HR to confirm. It applies once they approve it.'));
    expect(success).not.toHaveBeenCalledWith('Dependent removed.');
  });
});

describe('the first-paycheck lane ends (ASSOC-18)', () => {
  const lane = (at: string) => ({
    completed: true,
    currentStage: null,
    approvedAt: '2026-08-20T00:00:00Z',
    stages: [{ key: 'paycheck', done: true, at, dueAt: null, overdue: false }],
  });

  it('shows the landed moment for two weeks, then leaves Home', () => {
    const now = Date.parse('2026-10-29T18:00:00Z');
    expect(laneShowing(lane('2026-10-20T16:00:00Z') as never, now)).toBe(true);
    expect(laneShowing(lane('2026-10-02T16:00:00Z') as never, now)).toBe(false);
    expect(laneShowing({ completed: false, stages: [] } as never, now)).toBe(true);
  });

  it('Maria, paid Oct 2, no longer sees "Your first paycheck has landed" on Oct 29', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-29T18:00:00Z'));
    routes((path) => (path === '/me/first-paycheck' ? { lane: lane('2026-10-02T16:00:00Z') } : {}));
    const { container } = renderWith(<FirstPaycheckCard />);
    await waitFor(() => expect(calls).toContain('GET /me/first-paycheck'));
    expect(container).toBeEmptyDOMElement();
  });
});

describe('Benefits and Internal jobs read in the associate’s language (ASSOC-12)', () => {
  it('Benefits in Spanish, with no "Refresh" button on the empty state (ASSOC-30)', async () => {
    routes((path) => (path.startsWith('/benefits/me/enrollments') || path.startsWith('/benefits/enrollments/me') ? { enrollments: [] } : path.includes('plans') ? { plans: [] } : { enrollments: [] }));
    renderWith(<BenefitsHome />, { lang: 'es' });
    expect(await screen.findByText('Beneficios', { selector: 'h1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cómo funciona' })).toBeInTheDocument();
    expect(screen.queryByText('How this works')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Refresh|Actualizar/ })).not.toBeInTheDocument();
  });

  it('Internal jobs in Spanish', async () => {
    routes((path) => (path.includes('applications') ? { applications: [] } : { jobs: [] }));
    renderWith(<InternalJobsHome />, { lang: 'es' });
    expect(await screen.findByText('Empleos internos', { selector: 'h1' })).toBeInTheDocument();
    expect(await screen.findByText('No hay puestos abiertos')).toBeInTheDocument();
    expect(screen.queryByText('Internal jobs')).not.toBeInTheDocument();
  });
});

describe('Needs you speaks their language for every row (ASSOC-13)', () => {
  it('"Set when you can work" (the server’s English label) reads in Spanish', async () => {
    const { AssociateNeedsYou } = await import('@/components/home/AssociateNeedsYou');
    routes((path) =>
      path === '/me/inbox'
        ? { total: 1, sources: [{ key: 'my-availability', label: 'Set when you can work', description: 'The schedule cannot offer you shifts until it knows your availability.', count: 1, path: '/scheduling#availability' }] }
        : {},
    );
    renderWith(<AssociateNeedsYou />, { lang: 'es' });
    expect(await screen.findByText('Indica cuándo puedes trabajar')).toBeInTheDocument();
    expect(screen.queryByText('Set when you can work')).not.toBeInTheDocument();
  });
});
