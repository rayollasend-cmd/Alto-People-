import type { TrustSummary, TrustSummaryPublic } from '@alto-people/shared';
import { apiFetch } from './api';

/** The Trust Center (UX upgrade step 4). */
export const getTrustPublic = () => apiFetch<TrustSummaryPublic>('/trust/public');
export const getTrust = () => apiFetch<TrustSummary>('/trust');
