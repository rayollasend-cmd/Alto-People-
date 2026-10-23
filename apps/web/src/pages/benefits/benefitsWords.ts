import type { BenefitsPlanKind } from '@alto-people/shared';

/** One name per plan kind, for the associate's page and the benefits desk. */
export const KIND_LABEL: Record<BenefitsPlanKind, string> = {
  HEALTH_MEDICAL: 'Medical',
  DENTAL: 'Dental',
  VISION: 'Vision',
  HSA: 'HSA',
  FSA_HEALTHCARE: 'FSA — Healthcare',
  FSA_DEPENDENT_CARE: 'FSA — Dependent care',
  RETIREMENT_401K: '401(k)',
  RETIREMENT_403B: '403(b)',
  LIFE_INSURANCE: 'Life insurance',
  DISABILITY: 'Disability',
  TRUMP_ACCOUNT: 'Trump account (employer)',
};
