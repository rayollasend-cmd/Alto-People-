import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { renderAs } from '../hrPack/harness';

const api = vi.hoisted(() => ({
  listMyEnrollments: vi.fn(),
  listMyPlans: vi.fn(),
  getBenefitsOverview: vi.fn(),
  enrollMe: vi.fn(),
  terminateMyEnrollment: vi.fn(),
}));
vi.mock('@/lib/benefitsApi', async (orig) => ({ ...(await orig<typeof import('@/lib/benefitsApi')>()), ...api }));
const tax = vi.hoisted(() => ({ getAcaSummary: vi.fn() }));
vi.mock('@/lib/taxcompApi', async (orig) => ({ ...(await orig<typeof import('@/lib/taxcompApi')>()), ...tax }));

import { BenefitsHome } from '@/pages/benefits/BenefitsHome';

/**
 * /benefits for both sides (F500 G6): HR and finance land on the desk
 * (they used to get one sentence), and an associate sees the plans their
 * employer offers (they used to get "Could not load your benefits").
 */

const OVERVIEW = {
  totals: { activePlans: 3, enrolledPeople: 3, employeeCentsPerPeriod: 13800, employerCentsPerPeriod: 29000, lifeEventsWaiting: 2, cobraPending: 1 },
  clients: [
    {
      clientId: 'c1',
      clientName: 'Coastal Resort',
      plans: [
        { id: 'p1', clientId: 'c1', name: 'PPO 500', kind: 'HEALTH_MEDICAL', isActive: true, enrolled: 2, employeeCentsPerPeriod: 10500, employerCentsPerPeriod: 24000 },
        { id: 'p2', clientId: 'c1', name: 'Dental basic', kind: 'DENTAL', isActive: true, enrolled: 1, employeeCentsPerPeriod: 800, employerCentsPerPeriod: 0 },
      ],
    },
  ],
  openEnrollment: [{ id: 'w1', clientId: 'c1', clientName: 'Coastal Resort', name: '2027 plan year', status: 'OPEN', startsOn: '2026-11-01', endsOn: '2026-11-15', effectiveOn: '2027-01-01' }],
  carriers: [{ id: 'k1', name: 'Blue Cross', active: true, members: 2, lastFile: { createdAt: '2026-10-15T12:00:00.000Z', mode: 'CHANGE', status: 'FAILED', controlNumber: 12, memberCount: 2 } }],
};

beforeEach(() => {
  for (const f of [...Object.values(api), ...Object.values(tax)]) f.mockReset();
  api.getBenefitsOverview.mockResolvedValue(OVERVIEW);
  tax.getAcaSummary.mockResolvedValue({ counts: { offersDue: 2, offersOverdue: 1 } });
  api.listMyEnrollments.mockResolvedValue({ enrollments: [] });
});

describe('/benefits for the people who run it', () => {
  it('finance sees who is enrolled, what goes in each pay period, and what is waiting — each linked', async () => {
    renderAs('FINANCE_ACCOUNTANT', <BenefitsHome />, '/benefits');
    const strip = await screen.findByRole('group', { name: 'Benefits at a glance' });
    await waitFor(() => expect(within(strip).getByText('Each pay period').parentElement).toHaveTextContent('$428.00'));
    expect(within(strip).getByText('Each pay period').parentElement).toHaveTextContent('Employees $138.00 · company $290.00');
    await waitFor(() => expect(within(strip).getByText('ACA offers owed').closest('a')).toHaveTextContent('3'));
    expect(within(strip).getByText('ACA offers owed').closest('a')).toHaveAttribute('href', '/benefits/aca');
    expect(within(strip).getByText('Carrier feeds').closest('a')).toHaveTextContent('1 last file failed');
    for (const link of screen.getAllByRole('link', { name: 'Coastal Resort' })) expect(link).toHaveAttribute('href', '/clients/c1?section=benefits');
    expect(screen.getByText('2027 plan year', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('Open now')).toBeInTheDocument();
    // Not the old dead end.
    expect(screen.queryByText(/isn’t linked to one/)).toBeNull();
    expect(api.listMyPlans).not.toHaveBeenCalled();
  });

  it('HR admin gets the life-events and COBRA tiles linked to the lifecycle tabs', async () => {
    renderAs('HR_ADMINISTRATOR', <BenefitsHome />, '/benefits');
    const strip = await screen.findByRole('group', { name: 'Benefits at a glance' });
    await waitFor(() => expect(within(strip).getByText('Life events waiting').closest('a')).toHaveAttribute('href', '/benefits/lifecycle?tab=qle'));
    expect(within(strip).getByText('COBRA offers open').closest('a')).toHaveAttribute('href', '/benefits/lifecycle?tab=cobra');
  });
});

describe('/benefits for an associate', () => {
  it('shows the plans from GET /benefits/plans/mine — no client lookup first', async () => {
    api.listMyPlans.mockResolvedValue({
      client: { id: 'c1', name: 'Coastal Resort' },
      plans: [{ id: 'p1', clientId: 'c1', kind: 'DENTAL', name: 'Dental basic', description: null, employerContributionCentsPerPeriod: 0, employeeContributionDefaultCentsPerPeriod: 800, isActive: true }],
    });
    renderAs('ASSOCIATE', <BenefitsHome />, '/benefits', { associateId: 'a1' });
    expect(await screen.findByText('Dental basic')).toBeInTheDocument();
    expect(screen.getByText(/1 plan is available to elect/)).toBeInTheDocument();
    expect(api.getBenefitsOverview).not.toHaveBeenCalled();
  });

  it('an error says so once — no “when HR opens enrollment” card under it', async () => {
    api.listMyPlans.mockRejectedValue(new Error('boom'));
    renderAs('ASSOCIATE', <BenefitsHome />, '/benefits', { associateId: 'a1' });
    expect(await screen.findByText('Could not load your benefits.')).toBeInTheDocument();
    expect(screen.queryByText(/When HR opens enrollment/)).toBeNull();
    expect(screen.queryByText('Available plans')).toBeNull();
  });
});
