import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HUMAN_ROLES, ROLE_CAPABILITIES } from '@alto-people/shared';
import { renderAs } from '../hrPack/harness';

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), message: vi.fn(), loading: vi.fn(), dismiss: vi.fn() }));
vi.mock('sonner', async (orig) => ({ ...(await orig<typeof import('sonner')>()), toast: toastMock }));
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));
vi.mock('@/lib/useClients', () => ({
  useClients: () => ({ clients: [{ id: 'c1', name: 'Coastal Resort' }], isLoading: false, isError: false, error: null, refetch: vi.fn(), reload: vi.fn() }),
}));
vi.mock('@/lib/recruiting90Api', async (orig) => ({
  ...(await orig<typeof import('@/lib/recruiting90Api')>()),
  payFromRateCard: vi.fn(),
}));
vi.mock('@/lib/dirCommsApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/dirCommsApi')>()),
  broadcastAudienceCount: vi.fn(),
  createBroadcast: vi.fn(),
  listBroadcastTemplates: vi.fn().mockResolvedValue({ broadcasts: [] }),
}));
vi.mock('@/lib/communicationsApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/communicationsApi')>()),
  listChannels: vi.fn().mockResolvedValue({ channels: [] }),
}));
vi.mock('@/lib/orgApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/orgApi')>()),
  listDepartments: vi.fn().mockResolvedValue({ departments: [] }),
  listCostCenters: vi.fn().mockResolvedValue({ costCenters: [] }),
  listSites: vi.fn().mockResolvedValue({ sites: [] }),
}));
vi.mock('@/lib/skills111Api', async (orig) => ({
  ...(await orig<typeof import('@/lib/skills111Api')>()),
  listMySkills: vi.fn(),
  claimMySkill: vi.fn(),
  withdrawMySkill: vi.fn(),
  listPendingSkillClaims: vi.fn(),
  verifyAssociateSkill: vi.fn(),
  listSkills: vi.fn().mockResolvedValue({ skills: [] }),
}));

import { ApiError, apiFetch } from '@/lib/api';
import { payFromRateCard } from '@/lib/recruiting90Api';
import { broadcastAudienceCount, createBroadcast } from '@/lib/dirCommsApi';
import { claimMySkill, listMySkills, listPendingSkillClaims, verifyAssociateSkill } from '@/lib/skills111Api';
import { AgentDecisionRecordTab } from '@/pages/admin/AgentDecisionRecordTab';
import { NewPostingDrawer } from '@/pages/recruiting/RecruitingExtras';
import { BroadcastDrawer } from '@/pages/dirComms/BroadcastDrawer';
import { MySkillsCard } from '@/pages/me/MySkillsCard';
import { SkillsHome } from '@/pages/skills/SkillsHome';
import { REPORT_TEMPLATES } from '@/pages/reports/reportTemplates';

/**
 * Wave 2, HR and recruiting: decision notices that really send (or say
 * why not), the report templates that answer their question, pay from the
 * rate card on a gap's posting, a broadcast to the people picked, and
 * associates adding their own skills for HR to verify.
 */

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  for (const f of Object.values(toastMock)) f.mockReset();
});

describe('decision notices', () => {
  const record = {
    profiles: [],
    audits: [],
    decisions: [{ id: 'd1', at: '2026-10-20T12:00:00Z', capabilityKey: 'shift.fill', decisionType: 'HIRING', subject: 'Ivy Applicant', outcome: 'ADVERSE', summary: 'Not advanced.', jurisdictionTags: [], humanDecidedAt: '2026-10-20T12:00:00Z', noticeGivenAt: null, explanationSentAt: null, reviewRequestedAt: null }],
  };

  it('“Send the notice” says where it went', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      if (path.endsWith('/decision-record')) return record;
      return { id: 'd1', delivered: true, delivery: { channel: 'EMAIL', status: 'SENT', to: 'ivy@example.com' } };
    });
    const user = userEvent.setup();
    renderAs('HR_ADMINISTRATOR', <AgentDecisionRecordTab agentId="w1" canManage />);
    await user.click(await screen.findByRole('button', { name: 'Send the notice' }));
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('Emailed to ivy@example.com.'));
    expect(apiFetch).toHaveBeenCalledWith('/agents/decisions/d1/events', { method: 'POST', body: { event: 'notice_given' } });
  });

  it('when the email did not go out, it says so and offers to record it as given on paper', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path: string, opts?: { body?: { channel?: string } }) => {
      if (path.endsWith('/decision-record')) return record;
      if (!opts?.body?.channel) throw new ApiError(409, 'notice_not_sent', 'The email to ivy@example.com didn’t go out (email isn’t set up). Nothing was recorded.');
      return { id: 'd1', delivered: false, delivery: { channel: 'PAPER', status: 'BY_HAND', to: null } };
    });
    const user = userEvent.setup();
    renderAs('HR_ADMINISTRATOR', <AgentDecisionRecordTab agentId="w1" canManage />);
    await user.click(await screen.findByRole('button', { name: 'Send the notice' }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
    const [message, options] = toastMock.error.mock.calls[0]! as [string, { action: { label: string; onClick: () => void } }];
    expect(message).toMatch(/didn’t go out/);
    expect(options.action.label).toBe('Given on paper');
    options.action.onClick();
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/agents/decisions/d1/events', { method: 'POST', body: { event: 'notice_given', channel: 'PAPER' } }));
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('Recorded as given by hand.'));
  });
});

describe('the report templates answer their question', () => {
  it('terminations last quarter, headcount by store, pay changes, time to fill and overtime by store use the engine’s columns', () => {
    const by = Object.fromEntries(REPORT_TEMPLATES.map((t) => [t.key, t]));
    expect(by['terminations-by-reason']!.spec.filters).toEqual([{ column: 'lastDayWorked', op: 'period', value: 'last-quarter' }]);
    expect(by['headcount-by-store']).toMatchObject({ entity: 'ASSOCIATE', spec: { groupBy: ['store'] } });
    expect(by['pay-changes']).toMatchObject({ entity: 'PAY_CHANGE', requires: 'view:comp' });
    expect(by['pay-changes']!.spec.columns).toEqual(expect.arrayContaining(['previousAmount', 'amount', 'change']));
    expect(by['time-to-fill']).toMatchObject({ entity: 'TIME_TO_FILL', spec: { groupBy: ['posting'] } });
    expect(by['overtime-by-store']).toMatchObject({ entity: 'OVERTIME', spec: { groupBy: ['store'] } });
    expect(REPORT_TEMPLATES).toHaveLength(10);
  });

  it('a template the person can’t run is not offered', async () => {
    const { ReportsHome } = await import('@/pages/reports/ReportsHome');
    vi.mocked(apiFetch).mockResolvedValue({ reports: [] });
    const role = HUMAN_ROLES.find((r) => ROLE_CAPABILITIES[r].has('view:analytics') && !ROLE_CAPABILITIES[r].has('view:comp'));
    expect(role).toBeTruthy();
    renderAs(role!, <ReportsHome />, '/reports');
    const gallery = await screen.findByRole('region', { name: 'Start from a template' });
    expect(within(gallery).queryByRole('button', { name: /Pay changes/ })).toBeNull();
    expect(within(gallery).getByRole('button', { name: /New hires this month/ })).toBeInTheDocument();
  });
});

describe('a posting opened from a staffing gap', () => {
  it('starts at the pay on the client’s rate card', async () => {
    vi.mocked(payFromRateCard).mockResolvedValue({
      clientId: 'c1',
      clientName: 'Coastal Resort',
      rates: [
        { position: 'Housekeeper', payRate: 15, effectiveFrom: '2026-01-01' },
        { position: 'Houseman', payRate: 16.5, effectiveFrom: '2026-01-01' },
      ],
      suggested: { minPay: 15, maxPay: 16.5, payUnit: 'HOUR', position: null },
    });
    renderAs('INTERNAL_RECRUITER', <NewPostingDrawer seed={{ clientId: 'c1', title: 'Associate — Front Beach', location: 'Front Beach', openings: 23, schedule: 'SEASONAL' }} onClose={() => undefined} onSaved={() => undefined} />);
    expect(await screen.findByDisplayValue('15.00')).toBeInTheDocument();
    expect(screen.getByDisplayValue('16.50')).toBeInTheDocument();
    expect(screen.getByTestId('rate-card-pay')).toHaveTextContent('Coastal Resort’s rate card: Housekeeper $15.00/h · Houseman $16.50/h');
    expect(payFromRateCard).toHaveBeenCalledWith('c1');
  });
});

describe('Message selected', () => {
  it('the broadcast composer takes the people picked as its list', async () => {
    vi.mocked(broadcastAudienceCount).mockResolvedValue({ people: 2, withAccount: 1, withPhone: 1, withEmail: 2 });
    vi.mocked(createBroadcast).mockResolvedValue({ id: 'b1' });
    const user = userEvent.setup();
    const onSaved = vi.fn();
    renderAs('HR_ADMINISTRATOR', <BroadcastDrawer broadcast={null} recipients={[{ id: 'a1', name: 'Ana Lopez' }, { id: 'a2', name: 'Ben Ray' }]} onClose={() => undefined} onSaved={onSaved} />);
    expect(await screen.findByText('Message 2 people')).toBeInTheDocument();
    expect(screen.getByTestId('broadcast-recipients')).toHaveTextContent('Ana Lopez, Ben Ray');
    expect(screen.queryByLabelText('Client')).toBeNull();
    await waitFor(() => expect(broadcastAudienceCount).toHaveBeenCalledWith(expect.objectContaining({ recipientAssociateIds: ['a1', 'a2'] })));
    expect(await screen.findByText(/Reaches 2 selected people/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Title'), 'Badges are ready');
    await user.type(screen.getByLabelText('Body'), 'Pick yours up at the front desk.');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(createBroadcast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Badges are ready', recipientAssociateIds: ['a1', 'a2'] })));
    expect(onSaved).toHaveBeenCalled();
  });
});

describe('associates add their own skills', () => {
  it('the profile control adds a skill, which shows as waiting for HR', async () => {
    vi.mocked(listMySkills)
      .mockResolvedValueOnce({ skills: [], catalog: [{ id: 's1', name: 'Forklift', category: 'Warehouse' }] })
      .mockResolvedValue({ skills: [{ id: 'as1', skillId: 's1', skillName: 'Forklift', category: 'Warehouse', level: 'ADVANCED', yearsExperience: 4, verified: false, selfClaimed: true }], catalog: [{ id: 's1', name: 'Forklift', category: 'Warehouse' }] });
    vi.mocked(claimMySkill).mockResolvedValue({ id: 'as1', pending: true });
    const user = userEvent.setup();
    renderAs('ASSOCIATE', <MySkillsCard />, '/me', { associateId: 'a1' });
    expect(await screen.findByText('No skills on your record yet.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add a skill' }));
    await user.selectOptions(screen.getByLabelText('Skill'), 's1');
    await user.selectOptions(screen.getByLabelText('Level'), 'ADVANCED');
    await user.type(screen.getByLabelText('Years of experience'), '4');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(claimMySkill).toHaveBeenCalledWith({ skillId: 's1', level: 'ADVANCED', yearsExperience: 4 }));
    expect(await screen.findByText('Waiting for HR')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
  });

  it('HR verifies the claims waiting on the Skills page', async () => {
    vi.mocked(listPendingSkillClaims).mockResolvedValue({
      claims: [{ id: 'as1', associateId: 'a1', name: 'Ana Lopez', skillName: 'Forklift', category: 'Warehouse', level: 'ADVANCED', yearsExperience: 4, notes: null, claimedAt: '2026-10-20T12:00:00Z' }],
    });
    vi.mocked(verifyAssociateSkill).mockResolvedValue(undefined as never);
    const user = userEvent.setup();
    renderAs('HR_ADMINISTRATOR', <SkillsHome />, '/skills');
    await user.click(await screen.findByRole('tab', { name: /To verify \(1\)/ }));
    const list = await screen.findByRole('list', { name: 'Skills to verify' });
    expect(within(list).getByText('Ana Lopez')).toBeInTheDocument();
    await user.click(within(list).getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(verifyAssociateSkill).toHaveBeenCalledWith('as1'));
  });
});
