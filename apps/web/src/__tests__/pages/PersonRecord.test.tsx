import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { useEffect, type ReactNode } from 'react';
import { ROLE_CAPABILITIES, defaultTenantProfile, termsIn, type Capability, type DirectoryEntry, type TenantProfile } from '@alto-people/shared';
import { AuthContext, type TenantSession } from '@/lib/auth';
import { ConfirmProvider } from '@/lib/confirm';
import { I18nProvider, termVarsFrom, useI18n } from '@/lib/i18n';
import { ThemeProvider } from '@/lib/theme';
import { DensityProvider } from '@/lib/density';
import { PageTitleProvider } from '@/lib/pageTitle';
import { StoreScopeProvider } from '@/lib/storeScope';
import { TooltipProvider } from '@/components/ui/Tooltip';

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

/* A lenient empty value for every endpoint the record's many sections call
 * that this test does not care about (same device as the tenancy harness). */
const ARRAY_METHODS = new Set(['map', 'filter', 'forEach', 'slice', 'some', 'every', 'find', 'findIndex', 'reduce', 'flatMap', 'sort', 'includes', 'join', 'concat', 'at', 'indexOf']);
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

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const ANA: DirectoryEntry = {
  id: ID,
  firstName: 'Ana',
  lastName: 'Reyes',
  email: 'ana@example.com',
  phone: null,
  employmentType: 'W2_EMPLOYEE',
  j1Status: false,
  status: 'ACTIVE',
  workplaceClientId: '44444444-4444-4444-8444-444444444444',
  workplaceClientName: null,
  position: 'Housekeeper',
  startDate: '2026-03-02',
  payAmount: '18.50',
  payType: 'HOURLY',
  payCurrency: 'USD',
  managerId: OTHER,
  managerName: 'Dana Flores',
  departmentId: null,
  departmentName: 'Rooms',
  jobProfileId: null,
  jobProfileTitle: null,
  onboardingPercent: null,
  applicationId: null,
  separatedAt: null,
  deactivatedAt: null,
  deactivationReason: null,
  createdAt: '2026-02-20T00:00:00.000Z',
  photoUrl: null,
  currentLocationId: '33333333-3333-4333-8333-333333333333',
  currentLocationName: 'The Grand Hotel',
  currentAssignmentStartedAt: '2026-03-02',
};

const OVERVIEW = {
  windowDays: 14,
  work: {
    minutes: 480,
    entries: 1,
    awaitingReview: 1,
    lastWorkedAt: '2026-10-14T13:00:00.000Z',
    nextShift: {
      id: '55555555-5555-4555-8555-555555555555',
      startsAt: '2099-01-05T15:00:00.000Z',
      endsAt: '2099-01-05T23:00:00.000Z',
      position: 'Housekeeper',
      locationName: 'The Grand Hotel',
      timezone: 'America/New_York',
    },
    noShows30d: 0,
  },
  documents: { expiringSoon: 1, expired: 0 },
  pay: { scheduleId: '66666666-6666-4666-8666-666666666666', scheduleName: 'Biweekly' },
};

const FIXTURES: Record<string, unknown> = {
  [`/people/directory/${ID}`]: ANA,
  [`/people/directory/${ID}/overview`]: OVERVIEW,
  '/time/admin/entries': {
    entries: [
      {
        id: 'te1',
        associateId: ID,
        associateName: 'Ana Reyes',
        clientId: null,
        clientName: null,
        clockInAt: '2026-10-14T13:00:00.000Z',
        clockOutAt: '2026-10-14T21:30:00.000Z',
        status: 'COMPLETED',
        minutesElapsed: 510,
        netMinutes: 480,
      },
    ],
    truncated: false,
  },
  '/time-off/admin/requests': {
    requests: [
      { id: 'r1', associateId: ID, associateName: 'Ana Reyes', category: 'VACATION', startDate: '2026-11-02', endDate: '2026-11-04', requestedMinutes: 1440, reason: null, status: 'APPROVED', reviewerUserId: null, reviewerEmail: 'hr@hotel.example', reviewerNote: null, decidedAt: '2026-10-10T00:00:00.000Z', cancelledAt: null, createdAt: '2026-10-09T00:00:00.000Z' },
    ],
    total: 2,
  },
  '/time-off/admin/entitlements': {
    entitlements: [{ id: 'e1', associateId: ID, associateName: 'Ana Reyes', category: 'VACATION', annualMinutes: 4800, carryoverMaxMinutes: 2400, policyAnchorMonth: 1, policyAnchorDay: 1, lastGrantedAt: '2026-01-01T00:00:00.000Z' }],
  },
  '/hr-cases': {
    cases: [{ id: 'c1', associateId: ID, associateName: 'Ana Reyes', associateEmail: 'ana@example.com', category: 'BENEFITS', subject: 'Dental card never arrived', priority: 'MEDIUM', status: 'WAITING_ASSOCIATE', assignedToEmail: 'hr@hotel.example', commentCount: 2, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z' }],
  },
  '/performance/timeline': { entries: [{ kind: 'GOAL', id: 'g1', title: 'Learn the turndown standard', status: 'ACTIVE', date: '2026-09-01', parentId: null, parentKind: null, link: '/performance?tab=goals' }] },
  '/performance/goals': { goals: [{ id: 'g1', status: 'ACTIVE' }] },
  '/performance/one-on-ones': { meetings: [] },
  '/performance/pips': { pips: [] },
  [`/disciplinary-actions/ladder/${ID}`]: { associateId: ID, ladder: { VERBAL_WARNING: 1, WRITTEN_WARNING: 0, FINAL_WARNING: 0, SUSPENSION: 0, TERMINATION: 0 } },
  '/kiosk-pins': { pins: [] },
  // The real shape: null, not a lenient empty (which reads as "a program").
  [`/programs/associate/${ID}`]: { program: null },
};
const calls: string[] = [];

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(async (path: string) => {
    calls.push(path);
    return FIXTURES[path.split('?')[0] ?? ''] ?? EMPTY;
  }),
}));
vi.mock('@/lib/messagesApi', async (orig) => ({ ...(await orig<typeof import('@/lib/messagesApi')>()), unreadMessages: vi.fn(async () => ({ count: 0 })) }));

import { PersonRecord } from '@/pages/people/PersonRecord';

const HOTEL = defaultTenantProfile('DIRECT_EMPLOYER');
const ALTO = defaultTenantProfile('WORKFORCE_PROVIDER');

function TermSync({ profile }: { profile: TenantProfile }) {
  const { setTermVars, lang } = useI18n();
  useEffect(() => {
    setTermVars(termVarsFrom(termsIn(profile, lang)));
  }, [profile, lang, setTermVars]);
  return null;
}

let lastLocation = '';
function LocationSpy() {
  const loc = useLocation();
  lastLocation = `${loc.pathname}${loc.search}`;
  return null;
}

function renderRecord(profile: TenantProfile, route = `/people/${ID}`, role: 'HR_ADMINISTRATOR' | 'SHIFT_SUPERVISOR' | 'WORKFORCE_MANAGER' | 'INTERNAL_RECRUITER' = 'HR_ADMINISTRATOR') {
  const caps = ROLE_CAPABILITIES[role];
  const tenant: TenantSession = { id: 't', ...profile };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const ui: ReactNode = (
    <Routes>
      <Route path="/people/:associateId" element={<PersonRecord />} />
      <Route path="/people" element={<div>Directory</div>} />
    </Routes>
  );
  return render(
    <I18nProvider>
      <TermSync profile={profile} />
      <QueryClientProvider client={qc}>
        <ThemeProvider>
          <DensityProvider>
            <TooltipProvider>
              <MemoryRouter initialEntries={[route]}>
                <LocationSpy />
                <ConfirmProvider>
                  <AuthContext.Provider
                    value={{
                      isInitializing: false,
                      isOffline: false,
                      user: { id: 'u1', email: 'hr@hotel.example', role, status: 'ACTIVE', clientId: null, locationId: null, regionId: null, associateId: null, language: 'en', additionalRoles: [], activeRole: null, pinnedModules: [] } as never,
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

const FORBIDDEN = ['client', 'bill rate', 'housing', 'van', 'store', 'associate', 'alto'] as const;
const FORBIDDEN_RE = new RegExp(`\\b(${FORBIDDEN.map((w) => w.replace(' ', '\\s+') + 's?').join('|')})\\b`, 'gi');

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

function offenders(text: string): string[] {
  const out: string[] = [];
  for (const m of text.split('Alto People').join(' ').matchAll(FORBIDDEN_RE)) {
    const at = m.index ?? 0;
    out.push(`"${m[0]}" in “…${text.slice(Math.max(0, at - 30), at + m[0].length + 30).replace(/\s+/g, ' ').trim()}…”`);
  }
  return [...new Set(out)];
}

beforeEach(() => {
  calls.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('<PersonRecord>', () => {
  it('renders the record from the by-id lookup: name, status, the facts strip, and every facet as a tab', async () => {
    renderRecord(ALTO);
    expect(await screen.findByRole('heading', { name: 'Ana Reyes' })).toBeInTheDocument();
    await settle();
    expect(calls).toContain(`/people/directory/${ID}`);
    expect(calls).toContain(`/people/directory/${ID}/overview`);
    // The one status word, not the old three.
    expect(screen.getAllByText('Working').length).toBeGreaterThan(0);
    // The facts strip: the manager links to their own record; the store, its start.
    expect(screen.getAllByRole('link', { name: 'Dana Flores' }).some((l) => l.getAttribute('href') === `/people/${OTHER}`)).toBe(true);
    expect(screen.getByText(/since Mar 2, 2026/)).toBeInTheDocument();
    // Every facet, Overview first and open.
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent?.replace(/\(\d+\)/, '').trim());
    expect(tabs).toEqual(['Overview', 'Profile', 'Employment', 'Pay', 'Time', 'Time off', 'Performance', 'Cases', 'Documents', 'Thread']);
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    // Counts in the labels, from the per-person endpoints.
    expect(screen.getByRole('tab', { name: /^Time\s*\(1\)/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^Time off\s*\(1\)/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^Cases\s*\(1\)/ })).toBeInTheDocument();
    // One home for a person: no "Quick view" back into a drawer; sibling pages are links.
    expect(screen.queryByRole('link', { name: /quick view/i })).toBeNull();
    expect(screen.getByRole('link', { name: 'Schedule' })).toHaveAttribute('href', `/scheduling?associate=${ID}`);
  });

  it('?tab= picks the facet, and the new tabs read this person’s data', async () => {
    renderRecord(ALTO, `/people/${ID}?tab=cases`);
    await screen.findByRole('heading', { name: 'Ana Reyes' });
    await settle();
    expect(screen.getByRole('tab', { name: /^Cases/ })).toHaveAttribute('aria-selected', 'true');
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByRole('link', { name: 'Dental card never arrived' })).toHaveAttribute('href', '/hr-cases?case=c1');
    expect(calls.some((p) => p === `/hr-cases?associateId=${ID}`)).toBe(true);

    // Switching tabs writes ?tab= and shows only this person's rows.
    await userEvent.click(screen.getByRole('tab', { name: /^Time off/ }));
    await settle();
    expect(lastLocation).toBe(`/people/${ID}?tab=timeoff`);
    const timeOff = screen.getByRole('tabpanel');
    expect(within(timeOff).getAllByText('Vacation').length).toBeGreaterThan(0);
    expect(within(timeOff).queryByText('Ben Ortiz')).toBeNull();
    expect(timeOff.textContent).toContain('80h a year');

    await userEvent.click(screen.getByRole('tab', { name: /^Time\s*\(/ }));
    await settle();
    expect(lastLocation).toBe(`/people/${ID}?tab=time`);
    expect(within(screen.getByRole('tabpanel')).getByText('Awaiting review', { selector: 'span' })).toBeInTheDocument();
    expect(within(screen.getByRole('tabpanel')).getAllByText('8h').length).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole('tab', { name: /^Performance/ }));
    await settle();
    const perf = screen.getByRole('tabpanel');
    expect(within(perf).getByRole('link', { name: 'Learn the turndown standard' })).toBeInTheDocument();
    expect(within(perf).getByText('Verbal warning')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Profile' }));
    await settle();
    expect(lastLocation).toBe(`/people/${ID}?tab=profile`);
    // Back to Overview (the default) drops the param.
    await userEvent.click(screen.getByRole('tab', { name: 'Overview' }));
    await settle();
    expect(lastLocation).toBe(`/people/${ID}`);
  });

  it('hides the facets the role could not read', async () => {
    // A shift supervisor approves time but works no cases, reads no pay and no performance.
    renderRecord(ALTO, `/people/${ID}?tab=cases`, 'SHIFT_SUPERVISOR');
    await screen.findByRole('heading', { name: 'Ana Reyes' });
    await settle();
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent?.replace(/\(\d+\)/, '').trim());
    // No Documents: the vault reads need manage:documents, and the tab only ever showed the refusal (PEOPLE-8).
    expect(tabs).toEqual(['Overview', 'Profile', 'Employment', 'Time', 'Time off', 'Thread']);
    // A ?tab= the role can't open falls back to Overview rather than an empty page.
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
  });

  it('says so, with a retry, when the person cannot be loaded', async () => {
    const { apiFetch } = await import('@/lib/api');
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error('boom'));
    renderRecord(ALTO);
    expect(await screen.findByRole('button', { name: /retry|try again/i })).toBeInTheDocument();
  });

  it('a hotel tenant sees none of the staffing company’s words on any facet', async () => {
    for (const tab of ['', 'profile', 'time', 'timeoff', 'performance', 'cases']) {
      renderRecord(HOTEL, `/people/${ID}${tab ? `?tab=${tab}` : ''}`);
      await screen.findByRole('heading', { name: 'Ana Reyes' });
      await settle();
      const found = offenders(visibleText());
      expect(found, `${tab || 'overview'}:\n${found.join('\n')}`).toEqual([]);
      cleanup();
    }
  });
});

describe('<PersonRecord> life-cycle actions (HR walk 12 and 13)', () => {
  it('the header More menu holds Transfer, Promote and Separate for someone still employed', async () => {
    renderRecord(ALTO);
    await screen.findByRole('heading', { name: 'Ana Reyes' });
    await settle();
    await userEvent.click(screen.getAllByRole('button', { name: 'More actions' })[0]!);
    expect(await screen.findByRole('menuitem', { name: 'Transfer…' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Promote…' })).toBeInTheDocument();
    // Pausing sits with the other life-cycle moves now, not at the foot of Profile.
    expect(screen.getByRole('menuitem', { name: 'Deactivate…' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Erase personal data…' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Separate…' }));
    // …with the way back to this record (?return=), so the desk lands here again.
    expect(lastLocation).toBe(`/separations?associateId=${ID}&return=${encodeURIComponent(`/people/${ID}`)}`);
  });

  it('no Separate for someone already separated', async () => {
    FIXTURES[`/people/directory/${ID}`] = { ...ANA, status: 'TERMINATED', separatedAt: '2026-09-30T00:00:00.000Z' };
    try {
      renderRecord(ALTO);
      await screen.findByRole('heading', { name: 'Ana Reyes' });
      await settle();
      await userEvent.click(screen.getAllByRole('button', { name: 'More actions' })[0]!);
      // Gone already: nothing to separate, transfer, promote or pause — erasure is what's left.
      expect(await screen.findByRole('menuitem', { name: 'Erase personal data…' })).toBeInTheDocument();
      expect(screen.queryByRole('menuitem', { name: 'Separate…' })).toBeNull();
      expect(screen.queryByRole('menuitem', { name: 'Transfer…' })).toBeNull();
      expect(screen.queryByRole('menuitem', { name: 'Deactivate…' })).toBeNull();
    } finally {
      FIXTURES[`/people/directory/${ID}`] = ANA;
    }
  });

  it('offers each role only what its API allows (PEOPLE-7, 8, 16)', async () => {
    // The workforce manager (manage:org, no view:hr-admin, no manage:documents):
    // Transfer and Deactivate yes; Separate and the Documents tab no — both
    // used to land on "no access" / "Missing capability".
    renderRecord(ALTO, `/people/${ID}`, 'WORKFORCE_MANAGER');
    await screen.findByRole('heading', { name: 'Ana Reyes' });
    await settle();
    expect(screen.queryByRole('tab', { name: /Documents/ })).toBeNull();
    await userEvent.click(screen.getAllByRole('button', { name: 'More actions' })[0]!);
    expect(await screen.findByRole('menuitem', { name: 'Transfer…' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Separate…' })).toBeNull();
    cleanup();

    // The recruiter (no manage:org, no manage:communications): no Transfer
    // button on Profile, and no WhatsApp row that could only ever be blank.
    renderRecord(ALTO, `/people/${ID}?tab=profile`, 'INTERNAL_RECRUITER');
    await screen.findByRole('heading', { name: 'Ana Reyes' });
    await settle();
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).queryByRole('button', { name: /^(Transfer|Assign to location)$/ })).toBeNull();
    expect(within(panel).queryByText('WhatsApp')).toBeNull();
  });

  it('HR opens a case for them from the Cases tab, with the person already picked', async () => {
    renderRecord(ALTO, `/people/${ID}?tab=cases`);
    await screen.findByRole('heading', { name: 'Ana Reyes' });
    await settle();
    await userEvent.click(within(screen.getByRole('tabpanel')).getByRole('button', { name: 'New case' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Open a case for someone')).toBeInTheDocument();
    expect(within(dialog).getByText('Ana Reyes')).toBeInTheDocument();
  });
});

describe('<PersonRecord> Overview (F500 fix-up)', () => {
  it('opens on what needs attention, their work and their pay, from the overview numbers', async () => {
    renderRecord(ALTO);
    await screen.findByRole('heading', { name: 'Ana Reyes' });
    await settle();
    const panel = screen.getByRole('tabpanel');
    const attention = within(panel).getByTestId('attention-list');
    // No clock-in number on file (the kiosk list is empty), one document
    // running out, one clock-in waiting — exactly the fixture's numbers.
    expect(attention).toHaveTextContent('No clock-in number issued yet.');
    expect(attention).toHaveTextContent('1 document expires in the next 30 days.');
    expect(attention).toHaveTextContent('1 clock-in waiting for approval.');
    expect(within(attention).getByRole('link', { name: 'Open documents' })).toHaveAttribute('href', `/people/${ID}?tab=documents`);
    expect(within(attention).getByRole('link', { name: 'Review time' })).toHaveAttribute('href', `/time-attendance/timesheets/history/${ID}`);
    // Her manager is set, so no "No manager" line.
    expect(attention).not.toHaveTextContent(/No .* assigned/);
    // Work and pay.
    // The facts card (job, hire date, contact) — hours, last worked and the next
    // shift are the strip's, said once (F500 2026-10-26).
    expect(within(panel).getByTestId('person-facts')).toHaveTextContent('Hired');
    expect(panel).not.toHaveTextContent('Hours (14 days)8');
    expect(panel).toHaveTextContent('No-shows (30 days)0');
    expect(panel).toHaveTextContent('$18.50/hr');
    expect(panel).toHaveTextContent('Biweekly');
    // The strip: hours link to the Time tab; the next shift names its store.
    expect(screen.getAllByText('8.0h').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/The Grand Hotel/).length).toBeGreaterThan(0);
  });

  it('says so when nothing needs attention', async () => {
    FIXTURES[`/people/directory/${ID}/overview`] = { ...OVERVIEW, work: { ...OVERVIEW.work, awaitingReview: 0 }, documents: { expiringSoon: 0, expired: 0 } };
    FIXTURES['/kiosk-pins'] = { pins: [{ id: 'p1', associateId: ID, associateName: 'Ana Reyes', associateEmail: 'ana@example.com', clientId: ANA.workplaceClientId, clientName: 'Grand', locationId: null, locationName: null, employeeNumber: '4821', wontClockIn: false, active: true, faceConsentStatus: null, createdAt: '2026-03-01T00:00:00.000Z' }] };
    try {
      renderRecord(ALTO);
      await screen.findByRole('heading', { name: 'Ana Reyes' });
      await settle();
      expect(screen.getByTestId('attention-none')).toHaveTextContent('All clear on this record.');
    } finally {
      FIXTURES[`/people/directory/${ID}/overview`] = OVERVIEW;
      FIXTURES['/kiosk-pins'] = { pins: [] };
    }
  });

  it('a clock-in number filed under another client is named, with the re-issue link', async () => {
    FIXTURES['/kiosk-pins'] = { pins: [{ id: 'p1', associateId: ID, associateName: 'Ana Reyes', associateEmail: 'ana@example.com', clientId: '77777777-7777-4777-8777-777777777777', clientName: 'Coastal Resort Holdings', locationId: null, locationName: null, employeeNumber: '4821', wontClockIn: false, active: true, faceConsentStatus: null, createdAt: '2026-03-01T00:00:00.000Z' }] };
    try {
      renderRecord(ALTO);
      await screen.findByRole('heading', { name: 'Ana Reyes' });
      await settle();
      const attention = screen.getByTestId('attention-list');
      expect(attention).toHaveTextContent("Their clock-in number won't work: it's filed under Coastal Resort Holdings");
      expect(within(attention).getByRole('link', { name: 'Re-issue' }).getAttribute('href')).toContain(`issue=${ID}`);
    } finally {
      FIXTURES['/kiosk-pins'] = { pins: [] };
    }
  });

  it('erasing personal data is in More, behind the typed confirm — not a red button on Profile', async () => {
    renderRecord(ALTO, `/people/${ID}?tab=profile`);
    await screen.findByRole('heading', { name: 'Ana Reyes' });
    await settle();
    expect(within(screen.getByRole('tabpanel')).queryByRole('button', { name: /erase personal data/i })).toBeNull();
    expect(within(screen.getByRole('tabpanel')).queryByText('Danger zone')).toBeNull();
    await userEvent.click(screen.getAllByRole('button', { name: 'More actions' })[0]!);
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Erase personal data…' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Type the .* last name/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Erase permanently' })).toBeDisabled();
  });
});
