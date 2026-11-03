import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BackgroundCheck, BackgroundPerson, DrugTest } from '@alto-people/shared';
import { renderAs } from '../hrPack/harness';

/**
 * Background checks and drug tests about the CURRENT workforce (owner,
 * 2026-11-03): the tab asks for one group, shows each person once on their
 * newest check so the tiles count people, lists the never-screened under
 * "No passed check", says so when a link names someone with no check, and
 * never offers "Mark failed" where the FCRA steps must decide it.
 */

vi.mock('@/lib/complianceApi', () => ({
  listBackgroundChecks: vi.fn(),
  getBackgroundCheckDetail: vi.fn(),
  listPendingBackgroundChecks: vi.fn(),
  bulkInitiateBackgroundChecks: vi.fn(),
  updateBackgroundCheck: vi.fn(),
  listAdverseActions: vi.fn(),
  sendPreAdverse: vi.fn(),
  sendFinalAdverse: vi.fn(),
  withdrawAdverse: vi.fn(),
  listDrugTests: vi.fn(),
  getDrugTestDetail: vi.fn(),
  listPendingDrugTests: vi.fn(),
  bulkInitiateDrugTests: vi.fn(),
  updateDrugTest: vi.fn(),
  sendDrugPreAdverse: vi.fn(),
  sendDrugFinalAdverse: vi.fn(),
  withdrawDrugAdverse: vi.fn(),
}));
vi.mock('@/pages/compliance/providers/BackgroundProviderPanel', () => ({ BackgroundProviderPanel: () => null }));
vi.mock('@/pages/compliance/providers/DrugProviderPanel', () => ({ DrugProviderPanel: () => null }));

import {
  getBackgroundCheckDetail,
  getDrugTestDetail,
  listAdverseActions,
  listBackgroundChecks,
  listDrugTests,
  listPendingBackgroundChecks,
} from '@/lib/complianceApi';
import { BackgroundTab } from '@/pages/compliance/BackgroundTab';
import { DrugTestTab } from '@/pages/compliance/DrugTestTab';

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function check(over: Partial<BackgroundCheck>): BackgroundCheck {
  return {
    id: ID(1),
    associateId: ID(2),
    associateName: 'Pat Hopeful',
    clientId: null,
    provider: 'Sterling',
    externalId: null,
    status: 'PASSED',
    initiatedAt: '2026-10-20T12:00:00.000Z',
    completedAt: '2026-10-22T12:00:00.000Z',
    reportCount: 1,
    workStatus: 'ACTIVE',
    viaProvider: false,
    adjudication: null,
    ...over,
  };
}

function person(over: Partial<BackgroundPerson>): BackgroundPerson {
  return {
    associateId: ID(2),
    associateName: 'Pat Hopeful',
    clientId: null,
    workStatus: 'ACTIVE',
    latestCheckId: null,
    latestStatus: null,
    lastPassedAt: null,
    ...over,
  };
}

function test(over: Partial<DrugTest>): DrugTest {
  return {
    id: ID(11),
    associateId: ID(12),
    associateName: 'Lee Tested',
    clientId: null,
    provider: 'eScreen',
    externalId: null,
    status: 'NEEDS_REVIEW',
    initiatedAt: '2026-10-25T12:00:00.000Z',
    completedAt: null,
    reportCount: 0,
    workStatus: 'ACTIVE',
    viaCra: false,
    adjudication: null,
    ...over,
  };
}

const counts = { current: 2, starting: 0, paused: 1, former: 3, all: 6 };

beforeEach(() => {
  localStorage.clear();
  vi.mocked(listBackgroundChecks).mockReset();
  vi.mocked(listAdverseActions).mockReset().mockResolvedValue({ rows: [] });
  vi.mocked(getBackgroundCheckDetail).mockReset();
  vi.mocked(listDrugTests).mockReset();
  vi.mocked(getDrugTestDetail).mockReset().mockResolvedValue({ test: test({}), reports: [] });
});

describe('Background tab: one group, counted by people', () => {
  it('asks for the current workforce, counts a re-screened person once, and lists the never-screened under “No passed check”', async () => {
    const twice = [
      check({ id: ID(1), initiatedAt: '2026-10-20T12:00:00.000Z' }),
      check({ id: ID(3), initiatedAt: '2025-01-10T12:00:00.000Z', completedAt: '2025-01-12T12:00:00.000Z' }),
    ];
    vi.mocked(listBackgroundChecks).mockResolvedValue({
      checks: twice,
      workforce: 'current',
      workforceCounts: counts,
      people: [
        person({ latestCheckId: ID(1), latestStatus: 'PASSED', lastPassedAt: '2026-10-22T12:00:00.000Z' }),
        person({ associateId: ID(4), associateName: 'Nia Unscreened' }),
      ],
    });
    renderAs('HR_ADMINISTRATOR', <BackgroundTab canManage />, '/compliance?tab=background');

    const passed = await screen.findByRole('button', { name: /Passed/, pressed: false });
    expect(listBackgroundChecks).toHaveBeenCalledWith({ workforce: 'current' });
    // Two passed checks, one person.
    expect(within(passed).getByText('1')).toBeInTheDocument();
    expect(within(screen.getByTestId('compliance-workforce')).getByRole('button', { name: /Current/ })).toHaveAttribute('aria-pressed', 'true');
    // The earlier check is folded away; the never-screened person is not a ledger row.
    expect(screen.queryByText('Nia Unscreened')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /No passed check/ }));
    expect(await screen.findAllByText('Nia Unscreened')).not.toHaveLength(0);
    expect(screen.getAllByText('No check').length).toBeGreaterThan(0);
  });

  it('a link to someone with no check opens on All and says so, with a way to order one', async () => {
    vi.mocked(listBackgroundChecks).mockResolvedValue({
      checks: [],
      workforce: 'all',
      workforceCounts: counts,
      people: [person({ associateId: ID(9), associateName: 'Sam Nocheck', workStatus: 'DEACTIVATED' })],
    });
    renderAs('HR_ADMINISTRATOR', <BackgroundTab canManage />, `/compliance?tab=background&associateId=${ID(9)}`);
    expect(await screen.findByText('Sam Nocheck has no background check on file.')).toBeInTheDocument();
    expect(listBackgroundChecks).toHaveBeenCalledWith({ workforce: 'all' });
    expect(screen.getByRole('button', { name: /Order a check/ })).toBeInTheDocument();
  });

  it('the drawer has no “Mark failed”: a report to decide offers “Clear to work” and says the FCRA steps', async () => {
    const review = check({ status: 'NEEDS_REVIEW', result: 'consider', completedAt: null, reportCount: 0 });
    vi.mocked(listBackgroundChecks).mockResolvedValue({ checks: [review], workforce: 'all', workforceCounts: counts, people: [] });
    vi.mocked(getBackgroundCheckDetail).mockResolvedValue({ check: review, reports: [] });
    renderAs('HR_ADMINISTRATOR', <BackgroundTab canManage />, `/compliance?tab=background&associateId=${ID(2)}`);
    expect(await screen.findByRole('button', { name: 'Clear to work' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark failed' })).toBeNull();
    expect(screen.getByText(/To fail this check, take the adverse-action steps/)).toBeInTheDocument();
  });

  it('a worklist row outside the list on screen opens by id instead of a toast', async () => {
    vi.mocked(listBackgroundChecks).mockResolvedValue({ checks: [], workforce: 'current', workforceCounts: counts, people: [] });
    vi.mocked(listAdverseActions).mockResolvedValue({
      rows: [{ checkId: ID(7), associateId: ID(8), associateName: 'Rae Elsewhere', stage: 'DECIDE', waitUntil: null, preAdverseSentAt: null, adverseSentAt: null, result: 'consider', status: 'NEEDS_REVIEW', viaProvider: false }],
    });
    const far = check({ id: ID(7), associateId: ID(8), associateName: 'Rae Elsewhere', status: 'NEEDS_REVIEW', workStatus: 'ONBOARDING' });
    vi.mocked(getBackgroundCheckDetail).mockResolvedValue({ check: far, reports: [] });
    renderAs('HR_ADMINISTRATOR', <BackgroundTab canManage />, '/compliance?tab=background');
    await userEvent.click(await screen.findByRole('button', { name: 'Rae Elsewhere' }));
    await waitFor(() => expect(getBackgroundCheckDetail).toHaveBeenCalledWith(ID(7)));
    expect(await screen.findByRole('heading', { name: 'Rae Elsewhere' })).toBeInTheDocument();
    // The drawer used that read: the report list was disclosed once.
    expect(getBackgroundCheckDetail).toHaveBeenCalledTimes(1);
  });

  it('the Inbox’s link opens the worklist on Current + Starting soon; the chip hands back to the tab’s group', async () => {
    vi.mocked(listBackgroundChecks).mockResolvedValue({ checks: [check({})], workforce: 'current', workforceCounts: counts, people: [] });
    vi.mocked(listAdverseActions).mockResolvedValue({
      rows: [{ checkId: ID(7), associateId: ID(8), associateName: 'Rae Applicant', stage: 'DECIDE', waitUntil: null, preAdverseSentAt: null, adverseSentAt: null, result: 'consider', status: 'NEEDS_REVIEW', viaProvider: false, workStatus: 'ONBOARDING' }],
      workforces: ['current', 'starting'],
    });
    renderAs('HR_ADMINISTRATOR', <BackgroundTab canManage />, '/compliance?tab=background&workforce=current,starting');
    const chip = await screen.findByRole('button', { name: 'Current + Starting soon' });
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    expect(listAdverseActions).toHaveBeenCalledWith({ workforce: ['current', 'starting'] });
    // The ledger keeps one group.
    expect(listBackgroundChecks).toHaveBeenCalledWith({ workforce: 'current' });
    expect(screen.getByText('Rae Applicant')).toBeInTheDocument();

    await userEvent.click(chip);
    await waitFor(() => expect(listAdverseActions).toHaveBeenLastCalledWith({ workforce: 'current' }));
  });

  it('the bulk order ticks Current and Starting soon and leaves Paused unticked', async () => {
    vi.mocked(listBackgroundChecks).mockResolvedValue({ checks: [check({})], workforce: 'current', workforceCounts: counts, people: [] });
    const row = (n: number, group: 'current' | 'starting' | 'paused') => ({
      associateId: ID(100 + n), firstName: `F${n}`, lastName: 'Roster', email: `r${n}@x.co`, phone: null,
      status: group === 'current' ? ('ACTIVE' as const) : group === 'starting' ? ('PENDING' as const) : ('INACTIVE' as const),
      group, workStatus: null, lastStatus: null,
    });
    vi.mocked(listPendingBackgroundChecks).mockResolvedValue({ rows: [row(1, 'current'), row(2, 'starting'), row(3, 'paused')], truncated: false });
    renderAs('HR_ADMINISTRATOR', <BackgroundTab canManage />, '/compliance?tab=background');
    await userEvent.click(await screen.findByRole('button', { name: /Bulk order CSV/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('checkbox', { name: /Current/ })).toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: /Starting soon/ })).toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: /Paused/ })).not.toBeChecked();
    expect(within(dialog).getByText(/never-screened people selected/)).toHaveTextContent('2');
  });
});

describe('Drug test tab', () => {
  it('a result through a consumer reporting agency offers no “Mark failed”; a lab result does', async () => {
    const viaAgency = test({ provider: 'Checkr', viaCra: true });
    vi.mocked(listDrugTests).mockResolvedValue({ tests: [viaAgency], workforce: 'all', workforceCounts: counts, people: [] });
    vi.mocked(getDrugTestDetail).mockResolvedValue({ test: viaAgency, reports: [] });
    const first = renderAs('HR_ADMINISTRATOR', <DrugTestTab canManage />, `/compliance?tab=drugtests&associateId=${ID(12)}`);
    expect(await screen.findByRole('button', { name: 'Mark passed' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark failed' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Send pre-adverse notice' })).toBeInTheDocument();
    first.unmount();

    const lab = test({});
    vi.mocked(listDrugTests).mockResolvedValue({ tests: [lab], workforce: 'all', workforceCounts: counts, people: [] });
    vi.mocked(getDrugTestDetail).mockResolvedValue({ test: lab, reports: [] });
    renderAs('HR_ADMINISTRATOR', <DrugTestTab canManage />, `/compliance?tab=drugtests&associateId=${ID(12)}`);
    expect(await screen.findByRole('button', { name: 'Mark failed' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send pre-adverse notice' })).toBeNull();
  });

  it('opens on the Inbox’s view: newest tests needing review, current workforce', async () => {
    vi.mocked(listDrugTests).mockResolvedValue({
      tests: [test({}), test({ id: ID(13), associateId: ID(14), associateName: 'Bo Passed', status: 'PASSED', completedAt: '2026-10-26T12:00:00.000Z' })],
      workforce: 'current',
      workforceCounts: counts,
      people: [],
    });
    renderAs('HR_ADMINISTRATOR', <DrugTestTab canManage />, '/compliance?tab=drugtests&status=NEEDS_REVIEW&workforce=current');
    expect((await screen.findAllByText('Lee Tested')).length).toBeGreaterThan(0);
    expect(listDrugTests).toHaveBeenCalledWith({ workforce: 'current' });
    expect(screen.queryByText('Bo Passed')).toBeNull();
  });

  it('an order records why: the dialog waits for a reason', async () => {
    vi.mocked(listDrugTests).mockResolvedValue({ tests: [test({})], workforce: 'current', workforceCounts: counts, people: [] });
    renderAs('HR_ADMINISTRATOR', <DrugTestTab canManage />, '/compliance?tab=drugtests');
    await userEvent.click(await screen.findByRole('button', { name: /Order test/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Order test' })).toBeDisabled();
    expect(within(dialog).getByRole('combobox', { name: /Reason/ })).toHaveValue('');
  });
});
