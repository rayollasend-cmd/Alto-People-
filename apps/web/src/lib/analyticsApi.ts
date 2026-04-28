import type {
  DashboardKPIs,
  OnboardingAnalyticsResponse,
} from '@alto-people/shared';
import { apiFetch } from './api';

export function getDashboardKPIs(daysBack?: number): Promise<DashboardKPIs> {
  const q = daysBack ? `?days=${daysBack}` : '';
  return apiFetch<DashboardKPIs>(`/analytics/dashboard${q}`);
}

export function getOnboardingAnalytics(): Promise<OnboardingAnalyticsResponse> {
  return apiFetch<OnboardingAnalyticsResponse>('/analytics/onboarding');
}
