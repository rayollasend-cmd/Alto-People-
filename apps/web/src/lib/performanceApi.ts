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
