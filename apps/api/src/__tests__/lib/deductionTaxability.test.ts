import { describe, expect, it } from 'vitest';
import { exemptBasesFor, localExempt, sitExempt, suiExempt, taxableWages, codeForPlanKind, UNVERIFIED } from '../../lib/deductionTaxability.js';
import { buildDeductionLines, garnishmentLabel, reconcile, sumEmployee } from '../../lib/deductionLines.js';

const ctx = (states: string[], resident: string | null = states[0] ?? null, local = false) => ({ workStates: states, residentState: resident, localApplies: local });

describe('federal treatment', () => {
  it('a 401(k) deferral lowers income tax wages only; §125 and HSA lower every federal base', () => {
    expect(exemptBasesFor('RET_401K', ctx(['TX']))).toEqual(['FIT']);
    expect(exemptBasesFor('MEDICAL', ctx(['TX']))).toEqual(['FIT', 'SS', 'MEDICARE', 'FUTA', 'SUI:TX']);
    expect(exemptBasesFor('HSA', ctx(['TX']))).toEqual(['FIT', 'SS', 'MEDICARE', 'FUTA', 'SUI:TX']);
    expect(exemptBasesFor('ROTH_401K', ctx(['TX']))).toEqual([]);
    expect(exemptBasesFor('GARNISHMENT', ctx(['NJ']))).toEqual([]);
    expect(exemptBasesFor('ER_HEALTH', ctx(['CA']))).toEqual([]);
  });

  it('FICA wages keep the 401(k) deferral; income tax wages drop it', () => {
    const lines = buildDeductionLines({
      perPlan: [
        { planKind: 'RETIREMENT_401K', roth: false, amount: 100, employerAmount: 0, sourceId: 'e1' },
        { planKind: 'HEALTH_MEDICAL', roth: false, amount: 50, employerAmount: 200, sourceId: 'e2' },
        { planKind: 'HSA', roth: false, amount: 25, employerAmount: 10, sourceId: 'e3' },
      ],
      garnishments: [],
      loans: [],
      employerRetirement: 0,
      ctx: ctx(['TX']),
    });
    const w = taxableWages(2000, lines, ctx(['TX']));
    expect(w.fit).toBe(1825);
    expect(w.ss).toBe(1925);
    expect(w.medicare).toBe(1925);
    expect(w.futa).toBe(1925);
    expect(w.stateIncome).toEqual({}); // Texas has no wage income tax
    expect(w.stateUi.TX).toBe(1925);
    // Employer money never lowers a base or the check.
    expect(sumEmployee(lines, 'PRE_TAX')).toBe(175);
    expect(lines.filter((l) => l.category === 'EMPLOYER').map((l) => [l.code, l.employerAmount, l.w2Box12Code])).toEqual([
      ['ER_HEALTH', 200, 'DD'],
      ['ER_HSA', 10, 'W'],
    ]);
  });
});

describe('state treatment', () => {
  it('Pennsylvania taxes 401(k) deferrals and dependent care, not health or HSA through the cafeteria plan', () => {
    expect(sitExempt('RET_401K', 'PA')).toBe(false);
    expect(sitExempt('RET_403B', 'PA')).toBe(false);
    expect(sitExempt('DCAP', 'PA')).toBe(false);
    expect(sitExempt('MEDICAL', 'PA')).toBe(true);
    expect(sitExempt('HSA', 'PA')).toBe(true);
    // Local EIT follows PA compensation.
    expect(localExempt('RET_401K', ['PA'])).toBe(false);
    expect(localExempt('MEDICAL', ['PA'])).toBe(true);
  });

  it('New Jersey excludes only 401(k) from income tax and nothing from UI/TDI/FLI', () => {
    expect(sitExempt('RET_401K', 'NJ')).toBe(true);
    expect(sitExempt('RET_403B', 'NJ')).toBe(false);
    expect(sitExempt('RET_457B', 'NJ')).toBe(false);
    expect(sitExempt('MEDICAL', 'NJ')).toBe(false);
    expect(sitExempt('HSA', 'NJ')).toBe(false);
    expect(suiExempt('MEDICAL', 'NJ')).toBe(false);
    const b = exemptBasesFor('MEDICAL', ctx(['NJ']));
    expect(b).not.toContain('SIT:NJ');
    expect(b).not.toContain('SUI:NJ');
    expect(b).not.toContain('PGM:NJ_TDI');
    expect(b).toContain('FIT');
  });

  it('California taxes HSA for income tax, UI and SDI, and keeps 401(k) in UI and SDI wages', () => {
    expect(sitExempt('HSA', 'CA')).toBe(false);
    expect(suiExempt('HSA', 'CA')).toBe(false);
    expect(sitExempt('RET_401K', 'CA')).toBe(true);
    expect(exemptBasesFor('RET_401K', ctx(['CA']))).toEqual(['FIT', 'SIT:CA']);
    expect(exemptBasesFor('MEDICAL', ctx(['CA']))).toEqual(['FIT', 'SS', 'MEDICARE', 'FUTA', 'SIT:CA', 'SUI:CA', 'PGM:CA_SDI']);
  });

  it('the same deductions give each state its own base', () => {
    const lines = buildDeductionLines({
      perPlan: [
        { planKind: 'RETIREMENT_401K', roth: false, amount: 100, employerAmount: 0, sourceId: null },
        { planKind: 'HEALTH_MEDICAL', roth: false, amount: 50, employerAmount: 0, sourceId: null },
        { planKind: 'HSA', roth: false, amount: 25, employerAmount: 0, sourceId: null },
      ],
      garnishments: [],
      loans: [],
      employerRetirement: 0,
      ctx: ctx(['PA', 'NJ', 'CA'], 'PA', true),
    });
    const w = taxableWages(2000, lines, ctx(['PA', 'NJ', 'CA'], 'PA', true));
    expect(w.fit).toBe(1825);
    expect(w.stateIncome.PA).toBe(1925); // 401(k) taxed
    expect(w.stateIncome.NJ).toBe(1900); // only 401(k) excluded
    expect(w.stateIncome.CA).toBe(1850); // HSA taxed
    expect(w.stateUi.NJ).toBe(2000);
    expect(w.stateUi.CA).toBe(1950); // §125 medical excluded, HSA and 401(k) in
    expect(w.stateProgram.CA_SDI).toBe(1950);
    expect(w.stateProgram.NJ_TDI).toBe(2000);
    expect(w.local).toBe(1925); // PA EIT follows PA compensation
  });

  it('Ohio municipal tax uses Medicare wages: 401(k) in, §125 out', () => {
    expect(localExempt('RET_401K', ['OH'])).toBe(false);
    expect(localExempt('MEDICAL', ['OH'])).toBe(true);
  });

  it('every unverified fallback names its source to confirm with', () => {
    for (const u of UNVERIFIED) expect(u.note).toMatch(/CONFIRM WITH/);
  });
});

describe('the lines', () => {
  it('garnishments read like the order', () => {
    expect(garnishmentLabel({ kind: 'CHILD_SUPPORT', caseNumber: '1234', state: 'TX' })).toBe('Child support — case 1234 (TX SDU)');
    expect(garnishmentLabel({ kind: 'TAX_LEVY', agencyName: 'Internal Revenue Service' })).toBe('IRS levy');
    expect(garnishmentLabel({ kind: 'STUDENT_LOAN', agencyName: 'Dept. of Education' })).toBe('Student loan (AWG) · Dept. of Education');
  });

  it('plan kinds map to codes, Roth after tax', () => {
    expect(codeForPlanKind('RETIREMENT_401K')).toBe('RET_401K');
    expect(codeForPlanKind('RETIREMENT_401K', true)).toBe('ROTH_401K');
    expect(codeForPlanKind('FSA_DEPENDENT_CARE')).toBe('DCAP');
  });

  it('orders, loans and the match become lines; reconciling closes a cent and names a gap', () => {
    const c = ctx(['TX']);
    const lines = buildDeductionLines({
      perPlan: [{ planKind: 'RETIREMENT_401K', roth: true, amount: 40, employerAmount: 0, sourceId: 'e1' }],
      garnishments: [{ garnishmentId: 'g1', amount: 150, adminFee: 2, kind: 'CHILD_SUPPORT', caseNumber: '9', state: 'TX' }],
      loans: [{ loanNumber: 'L-1', amount: 30 }],
      employerRetirement: 20,
      ctx: c,
    });
    expect(lines.map((l) => l.code)).toEqual(['ROTH_401K', 'GARNISHMENT', 'GARNISHMENT_FEE', 'RET_LOAN', 'ER_401K_MATCH']);
    expect(sumEmployee(lines, 'POST_TAX')).toBe(222);
    const closed = reconcile(lines, { preTax: 0, postTax: 222.01 }, c);
    expect(closed.find((l) => l.code === 'AFTER_TAX_OTHER')?.employeeAmount).toBe(0.01);
  });
});
