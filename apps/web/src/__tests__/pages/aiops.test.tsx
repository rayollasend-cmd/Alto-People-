import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAs } from './hrPack/harness';

const listCallOuts = vi.fn();
vi.mock('@/lib/callOutsApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/callOutsApi')>()),
  listCallOuts: (...a: unknown[]) => listCallOuts(...a),
  recordCallOutFor: vi.fn(),
}));
const listRetention = vi.fn();
const logPlay = vi.fn();
vi.mock('@/lib/retentionApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/retentionApi')>()),
  listRetention: (...a: unknown[]) => listRetention(...a),
  getRetentionSummary: vi.fn().mockResolvedValue({
    bands: { HIGH: 1, MEDIUM: 2, LOW: 9 },
    stores: [{ id: 's1', name: 'Front Beach', high: 1, medium: 1 }],
    plays: [{ kind: 'CHECK_IN', taken: 4, stayed: 3, left: 1, pending: 0, stayRate: 75 }],
  }),
  getCrewRisk: vi.fn().mockResolvedValue({ high: 1, medium: 2 }),
  logPlay: (...a: unknown[]) => logPlay(...a),
  markPlayDone: vi.fn(),
  recomputeRetention: vi.fn(),
}));
vi.mock('@/lib/schedulingApi', async (orig) => ({ ...(await orig<typeof import('@/lib/schedulingApi')>()), listShifts: vi.fn().mockResolvedValue({ shifts: [] }) }));

import { CallOutsDesk } from '@/pages/callouts/CallOutsDesk';
import { RetentionDesk } from '@/pages/retention/RetentionDesk';
import { CrewSignalsCard } from '@/components/home/CrewSignalsCard';

const soon = new Date(Date.now() + 3 * 3_600_000).toISOString();
const item = (over: Record<string, unknown>) => ({
  id: 'c1',
  associateId: 'a1',
  name: 'Ana Lopez',
  photoUrl: null,
  channel: 'VOICE',
  reason: 'SICK',
  note: 'Fever since last night',
  late: false,
  excused: true,
  excusedWhy: 'Sick — covered by accrued sick time',
  minutesBeforeStart: 180,
  hasRecording: true,
  calledOutAt: new Date().toISOString(),
  shift: { id: 's1', position: 'Cashier', startsAt: soon, endsAt: soon, place: 'Front Beach', timezone: 'America/Chicago' },
  cover: { state: 'looking', by: null, steps: [{ key: 'post', status: 'done', detail: 'Released and posted to Open shifts.' }, { key: 'bench', status: 'done', detail: '3 on the bench invited.' }] },
  ...over,
});

beforeEach(() => {
  listCallOuts.mockReset();
  listRetention.mockReset();
  logPlay.mockReset();
});

describe('<CallOutsDesk>', () => {
  it('puts what still needs cover first, with the reason, the channel and the steps already taken', async () => {
    listCallOuts.mockResolvedValue({ range: 'today', total: 2, covered: 1, looking: 1, uncovered: 0, late: 1, truncated: false, items: [item({}), item({ id: 'c2', name: 'Bo Ray', channel: 'APP', late: true, minutesBeforeStart: 45, excused: false, excusedWhy: null, hasRecording: false, note: null, cover: { state: 'covered', by: 'Cal Crew', steps: [] } })] });
    renderAs('SHIFT_SUPERVISOR', <CallOutsDesk />, '/call-outs');
    const looking = await screen.findByRole('heading', { name: /Still looking for cover · 1/ });
    const section = looking.closest('section')!;
    expect(within(section).getByText('Ana Lopez')).toBeInTheDocument();
    expect(within(section).getByText(/Sick · by phone/)).toBeInTheDocument();
    expect(within(section).getByText('Left a voice message')).toBeInTheDocument();
    await userEvent.click(within(section).getByRole('button', { name: /show how cover is going for ana lopez/i }));
    expect(within(section).getByText('3 on the bench invited.')).toBeInTheDocument();
    expect(screen.getByText('Covered by Cal Crew')).toBeInTheDocument();
    expect(screen.getByText(/Late call-out · 45 min notice/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /record a call-out/i })).toBeInTheDocument();
  });

  it('an empty day explains what happens when someone calls out', async () => {
    listCallOuts.mockResolvedValue({ range: 'today', total: 0, covered: 0, looking: 0, uncovered: 0, late: 0, truncated: false, items: [] });
    renderAs('SHIFT_SUPERVISOR', <CallOutsDesk />, '/call-outs');
    expect(await screen.findByText('No call-outs today or tomorrow')).toBeInTheDocument();
  });
});

describe('<RetentionDesk>', () => {
  it('shows the reasons and plays; logs a pay review with a proposed rate', async () => {
    listRetention.mockResolvedValue({
      truncated: false,
      computedAt: new Date().toISOString(),
      items: [
        {
          associateId: 'a1',
          name: 'Ana Lopez',
          photoUrl: null,
          score: 55,
          band: 'HIGH',
          reasons: [{ key: 'pay_below_market', label: 'Paid below the local market', points: 15, detail: 'Pay sits near the 18th percentile for this role nearby.' }],
          plays: ['PAY_REVIEW', 'CHECK_IN'],
          store: { id: 's1', name: 'Front Beach' },
          client: { id: 'c1', name: 'Coastal' },
          recentPlays: [],
        },
      ],
    });
    logPlay.mockResolvedValue({ playId: 'p1', approvalId: 'ap1', pending: true });
    renderAs('HR_ADMINISTRATOR', <RetentionDesk />, '/retention');
    expect(await screen.findByText('Paid below the local market.')).toBeInTheDocument();
    expect(screen.getAllByText('High risk').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole('img', { name: /risk 55 of 100/i })).toBeInTheDocument();
    // The best play's tile, and the same rate in the stay-rate chart's table.
    expect(screen.getAllByText('75%').length).toBeGreaterThanOrEqual(2);
    expect(within(screen.getByRole('table', { name: 'Stayed 90 days, by play' })).getByText('75%')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Review their pay' }));
    const send = await screen.findByRole('button', { name: 'Send for approval' });
    expect(send).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/proposed hourly rate/i), '18.50');
    await userEvent.click(send);
    await waitFor(() => expect(logPlay).toHaveBeenCalledWith('a1', { kind: 'PAY_REVIEW', note: undefined, proposedRate: 18.5 }));
  });
});

describe('<CrewSignalsCard>', () => {
  it('says how many call-outs still need cover and who might leave, each linking to its desk', async () => {
    listCallOuts.mockResolvedValue({ range: 'today', total: 2, covered: 1, looking: 1, uncovered: 0, late: 0, truncated: false, items: [] });
    renderAs('SHIFT_SUPERVISOR', <CrewSignalsCard />, '/');
    expect(await screen.findByRole('link', { name: /2 call-outs today and tomorrow.*1 still looking for cover/i })).toHaveAttribute('href', '/call-outs');
    expect(await screen.findByRole('link', { name: /at high risk of leaving/i })).toHaveAttribute('href', '/retention');
  });
});
