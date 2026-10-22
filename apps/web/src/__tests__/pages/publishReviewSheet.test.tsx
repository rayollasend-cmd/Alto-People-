import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PublishPreflightResponse } from '@alto-people/shared';
import { PublishReviewSheet } from '@/pages/scheduling/PublishReviewSheet';

/**
 * Role walk, ops 10 — the publish confirm is a review sheet: totals, who
 * is notified, each issue a row that opens the fix, and the labor-rules
 * engine's blocks disable Publish until cleared.
 */

const A = '22222222-2222-4222-8222-222222222222';
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '33333333-3333-4333-8333-333333333333';

const preflight: PublishPreflightResponse = {
  drafts: 12,
  noticeWindowDrafts: 1,
  open: 2,
  otProjected: [{ name: 'Ana Lopez', hours: 42, associateId: A, shiftIds: [S1], projectedCostCents: 75600 }],
  restGaps: [{ name: 'Ben Ortiz', gapHours: 7, startsAt: new Date().toISOString(), associateId: A, shiftIds: [S1, S2] }],
  laborFindings: [
    { rule: 'MINOR_HOURS_OF_DAY', severity: 'block', reason: 'Age 16: ends after 22:00, FL minors', shiftId: S2, associateId: A, associateName: 'Cal Young' },
    { rule: 'OVERTIME_WEEKLY', severity: 'warn', reason: 'Overtime ahead: 42 h this week > 40', shiftId: S1, associateId: A, associateName: 'Ana Lopez' },
  ],
  totals: { shifts: 40, hours: 312, costCents: 561600, deltaHoursVsLastWeek: 12, deltaCostCentsVsLastWeek: 21600 },
  notifyCount: 9,
  openShiftIds: [S1, S2],
};

function renderSheet(pf: PublishPreflightResponse | null, extra: Partial<Parameters<typeof PublishReviewSheet>[0]> = {}) {
  const onPublish = vi.fn();
  const onOpenShift = vi.fn();
  const onOpenAssociate = vi.fn();
  render(
    <PublishReviewSheet
      open
      draftsInWeek={12}
      preflight={pf}
      preflightFailed={false}
      truncated={false}
      initialReason=""
      workersLabel="associates"
      publishing={false}
      onCancel={vi.fn()}
      onPublish={onPublish}
      onOpenShift={onOpenShift}
      onOpenAssociate={onOpenAssociate}
      {...extra}
    />,
  );
  return { onPublish, onOpenShift, onOpenAssociate };
}

afterEach(cleanup);

describe('<PublishReviewSheet>', () => {
  it('shows totals and the notify count, and blocks publish while a labor-rules block stands', async () => {
    const user = userEvent.setup();
    const { onPublish, onOpenShift } = renderSheet(preflight);
    expect(screen.getByTestId('publish-totals')).toHaveTextContent('40');
    expect(screen.getByTestId('publish-totals')).toHaveTextContent('312h');
    expect(screen.getByTestId('publish-totals')).toHaveTextContent('+12h vs last wk');
    expect(screen.getByTestId('publish-notify')).toHaveTextContent('9 people will be notified');
    expect(screen.getByTestId('publish-blocks')).toHaveTextContent('Cal Young');
    const publish = screen.getByTestId('publish-confirm');
    expect(publish).toBeDisabled();
    await user.click(publish);
    expect(onPublish).not.toHaveBeenCalled();
    // A block row opens the shift to fix.
    await user.click(screen.getByText('Cal Young'));
    expect(onOpenShift).toHaveBeenCalledWith(S2);
  });

  it('each issue row opens its fix: unfilled → Assign, overtime → the person, rest gap → the second shift', async () => {
    const user = userEvent.setup();
    const { onOpenShift, onOpenAssociate } = renderSheet({ ...preflight, laborFindings: [] });
    await user.click(screen.getByTestId('publish-open'));
    expect(onOpenShift).toHaveBeenLastCalledWith(S1);
    await user.click(screen.getByTestId('publish-ot'));
    expect(onOpenAssociate).toHaveBeenCalledWith(A, [S1]);
    await user.click(screen.getByTestId('publish-rest'));
    expect(onOpenShift).toHaveBeenLastCalledWith(S2);
  });

  it('publishes with the inline notice-window reason when nothing blocks', async () => {
    const user = userEvent.setup();
    const { onPublish } = renderSheet({ ...preflight, laborFindings: [] });
    await user.type(screen.getByLabelText(/inside a fair-workweek notice window/i), 'Volume spike');
    await user.click(screen.getByTestId('publish-confirm'));
    expect(onPublish).toHaveBeenCalledWith('Volume spike');
  });

  it('shows the findings a refused publish answered with, in the same sheet', () => {
    renderSheet({ ...preflight, laborFindings: [] }, {
      blockedBy: [{ rule: 'REST_BETWEEN_SHIFTS', severity: 'block', reason: 'Short rest: 6 h between shifts < 10', shiftId: S1, associateId: A, associateName: 'Ana Lopez' }],
    });
    expect(screen.getByTestId('publish-blocks')).toHaveTextContent('Short rest');
    expect(screen.getByTestId('publish-confirm')).toBeDisabled();
  });

  it('says the week is clean when nothing needs a look', () => {
    renderSheet({ drafts: 3, open: 0, otProjected: [], restGaps: [], laborFindings: [] });
    expect(screen.getByTestId('publish-clean')).toBeInTheDocument();
    expect(screen.getByTestId('publish-confirm')).toBeEnabled();
  });
});
