import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { useEffect, type ReactNode } from 'react';
import { ROLE_CAPABILITIES, defaultTenantProfile, termsIn, type BusinessModel, type Capability, type TenantProfile } from '@alto-people/shared';
import { AuthContext, type TenantSession } from '@/lib/auth';
import { ConfirmProvider } from '@/lib/confirm';
import { I18nProvider, termVarsFrom, useI18n } from '@/lib/i18n';
import { ThemeProvider } from '@/lib/theme';
import { DensityProvider } from '@/lib/density';
import { PageTitleProvider } from '@/lib/pageTitle';
import { StoreScopeProvider } from '@/lib/storeScope';
import { TooltipProvider } from '@/components/ui/Tooltip';

// jsdom has neither; the chrome measures itself and the theme reads the OS preference.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => undefined;
}
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({ matches: false, media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
}

/**
 * Brief 2-1b — the forbidden-word harness: the acceptance line for the
 * hotel tenant. A DIRECT_EMPLOYER with the default switches (housing,
 * transportation, programs, bill rates, the client portal, robotics and
 * the agent builder off) and the words team member / property / property
 * manager must see none of the staffing company's words on any screen.
 *
 * The list lives here, not in prose. Matched case-insensitively on word
 * boundaries, singular and plural: "van" never matches "advance" or
 * "relevant", "store" never matches "restore".
 *
 * Exempt, by the owner's rulings of 2026-10-13: the product name "Alto
 * People" in Hugo's self-introduction, and the Organization profile page,
 * which names the module catalog for the tenant's admin. Nothing else.
 *
 * TODO (surfaces not rendered here yet — deep pages that need their own
 * fixtures before the words on them can be chased):
 *   - Organization profile (/admin/organization): it names every module a
 *     tenant can turn on, in the shared catalog's words ("Client portal",
 *     "Bill rates and margin", "Housing link", "Transportation: rides, vans
   *     …"). Those names are the catalog, not the tenant's vocabulary; the
 *     owner exempted the page on 2026-10-13.
 */

const FORBIDDEN = ['client', 'bill rate', 'housing', 'van', 'store', 'associate', 'alto'] as const;
const EXEMPT_PHRASES = ['Alto People'];
const FORBIDDEN_RE = new RegExp(`\\b(${FORBIDDEN.map((w) => w.replace(' ', '\\s+') + 's?').join('|')})\\b`, 'gi');

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  // Route-aware: the dashboard's endpoints get a small real fixture (it
  // reads nested shapes the lenient empty cannot satisfy); the rest get EMPTY.
  apiFetch: vi.fn(async (path: string) => DASHBOARD_FIXTURES[path.split('?')[0] ?? ''] ?? EMPTY),
}));
vi.mock('@/lib/usersAdminApi', async (orig) => {
  const actual = await orig<typeof import('@/lib/usersAdminApi')>();
  return {
    ...actual,
    listAdminUsers: vi.fn(async () => ({ users: [], total: 0 })),
    getUserCounts: vi.fn(async () => ({ total: 0, active: 0, invited: 0, disabled: 0, byRole: {} })),
    getAccessReport: vi.fn(async () => ({
      generatedAt: '2026-10-13T00:00:00.000Z',
      counts: { totalAccounts: 0, byStatus: { ACTIVE: 0, DISABLED: 0, INVITED: 0 }, byRole: {}, activeAssociates: 0, flaggedAccounts: 0, byFlag: {} },
      rows: [],
    })),
  };
});
vi.mock('@/lib/tenantProfileApi', () => ({
  getTenantProfile: vi.fn(async () => tenantProfileResponse),
  saveTenantProfile: vi.fn(),
}));
vi.mock('@/lib/messagesApi', async (orig) => ({ ...(await orig<typeof import('@/lib/messagesApi')>()), unreadMessages: vi.fn(async () => ({ count: 0 })) }));
vi.mock('@/components/ShiftLeadsCard', () => ({ ShiftLeadsCard: () => null }));

import { Sidebar } from '@/components/Sidebar';
import { MobileNav } from '@/components/MobileNav';
import { CommandPalette } from '@/components/ui/CommandPalette';
import { AdminDashboard } from '@/pages/AdminDashboard';
import { PeopleDirectory } from '@/pages/people/PeopleDirectory';
import { SchedulingHome } from '@/pages/scheduling/SchedulingHome';
import { TimeHome } from '@/pages/time/TimeHome';
import { HrCasesHome } from '@/pages/hrCases/HrCasesHome';
import { UsersAdmin } from '@/pages/admin/UsersAdmin';
import { TenantProfileHome } from '@/pages/admin/TenantProfileHome';
import { EmployersAdmin } from '@/pages/admin/EmployersAdmin';
import { OrgUnitsAdmin } from '@/pages/admin/OrgUnitsAdmin';
import { SitesAdmin } from '@/pages/admin/SitesAdmin';
import { Settings } from '@/pages/Settings';
import { MeHome } from '@/pages/me/MeHome';
import { DocumentsHome } from '@/pages/documents/DocumentsHome';
import { ReimbursementsHome } from '@/pages/reimbursements/ReimbursementsHome';
import { InternalJobsHome } from '@/pages/internalJobs/InternalJobsHome';
import { AgreementsHome } from '@/pages/agreements/AgreementsHome';
import { ApplicationsList } from '@/pages/onboarding/ApplicationsList';
import { NewApplicationDialog } from '@/pages/onboarding/NewApplicationDialog';
import { BulkInviteDialog } from '@/pages/onboarding/BulkInviteDialog';

/* ------------------------------------------------------------------ *
 *  A lenient empty value: every property is another empty, every call
 *  returns one, it iterates as nothing and prints as nothing, so a page
 *  settles into its empty state instead of throwing on a missing field.
 * ------------------------------------------------------------------ */
const ARRAY_METHODS = new Set(['map', 'filter', 'forEach', 'slice', 'some', 'every', 'find', 'findIndex', 'reduce', 'flatMap', 'sort', 'includes', 'join', 'concat', 'at', 'indexOf']);
// An arrow function as the target: it has no non-configurable own keys, so
// the empty ownKeys trap is honest, and a call on any field still works.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const EMPTY: any = new Proxy(() => undefined, {
  get(_t, p) {
    if (p === 'then' || p === 'catch' || p === 'finally' || p === '$$typeof' || p === 'prototype') return undefined;
    if (p === Symbol.toPrimitive || p === 'toString' || p === 'valueOf') return () => '';
    if (p === 'toJSON') return () => null;
    if (p === Symbol.iterator) return function* iter() {};
    if (p === 'length' || p === 'size') return 0;
    if (p === 'constructor') return Object;
    if (typeof p === 'symbol') return undefined;
    if (ARRAY_METHODS.has(p)) return (...args: unknown[]) => (Array.prototype[p as 'map'] as (...a: unknown[]) => unknown).apply([], args);
    return EMPTY;
  },
  apply: () => EMPTY,
  has: () => false,
  ownKeys: () => [],
  getOwnPropertyDescriptor: () => undefined,
});

/** The dashboard's data, with counts above zero so every hint and tile renders. */
/** A hotel's hire, mid-onboarding: no client, a property, a position. */
const HOTEL_APPLICATION = {
  id: '44444444-4444-4444-8444-444444444444',
  associateName: 'Tess Member',
  clientName: '',
  onboardingTrack: 'STANDARD',
  status: 'IN_REVIEW',
  position: 'Housekeeper',
  startDate: '2026-10-19',
  invitedAt: '2026-10-10T14:00:00.000Z',
  submittedAt: null,
  percentComplete: 60,
  lastInviteDelivery: null,
  blockedOnTitle: 'Profile',
  lastActivityAt: '2026-10-12T14:00:00.000Z',
};

const DASHBOARD_FIXTURES: Record<string, unknown> = {
  '/onboarding/applications': { applications: [HOTEL_APPLICATION], total: 1, page: 1, pageSize: 50 },
  '/onboarding/applications/stats': {
    total: 1,
    byStatus: { DRAFT: 0, SUBMITTED: 0, IN_REVIEW: 1, APPROVED: 0, REJECTED: 0 },
    inFlight: 1,
    stale: 0,
    bounced: 0,
    avgPercent: 60,
    staleSamples: [],
    bouncedSamples: [],
  },
  '/onboarding/templates': { templates: [{ id: '55555555-5555-4555-8555-555555555555', clientId: null, name: 'Hotel standard', track: 'STANDARD', tasks: [] }] },
  '/admin/sites': { sites: [{ id: '11111111-1111-4111-8111-111111111111', name: 'The Grand Hotel', type: 'PROPERTY', timezone: 'America/Chicago', state: 'FL', isActive: true, clientId: null, clientName: null, orgUnitId: null, orgUnitName: null, orgUnitType: null }] },
  '/analytics/dashboard': {
    activeAssociates: 42,
    openShiftsNext30d: 7,
    associatesClockedIn: 5,
    pendingOnboardingApplications: 3,
    pendingI9Section2: 2,
    pendingDocumentReviews: 4,
    netPaidLast30d: 12_345.67,
    netPendingDisbursement: 2_345.5,
    applicationStatusCounts: { DRAFT: 1, SUBMITTED: 2, IN_REVIEW: 1, APPROVED: 5, REJECTED: 1 },
    windowDays: 30,
    trends: {
      hires: { series: [1, 2, 3, 2, 4, 3, 5, 2], delta: 2 },
      shiftsScheduled: { series: [10, 12, 11, 14, 13, 15, 16, 9], delta: 1 },
      applications: { series: [2, 3, 2, 4, 3, 5, 4, 2], delta: -1 },
    },
  },
  '/w4-recollection/summary': { outstanding: 1, notified: 1, resolved: 0 },
  '/osha/incidents': { incidents: [{ status: 'OPEN' }, { status: 'RESOLVED' }] },
  '/audit/logs': {
    entries: [
      { id: '11111111-1111-4111-8111-111111111111', action: 'application.approved', actorUserId: null, actorEmail: 'hr@hotel.example', entityType: 'Application', entityId: 'a1', clientId: null, metadata: null, createdAt: '2026-10-13T00:00:00.000Z' },
      { id: '22222222-2222-4222-8222-222222222222', action: 'time.entry_approved', actorUserId: null, actorEmail: null, entityType: 'TimeEntry', entityId: 't1', clientId: null, metadata: null, createdAt: '2026-10-12T00:00:00.000Z' },
    ],
    nextBefore: null,
  },
  '/me/decisions': { decisions: [] },
  '/me/colleagues': { colleagues: [] },
  '/me/plan': { items: [] },
};

const HOTEL = defaultTenantProfile('DIRECT_EMPLOYER');
const ALTO = defaultTenantProfile('WORKFORCE_PROVIDER');
let tenantProfileResponse = profileResponse(HOTEL);

function profileResponse(profile: TenantProfile) {
  return {
    tenantId: 't-hotel',
    profile,
    defaults: { modules: profile.modules, terminology: profile.terminology },
    catalog: {
      businessModels: ['DIRECT_EMPLOYER', 'WORKFORCE_PROVIDER', 'MANAGED_PROGRAM', 'HYBRID'] as BusinessModel[],
      modules: Object.keys(profile.modules).map((key) => ({ key, label: key })),
      termKeys: Object.keys(profile.terminology),
    },
  };
}

/** The AuthProvider's job in the app: the dictionary's {site} {worker} … follow the profile. */
function TermSync({ profile }: { profile: TenantProfile }) {
  const { setTermVars, lang } = useI18n();
  useEffect(() => {
    setTermVars(termVarsFrom(termsIn(profile, lang)));
  }, [profile, lang, setTermVars]);
  return null;
}

/** The team member's own screens render as an ASSOCIATE with an associate record; everything else as HR. */
type HarnessRole = 'HR_ADMINISTRATOR' | 'ASSOCIATE';

function renderUnder(profile: TenantProfile, ui: ReactNode, route = '/', role: HarnessRole = 'HR_ADMINISTRATOR') {
  const caps = ROLE_CAPABILITIES[role];
  const tenant: TenantSession = { id: 't', ...profile };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <I18nProvider>
      <TermSync profile={profile} />
      <QueryClientProvider client={qc}>
        <ThemeProvider>
          <DensityProvider>
            <TooltipProvider>
        <MemoryRouter initialEntries={[route]}>
          <ConfirmProvider>
            <AuthContext.Provider
              value={{
                isInitializing: false,
                isOffline: false,
                user: { id: 'u1', email: 'hr@hotel.example', role, status: 'ACTIVE', clientId: null, locationId: null, regionId: null, associateId: role === 'ASSOCIATE' ? 'a1' : null, language: 'en', additionalRoles: [], activeRole: null, pinnedModules: [] } as never,
                role,
                primaryRole: role,
                availableRoles: [role],
                capabilities: caps,
                tenant,
                signIn: vi.fn(),
                submitMfaChallenge: vi.fn(),
                signOut: vi.fn(),
                refreshUser: vi.fn(),
                switchRole: vi.fn(),
                can: (c: Capability) => caps.has(c),
              }}
            >
              <StoreScopeProvider>
                <PageTitleProvider>{ui}</PageTitleProvider>
              </StoreScopeProvider>
            </AuthContext.Provider>
          </ConfirmProvider>
        </MemoryRouter>
            </TooltipProvider>
          </DensityProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

async function settle() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }
}

/** Everything a person could read: text, labels, titles, placeholders, alt text — portals included. */
function visibleText(): string {
  const parts = [document.body.textContent ?? ''];
  for (const el of document.body.querySelectorAll('[aria-label],[title],[placeholder],[alt]')) {
    for (const a of ['aria-label', 'title', 'placeholder', 'alt']) {
      const v = el.getAttribute(a);
      if (v) parts.push(v);
    }
  }
  return parts.join(' \n ');
}

function offenders(surface: string, text: string): string[] {
  let scrubbed = text;
  for (const phrase of EXEMPT_PHRASES) scrubbed = scrubbed.split(phrase).join(' ');
  const out: string[] = [];
  for (const m of scrubbed.matchAll(FORBIDDEN_RE)) {
    const at = m.index ?? 0;
    const context = scrubbed.slice(Math.max(0, at - 30), at + m[0].length + 30).replace(/\s+/g, ' ').trim();
    out.push(`${surface}: "${m[0]}" in “…${context}…”`);
  }
  return [...new Set(out)];
}

type Surface = { name: string; ui: () => ReactNode; route?: string; skip?: string; role?: HarnessRole };

const SURFACES: Surface[] = [
  { name: 'Sidebar', ui: () => <Sidebar /> },
  { name: 'MobileNav', ui: () => <MobileNav open onClose={() => undefined} onOpenCommandPalette={() => undefined} /> },
  { name: 'CommandPalette', ui: () => <CommandPalette open onOpenChange={() => undefined} onShowKeyboardShortcuts={() => undefined} /> },
  { name: 'Dashboard home', ui: () => <AdminDashboard /> },
  { name: 'People directory', ui: () => <PeopleDirectory />, route: '/people' },
  { name: 'Scheduling home', ui: () => <SchedulingHome />, route: '/scheduling' },
  { name: 'Time home', ui: () => <TimeHome />, route: '/time' },
  { name: 'HR cases home', ui: () => <HrCasesHome />, route: '/hr-cases' },
  { name: 'Users & access', ui: () => <UsersAdmin />, route: '/admin/users' },
  { name: 'Organization profile', ui: () => <TenantProfileHome />, route: '/admin/organization', skip: 'exempt by the owner (2026-10-13): it names the module catalog' },
  { name: 'Employers of record', ui: () => <EmployersAdmin />, route: '/admin/employers' },
  { name: 'Organizational tree', ui: () => <OrgUnitsAdmin />, route: '/admin/org-units' },
  { name: 'Sites', ui: () => <SitesAdmin />, route: '/admin/sites' },
  { name: 'Settings', ui: () => <Settings />, route: '/settings' },
  { name: 'Onboarding list', ui: () => <ApplicationsList />, route: '/onboarding' },
  { name: 'Invite dialog', ui: () => <NewApplicationDialog open onOpenChange={() => undefined} onCreated={() => undefined} />, route: '/onboarding' },
  { name: 'Bulk invite dialog', ui: () => <BulkInviteDialog open onOpenChange={() => undefined} onCreated={() => undefined} />, route: '/onboarding' },
  // The team member's own screens (the hotel e2e walk's second browser).
  { name: 'Team member: my profile', ui: () => <MeHome />, route: '/me', role: 'ASSOCIATE' },
  { name: 'Team member: time', ui: () => <TimeHome />, route: '/time-attendance', role: 'ASSOCIATE' },
  { name: 'Team member: documents', ui: () => <DocumentsHome />, route: '/documents', role: 'ASSOCIATE' },
  { name: 'Team member: reimbursements', ui: () => <ReimbursementsHome />, route: '/reimbursements', role: 'ASSOCIATE' },
  { name: 'Team member: internal jobs', ui: () => <InternalJobsHome />, route: '/internal-jobs', role: 'ASSOCIATE' },
  { name: 'Team member: agreements', ui: () => <AgreementsHome />, route: '/agreements', role: 'ASSOCIATE' },
];

beforeEach(() => {
  tenantProfileResponse = profileResponse(HOTEL);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the hotel tenant sees none of the staffing words', () => {
  for (const s of SURFACES) {
    (s.skip ? it.skip : it)(`${s.name} is clean${s.skip ? ` — skipped: ${s.skip}` : ''}`, async () => {
      renderUnder(HOTEL, s.ui(), s.route, s.role);
      await settle();
      const found = offenders(s.name, visibleText());
      expect(found, found.join('\n')).toEqual([]);
    });
  }
});

describe("Alto HR's words are unchanged for a workforce provider", () => {
  it('the navigation still says Clients, People and Store operations; scheduling still assigns associates and filters by client', async () => {
    tenantProfileResponse = profileResponse(ALTO);
    // Doors open only around the current page; this test reads every label.
    window.localStorage.setItem('alto.sidebar.openDoors', JSON.stringify(['me', 'team', 'people', 'hire', 'time', 'pay', 'compliance', 'operations', 'transport', 'clients', 'comms', 'insights', 'settings']));
    renderUnder(ALTO, <Sidebar />);
    await settle();
    let text = visibleText();
    expect(text).toMatch(/\bClients\b/);
    expect(text).toMatch(/\bPeople\b/);
    expect(text).toMatch(/\bStore operations\b/);
    cleanup();
    renderUnder(ALTO, <SchedulingHome />, '/scheduling');
    await settle();
    text = visibleText();
    expect(text).toMatch(/assign associates/);
    expect(text).toMatch(/All clients/);
  });
});
