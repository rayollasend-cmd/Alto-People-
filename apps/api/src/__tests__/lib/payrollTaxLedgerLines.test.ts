import { describe, expect, it } from 'vitest';
import { postingsFor } from '../../lib/payrollTaxLedger.js';

/**
 * The ledger owes each state, locality and program what the tax engine's
 * lines say this check withheld — a two-state worker owes two states.
 */

const base = { federalWithholding: 100, fica: 62, medicare: 14.5, employerFica: 62, employerMedicare: 14.5, employerFuta: 6, employerSuta: 27, localWithholding: 0 };

describe('postingsFor with tax-engine lines', () => {
  it('splits a two-state worker, files local tax by place, and puts paid leave with the employment agency', () => {
    const out = postingsFor([
      {
        ...base,
        stateWithholding: 60,
        taxState: 'NJ',
        lines: [
          { kind: 'STATE', code: 'NJ_SIT', label: 'New Jersey income tax', workState: 'NJ', amount: 35, employer: false },
          { kind: 'STATE', code: 'PA_SIT', label: 'Pennsylvania income tax', workState: 'PA', amount: 25, employer: false },
          { kind: 'LOCAL', code: 'PA_EIT_510101', label: 'Philadelphia wage tax', workState: 'PA', amount: 31.5, employer: false },
          { kind: 'STATE_PROGRAM', code: 'NJ_FLI', label: 'NJ family leave', workState: 'NJ', amount: 2.3, employer: false },
          { kind: 'SUI', code: 'NJ_SUI', label: 'NJ unemployment', workState: 'NJ', amount: 0.01, employer: true },
        ],
      },
    ]);
    const by = Object.fromEntries(out.map((p) => [`${p.kind}|${p.jurisdiction}`, p]));
    expect(by['STATE_WITHHOLDING|NJ'].amount).toBe(35);
    expect(by['STATE_WITHHOLDING|PA'].amount).toBe(25);
    expect(by['LOCAL|PA:Philadelphia wage tax'].amount).toBe(31.5);
    expect(by['STATE_UNEMPLOYMENT|NJ']).toMatchObject({ amount: 29.3, breakdown: { unemployment: 27, disabilityAndPaidLeave: 2.3 } });
    expect(by['STATE_UNEMPLOYMENT|PA']).toBeUndefined();
  });

  it('a check with no engine lines keeps the old single-state posting', () => {
    const out = postingsFor([{ ...base, stateWithholding: 40, localWithholding: 10, taxState: 'OH', localJurisdiction: 'OH:Columbus' }]);
    const keys = out.map((p) => `${p.kind}|${p.jurisdiction}|${p.amount}`);
    expect(keys).toEqual(expect.arrayContaining(['STATE_WITHHOLDING|OH|40', 'STATE_UNEMPLOYMENT|OH|27', 'LOCAL|OH:Columbus|10']));
  });
});
