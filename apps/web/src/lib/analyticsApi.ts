import type {
  DashboardKPIs,
  OnboardingAnalyticsResponse,
} from '@alto-people/shared';
import { apiFetch } from './api';

export function getDashboardKPIs(): Promise<DashboardKPIs> {
  return apiFetch<DashboardKPIs>('/analytics/dashboard');
}

export function getOnboardingAnalytics(): Promise<OnboardingAnalyticsResponse> {
  return apiFetch<OnboardingAnalyticsResponse>('/analytics/onboarding');
}
