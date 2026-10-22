import type {
  PerformanceReview,
  PerformanceReviewCreateInput,
  PerformanceReviewListResponse,
  PerformanceReviewStatus,
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

/** What a reviewer writes from — GET /performance/review-context. */
export interface ReviewContext {
  associate: { id: string; name: string };
  from: string;
  to: string;
  goals: Array<{ id: string; title: string; status: string; progressPct: number; periodEnd: string }>;
  kudos: Array<{ id: string; message: string; from: string; at: string }>;
  oneOnOnes: Array<{ id: string; at: string; notes: string | null; agenda: string | null; itemsDone: number; itemsOpen: number }>;
  attendance: { late: number; noCallNoShow: number; callOut: number; earlyOut: number };
  lastReview: { id: string; periodStart: string; periodEnd: string; overallRating: number; summary: string } | null;
}

export function getReviewContext(associateId: string, from?: string, to?: string): Promise<ReviewContext> {
  const q = new URLSearchParams({ associateId });
  if (from) q.set('from', from);
  if (to) q.set('to', to);
  return apiFetch<ReviewContext>(`/performance/review-context?${q.toString()}`);
}
