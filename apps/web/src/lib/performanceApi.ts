import type {
  PerformanceReview,
  PerformanceReviewCreateInput,
  PerformanceReviewListResponse,
  PerformanceReviewStatus,
} from '@alto-people/shared';
import { apiFetch } from './api';

/** One status, or several ("needs action" = DRAFT + SUBMITTED). */
export function listReviews(filters: { status?: PerformanceReviewStatus | PerformanceReviewStatus[] } = {}): Promise<PerformanceReviewListResponse> {
  const status = Array.isArray(filters.status) ? filters.status.join(',') : filters.status;
  const qs = status ? `?status=${status}` : '';
  return apiFetch<PerformanceReviewListResponse>(`/performance/reviews${qs}`);
}

/** GET /performance/reviews/summary — the cycle at a glance (apps/api routes/performance.ts). */
export interface ReviewsSummary {
  drafts: number;
  awaitingAck: number;
  acknowledged: number;
  doneThisQuarter: number;
  /** "YYYY-MM-DD", the first day of the current calendar quarter. */
  quarterStart: string;
  /** People whose review fell due before today (a year after their last review's period end, or their hire date). */
  overdue: number;
  /** People whose review falls due between today and the month's end. */
  dueThisMonth: number;
  due: Array<{ associateId: string; name: string; lastPeriodEnd: string | null; dueOn: string; overdue: boolean }>;
}

export function getReviewsSummary(): Promise<ReviewsSummary> {
  return apiFetch<ReviewsSummary>('/performance/reviews/summary');
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
