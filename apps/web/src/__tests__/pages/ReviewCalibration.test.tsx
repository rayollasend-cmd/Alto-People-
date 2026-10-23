import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAs } from './hrPack/harness';

const getCalibration = vi.fn();
const calibrateReview = vi.fn();
vi.mock('@/lib/performanceApi', () => ({
  getCalibration: (...a: unknown[]) => getCalibration(...a),
  calibrateReview: (...a: unknown[]) => calibrateReview(...a),
}));

import { quarterRange, ReviewCalibration } from '@/pages/performance/ReviewCalibration';

const review = (over: Record<string, unknown>) => ({
  id: 'r1',
  associateId: 'a1',
  associateName: 'Ana Lopez',
  reviewerUserId: 'mgr',
  reviewerName: 'Kim Park',
  periodStart: '2026-07-01',
  periodEnd: '2026-09-30',
  status: 'DRAFT',
  overallRating: 5,
  originalRating: null,
  calibrationNote: null,
  calibratedByName: null,
  calibratedAt: null,
  ...over,
});

beforeEach(() => {
  getCalibration.mockReset();
  calibrateReview.mockReset();
  getCalibration.mockResolvedValue({
    total: 2,
    mean: 4,
    distribution: [0, 0, 1, 0, 1],
    reviewers: [{ reviewerUserId: 'mgr', name: 'Kim Park', count: 3, mean: 5, distribution: [0, 0, 0, 0, 3], lean: 'generous', delta: 1 }],
    reviews: [review({}), review({ id: 'r2', associateName: 'Ben Ortiz', reviewerUserId: 'u1', reviewerName: 'Me', overallRating: 3 })],
  });
});

describe('<ReviewCalibration>', () => {
  it('calls out a generous reviewer and moves a rating with a reason', async () => {
    calibrateReview.mockResolvedValue({});
    renderAs('HR_ADMINISTRATOR', <ReviewCalibration />, '/performance/calibration');
    expect(await screen.findByText('Rates above everyone')).toBeInTheDocument();

    const moves = screen.getAllByRole('button', { name: 'Move rating' });
    // The reviewer can't calibrate their own review (Ben's was written by u1, the viewer).
    expect(moves[1]).toBeDisabled();
    await userEvent.click(moves[0]!);
    const save = screen.getAllByRole('button', { name: 'Move rating' }).at(-1)!;
    await userEvent.click(screen.getByRole('button', { name: 'Rating 4' }));
    expect(save).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/why/i), 'In line with peers.');
    await userEvent.click(save);
    await waitFor(() => expect(calibrateReview).toHaveBeenCalledWith('r1', { rating: 4, note: 'In line with peers.' }));
  });

  it('picks the period with quarter presets — last quarter by default, this quarter or custom dates (F500 G1)', async () => {
    renderAs('HR_ADMINISTRATOR', <ReviewCalibration />, '/performance/calibration');
    await screen.findByText('Rates above everyone');
    const last = quarterRange(1);
    expect(getCalibration).toHaveBeenLastCalledWith(last);
    expect(screen.queryByLabelText('From')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: 'This quarter' }));
    await waitFor(() => expect(getCalibration).toHaveBeenLastCalledWith(quarterRange(0)));
    await userEvent.click(screen.getByRole('radio', { name: 'Custom' }));
    expect(screen.getByLabelText('From')).toHaveValue(last.from);
    // Siblings are links, not a bare "All reviews".
    expect(screen.getByRole('link', { name: 'Reviews' })).toHaveAttribute('href', '/performance');
  });

  it('reads the period from the URL', async () => {
    renderAs('HR_ADMINISTRATOR', <ReviewCalibration />, '/performance/calibration?period=custom&from=2026-01-01&to=2026-03-31');
    await screen.findByText('Rates above everyone');
    expect(getCalibration).toHaveBeenLastCalledWith({ from: '2026-01-01', to: '2026-03-31' });
  });

  it('works out the quarters on the calendar', () => {
    expect(quarterRange(0, new Date(2026, 9, 22))).toEqual({ from: '2026-10-01', to: '2026-12-31' });
    expect(quarterRange(1, new Date(2026, 9, 22))).toEqual({ from: '2026-07-01', to: '2026-09-30' });
    expect(quarterRange(1, new Date(2026, 1, 3))).toEqual({ from: '2025-10-01', to: '2025-12-31' });
  });
});
