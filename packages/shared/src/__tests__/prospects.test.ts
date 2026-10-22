import { describe, expect, it } from 'vitest';
import {
  PROSPECT_STAGE_WEIGHTS,
  ProspectInputSchema,
  isOpenProspectStage,
  prospectAnnualValue,
  prospectWeightedValue,
} from '../prospects.js';

describe('the pipeline maths', () => {
  it('a year of value is hours × rate × 52, and unknown when either is missing', () => {
    expect(prospectAnnualValue(200, 22)).toBe(228_800);
    expect(prospectAnnualValue(40, 18.75)).toBe(39_000);
    expect(prospectAnnualValue(0, 22)).toBe(0);
    expect(prospectAnnualValue(null, 22)).toBeNull();
    expect(prospectAnnualValue(200, null)).toBeNull();
  });

  it('weights by stage: Lead 10%, Contacted 25%, Proposal 50%, Verbal 80%; nothing for Won or Lost', () => {
    expect(PROSPECT_STAGE_WEIGHTS).toEqual({ LEAD: 0.1, CONTACTED: 0.25, PROPOSAL: 0.5, VERBAL: 0.8 });
    expect(prospectWeightedValue('LEAD', 228_800)).toBe(22_880);
    expect(prospectWeightedValue('CONTACTED', 117_000)).toBe(29_250);
    expect(prospectWeightedValue('PROPOSAL', 156_000)).toBe(78_000);
    expect(prospectWeightedValue('VERBAL', 52_000)).toBe(41_600);
    expect(prospectWeightedValue('WON', 52_000)).toBeNull();
    expect(prospectWeightedValue('LOST', 52_000)).toBeNull();
    expect(prospectWeightedValue('LEAD', null)).toBeNull();
    expect(isOpenProspectStage('VERBAL')).toBe(true);
    expect(isOpenProspectStage('WON')).toBe(false);
  });

  it('the input contract: a blank contact email is no email; dates are calendar days', () => {
    expect(ProspectInputSchema.parse({ name: 'Bay Foods', contactEmail: '' }).contactEmail).toBeNull();
    expect(ProspectInputSchema.safeParse({ name: 'Bay Foods', contactEmail: 'not-an-email' }).success).toBe(false);
    expect(ProspectInputSchema.safeParse({ name: 'Bay Foods', expectedStartDate: '2026-11-01T00:00:00Z' }).success).toBe(false);
    expect(ProspectInputSchema.parse({ name: 'Bay Foods', expectedStartDate: '2026-11-01' }).expectedStartDate).toBe('2026-11-01');
    expect(ProspectInputSchema.safeParse({ name: 'B' }).success).toBe(false);
  });
});
