import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DirectoryEntry, HirePayStatus } from '@alto-people/shared';
import { renderAs } from './hrPack/harness';

/**
 * The recruiter sets a new hire's starting wage and pay schedule (owner,
 * 2026-10-23), and sees their employment:
 *   - the application's "Starting pay & schedule" card: wage prefilled from
 *     the rate card, pay type, effective date, the schedule picker (from the
 *     person's own choices — the recruiter cannot read payroll's list), and
 *     "Waiting for approval" when the wage went to a second person;
 *   - the record's Employment tab: placement facts, the pay schedule with a
 *     Change for a new hire, and the Starting pay card for new hires only.
 * The API is stubbed by path so every client module stays real.
 */

type Call = { path: string; method: string; body: unknown };
const calls: Call[] = [];
let routes: Record<string, unknown> = {};
vi.mock('@/lib/api', async (orig) => {
  const real = await orig<typeof import('@/lib/api')>();
  return {
    ...real,
    apiFetch: async (path: string, init?: { method?: string; body?: unknown }) => {
      const method = init?.method ?? 'GET';
      calls.push({ path, method, body: init?.body });
      const key = `${method} ${path.split('?')[0]}`;
      if (key in routes) {
        const v = routes[key];
        return typeof v === 'function' ? (v as (b: unknown) => unknown)(init?.body) : v;
      }
      return new Proxy({}, { get: (_t, prop) => (prop === 'then' || typeof prop === 'symbol' ? undefined : []) });
    },
  };
});
vi.mock('@/pages/onboarding/EsignSection', () => ({ EsignSection: () => null }));
vi.mock('@/pages/onboarding/DocumentReviewPanel', () => ({ DocumentReviewPanel: () => null }));

import { StartingPayCard } from '@/components/StartingPayCard';
import { EmploymentTab } from '@/pages/people/PeopleDirectory';
import { ApplicationDetailBody } from '@/pages/onboarding/ApplicationDetail';

const P = '33333333-3333-4333-8333-333333333333';
const APP = '66666666-6666-4666-8666-666666666666';
const SCH = '11111111-1111-4111-8111-111111111111';

const choices = {
  schedules: [
    {
      id: SCH,
      name: 'Biweekly — Coastal',
      pattern: 'Every other week, Saturday to Friday, paid the next Friday',
      isActive: true,
      isDefault: true,
      nextPeriod: { periodStart: '2026-10-10', periodEnd: '2026-10-23', payDate: '2026-10-30' },
      firstStart: '2026-10-24',
    },
  ],
};

const uncovered = { current: null, pending: null, ruleDefault: null, nextPayDate: null, newHire: true };

function status(over: Partial<HirePayStatus> = {}): HirePayStatus {
  return {
    associateId: P,
    newHire: true,
    why: 'NEW_HIRE',
    message: null,
    canSet: true,
    compAccess: false,
    startDate: '2026-10-26',
    client: { id: '77777777-7777-4777-8777-777777777777', name: 'Coastal Resort' },
    position: 'Housekeeper',
    current: null,
    suggested: { payType: 'HOURLY', amount: '16.50', source: 'RATE_CARD', label: "From the rate card's pay for Housekeeper at Coastal Resort" },
    ceilings: {
      HOURLY: { payType: 'HOURLY', amount: '16.50', source: 'RATE_CARD', label: "the rate card's pay for Housekeeper at Coastal Resort" },
      SALARY: null,
    },
    pending: null,
    ...over,
  };
}

beforeEach(() => {
  calls.length = 0;
  routes = {};
});

describe('“Starting pay & schedule” on the application (the recruiter)', () => {
  it('prefills the rate card’s wage, sends a wage above it for approval, then says it is waiting', async () => {
    let hirePay = status();
    routes = {
      [`GET /comp/associates/${P}/hire-pay`]: () => hirePay,
      [`POST /comp/associates/${P}/records`]: () => {
        hirePay = status({ pending: { id: '88888888-8888-4888-8888-888888888888', title: 'Ana Reyes: starting pay $18.00 per hour', payType: 'HOURLY', amount: '18.00', effectiveFrom: '2026-10-26', requestedAt: '2026-10-19T15:00:00.000Z' } });
        return { pending: true, approvalId: '88888888-8888-4888-8888-888888888888', title: 'Ana Reyes: starting pay $18.00 per hour' };
      },
      [`GET /associates/${P}/pay-schedule`]: uncovered,
      [`GET /associates/${P}/pay-schedule/choices`]: choices,
    };
    renderAs('INTERNAL_RECRUITER', <StartingPayCard associateId={P} variant="application" />, '/onboarding');

    expect(await screen.findByText('Starting pay & schedule')).toBeInTheDocument();
    const wage = await screen.findByLabelText('Wage per hour');
    expect(wage).toHaveValue(16.5);
    expect(screen.getByText("From the rate card's pay for Housekeeper at Coastal Resort")).toBeInTheDocument();
    expect(screen.getByLabelText('Effective from')).toHaveValue('2026-10-26');
    expect(screen.getByText('Their start date')).toBeInTheDocument();
    // The hint already names the rate card, so the ceiling line does not say it twice.
    expect(screen.getByText('Up to $16.50/hr applies now. Above it, someone with compensation access approves it.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set starting pay' })).toBeEnabled();

    // Above the card: it says so, and the button says where it goes.
    fireEvent.change(wage, { target: { value: '18' } });
    expect(screen.getByText(/Above \$16\.50\/hr, the rate card's pay for Housekeeper at Coastal Resort: someone with compensation access approves it/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Send for approval' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ payType: 'HOURLY', amount: 18, reason: 'HIRE', effectiveFrom: '2026-10-26' }),
    );
    const waiting = (await screen.findByText('Waiting for approval')).closest('[role="status"]') as HTMLElement;
    expect(waiting).not.toBeNull();
    expect(within(waiting).getByText('$18.00/hr')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Set starting pay|Send for approval/ })).not.toBeInTheDocument();
  });

  it('chooses the pay schedule from the person’s own choices, never payroll’s list', async () => {
    routes = {
      [`GET /comp/associates/${P}/hire-pay`]: status(),
      [`GET /associates/${P}/pay-schedule`]: uncovered,
      [`GET /associates/${P}/pay-schedule/choices`]: choices,
      [`PUT /associates/${P}/pay-schedule`]: (b: unknown) => ({ ...uncovered, current: { scheduleId: SCH, name: 'Biweekly — Coastal', pattern: 'Every other week', since: '2026-10-24', because: 'Individual' }, ...(b as object) }),
    };
    renderAs('INTERNAL_RECRUITER', <StartingPayCard associateId={P} variant="application" />, '/onboarding');
    expect(await screen.findByText('No pay schedule covers this hire — choose one')).toBeInTheDocument();
    const select = await screen.findByRole('combobox', { name: 'Pay schedule' });
    await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(2));
    await userEvent.selectOptions(select, SCH);
    await userEvent.click(screen.getByRole('button', { name: 'Use this schedule' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ scheduleId: SCH }));
    // Named, not linked into payroll (which the recruiter cannot open).
    expect(await screen.findByText('Biweekly — Coastal')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Biweekly — Coastal' })).not.toBeInTheDocument();
    expect(calls.some((c) => c.path.startsWith('/payroll/'))).toBe(false);
  });

  it('a correction starts from the pay on file', async () => {
    routes = {
      [`GET /comp/associates/${P}/hire-pay`]: status({ current: { id: '99999999-9999-4999-8999-999999999999', payType: 'HOURLY', amount: '16.00', effectiveFrom: '2026-10-26', reason: 'HIRE' } }),
      [`POST /comp/associates/${P}/records`]: { ok: true },
      [`GET /associates/${P}/pay-schedule`]: uncovered,
      [`GET /associates/${P}/pay-schedule/choices`]: choices,
    };
    renderAs('INTERNAL_RECRUITER', <StartingPayCard associateId={P} variant="application" />, '/onboarding');
    expect(await screen.findByText('$16.00/hr')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Correct' }));
    const wage = screen.getByLabelText('Wage per hour');
    expect(wage).toHaveValue(16);
    fireEvent.change(wage, { target: { value: '16.5' } });
    await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ payType: 'HOURLY', amount: 16.5, reason: 'HIRE', effectiveFrom: '2026-10-26' }),
    );
  });

  it('whoever manages compensation sees the waiting wage with the way to the request', async () => {
    routes = {
      [`GET /comp/associates/${P}/hire-pay`]: status({
        compAccess: true,
        current: { id: '99999999-9999-4999-8999-999999999999', payType: 'HOURLY', amount: '13.75', effectiveFrom: '2026-10-26', reason: 'HIRE' },
        pending: { id: '88888888-8888-4888-8888-888888888888', title: 'Ana Reyes: starting pay $15.25 per hour', payType: 'HOURLY', amount: '15.25', effectiveFrom: '2026-10-26', requestedAt: '2026-10-23T15:00:00.000Z' },
      }),
      [`GET /associates/${P}/pay-schedule`]: uncovered,
      'GET /payroll/pay-schedules': { schedules: [], unassigned: 0 },
    };
    renderAs('HR_ADMINISTRATOR', <StartingPayCard associateId={P} variant="application" />, '/onboarding');
    expect(await screen.findByText('Waiting for approval')).toBeInTheDocument();
    expect(screen.getByText('$13.75/hr')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the request' })).toHaveAttribute('href', '/approvals?tab=requests&approval=88888888-8888-4888-8888-888888888888');
    // Nothing to correct while a wage waits.
    expect(screen.queryByRole('button', { name: 'Correct' })).not.toBeInTheDocument();
  });

  it('past the window it says, in words, whose call it is — and offers no form', async () => {
    routes = {
      [`GET /comp/associates/${P}/hire-pay`]: status({
        newHire: false,
        why: 'PAID',
        canSet: false,
        message: 'Ana Reyes has been paid on a payroll run. This is a pay change now — someone with compensation access makes it.',
        suggested: null,
        ceilings: { HOURLY: null, SALARY: null },
      }),
      [`GET /associates/${P}/pay-schedule`]: { ...uncovered, newHire: false },
      [`GET /associates/${P}/pay-schedule/choices`]: choices,
    };
    renderAs('INTERNAL_RECRUITER', <StartingPayCard associateId={P} variant="application" />, '/onboarding');
    expect(await screen.findByText(/This is a pay change now — someone with compensation access makes it\./)).toBeInTheDocument();
    expect(screen.queryByLabelText('Wage per hour')).not.toBeInTheDocument();
  });
});

const ANA: DirectoryEntry = {
  id: P,
  firstName: 'Ana',
  lastName: 'Reyes',
  email: 'ana@example.com',
  phone: null,
  employmentType: 'W2_EMPLOYEE',
  j1Status: false,
  status: 'PENDING',
  workplaceClientId: '77777777-7777-4777-8777-777777777777',
  workplaceClientName: 'Coastal Resort',
  position: 'Housekeeper',
  startDate: '2026-10-26',
  managerId: null,
  managerName: 'Dana Reyes',
  departmentId: null,
  departmentName: null,
  jobProfileId: null,
  jobProfileTitle: null,
  onboardingPercent: 40,
  applicationId: APP,
  createdAt: '2026-10-01T12:00:00.000Z',
  photoUrl: null,
  currentLocationId: null,
  currentLocationName: 'Front Beach 218',
  currentAssignmentStartedAt: null,
};

describe('the record’s Employment tab (the recruiter)', () => {
  it('a new hire: placement, their starting pay, and a pay schedule they can change', async () => {
    routes = {
      [`GET /org/associates/${P}/employment`]: { employment: [] },
      [`GET /comp/associates/${P}/hire-pay`]: status({ current: { id: '99999999-9999-4999-8999-999999999999', payType: 'HOURLY', amount: '16.50', effectiveFrom: '2026-10-26', reason: 'HIRE' } }),
      [`GET /associates/${P}/pay-schedule`]: {
        current: { scheduleId: SCH, name: 'Biweekly — Coastal', pattern: 'Every other week', since: '2026-10-24', because: 'Client: Coastal Resort' },
        pending: null,
        ruleDefault: { scheduleId: SCH, name: 'Biweekly — Coastal', because: 'Client: Coastal Resort' },
        nextPayDate: '2026-11-13',
        newHire: true,
      },
      [`GET /associates/${P}/pay-schedule/choices`]: choices,
    };
    renderAs('INTERNAL_RECRUITER', <EmploymentTab associateId={P} associate={ANA} />, '/people');

    // Where they work.
    expect(await screen.findByText('Placement')).toBeInTheDocument();
    for (const [label, value] of [
      ['Start date', 'Oct 26, 2026'],
      ['Employment type', 'W-2'],
      ['Position', 'Housekeeper'],
      ['Manager', 'Dana Reyes'],
      ['Department', 'Not set'],
    ] as const) {
      const term = screen.getByText(label, { selector: 'dt' });
      expect(within(term.parentElement!).getByText(value)).toBeInTheDocument();
    }
    expect(screen.getByText('Coastal Resort')).toBeInTheDocument();
    expect(screen.getByText('Front Beach 218')).toBeInTheDocument();

    // Their starting pay, correctable.
    expect(await screen.findByText('Starting pay')).toBeInTheDocument();
    expect(screen.getByText('Wage on file')).toBeInTheDocument();
    expect(screen.getByText('$16.50/hr')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Correct' })).toBeInTheDocument();

    // The schedule, with a Change for a new hire.
    const row = await screen.findByRole('region', { name: 'Pay schedule' });
    expect(within(row).getByText('Biweekly — Coastal')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Change' })).toBeInTheDocument();
    // No employment spell yet, said once.
    expect(screen.getByText('No employment record yet')).toBeInTheDocument();
  });

  it('someone past the window: no starting pay card, and the schedule is read only', async () => {
    routes = {
      [`GET /org/associates/${P}/employment`]: {
        employment: [
          { id: 'e1', employer: { id: 'o1', kind: 'TENANT', legalName: 'Alto Etho LLC', ein: null, clientId: null }, employmentType: 'W2_EMPLOYEE', hireDate: '2026-09-18', endDate: null, applicationId: APP, site: null },
        ],
      },
      [`GET /comp/associates/${P}/hire-pay`]: status({ newHire: false, why: 'NOT_NEW_HIRE', canSet: false, message: 'Ana Reyes was hired more than 30 days ago. This is a pay change now — someone with compensation access makes it.', suggested: null, ceilings: { HOURLY: null, SALARY: null } }),
      [`GET /associates/${P}/pay-schedule`]: {
        current: { scheduleId: SCH, name: 'Biweekly — Coastal', pattern: 'Every other week', since: '2026-03-07', because: 'Client: Coastal Resort' },
        pending: null,
        ruleDefault: null,
        nextPayDate: '2026-11-13',
        newHire: false,
      },
      [`GET /associates/${P}/pay-schedule/choices`]: choices,
    };
    renderAs('INTERNAL_RECRUITER', <EmploymentTab associateId={P} associate={{ ...ANA, status: 'ACTIVE', startDate: null }} />, '/people');
    const row = await screen.findByRole('region', { name: 'Pay schedule' });
    // No planned start on the application: the open employment spell's hire date is their start.
    const start = screen.getByText('Start date', { selector: 'dt' });
    expect(within(start.parentElement!).getByText('Sep 18, 2026')).toBeInTheDocument();
    expect(screen.getByText('Alto Etho LLC')).toBeInTheDocument();
    expect(within(row).getByText('Biweekly — Coastal')).toBeInTheDocument();
    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/hire-pay'))).toBe(true));
    expect(within(row).queryByRole('button', { name: 'Change' })).not.toBeInTheDocument();
    expect(screen.queryByText('Starting pay')).not.toBeInTheDocument();
    expect(screen.queryByText(/\$\d/)).not.toBeInTheDocument();
  });

  it('someone with the compensation view reads pay on the Pay tab, not here', async () => {
    routes = {
      [`GET /org/associates/${P}/employment`]: { employment: [] },
      [`GET /associates/${P}/pay-schedule`]: { ...uncovered, newHire: true },
    };
    renderAs('HR_ADMINISTRATOR', <EmploymentTab associateId={P} associate={ANA} />, '/people');
    expect(await screen.findByText('Placement')).toBeInTheDocument();
    expect(calls.some((c) => c.path.endsWith('/hire-pay'))).toBe(false);
  });
});

describe('the application page', () => {
  const app = {
    id: APP,
    associateId: P,
    clientId: '77777777-7777-4777-8777-777777777777',
    associateName: 'Ana Reyes',
    clientName: 'Coastal Resort',
    onboardingTrack: 'STANDARD',
    status: 'SUBMITTED',
    position: 'Housekeeper',
    startDate: '2026-10-26T00:00:00.000Z',
    invitedAt: '2026-10-12T12:00:00.000Z',
    submittedAt: '2026-10-15T12:00:00.000Z',
    percentComplete: 60,
    employmentType: 'W2_EMPLOYEE',
    approvedAt: null,
    rejectedAt: null,
    rejectionReason: null,
    hireDate: null,
    tasks: [],
  };
  const firstDay = {
    startDate: '2026-10-26',
    store: null,
    stores: [],
    manager: null,
    employeeNumber: { issued: false, clientId: null, validAtClient: false, number: null },
    firstShift: null,
    i9: { section1CompletedAt: null, section2CompletedAt: null, section2DueBy: null },
  };

  it('the recruiter gets the card, and First day points at it instead of a second picker', async () => {
    routes = {
      [`GET /onboarding/applications/${APP}`]: app,
      [`GET /onboarding/applications/${APP}/first-day`]: firstDay,
      [`GET /comp/associates/${P}/hire-pay`]: status(),
      [`GET /associates/${P}/pay-schedule`]: uncovered,
      [`GET /associates/${P}/pay-schedule/choices`]: choices,
    };
    renderAs('INTERNAL_RECRUITER', <ApplicationDetailBody applicationId={APP} mode="page" />, `/onboarding/applications/${APP}`);
    expect(await screen.findByText('Starting pay & schedule')).toBeInTheDocument();
    expect(await screen.findByText('None covers this hire — choose one under Starting pay & schedule.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText(/No pay schedule covers this hire — choose one/)).toHaveLength(1));
    expect(await screen.findByLabelText('Wage per hour')).toHaveValue(16.5);
  });

  it('a supervisor (invites only) gets no pay card and asks nothing about pay', async () => {
    routes = {
      [`GET /onboarding/applications/${APP}`]: app,
      [`GET /onboarding/applications/${APP}/first-day`]: firstDay,
    };
    renderAs('SHIFT_SUPERVISOR', <ApplicationDetailBody applicationId={APP} mode="page" />, `/onboarding/applications/${APP}`);
    expect(await screen.findByTestId('checklist-resolved')).toBeInTheDocument();
    expect(screen.queryByText('Starting pay & schedule')).not.toBeInTheDocument();
    expect(calls.some((c) => c.path.includes('/hire-pay'))).toBe(false);
  });
});
