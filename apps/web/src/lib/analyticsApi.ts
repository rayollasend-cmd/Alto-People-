import type { DashboardKPIs } from '@alto-people/shared';
import { apiFetch } from './api';

export function getDashboardKPIs(): Promise<DashboardKPIs> {
  return apiFetch<DashboardKPIs>('/analytics/dashboard');
}
