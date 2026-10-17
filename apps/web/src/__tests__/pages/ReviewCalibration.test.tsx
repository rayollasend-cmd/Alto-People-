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

import { ReviewCalibration } from '@/pages/performance/ReviewCalibration';

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
});
