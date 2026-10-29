import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderAs } from '../hrPack/harness';

/**
 * Deep audit 2026-10-29 (CRAWL-11/15): a page a role can open never fires a
 * read the API is certain to refuse, and never shows the refusal raw.
 *   - /time-off: the desk (queue, entitlements) is manage:time's; someone on
 *     the roster without it gets their own time off, anyone else the access
 *     page — not "You don't have permission to view the time-off queue".
 *   - /scheduling: the board reads manage:scheduling / view:executive /
 *     process:payroll; the client portal holds only view:scheduling.
 *   - /rides: "my rides" needs a person record; an account without one that
 *     doesn't run the vans gets the access page, and nothing is asked.
 */

vi.mock('@/lib/timeOffApi', () => ({ getTimeOffSummary: vi.fn(() => new Promise(() => {})) }));
vi.mock('@/pages/timeoff/AssociateTimeOffView', () => ({ AssociateTimeOffView: () => <div>My time off view</div> }));
vi.mock('@/pages/timeoff/AdminTimeOffView', () => ({ AdminTimeOffView: () => <div>The time-off queue</div> }));
vi.mock('@/pages/timeoff/AdminTimeOffEntitlementsView', () => ({ AdminTimeOffEntitlementsView: () => <div>Entitlements</div> }));
vi.mock('@/pages/timeoff/TimeOffPoliciesView', () => ({ TimeOffPoliciesView: () => <div>Policies</div> }));
vi.mock('@/pages/scheduling/AdminSchedulingView', () => ({ AdminSchedulingView: () => <div>The schedule board</div> }));
vi.mock('@/pages/scheduling/AssociateScheduleView', () => ({ AssociateScheduleView: () => <div>My schedule</div> }));
const getMyTransport = vi.fn();
const getMyLiveRide = vi.fn();
vi.mock('@/lib/transportApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/transportApi')>()),
  getMyTransport: () => getMyTransport(),
  getMyLiveRide: () => getMyLiveRide(),
}));

import { TimeOffHome } from '@/pages/timeoff/TimeOffHome';
import { SchedulingHome } from '@/pages/scheduling/SchedulingHome';
import { RideHome } from '@/pages/transport/RideHome';

beforeEach(() => {
  getMyTransport.mockReset();
  getMyLiveRide.mockReset();
});

describe('/time-off by role', () => {
  it('the desk for manage:time', () => {
    renderAs('HR_ADMINISTRATOR', <TimeOffHome />, '/time-off');
    expect(screen.getByText('The time-off queue')).toBeInTheDocument();
  });

  it('someone on the roster without the desk gets their own time off, not a refused queue', () => {
    renderAs('FLOOR_SUPERVISOR', <TimeOffHome />, '/time-off', { associateId: 'a1' });
    expect(screen.getByText('My time off view')).toBeInTheDocument();
    expect(screen.queryByText('The time-off queue')).not.toBeInTheDocument();
  });

  it('the chairman (view:time, no desk, no record) gets the access page', () => {
    renderAs('EXECUTIVE_CHAIRMAN', <TimeOffHome />, '/time-off');
    expect(screen.getByTestId('no-access')).toBeInTheDocument();
    expect(screen.queryByText('The time-off queue')).not.toBeInTheDocument();
  });
});

describe('/scheduling by role', () => {
  it('the client portal gets the access page, not a board that 403s', () => {
    renderAs('CLIENT_PORTAL', <SchedulingHome />, '/scheduling');
    expect(screen.getByTestId('no-access')).toBeInTheDocument();
  });

  it('an associate gets their own schedule; the chairman the board', async () => {
    renderAs('ASSOCIATE', <SchedulingHome />, '/scheduling', { associateId: 'a1' });
    expect(await screen.findByText('My schedule')).toBeInTheDocument();
    renderAs('EXECUTIVE_CHAIRMAN', <SchedulingHome />, '/scheduling');
    expect(await screen.findByText('The schedule board')).toBeInTheDocument();
  });
});

describe('/rides without a person record', () => {
  it('asks nothing of /transport/me and shows the access page', () => {
    renderAs('SHIFT_SUPERVISOR', <RideHome />, '/rides');
    expect(screen.getByTestId('no-access')).toBeInTheDocument();
    expect(getMyTransport).not.toHaveBeenCalled();
    expect(getMyLiveRide).not.toHaveBeenCalled();
  });
});
