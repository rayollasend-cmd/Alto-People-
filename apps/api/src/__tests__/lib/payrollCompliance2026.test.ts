import { describe, expect, it } from 'vitest';
import { ageAtYearEnd, catchUpAllowance, isRothCatchUpHigherEarner, limitsFor, splitDeferral } from '../../lib/contributionLimits.js';
import { computeCheckDeductions, emptyDeferrals, readDeferrals, rothCatchUpStatus, type EnrollmentFacts } from '../../lib/retirementDeferrals.js';
import { checkWageStatement, factsBeforeRun, factsFromPaystub } from '../../lib/wageStatementRules.js';
import { buildEfw2File, efw2Unsupported, Efw2UnsupportedError, type Efw2File } from '../../lib/efw2.js';
import { hasW2cDelta } from '../../lib/w2cAggregator.js';
import type { W2Boxes } from '../../lib/w2Aggregator.js';
import { deadlineDays, dueDateFor, newHireCsv } from '../../lib/newHireReporting.js';
import { documentHash, formFor, noticeLanguage, noticeLines, type NoticeFacts } from '../../lib/payNotices.js';
import type { PaystubData } from '../../lib/paystub.js';

/**
 * The pure parts of the 2026 payroll compliance work: limits and the SECURE
 * 2.0 Roth catch-up rule, state paystub elements, the EFW2 refusal for
 * boxes its layout cannot carry, new-hire deadlines and pay-notice forms.
 */

const dobForAge = (age: number, year = 2026) => new Date(Date.UTC(year - age, 5, 15));
const plan = (kind: EnrollmentFacts['plan']['kind'], cents: number, opts: { roth?: boolean; deemed?: boolean; employer?: number } = {}): EnrollmentFacts => ({
  electedAmountCentsPerPeriod: cents,
  rothElection: opts.roth ?? false,
  plan: { kind, allowsDeemedRoth: opts.deemed ?? true, employerContributionCentsPerPeriod: opts.employer ?? 0 },
});

describe('contribution limits (IRS Notice 2025-67)', () => {
  it('carries the 2026 figures and falls back, flagged, for an unknown year', () => {
    const l = limitsFor(2026);
    expect(l).toMatchObject({ deferral402g: 24_500, catchUp50: 8_000, superCatchUp60to63: 11_250, hsaFamily: 8_750, healthFsa: 3_400, dependentCareFsa: 7_500, rothCatchUpWageThreshold: 150_000, fallback: false });
    expect(limitsFor(2031)).toMatchObject({ year: 2031, deferral402g: 24_500, fallback: true });
  });

  it('gives the catch-up by age at year end: none under 50, the larger amount at 60–63, the regular one at 64', () => {
    expect(catchUpAllowance(dobForAge(49), 2026)).toBe(0);
    expect(catchUpAllowance(dobForAge(50), 2026)).toBe(8_000);
    expect(catchUpAllowance(dobForAge(60), 2026)).toBe(11_250);
    expect(catchUpAllowance(dobForAge(63), 2026)).toBe(11_250);
    expect(catchUpAllowance(dobForAge(64), 2026)).toBe(8_000);
    expect(catchUpAllowance(null, 2026)).toBe(0);
    expect(ageAtYearEnd(new Date('1976-12-31T00:00:00Z'), 2026)).toBe(50);
  });

  it('splits an election into 402(g), catch-up and what the limit stops', () => {
    expect(splitDeferral(1_000, 24_000, 24_500, 8_000)).toEqual({ regular: 500, catchUp: 500, stopped: 0 });
    expect(splitDeferral(1_000, 32_000, 24_500, 8_000)).toEqual({ regular: 0, catchUp: 500, stopped: 500 });
    expect(splitDeferral(1_000, 24_000, 24_500, 0)).toEqual({ regular: 500, catchUp: 0, stopped: 500 });
  });

  it('is a higher earner only strictly over the threshold of the plan year', () => {
    expect(isRothCatchUpHigherEarner(150_000, 2026)).toBe(false);
    expect(isRothCatchUpHigherEarner(150_000.01, 2026)).toBe(true);
    expect(isRothCatchUpHigherEarner(146_000, 2025)).toBe(true);
  });
});

describe('check deductions with the Roth catch-up rule', () => {
  const nearLimit = (over = 0) => ({ ...emptyDeferrals(), pre401k: 24_000 + over });

  it('a 55-year-old under the wage line keeps a pre-tax catch-up', () => {
    const r = computeCheckDeductions([plan('RETIREMENT_401K', 100_000)], { dob: dobForAge(55), ytd: nearLimit(), priorYearFicaWages: 120_000 }, 2026);
    expect(r.deferrals).toMatchObject({ pre401k: 1_000, roth401k: 0, catchUp: 500, catchUpRoth: 0, highEarner: false });
    expect(r).toMatchObject({ preTax: 1_000, preTaxRetirement: 1_000, roth: 0 });
  });

  it('a higher earner’s catch-up is made Roth where the plan allows deemed Roth', () => {
    const r = computeCheckDeductions([plan('RETIREMENT_401K', 100_000)], { dob: dobForAge(55), ytd: nearLimit(), priorYearFicaWages: 200_000 }, 2026);
    expect(r.deferrals).toMatchObject({ pre401k: 500, roth401k: 500, catchUp: 500, catchUpRoth: 500, highEarner: true, catchUpStoppedNoRoth: 0 });
    expect(r).toMatchObject({ preTax: 500, roth: 500 });
  });

  it('stops a higher earner’s catch-up when the plan has no deemed Roth and they did not elect Roth', () => {
    const r = computeCheckDeductions([plan('RETIREMENT_401K', 100_000, { deemed: false })], { dob: dobForAge(55), ytd: nearLimit(), priorYearFicaWages: 200_000 }, 2026);
    expect(r.deferrals).toMatchObject({ pre401k: 500, catchUp: 0, catchUpStoppedNoRoth: 500 });
    expect(r.preTax).toBe(500);
  });

  it('honors a Roth election even where the plan has no deemed Roth', () => {
    const r = computeCheckDeductions([plan('RETIREMENT_403B', 100_000, { deemed: false, roth: true })], { dob: dobForAge(61), ytd: { ...emptyDeferrals(), roth403b: 24_000 }, priorYearFicaWages: 200_000 }, 2026);
    expect(r.deferrals).toMatchObject({ roth403b: 1_000, catchUpRoth: 500, catchUpStoppedNoRoth: 0 });
    expect(r).toMatchObject({ preTax: 0, roth: 1_000 });
  });

  it('caps HSA at the family limit plus the 55+ catch-up, FSAs at theirs, and reports a Trump account as employer money', () => {
    const r = computeCheckDeductions(
      [plan('HSA', 100_000), plan('FSA_HEALTHCARE', 50_000), plan('FSA_DEPENDENT_CARE', 50_000), plan('TRUMP_ACCOUNT', 0, { employer: 2_500 }), plan('HEALTH_MEDICAL', 12_000)],
      { dob: dobForAge(56), ytd: { ...emptyDeferrals(), hsa: 9_500, fsa: 3_000, dcap: 7_400 }, priorYearFicaWages: 0 },
      2026,
    );
    expect(r.deferrals).toMatchObject({ hsa: 250, fsa: 400, dcap: 100, trumpAccountEmployer: 25 });
    expect(r.deferrals.limitStopped).toBe(750 + 100 + 400);
    expect(r.preTax).toBe(250 + 400 + 100 + 120);
  });

  it('reads a check stored before deferral detail existed as a 401(k)', () => {
    expect(readDeferrals(null, 150).pre401k).toBe(150);
    expect(readDeferrals({ roth401k: 20, highEarner: true }).highEarner).toBe(true);
  });

  it('names the person’s catch-up position', () => {
    const base = { year: 2026, rothElection: false, allowsDeemedRoth: true };
    expect(rothCatchUpStatus({ ...base, dob: dobForAge(40), priorYearFicaWages: 0 }).status).toBe('NOT_ELIGIBLE');
    expect(rothCatchUpStatus({ ...base, dob: null, priorYearFicaWages: 0 }).status).toBe('AGE_UNKNOWN');
    expect(rothCatchUpStatus({ ...base, dob: dobForAge(52), priorYearFicaWages: 90_000 }).status).toBe('PRE_TAX_OR_ROTH');
    expect(rothCatchUpStatus({ ...base, dob: dobForAge(52), priorYearFicaWages: 190_000 }).status).toBe('ROTH_DEEMED');
    expect(rothCatchUpStatus({ ...base, allowsDeemedRoth: false, dob: dobForAge(52), priorYearFicaWages: 190_000 }).status).toBe('CATCH_UP_STOPPED');
    expect(rothCatchUpStatus({ ...base, rothElection: true, allowsDeemedRoth: false, dob: dobForAge(52), priorYearFicaWages: 190_000 }).status).toBe('ROTH_BY_ELECTION');
  });
});

describe('state wage-statement rules', () => {
  const employer = { legalName: 'Acme LLC', addressLine1: '1 Main', city: 'Oakland', state: 'CA', zip: '94601', phone: null };

  it('CA needs the employer address and the paid sick leave balance (Labor Code §226(a), §246(i))', () => {
    const missing = checkWageStatement('CA', factsBeforeRun({ employer: { ...employer, addressLine1: null }, employeeName: 'Ana Ruiz', hasSickBalance: false })).missing;
    expect(missing).toEqual(['EMPLOYER_ADDRESS', 'SICK_LEAVE_BALANCE']);
    expect(checkWageStatement('CA', factsBeforeRun({ employer, employeeName: 'Ana Ruiz', hasSickBalance: true })).missing).toEqual([]);
  });

  it('NY needs the employer phone (Labor Law §195(3)); a state with no rule has nothing to check', () => {
    expect(checkWageStatement('NY', factsBeforeRun({ employer, employeeName: 'Ana', hasSickBalance: false })).missing).toEqual(['EMPLOYER_PHONE']);
    expect(checkWageStatement('TX', factsBeforeRun({ employer, employeeName: 'Ana', hasSickBalance: false }))).toEqual({ state: 'TX', citation: null, missing: [] });
  });

  it('reads a built paystub: hours by rate, total hours, sick balance', () => {
    const stub = {
      company: { name: 'Acme LLC', addressLine1: '1 Main', city: 'Oakland', state: 'CA', zip: '94601' },
      associate: { firstName: 'Ana', lastName: 'Ruiz', email: null, addressLine1: null, city: null, state: null, zip: null, employeeId: 'AB12CD34' },
      period: { start: '2026-04-04', end: '2026-04-17', payDate: '2026-04-24' },
      earnings: [
        { label: 'Regular', hours: 80, rate: 20, amount: 1600 },
        { label: 'Overtime', hours: 2, rate: 30, amount: 60 },
      ],
      gross: { current: 1660, ytd: 1660 },
      taxes: [],
      taxesTotal: { current: 0, ytd: 0 },
      preTaxDeductions: [],
      postTaxDeductions: [],
      net: { current: 1500, ytd: 1500 },
      employer: { fica: 0, medicare: 0, futa: 0, suta: 0 },
      meta: { runId: 'r', itemId: 'i', issuedAt: '2026-04-24T00:00:00Z' },
      hoursTotal: 82,
      sickLeave: { availableHours: 12.5 },
    } as unknown as PaystubData;
    expect(checkWageStatement('CA', factsFromPaystub(stub)).missing).toEqual([]);
    expect(checkWageStatement('CA', factsFromPaystub({ ...stub, sickLeave: undefined, hoursTotal: null })).missing).toEqual(['TOTAL_HOURS', 'SICK_LEAVE_BALANCE']);
  });
});

const boxes = (extra: Partial<W2Boxes> = {}): W2Boxes => ({
  box1Wages: 50_000,
  box2FitWithheld: 5_000,
  box3SsWages: 50_000,
  box4SsTax: 3_100,
  box5MedicareWages: 50_000,
  box6MedicareTax: 725,
  stateLines: [],
  sourceItemCount: 26,
  ...extra,
});

const efw2Input = (b: W2Boxes, taxYear = 2026): Efw2File => ({
  submitter: { ein: '123456789', userId: 'USRID0000000001', name: 'Acme', addressLine1: '1 Main', city: 'Oakland', state: 'CA', zip5: '94601', contactName: 'Pat', contactPhone: '555-867-5309', contactEmail: 'pat@example.com' },
  employer: { ein: '123456789', taxYear, name: 'Acme', addressLine1: '1 Main', city: 'Oakland', state: 'CA', zip5: '94601' },
  employees: [{ ssn: '123456789', firstName: 'Ana', lastName: 'Ruiz', addressLine1: '2 Elm', city: 'Oakland', state: 'CA', zip5: '94601', boxes: b }],
});

describe('EFW2 refuses what its layout cannot carry', () => {
  it('builds a file for Boxes 1–6 only', () => {
    expect(() => buildEfw2File(efw2Input(boxes()))).not.toThrow();
  });

  it('refuses TY2026 Box 12 TP/TT/TA and Box 14b, naming the unconfirmed positions', () => {
    const b = boxes({ box12: [{ code: 'TP', amount: 4_000 }, { code: 'TT', amount: 600 }], box14bTippedOccupationCodes: ['101'], box7SsTips: 4_000 });
    const gaps = efw2Unsupported(efw2Input(b));
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.missing).toEqual(['Box 12 TP (TY2026 position not confirmed)', 'Box 12 TT (TY2026 position not confirmed)', 'Box 14b (TY2026 position not confirmed)', 'Box 7']);
    expect(gaps[0]!.ssnLast4).toBe('6789');
    expect(() => buildEfw2File(efw2Input(b))).toThrow(Efw2UnsupportedError);
  });

  it('refuses a 401(k) deferral too rather than file a zero in its place', () => {
    expect(efw2Unsupported(efw2Input(boxes({ box12: [{ code: 'D', amount: 6_000 }] })))[0]!.missing).toEqual(['Box 12 D']);
  });

  it('a W-2c sees a change in Box 12 or 14b', () => {
    expect(hasW2cDelta(boxes(), boxes({ box12: [] }))).toBe(false);
    expect(hasW2cDelta(boxes({ box12: [{ code: 'TT', amount: 600 }] }), boxes({ box12: [{ code: 'TT', amount: 650 }] }))).toBe(true);
    expect(hasW2cDelta(boxes({ box14bTippedOccupationCodes: ['101'] }), boxes())).toBe(true);
  });
});

describe('new-hire reporting deadlines (42 USC 653a)', () => {
  it('is 20 days by default and shorter where a state says so, flagged to confirm', () => {
    expect(deadlineDays('TX')).toEqual({ days: 20, confirmWithState: false });
    expect(deadlineDays('al')).toEqual({ days: 7, confirmWithState: true });
    expect(dueDateFor('CA', new Date('2026-03-01T00:00:00Z')).toISOString().slice(0, 10)).toBe('2026-03-21');
    expect(dueDateFor('ME', new Date('2026-03-01T00:00:00Z')).toISOString().slice(0, 10)).toBe('2026-03-08');
  });

  it('writes the file with the federally required elements, quoting what needs it', () => {
    const csv = newHireCsv([
      { reportId: 'x', employerEin: '123456789', employerName: 'Acme, LLC', employerAddress: '1 Main', employerCity: 'Oakland', employerState: 'CA', employerZip: '94601', ssn: '123456789', firstName: 'Ana', lastName: 'Ruiz', address: '2 Elm', city: 'Oakland', state: 'CA', zip: '94601', dob: '1990-01-02', hireDate: '2026-03-01', stateOfHire: 'CA' },
    ]);
    const [header, row] = csv.trim().split('\r\n');
    expect(header).toContain('Employer FEIN');
    expect(header).toContain('Date of Hire');
    expect(row).toContain('"Acme, LLC"');
    expect(row!.endsWith('2026-03-01,CA')).toBe(true);
  });
});

describe('state pay notices', () => {
  it('picks the NY form by pay basis, CA for non-exempt only', () => {
    expect(formFor('NY', { payType: 'HOURLY', exempt: false })).toBe('NY_LS54');
    expect(formFor('NY', { payType: 'SALARY', exempt: false })).toBe('NY_LS56');
    expect(formFor('NY', { payType: 'SALARY', exempt: true })).toBe('NY_LS59');
    expect(formFor('CA', { payType: 'HOURLY', exempt: false })).toBe('CA_2810_5');
    expect(formFor('CA', { payType: 'SALARY', exempt: true })).toBeNull();
    expect(formFor('TX', { payType: 'HOURLY', exempt: false })).toBeNull();
  });

  it('uses the worker’s language when the state publishes it and we have the text', () => {
    expect(noticeLanguage('NY', 'es')).toEqual({ language: 'es', untranslated: null });
    expect(noticeLanguage('NY', 'ht')).toEqual({ language: 'ht', untranslated: null });
    expect(noticeLanguage('NY', 'ko')).toEqual({ language: 'en', untranslated: 'ko' });
    expect(noticeLanguage('NY', 'uk')).toEqual({ language: 'en', untranslated: null });
    expect(noticeLanguage('IL', 'es')).toEqual({ language: 'en', untranslated: null });
  });

  it('states the rate, overtime and payday, and hashes what was signed', () => {
    const facts: NoticeFacts = {
      employer: { legalName: 'Acme LLC', addressLine1: '1 Main', city: 'Buffalo', state: 'NY', zip: '14201', phone: '555-0100', ein: null },
      employee: { name: 'Ana Ruiz' },
      payType: 'HOURLY',
      rate: 18,
      basis: 'hour',
      overtimeRate: 27,
      exempt: false,
      payFrequency: 'Every two weeks',
      regularPayday: 'Friday',
      allowances: 'None',
      effectiveDate: '2026-04-01',
      sickLeave: null,
      missing: [],
      untranslatedLanguage: null,
    };
    const es = noticeLines(facts, 'es');
    expect(es.find((l) => l.label === 'Tarifa de pago')?.value).toBe('$18.00 por hora');
    expect(es.find((l) => l.label === 'Tarifa de horas extra')?.value).toBe('$27.00 por hora');
    const h1 = documentHash({ form: 'NY_LS54', language: 'es', facts: facts as never, sentAt: new Date('2026-04-01T00:00:00Z') });
    const h2 = documentHash({ form: 'NY_LS54', language: 'es', facts: { ...facts, rate: 19 } as never, sentAt: new Date('2026-04-01T00:00:00Z') });
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).not.toBe(h2);
  });
});
