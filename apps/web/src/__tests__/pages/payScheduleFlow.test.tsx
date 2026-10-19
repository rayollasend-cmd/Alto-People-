import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAs } from './hrPack/harness';

/**
 * The pay-schedule engine as the payroll flow shows it: the run wizard
 * tells the truth about who a run pays, the payroll home lists every
 * schedule's next payday, a failing payout rail is one slim line, and a
 * person's pay schedule reads and changes from onboarding and the record.
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
      // Anything else answers an object whose every field is an empty list, so unrelated widgets render empty.
      return new Proxy({}, { get: (_t, prop) => (prop === 'then' || typeof prop === 'symbol' ? undefined : []) });
    },
  };
});

import { RunPayrollWizard } from '@/pages/payroll/RunPayrollWizard';
import { AdminPayrollView } from '@/pages/payroll/AdminPayrollView';
import { WebhookHealthTile } from '@/pages/payroll/WebhookHealthTile';
import { PayScheduleAssignment } from '@/components/PayScheduleAssignment';
import { EmploymentTab } from '@/pages/people/PeopleDirectory';

const SCH = '11111111-1111-4111-8111-111111111111';
const SCH2 = '22222222-2222-4222-8222-222222222222';
const PERSON = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const DRAFT = '55555555-5555-4555-8555-555555555555';

const period = { periodStart: '2027-01-02', periodEnd: '2027-01-15', payDate: '2027-01-22', unadjustedPayDate: null, adjustedFor: null, run: null };

function legacySchedule(id: string, name: string, associateCount: number) {
  return {
    id,
    clientId: null,
    clientName: null,
    name,
    frequency: 'BIWEEKLY',
    anchorDate: '2026-12-19',
    payDateOffsetDays: 7,
    isActive: true,
    notes: null,
    associateCount,
    nextPeriodStart: period.periodStart,
    nextPeriodEnd: period.periodEnd,
    nextPayDate: period.payDate,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function summary(id: string, name: string, people: number, pattern = 'Every other week, Saturday to Friday, paid the next Friday') {
  return {
    id,
    name,
    pattern,
    frequency: 'BIWEEKLY',
    anchorDate: '2026-12-19',
    payDateOffsetDays: 7,
    isActive: true,
    isDefault: false,
    clients: [],
    people,
    blocked: 0,
    attention: 0,
    nextPeriod: period,
    pendingVersion: null,
    pendingJoins: 0,
    pendingLeaves: 0,
    notes: null,
  };
}

function previewItem(associateId: string, name: string) {
  return {
    associateId,
    associateName: name,
    hoursWorked: 40,
    hourlyRate: 20,
    regularHours: 40,
    overtimeHours: 0,
    grossPay: 800,
    preTaxDeductions: 0,
    preTaxRetirement: 0,
    federalIncomeTax: 60,
    fica: 49.6,
    medicare: 11.6,
    stateIncomeTax: 0,
    taxState: 'FL',
    payFrequency: 'BIWEEKLY',
    disposableEarnings: 678.8,
    postTaxDeductions: 0,
    netPay: 678.8,
    employerFica: 49.6,
    employerMedicare: 11.6,
    employerFuta: 4.8,
    employerSuta: 2.4,
    ytdWages: 0,
  };
}

function preview(items: ReturnType<typeof previewItem>[]) {
  const gross = items.reduce((s, i) => s + i.grossPay, 0);
  const net = items.reduce((s, i) => s + i.netPay, 0);
  return {
    items,
    totals: { totalGross: gross, totalEmployeeTax: gross - net, totalNet: net, totalEmployerTax: 0, totalGarnishments: 0, itemCount: items.length },
  };
}

const noExceptions = { exceptions: [], counts: { blocking: 0, warning: 0, info: 0 } };

function wizardRoutes(o: { people: number; items: ReturnType<typeof previewItem>[]; exceptions?: unknown }) {
  routes = {
    'GET /payroll/schedules': { schedules: [legacySchedule(SCH, 'Biweekly — Seaside', o.people)] },
    'GET /payroll/pay-schedules': { schedules: [summary(SCH, 'Biweekly — Seaside', o.people)], unassigned: 0 },
    [`GET /payroll/pay-schedules/${SCH}/calendar`]: { periods: [period] },
    'POST /payroll/runs/preview': preview(o.items),
    'POST /payroll/runs/exceptions': o.exceptions ?? noExceptions,
    'POST /payroll/runs': { id: DRAFT, items: o.items },
  };
}

function openWizard(onCreated = vi.fn()) {
  renderAs(
    'HR_ADMINISTRATOR',
    <RunPayrollWizard
      open
      onOpenChange={() => {}}
      onCreated={onCreated}
      seed={{ scheduleId: SCH, periodStart: period.periodStart, periodEnd: period.periodEnd }}
    />,
    '/payroll',
  );
  return onCreated;
}

beforeEach(() => {
  calls.length = 0;
  routes = {};
});

describe('Run payroll wizard', () => {
  it('a schedule with no one on it says so, links to add people, and will not create a run', async () => {
    wizardRoutes({ people: 0, items: [] });
    openWizard();

    expect(await screen.findByText('No one is on this schedule yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Add people/ })).toHaveAttribute('href', `/payroll/schedules/${SCH}`);
    expect(screen.getByText('0 on this schedule')).toBeInTheDocument();
    // Never a green "all clear" for an empty run.
    expect(screen.queryByText(/No exceptions for/)).not.toBeInTheDocument();
    const create = screen.getByRole('button', { name: /Create run/ });
    expect(create).toBeDisabled();
    expect(create).toHaveAttribute('title', 'No one is on this schedule yet — add people to it first.');
    expect(screen.getByText('No one is on this schedule yet — add people to it first.')).toBeInTheDocument();
  });

  it('people on the schedule but no approved time: says exactly that and links to approvals', async () => {
    wizardRoutes({ people: 3, items: [] });
    openWizard();

    expect(await screen.findByText('3 people are on this schedule, but none has approved time in this period')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Approve time' })).toHaveAttribute(
      'href',
      `/time-attendance?tab=queue&from=${period.periodStart}&to=${period.periodEnd}`,
    );
    expect(screen.getByRole('button', { name: /Create run/ })).toBeDisabled();
  });

  it('sends the schedule on the preview, the exception scan and the create', async () => {
    wizardRoutes({ people: 2, items: [previewItem(PERSON, 'Ken Ito')] });
    const onCreated = openWizard();

    expect(await screen.findByText('2 on this schedule')).toBeInTheDocument();
    expect(screen.getByText('1 with approved time')).toBeInTheDocument();
    expect(screen.getByText('Biweekly — Seaside')).toBeInTheDocument();
    expect(screen.getByText(/Every other week/)).toBeInTheDocument();
    const create = screen.getByRole('button', { name: /Create run/ });
    await waitFor(() => expect(create).toBeEnabled());
    await userEvent.click(create);

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const body = (method: string, path: string) => calls.find((c) => c.method === method && c.path === path)?.body as Record<string, unknown>;
    expect(body('POST', '/payroll/runs/preview')).toMatchObject({ payrollScheduleId: SCH, periodStart: period.periodStart, periodEnd: period.periodEnd });
    expect(body('POST', '/payroll/runs/exceptions')).toMatchObject({ payrollScheduleId: SCH });
    expect(body('POST', '/payroll/runs')).toMatchObject({ payrollScheduleId: SCH, periodStart: period.periodStart });
  });

  it('people who worked but are on no schedule are named as not paid by this run', async () => {
    const unassigned = (id: string, name: string) => ({
      associateId: id,
      associateName: name,
      kind: 'UNASSIGNED_SCHEDULE',
      severity: 'WARNING',
      message: `${name} has approved time but is on no pay schedule`,
    });
    wizardRoutes({
      people: 2,
      items: [previewItem(PERSON, 'Ken Ito')],
      exceptions: {
        exceptions: [unassigned(OTHER, 'Ana Ruiz'), unassigned(DRAFT, 'Bo Chen'), unassigned(OTHER, 'Ana Ruiz')],
        counts: { blocking: 0, warning: 3, info: 0 },
      },
    });
    openWizard();

    expect(
      await screen.findByText('2 people worked this period but are on no pay schedule — they won’t be paid by this run.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Assign them' })).toHaveAttribute('href', '/payroll/schedules');
  });
});

describe('Payroll home', () => {
  const upcoming = {
    nextRun: null,
    lastRun: null,
    bySchedule: [
      { scheduleId: SCH2, scheduleName: 'Weekly — Warehouse', frequency: 'WEEKLY', periodStart: '2027-01-09', periodEnd: '2027-01-15', payDate: '2027-01-29', people: 0, draftRunId: DRAFT },
      { scheduleId: SCH, scheduleName: 'Biweekly — Seaside', frequency: 'BIWEEKLY', periodStart: '2027-01-02', periodEnd: '2027-01-15', payDate: '2027-01-22', people: 12, draftRunId: null },
    ],
  };

  it('lists every schedule’s next payday, soonest first, each with its own Run or Resume', async () => {
    routes = {
      'GET /payroll/upcoming': upcoming,
      'GET /payroll/pay-schedules': { schedules: [summary(SCH, 'Biweekly — Seaside', 12), summary(SCH2, 'Weekly — Warehouse', 0, 'Every week, Saturday to Friday, paid two Fridays later')], unassigned: 0 },
    };
    renderAs('HR_ADMINISTRATOR', <AdminPayrollView canProcess canVoid />, '/payroll');

    const hero = await screen.findByRole('region', { name: 'Next paydays' });
    const rows = within(hero).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('Biweekly — Seaside')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('12')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Weekly — Warehouse')).toBeInTheDocument();
    expect(await within(rows[1]!).findByText(/Every week, Saturday to Friday/)).toBeInTheDocument();
    expect(within(rows[0]!).getByRole('button', { name: 'Run payroll for Biweekly — Seaside' })).toBeInTheDocument();
    expect(within(rows[1]!).getByRole('button', { name: 'Resume draft for Weekly — Warehouse' })).toBeInTheDocument();
    expect(within(hero).getByRole('link', { name: 'Pay schedules' })).toHaveAttribute('href', '/payroll/schedules');
  });

  it('a failing payout rail is one slim line that sends you to Payroll banking', async () => {
    routes = {
      'GET /payroll/disbursement/webhook-status': {
        provider: 'WISE',
        health: 'erroring',
        detail: 'Signature check failed',
        lastEventAt: '2026-10-17T14:00:00.000Z',
        minutesSinceLastEvent: 60,
        eventsLast24h: 4,
        errorsLast7d: 3,
        pendingFinalizedItems: 5,
        latestError: { at: '2026-10-17T14:00:00.000Z', eventType: 'transfers#state-change', notes: 'Signature check failed' },
      },
    };
    renderAs('HR_ADMINISTRATOR', <WebhookHealthTile surface="payroll" />, '/payroll');

    const line = await screen.findByRole('status');
    expect(line).toHaveTextContent(/Payouts: Wise — failing since Oct 17, 2026/);
    expect(line).toHaveTextContent('5 paychecks waiting');
    expect(within(line).getByRole('link', { name: /Fix in Payroll banking/ })).toHaveAttribute('href', '/payroll/banking');
    // The provider's raw error stays on the banking page.
    expect(screen.queryByText('Signature check failed')).not.toBeInTheDocument();
  });
});

describe('A person’s pay schedule', () => {
  const schedules = {
    schedules: [summary(SCH, 'Biweekly — Seaside', 12), summary(SCH2, 'Weekly — Warehouse', 4, 'Every week, Saturday to Friday, paid two Fridays later')],
    unassigned: 0,
  };

  it('onboarding shows the schedule the rules choose, and why', async () => {
    routes = {
      [`GET /associates/${PERSON}/pay-schedule`]: {
        current: null,
        pending: null,
        ruleDefault: { scheduleId: SCH, name: 'Biweekly — Seaside', because: 'they work at Seaside, and Seaside is paid every other week' },
        nextPayDate: '2027-01-22',
      },
      'GET /payroll/pay-schedules': schedules,
    };
    renderAs('HR_ADMINISTRATOR', <PayScheduleAssignment associateId={PERSON} variant="hire" />, '/onboarding');

    expect(await screen.findByRole('link', { name: 'Biweekly — Seaside' })).toHaveAttribute('href', `/payroll/schedules/${SCH}`);
    expect(screen.getByText(/They work at Seaside, and Seaside is paid every other week/)).toBeInTheDocument();
    expect(screen.getByText(/Will be on it from the hire date/)).toBeInTheDocument();
    expect(screen.getByText('First payday')).toBeInTheDocument();
    expect(await screen.findByText(/Every other week, Saturday to Friday/)).toBeInTheDocument();
  });

  it('onboarding: no schedule covers the hire — amber, and HR chooses one', async () => {
    let state: Record<string, unknown> = { current: null, pending: null, ruleDefault: null, nextPayDate: null };
    routes = {
      [`GET /associates/${PERSON}/pay-schedule`]: () => state,
      [`PUT /associates/${PERSON}/pay-schedule`]: (body: unknown) => {
        state = {
          current: null,
          pending: { scheduleId: SCH2, name: 'Weekly — Warehouse', effectiveFrom: '2027-01-09', because: 'chosen for this person' },
          ruleDefault: null,
          nextPayDate: '2027-01-29',
        };
        void body;
        return state;
      },
      'GET /payroll/pay-schedules': schedules,
    };
    renderAs('HR_ADMINISTRATOR', <PayScheduleAssignment associateId={PERSON} variant="hire" />, '/onboarding');

    expect(await screen.findByText('No pay schedule covers this hire — choose one')).toBeInTheDocument();
    const select = await screen.findByRole('combobox', { name: 'Pay schedule' });
    await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(3));
    await userEvent.selectOptions(select, SCH2);
    await userEvent.click(screen.getByRole('button', { name: 'Use this schedule' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    // Onboarding lets the server date it (the hire): no effective date sent.
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ scheduleId: SCH2 });
    expect(await screen.findByRole('link', { name: 'Weekly — Warehouse' })).toBeInTheDocument();
    expect(screen.queryByText('No pay schedule covers this hire — choose one')).not.toBeInTheDocument();
  });

  it('the person record shows the schedule, a booked move and the next payday; Change dates it to the next period start', async () => {
    routes = {
      [`GET /associates/${PERSON}/pay-schedule`]: {
        current: { scheduleId: SCH2, name: 'Weekly — Warehouse', pattern: 'Every week, Saturday to Friday, paid two Fridays later', since: '2026-03-07', because: 'they work at the Warehouse site' },
        pending: { scheduleId: SCH, name: 'Biweekly', effectiveFrom: '2026-10-31', because: 'transferred to Seaside' },
        ruleDefault: null,
        nextPayDate: '2026-10-23',
      },
      [`PUT /associates/${PERSON}/pay-schedule`]: (b: unknown) => ({
        current: null,
        pending: null,
        ruleDefault: null,
        nextPayDate: null,
        ...(b as object),
      }),
      [`GET /org/associates/${PERSON}/employment`]: { employment: [] },
      // The period under way is passed over for the first one still to start.
      [`GET /payroll/pay-schedules/${SCH}/calendar`]: {
        periods: [{ ...period, periodStart: '2026-01-03', periodEnd: '2026-01-16', payDate: '2026-01-23' }, period],
      },
      'GET /payroll/pay-schedules': schedules,
    };
    renderAs('HR_ADMINISTRATOR', <EmploymentTab associateId={PERSON} />, '/people');

    const row = await screen.findByRole('region', { name: 'Pay schedule' });
    expect(within(row).getByRole('link', { name: 'Weekly — Warehouse' })).toBeInTheDocument();
    expect(within(row).getByText(/Every week, Saturday to Friday/)).toBeInTheDocument();
    expect(within(row).getByText(/Since Mar 7, 2026 · They work at the Warehouse site/)).toBeInTheDocument();
    expect(within(row).getByText('Moves to Biweekly on Oct 31, 2026 — transferred to Seaside')).toBeInTheDocument();
    expect(within(row).getByText('Next payday')).toBeInTheDocument();

    await userEvent.click(within(row).getByRole('button', { name: 'Change' }));
    const select = await within(row).findByLabelText('Pay schedule');
    await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(3));
    await userEvent.selectOptions(select, SCH);
    expect(within(row).getByLabelText('Effective from')).toHaveValue(period.periodStart);
    expect(within(row).getByText('The start of its next pay period')).toBeInTheDocument();
    await userEvent.click(within(row).getByRole('button', { name: 'Save change' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ scheduleId: SCH, effectiveFrom: period.periodStart }),
    );
  });

  it('a date picked by hand is the date sent, even after the calendar loads', async () => {
    routes = {
      [`GET /associates/${PERSON}/pay-schedule`]: { current: null, pending: null, ruleDefault: null, nextPayDate: null },
      [`PUT /associates/${PERSON}/pay-schedule`]: { current: null, pending: null, ruleDefault: null, nextPayDate: null },
      [`GET /payroll/pay-schedules/${SCH}/calendar`]: () => new Promise((r) => setTimeout(() => r({ periods: [period] }), 50)),
      'GET /payroll/pay-schedules': schedules,
    };
    renderAs('HR_ADMINISTRATOR', <PayScheduleAssignment associateId={PERSON} variant="record" />, '/people');
    const select = await screen.findByRole('combobox', { name: 'Pay schedule' });
    await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(3));
    await userEvent.selectOptions(select, SCH);
    const date = screen.getByLabelText('Effective from');
    fireEvent.change(date, { target: { value: '2099-03-04' } });
    await new Promise((r) => setTimeout(r, 120));
    expect(date).toHaveValue('2099-03-04');
    await userEvent.click(screen.getByRole('button', { name: 'Save change' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ scheduleId: SCH, effectiveFrom: '2099-03-04' }));
  });

  it('Change is for whoever runs payroll: a supervisor sees no Change', async () => {
    routes = {
      [`GET /associates/${PERSON}/pay-schedule`]: {
        current: { scheduleId: SCH, name: 'Biweekly — Seaside', pattern: 'Every other week', since: '2026-03-07', because: 'the company default' },
        pending: null,
        ruleDefault: null,
        nextPayDate: null,
      },
    };
    renderAs('SHIFT_SUPERVISOR', <PayScheduleAssignment associateId={PERSON} variant="record" />, '/people');
    expect(await screen.findByRole('link', { name: 'Biweekly — Seaside' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change' })).not.toBeInTheDocument();
  });

  it('says nothing to someone the API turns away', async () => {
    const { ApiError } = await import('@/lib/api');
    routes = {
      [`GET /associates/${PERSON}/pay-schedule`]: () => {
        throw new ApiError(403, 'forbidden', 'Forbidden');
      },
    };
    const { container } = renderAs('HR_ADMINISTRATOR', <PayScheduleAssignment associateId={PERSON} variant="record" />, '/people');
    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/pay-schedule'))).toBe(true));
    await waitFor(() => expect(container.querySelector('section')).toBeNull());
    expect(screen.queryByText(/Couldn't load/)).not.toBeInTheDocument();
  });
});
