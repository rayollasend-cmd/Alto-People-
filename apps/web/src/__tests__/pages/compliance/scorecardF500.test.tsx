import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  ROLE_CAPABILITIES,
  defaultTenantProfile,
  type Capability,
  type ManualAttestationSignal,
  type ScorecardAction,
} from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';

/**
 * The compliance scorecard, F500 fix-up:
 *   - Open actions fold by signal ("Background check on file · 10 people"),
 *     page at 25, keep Fix in view and put the rest in a ⋯ menu;
 *   - the Expiring documents header speaks for the documents (0/0/0 is not
 *     "Critical"); the insurance attestations carry their own badge;
 *   - a TRIR on 1,239 hours is not shown — the case count is;
 *   - no control sits inside another control;
 *   - the score's weekly change is dated.
 */

const NOW = '2026-10-22T12:00:00.000Z';
const GEN = { generatedAt: NOW };

vi.mock('@/lib/useClients', () => ({ useClients: () => ({ clients: [] }) }));
vi.mock('@/lib/lms94Api', () => ({ enrollAssociates: vi.fn() }));
vi.mock('@/lib/documentsApi', () => ({ downloadDocumentUrl: vi.fn(() => '#') }));
vi.mock('@/pages/compliance/ComplianceDonut', () => ({ ComplianceDonut: () => <div>donut</div> }));
vi.mock('@/lib/complianceScorecardApi', () => ({
  getScorecardOnboarding: vi.fn(),
  getScorecardExpirations: vi.fn(),
  getScorecardShifts: vi.fn(),
  getScorecardBilling: vi.fn(),
  getScorecardTraining: vi.fn(),
  getScorecardActions: vi.fn(),
  getScorecardHistory: vi.fn(),
  getScorecardSafety: vi.fn(),
  nudgeScorecardSignal: vi.fn(),
  setScorecardActionState: vi.fn(),
  scorecardReportUrl: vi.fn(() => '/api/report.pdf'),
  upsertAttestation: vi.fn(),
  snoozeAttestation: vi.fn(),
  unsnoozeAttestation: vi.fn(),
}));

import * as api from '@/lib/complianceScorecardApi';
import { ComplianceScorecard } from '@/pages/compliance/ComplianceScorecard';
import { groupScorecardActions } from '@/pages/compliance/scorecardActions';

const NAMES = ['Aaliyah Brooks', 'Dana Reyes', 'Gerodney Lee', 'Jay Patel', 'Kim Nguyen', 'Leo Ramos', 'Marcus Hill', 'Nia Carter', 'Rosa Vega', 'Tomas Ortiz'];
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function bgAction(i: number): ScorecardAction {
  return {
    id: `onb:BACKGROUND_CHECK:${uuid(i)}`,
    severity: 'critical',
    title: `${NAMES[i]} — missing: Background check on file`,
    contractClause: 'FCRA + Walmart MSA — background check on file',
    subject: { associateId: uuid(i), associateName: NAMES[i]!, clientId: null, clientName: 'Coastal Resort Holdings' },
    link: `/compliance?tab=background&associateId=${uuid(i)}`,
    group: { key: 'onb:BACKGROUND_CHECK', label: 'Background check on file', link: '/compliance?tab=background' },
  };
}
function shiftAction(n: number): ScorecardAction {
  return {
    id: `shf:SIG_${n}`,
    severity: 'warn',
    title: `Shift signal ${n}: 50% (target 97%)`,
    contractClause: 'Walmart SOW',
    subject: { associateId: null, associateName: null, clientId: null, clientName: null },
    link: '/scheduling',
  };
}
const attestation = (status: ManualAttestationSignal['status']): ManualAttestationSignal => ({
  key: 'WORKERS_COMP',
  label: 'Workers Comp insurance current',
  description: 'Coverage is current.',
  cadence: 'ANNUAL',
  periodStart: '2026-01-01',
  periodEnd: '2026-12-31',
  dueDate: '2026-01-31',
  status,
  current: null,
  snoozedUntil: null,
} as unknown as ManualAttestationSignal);

function actionsResponse(actions: ScorecardAction[]) {
  return {
    actions,
    criticalCount: actions.filter((a) => a.severity === 'critical').length,
    warnCount: actions.filter((a) => a.severity === 'warn').length,
    score: 17,
    truncated: false,
    totalActionCount: actions.length,
    ...GEN,
  };
}

function renderScorecard() {
  const role = 'HR_ADMINISTRATOR' as const;
  const caps = ROLE_CAPABILITIES[role];
  return render(
    <AuthContext.Provider
      value={
        {
          tenant: { id: 't1', ...defaultTenantProfile('WORKFORCE_PROVIDER') },
          isInitializing: false,
          isOffline: false,
          user: { id: 'u1', email: 'hr@altohr.com', role, status: 'ACTIVE', clientId: null, associateId: null },
          role,
          capabilities: new Set<Capability>(caps),
          signIn: vi.fn(),
          signOut: vi.fn(),
          can: (c: Capability) => caps.has(c),
        } as never
      }
    >
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <ComplianceScorecard />
        </MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
}

beforeEach(() => {
  vi.mocked(api.getScorecardOnboarding).mockResolvedValue({
    activeAssociateCount: 10,
    fullyCompliantCount: 0,
    signals: [
      {
        key: 'I9_BOTH_SECTIONS',
        label: 'I-9 Section 1 + Section 2',
        contractClause: 'IRCA — I-9',
        completedCount: 0,
        missingCount: 10,
        overdueCount: 0,
        missing: [],
      },
    ],
    severity: 'critical',
    ...GEN,
  } as never);
  vi.mocked(api.getScorecardExpirations).mockResolvedValue({
    buckets: { red: [], amber: [], green: [] },
    attestations: [attestation('overdue')],
    severity: 'critical',
    ...GEN,
  });
  vi.mocked(api.getScorecardShifts).mockResolvedValue({ windowDays: 30, signals: [], severity: 'ok', ...GEN });
  vi.mocked(api.getScorecardBilling).mockResolvedValue({ rateChecks: [], atRiskStatements: [], unpaidFinalCount: 0, attestations: [], severity: 'ok', ...GEN });
  vi.mocked(api.getScorecardTraining).mockResolvedValue({
    signals: [{ tag: 'FOOD_HANDLER', label: 'Food handler certification', contractClause: 'FDA', status: 'no_course', completedCount: 0, totalAssociates: 10, missing: [], missingIds: [], courses: [] }],
    severity: 'ok',
    ...GEN,
  } as never);
  vi.mocked(api.getScorecardSafety).mockResolvedValue({
    daysSinceLastRecordable: 6,
    recordableCountYtd: 2,
    dartCountYtd: 1,
    hoursWorkedYtd: 1239,
    trir: 322.95,
    dart: 161.47,
    openIncidents: [],
    attestations: [],
    severity: 'warn',
    ...GEN,
  });
  vi.mocked(api.getScorecardHistory).mockResolvedValue({
    points: [
      { day: '2026-10-15', score: 40, criticalCount: 1, warnCount: 1, activeAssociateCount: 10, fullyCompliantCount: 0 },
      { day: '2026-10-22', score: 17, criticalCount: 35, warnCount: 39, activeAssociateCount: 10, fullyCompliantCount: 0 },
    ],
    weekDelta: -23,
  } as never);
  vi.mocked(api.getScorecardActions).mockResolvedValue(actionsResponse([...NAMES.map((_, i) => bgAction(i)), shiftAction(1)]));
  vi.mocked(api.setScorecardActionState).mockReset();
  vi.mocked(api.setScorecardActionState).mockImplementation(async (input) => ({
    state: { status: input.status ?? 'OPEN', assigneeUserId: input.assigneeUserId ?? null, assigneeEmail: null, snoozedUntil: input.snoozedUntil ?? null, updatedAt: NOW },
  }) as never);
});

describe('groupScorecardActions', () => {
  it('folds a signal with several people into one row and leaves one-offs alone', () => {
    const entries = groupScorecardActions([bgAction(0), shiftAction(1), bgAction(1), bgAction(2)]);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: 'group', key: 'onb:BACKGROUND_CHECK', label: 'Background check on file' });
    expect(entries[0]!.kind === 'group' && entries[0]!.actions.map((a) => a.subject.associateName)).toEqual(['Aaliyah Brooks', 'Dana Reyes', 'Gerodney Lee']);
    expect(entries[1]).toMatchObject({ kind: 'single' });
  });

  it('a signal with one person missing it stays a plain row', () => {
    expect(groupScorecardActions([bgAction(0), shiftAction(1)]).map((e) => e.kind)).toEqual(['single', 'single']);
  });
});

describe('<ComplianceScorecard> Open actions', () => {
  it('shows ten people missing one signal as one row, opened to list them, with Fix to the owning tab', async () => {
    const user = userEvent.setup();
    renderScorecard();
    const list = await screen.findByRole('list', { name: 'Open actions' });
    const group = within(list).getByRole('button', { name: /Background check on file · 10 people/ });
    expect(group).toHaveAttribute('aria-expanded', 'false');
    expect(within(list).queryByText('Aaliyah Brooks')).not.toBeInTheDocument();
    expect(within(list).getByRole('link', { name: 'Fix: Background check on file' })).toHaveAttribute('href', '/compliance?tab=background');
    // "11 actions, grouped into 2 rows": the fold is honest about what it holds.
    expect(screen.getByText(/11 actions, grouped into 2 rows/)).toBeInTheDocument();
    await user.click(group);
    expect(group).toHaveAttribute('aria-expanded', 'true');
    expect(within(list).getByText('Aaliyah Brooks')).toBeInTheDocument();
    expect(within(list).getAllByText('Coastal Resort Holdings').length).toBe(10);
  });

  it('keeps Fix in view and puts I’ve got it, Snooze and Done in a ⋯ menu', async () => {
    const user = userEvent.setup();
    renderScorecard();
    const list = await screen.findByRole('list', { name: 'Open actions' });
    expect(within(list).queryByRole('button', { name: /I've got it/ })).not.toBeInTheDocument();
    expect(within(list).queryByRole('button', { name: /Snooze 7d/ })).not.toBeInTheDocument();
    await user.click(within(list).getByRole('button', { name: 'More for Shift signal 1: 50% (target 97%)' }));
    expect(await screen.findByRole('menuitem', { name: "I've got it" })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Snooze 7 days' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Mark done' })).toBeInTheDocument();
  });

  it('snoozes a whole signal from its ⋯ menu', async () => {
    const user = userEvent.setup();
    renderScorecard();
    const list = await screen.findByRole('list', { name: 'Open actions' });
    await user.click(within(list).getByRole('button', { name: 'More for Background check on file' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Snooze all 10 for 7 days' }));
    await waitFor(() => expect(api.setScorecardActionState).toHaveBeenCalledTimes(10));
    expect(vi.mocked(api.setScorecardActionState).mock.calls.map((c) => c[0].actionId).sort()).toEqual(NAMES.map((_, i) => bgAction(i).id).sort());
    expect(vi.mocked(api.setScorecardActionState).mock.calls[0]![0]).toMatchObject({ status: 'SNOOZED' });
  });

  it('pages at 25 rows', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getScorecardActions).mockResolvedValue(actionsResponse(Array.from({ length: 30 }, (_, i) => shiftAction(i))));
    renderScorecard();
    const list = await screen.findByRole('list', { name: 'Open actions' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(25);
    await user.click(screen.getByRole('button', { name: 'Show 5 more' }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(30);
  });
});

describe('<ComplianceScorecard> tiles', () => {
  it('Expiring documents with nothing expiring is not Critical; the attestations below carry their own badge', async () => {
    renderScorecard();
    const heading = await screen.findByText('Expiring documents (next 90 days)');
    const tile = heading.closest('[class*="border"]')!.parentElement as HTMLElement;
    const attHeading = await within(tile).findByText('Insurance attestations');
    expect(within(attHeading.parentElement!).getByText('Critical')).toBeInTheDocument();
    // The tile's own badge says nothing is expiring — neutral, never a
    // green "OK" over three empty buckets (F500 audit 2026-10-26).
    const headerRow = heading.parentElement!.parentElement!;
    expect(within(headerRow).getByText('Nothing expiring')).toBeInTheDocument();
    expect(within(headerRow).queryByText('OK')).not.toBeInTheDocument();
  });

  it('an empty expiry bucket is a plain zero, not red, amber or green', async () => {
    renderScorecard();
    const bucket = await screen.findByRole('button', { name: 'Open the full 0–30 days list' });
    const tile = bucket.firstElementChild as HTMLElement;
    expect(tile).toHaveTextContent('0');
    expect(tile.className).not.toMatch(/alert|warning|success/);
  });

  it('a bill-rate check that matched no job does not pass', async () => {
    vi.mocked(api.getScorecardBilling).mockResolvedValue({
      rateChecks: [{ jobId: uuid(1), jobName: 'Housekeeper', clientId: uuid(2), clientName: 'Coastal', billRate: 21, expectedRate: null, match: true }],
      atRiskStatements: [],
      unpaidFinalCount: 0,
      attestations: [],
      severity: 'ok',
      ...GEN,
    } as never);
    renderScorecard();
    expect(await screen.findByText('No active job matches a SOW rate pattern, so no bill rate was checked.')).toBeInTheDocument();
    expect(screen.queryByText(/matched jobs bill at the contracted rate/)).not.toBeInTheDocument();
  });

  it('training with no course linked is "Not tracked", not a green OK', async () => {
    renderScorecard();
    await screen.findByText('Food handler certification');
    const heading = screen.getByText('Training completeness');
    const headerRow = heading.parentElement!.parentElement!;
    expect(within(headerRow).getByText('Not tracked')).toBeInTheDocument();
    expect(within(headerRow).queryByText('OK')).not.toBeInTheDocument();
  });

  it('a truncated list says it shows 200 of the total, and All counts the total', async () => {
    const many = Array.from({ length: 200 }, (_, i) => shiftAction(i));
    vi.mocked(api.getScorecardActions).mockResolvedValue({ ...actionsResponse(many), truncated: true, totalActionCount: 235, warnCount: 235 });
    renderScorecard();
    expect(await screen.findByTestId('actions-truncated')).toHaveTextContent('Showing 200 of 235 open actions');
    expect(screen.getByRole('button', { name: /^All/ })).toHaveTextContent('235');
  });

  it('shows the case count, not a TRIR of 322.95, on 1,239 hours', async () => {
    renderScorecard();
    expect(await screen.findByText(/2 recordables · rates shown after 20,000 h/)).toBeInTheDocument();
    expect(screen.queryByText('322.95')).not.toBeInTheDocument();
    expect(screen.queryByText('161.47')).not.toBeInTheDocument();
  });

  it('no button sits inside another button (signal rows, training rows)', async () => {
    const { container } = renderScorecard();
    await screen.findByText('I-9 Section 1 + Section 2');
    await screen.findByText('Food handler certification');
    expect(container.querySelectorAll('button button')).toHaveLength(0);
    expect(screen.getByRole('button', { name: /I-9 Section 1 \+ Section 2: 0 of 10/ })).toBeInTheDocument();
  });

  it('says "No course linked" and links to Learning, without the code identifier', async () => {
    renderScorecard();
    expect(await screen.findByText('No course linked')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Link a course in Learning' })).toHaveAttribute('href', '/learning');
    expect(screen.queryByText(/complianceTag/)).not.toBeInTheDocument();
    expect(screen.queryByText('Tag a course')).not.toBeInTheDocument();
  });

  it('dates the weekly change of the score', async () => {
    renderScorecard();
    expect(await screen.findByText(/−23 · was 40 on Oct 15, 2026/)).toBeInTheDocument();
    expect(screen.queryByText(/-23 wk/i)).not.toBeInTheDocument();
  });
});
