import { describe, expect, it } from 'vitest';
import { f1099NecThreshold } from '../../lib/f1099NecAggregator.js';
import { f1099MiscThresholds, meetsF1099MiscThreshold } from '../../lib/f1099MiscAggregator.js';

/** One Big Beautiful Bill Act §70433: the $600 bar is $2,000 for payments made after Dec 31, 2025. */
describe('1099 reporting thresholds by year paid', () => {
  it('NEC: $600 through 2025, $2,000 from 2026', () => {
    expect(f1099NecThreshold(2025)).toBe(600);
    expect(f1099NecThreshold(2026)).toBe(2000);
  });
  it('MISC: the $600 boxes rise, the $10 boxes stay', () => {
    expect(f1099MiscThresholds(2025).box3OtherIncome).toBe(600);
    expect(f1099MiscThresholds(2026).box3OtherIncome).toBe(2000);
    expect(f1099MiscThresholds(2026).box2Royalties).toBe(10);
    const boxes = { box1Rents: 1500 } as Parameters<typeof meetsF1099MiscThreshold>[0];
    expect(meetsF1099MiscThreshold({ ...emptyMisc(), ...boxes }, 2025)).toBe(true);
    expect(meetsF1099MiscThreshold({ ...emptyMisc(), ...boxes }, 2026)).toBe(false);
  });
});

function emptyMisc(): Parameters<typeof meetsF1099MiscThreshold>[0] {
  return { box1Rents: 0, box2Royalties: 0, box3OtherIncome: 0, box4FitWithheld: 0, box5FishingBoatProceeds: 0, box6MedicalHealthcarePayments: 0, box8SubstitutePayments: 0, box9CropInsuranceProceeds: 0, box10GrossProceedsAttorney: 0, box11FishForResale: 0, box12Section409ADeferrals: 0, box13ExcessGoldenParachute: 0, box14NonqualifiedDeferred: 0 } as unknown as Parameters<typeof meetsF1099MiscThreshold>[0];
}
