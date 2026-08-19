import type {
  DashboardKPIs,
  OnboardingAnalyticsResponse,
  RetentionResponse,
} from '@alto-people/shared';
import { apiFetch } from './api';

export function getRetention(clientId?: string): Promise<RetentionResponse> {
  const q = clientId ? `?clientId=${clientId}` : '';
  return apiFetch<RetentionResponse>(`/analytics/retention${q}`);
}

export function getDashboardKPIs(daysBack?: number): Promise<DashboardKPIs> {
  const q = daysBack ? `?days=${daysBack}` : '';
  return apiFetch<DashboardKPIs>(`/analytics/dashboard${q}`);
}

export function getOnboardingAnalytics(): Promise<OnboardingAnalyticsResponse> {
  return apiFetch<OnboardingAnalyticsResponse>('/analytics/onboarding');
}
