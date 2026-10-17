import type {
  PerformanceReview,
  PerformanceReviewCreateInput,
  PerformanceReviewListResponse,
  PerformanceReviewStatus,
  PerformanceReviewUpdateInput,
} from '@alto-people/shared';
import { apiFetch } from './api';

export function listReviews(filters: { status?: PerformanceReviewStatus } = {}): Promise<PerformanceReviewListResponse> {
  const qs = filters.status ? `?status=${filters.status}` : '';
  return apiFetch<PerformanceReviewListResponse>(`/performance/reviews${qs}`);
}

export function listMyReviews(): Promise<PerformanceReviewListResponse> {
  return apiFetch<PerformanceReviewListResponse>('/performance/me/reviews');
}

export function createReview(body: PerformanceReviewCreateInput): Promise<PerformanceReview> {
  return apiFetch<PerformanceReview>('/performance/reviews', { method: 'POST', body });
}

export function updateReview(id: string, body: PerformanceReviewUpdateInput): Promise<PerformanceReview> {
  return apiFetch<PerformanceReview>(`/performance/reviews/${id}`, { method: 'PATCH', body });
}

export function submitReview(id: string): Promise<PerformanceReview> {
  return apiFetch<PerformanceReview>(`/performance/reviews/${id}/submit`, { method: 'POST' });
}

export function acknowledgeReview(id: string): Promise<PerformanceReview> {
  return apiFetch<PerformanceReview>(`/performance/me/reviews/${id}/acknowledge`, {
    method: 'POST',
  });
}

/* ----- Calibration ----- */

export interface CalibrationReviewer {
  reviewerUserId: string | null;
  name: string;
  count: number;
  mean: number | null;
  /** Reviews at 1..5, in that order. */
  distribution: number[];
  lean: 'generous' | 'strict' | null;
  delta: number;
}

export interface CalibrationReview {
  id: string;
  associateId: string;
  associateName: string;
  reviewerUserId: string | null;
  reviewerName: string | null;
  periodStart: string;
  periodEnd: string;
  status: PerformanceReviewStatus;
  overallRating: number;
  originalRating: number | null;
  calibrationNote: string | null;
  calibratedByName: string | null;
  calibratedAt: string | null;
}

export interface CalibrationView {
  total: number;
  mean: number | null;
  distribution: number[];
  reviewers: CalibrationReviewer[];
  reviews: CalibrationReview[];
}

export function getCalibration(range: { from?: string; to?: string } = {}): Promise<CalibrationView> {
  const qs = new URLSearchParams();
  if (range.from) qs.set('from', range.from);
  if (range.to) qs.set('to', range.to);
  const s = qs.toString();
  return apiFetch<CalibrationView>(`/performance/calibration${s ? `?${s}` : ''}`);
}

export function calibrateReview(id: string, body: { rating: number; note: string }): Promise<PerformanceReview> {
  return apiFetch<PerformanceReview>(`/performance/reviews/${id}/calibrate`, { method: 'POST', body });
}
