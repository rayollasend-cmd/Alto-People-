import { describe, expect, it } from 'vitest';
import { computeWithholding, convertFrequency, levyExemptPerPeriod, minimumWageFloor, type EngineOrder } from '../../lib/garnishmentEngine.js';
import { buildAcknowledgment, buildLumpSumNotice, buildTerminationNotice, eiwoProblems, orderFieldsFrom, parseEiwoFile, parseXml, redactParsed } from '../../lib/eiwo.js';
import { adviceText, dedSegment, remitDueBy } from '../../lib/garnishmentRemit.js';
import { buildNachaFile, validateNachaFile } from '../../lib/banking/nacha.js';
import { autoEnrollProblems, eligibleOn, employerContribution, projectRetirement, trueUp, enrollmentFacts, type PayrollElection } from '../../lib/retirement.js';
import { RECORDKEEPERS, contributionTotals, parseCsv, type ContributionRow } from '../../lib/recordkeepers.js';
import { build834, coverageLevelFor, segmentsOf, type Edi834Member } from '../../lib/edi834.js';

const order = (o: Partial<EngineOrder> & { id: string }): EngineOrder => ({ kind: 'CHILD_SUPPORT', priority: 10, ...o });

describe('garnishment engine — support allocation and CCPA limits', () => {
  it('pro rata splits the support limit by what each order asks; current support before arrears', () => {
    // D = 1000, 60% limit = 600. Current asks 400 + 400 = 800 > 600 → 300 each; arrears get nothing.
    const r = computeWithholding({
      disposableEarnings: 1000,
      payFrequency: 'BIWEEKLY',
      orders: [
        order({ id: 'a', currentSupport: 400, pastDueSupport: 100, orderFrequency: 'BIWEEKLY', state: 'TX' }),
        order({ id: 'b', currentSupport: 400, orderFrequency: 'BIWEEKLY', state: 'TX' }),
      ],
      stateRules: { TX: { allocationMethod: 'PRO_RATA' } },
    });
    expect(r.deductions.find((d) => d.garnishmentId === 'a')!.amount).toBe(300);
    expect(r.deductions.find((d) => d.garnishmentId === 'b')!.amount).toBe(300);
    expect(r.total).toBe(600);
    expect(r.deductions[0]!.note).toMatch(/60% support limit/);
  });

  it('first in time fills the earliest order first when the state says so', () => {
    const r = computeWithholding({
      disposableEarnings: 1000,
      payFrequency: 'BIWEEKLY',
      orders: [
        order({ id: 'late', currentSupport: 400, orderFrequency: 'BIWEEKLY', state: 'XX', receivedAt: new Date('2026-05-01') }),
        order({ id: 'early', currentSupport: 400, orderFrequency: 'BIWEEKLY', state: 'XX', receivedAt: new Date('2026-01-01') }),
      ],
      stateRules: { XX: { allocationMethod: 'FIRST_IN_TIME' } },
    });
    expect(r.deductions.find((d) => d.garnishmentId === 'early')!.amount).toBe(400);
    expect(r.deductions.find((d) => d.garnishmentId === 'late')!.amount).toBe(200);
  });

  it('50% for a second family, +5% with arrears over 12 weeks', () => {
    const second = computeWithholding({ disposableEarnings: 1000, orders: [order({ id: 'a', amountPerRun: 900, supportsSecondFamily: true })] });
    expect(second.total).toBe(500);
    const arrears = computeWithholding({ disposableEarnings: 1000, orders: [order({ id: 'a', amountPerRun: 900, supportsSecondFamily: true, arrearsOver12Weeks: true })] });
    expect(arrears.total).toBe(550);
  });

  it('a monthly order is restated per paycheck', () => {
    expect(convertFrequency(520, 'MONTHLY', 'WEEKLY')).toBe(120);
    const r = computeWithholding({ disposableEarnings: 1000, payFrequency: 'WEEKLY', orders: [order({ id: 'a', currentSupport: 520, orderFrequency: 'MONTHLY' })] });
    expect(r.total).toBe(120);
  });

  it('creditors stop at 30× the federal minimum wage', () => {
    expect(minimumWageFloor('WEEKLY')).toBe(217.5);
    expect(minimumWageFloor('BIWEEKLY')).toBe(435);
    expect(minimumWageFloor('SEMIMONTHLY')).toBe(471.25);
    expect(minimumWageFloor('MONTHLY')).toBe(942.5);
    // Weekly D = 250: 25% = 62.50 but only 250 − 217.50 = 32.50 is reachable.
    const r = computeWithholding({ disposableEarnings: 250, payFrequency: 'WEEKLY', orders: [order({ id: 'c', kind: 'CREDITOR', amountPerRun: 100 })] });
    expect(r.total).toBe(32.5);
  });

  it('student loans take at most 15%, inside the 25% shared with creditors', () => {
    const r = computeWithholding({
      disposableEarnings: 1000,
      orders: [order({ id: 'sl', kind: 'STUDENT_LOAN', amountPerRun: 400, priority: 20 }), order({ id: 'c', kind: 'CREDITOR', amountPerRun: 400, priority: 30 })],
    });
    expect(r.deductions.find((d) => d.garnishmentId === 'sl')!.amount).toBe(150);
    expect(r.deductions.find((d) => d.garnishmentId === 'c')!.amount).toBe(100);
  });

  it('a state admin fee is capped at the state maximum and counts toward the limit', () => {
    const r = computeWithholding({
      disposableEarnings: 1000,
      orders: [order({ id: 'a', amountPerRun: 200, state: 'OH', adminFee: 5 })],
      stateRules: { OH: { allocationMethod: 'PRO_RATA', adminFeeMax: 2, adminFeeFrequency: 'PER_PAYMENT' } },
    });
    expect(r.deductions[0]!.adminFee).toBe(2);
    expect(r.adminFeeTotal).toBe(2);
    // At the limit there is no room for a fee.
    const full = computeWithholding({ disposableEarnings: 1000, orders: [order({ id: 'a', amountPerRun: 600, adminFee: 5 })] });
    expect(full.adminFeeTotal).toBe(0);
    // A monthly fee already taken this month is not taken again.
    const monthly = computeWithholding({
      disposableEarnings: 1000,
      orders: [order({ id: 'a', amountPerRun: 100, state: 'NY' })],
      stateRules: { NY: { allocationMethod: 'PRO_RATA', adminFeeMax: 2, adminFeeFrequency: 'MONTHLY' } },
      feeAlreadyCharged: new Set(['a']),
    });
    expect(monthly.adminFeeTotal).toBe(0);
  });
});

describe('federal tax levy — Publication 1494', () => {
  // Example figures (enter the real ones per year from Pub 1494): $15,000 standard, $2,000 additional, $5,000 per dependent.
  const p = { standardDeduction: 15000, additionalStandardDeduction: 2000, exemptionAmount: 5000 };

  it('exempt amount = (standard + additional + dependents × exemption) / periods', () => {
    expect(levyExemptPerPeriod(p, 0, 0, 'BIWEEKLY')).toBe(576.92);
    expect(levyExemptPerPeriod(p, 2, 1, 'WEEKLY')).toBe(519.23); // (15000 + 2000 + 10000) / 52
    expect(levyExemptPerPeriod(p, 1, 0, 'MONTHLY')).toBe(1666.67);
  });

  it('the levy takes take-home pay above the exempt amount, after support', () => {
    const exempt = levyExemptPerPeriod(p, 0, 0, 'BIWEEKLY');
    const r = computeWithholding({
      disposableEarnings: 1500,
      takeHomePay: 1400,
      payFrequency: 'BIWEEKLY',
      orders: [order({ id: 'cs', amountPerRun: 200 }), order({ id: 'irs', kind: 'TAX_LEVY', levyExemptPerPeriod: exempt, priority: 20 })],
    });
    expect(r.deductions.find((d) => d.garnishmentId === 'irs')!.amount).toBe(Math.round((1400 - 200 - exempt) * 100) / 100);
  });

  it('pay within the exempt amount → no levy, with a reason', () => {
    const r = computeWithholding({ disposableEarnings: 500, payFrequency: 'BIWEEKLY', orders: [order({ id: 'irs', kind: 'TAX_LEVY', levyExemptPerPeriod: 576.92 })] });
    expect(r.total).toBe(0);
    expect(r.skipped[0]!.note).toMatch(/exempt amount/);
  });
});

const EIWO = `<?xml version="1.0" encoding="UTF-8"?>
<!-- sample in the e-IWO element style -->
<IWOTransmission xmlns:e="urn:ocse:eiwo">
  <Header><e:EmployerFEIN>12-3456789</e:EmployerFEIN></Header>
  <IWODocument>
    <DocumentActionCode>ORG</DocumentActionCode>
    <DocumentTrackingNumber>TRK-001</DocumentTrackingNumber>
    <CaseIdentifier>CS123456</CaseIdentifier>
    <OrderIdentifier>ORD-77</OrderIdentifier>
    <RemittanceIdentifier>RID-9</RemittanceIdentifier>
    <IssuingStateTribeTerritory>TX</IssuingStateTribeTerritory>
    <IssuingJurisdictionFIPSCode>48000</IssuingJurisdictionFIPSCode>
    <IssuingAgencyName>Texas Office of the Attorney General</IssuingAgencyName>
    <EmployeeFirstName>Maria</EmployeeFirstName>
    <EmployeeLastName>Lopez</EmployeeLastName>
    <EmployeeSSN>123-45-6789</EmployeeSSN>
    <EmployeeBirthDate>19880412</EmployeeBirthDate>
    <CurrentChildSupportAmount>400.00</CurrentChildSupportAmount>
    <PastDueChildSupportAmount>50.00</PastDueChildSupportAmount>
    <CurrentCashMedicalSupportAmount>25.00</CurrentCashMedicalSupportAmount>
    <CurrentSupportFrequency>M</CurrentSupportFrequency>
    <ArrearsGreaterThan12WeeksIndicator>Y</ArrearsGreaterThan12WeeksIndicator>
    <SDUName>Texas State Disbursement Unit</SDUName>
    <SDUAddressLine1>PO Box 659791</SDUAddressLine1>
    <SDUCity>San Antonio</SDUCity><SDUState>TX</SDUState><SDUZip>78265</SDUZip>
  </IWODocument>
  <IWODocument>
    <DocumentActionCode>TRM</DocumentActionCode>
    <CaseIdentifier>CS999</CaseIdentifier>
    <EmployeeLastName>Smith &amp; Sons</EmployeeLastName>
    <EmployeeSSN>987654321</EmployeeSSN>
  </IWODocument>
</IWOTransmission>`;

describe('e-IWO intake and answers', () => {
  it('reads each document: action, case/order/remittance ids, amounts, frequency, payee', () => {
    const docs = parseEiwoFile(EIWO);
    expect(docs).toHaveLength(2);
    const d = docs[0]!;
    expect(d.documentActionCode).toBe('ORG');
    expect(d.caseIdentifier).toBe('CS123456');
    expect(d.orderIdentifier).toBe('ORD-77');
    expect(d.remittanceIdentifier).toBe('RID-9');
    expect(d.issuingState).toBe('TX');
    expect(d.fipsCode).toBe('48000');
    expect(d.employeeSsn).toBe('123456789');
    expect(d.employeeDob).toBe('1988-04-12');
    expect(d.orderFrequency).toBe('MONTHLY');
    expect(d.currentSupport).toBe(400);
    expect(d.pastDueSupport).toBe(50);
    expect(d.medicalSupport).toBe(25);
    expect(d.arrearsOver12Weeks).toBe(true);
    expect(d.payeeName).toBe('Texas State Disbursement Unit');
    expect(d.payeeAddress).toBe('PO Box 659791\nSan Antonio, TX 78265');
    expect(eiwoProblems(d)).toEqual([]);
    expect(docs[1]!.documentActionCode).toBe('TRM');
    expect(docs[1]!.employeeLastName).toBe('Smith & Sons');
    expect(orderFieldsFrom(d)).toMatchObject({ currentSupport: 400, pastDueSupport: 50, medicalSupport: 25, orderFrequency: 'MONTHLY' });
  });

  it('keeps only the SSN’s last four in the stored copy', () => {
    const kept = redactParsed(parseEiwoFile(EIWO)[0]!);
    expect(JSON.stringify(kept)).not.toContain('123456789');
    expect(kept.employeeSsnLast4).toBe('6789');
  });

  it('refuses a broken file and an unknown action code plainly', () => {
    expect(() => parseXml('<a><b></a>')).toThrow(/closes <a>/);
    expect(() => parseEiwoFile('<IWO><DocumentActionCode>XYZ</DocumentActionCode></IWO>')).toThrow(/not ORG, AMD, TRM or LUM/);
  });

  it('names what an incomplete document is missing', () => {
    const [d] = parseEiwoFile('<IWO><DocumentActionCode>ORG</DocumentActionCode><EmployeeLastName>Lee</EmployeeLastName></IWO>');
    const problems = eiwoProblems(d!);
    expect(problems.join(' ')).toMatch(/case identifier/);
    expect(problems.join(' ')).toMatch(/Social Security/);
    expect(problems.join(' ')).toMatch(/how often/);
  });

  it('acknowledges: accepted (A) and rejected (R) with a reason code, escaping text', () => {
    const [d] = parseEiwoFile(EIWO);
    const employer = { ein: '12-3456789', name: 'Acme <Staffing>', address: '1 Main St' };
    const now = new Date('2026-10-18T12:00:00Z');
    const ok = buildAcknowledgment(employer, [{ doc: d!, ssn: '123456789', accepted: true }], now, '42');
    expect(ok).toContain('<DispositionStatusCode>A</DispositionStatusCode>');
    expect(ok).not.toContain('DispositionReasonCode');
    expect(ok).toContain('<CaseIdentifier>CS123456</CaseIdentifier>');
    expect(ok).toContain('<DocumentTrackingNumber>TRK-001</DocumentTrackingNumber>');
    expect(ok).toContain('<EmployerName>Acme &lt;Staffing&gt;</EmployerName>');
    expect(ok).toContain('<EmployerFEIN>123456789</EmployerFEIN>');
    expect(ok).toContain('<ControlNumber>42</ControlNumber>');
    const no = buildAcknowledgment(employer, [{ doc: d!, ssn: '123456789', accepted: false, reasonCode: 'T', terminationDate: '2026-09-30' }], now);
    expect(no).toContain('<DispositionStatusCode>R</DispositionStatusCode>');
    expect(no).toContain('<DispositionReasonCode>T</DispositionReasonCode>');
    expect(no).toContain('<TerminationDate>2026-09-30</TerminationDate>');
    // The answer is itself readable XML.
    expect(() => parseXml(no)).not.toThrow();
  });

  it('writes termination and lump-sum notices in the acknowledgment format', () => {
    const employer = { ein: '123456789', name: 'Acme' };
    const ref = { caseIdentifier: 'CS1', orderIdentifier: 'O1', remittanceIdentifier: 'R1', fipsCode: '48000', employeeFirstName: 'Maria', employeeLastName: 'Lopez', ssn: '123456789' };
    const t = buildTerminationNotice(employer, { order: ref, terminationDate: '2026-10-01', lastPayDate: '2026-10-09', finalPaymentAmount: 123.4, employeeLastKnownAddress: '5 Elm St', newEmployerName: 'Beta LLC' });
    expect(t).toContain('<DocumentActionCode>TRM</DocumentActionCode>');
    expect(t).toContain('<FinalPaymentAmount>123.40</FinalPaymentAmount>');
    expect(t).toContain('<NewEmployerName>Beta LLC</NewEmployerName>');
    const l = buildLumpSumNotice(employer, { order: ref, paymentType: 'BONUS', amount: 2500, expectedPaymentDate: '2026-12-15' });
    expect(l).toContain('<DocumentActionCode>LUM</DocumentActionCode>');
    expect(l).toContain('<LumpSumPaymentAmount>2500.00</LumpSumPaymentAmount>');
    expect(parseXml(l).children[0]!.name).toBe('EIWOAcknowledgmentFile');
  });
});

describe('electronic remittance — CCD+ with the child support DED addenda', () => {
  it('builds the DED segment: case, pay date, cents, SSN, medical, name, FIPS, termination', () => {
    const seg = dedSegment({ caseId: 'CS123456', payDate: '2026-10-16', amount: 276.92, ssn: '123-45-6789', medicalSupport: true, lastName: 'Lopez-Garcia', firstName: 'Maria', fipsCode: '48000', terminated: false });
    expect(seg).toBe('DED*CS*CS123456*261016*27692*123456789*Y*LOPEZGA,M*48000*N\\');
    expect(seg.length).toBeLessThanOrEqual(80);
  });

  it('rides as the addenda of a valid NACHA CCD file', () => {
    const addenda = dedSegment({ caseId: 'CS1', payDate: '2026-10-16', amount: 100, ssn: '123456789', medicalSupport: false, lastName: 'Lee', firstName: 'Ann', fipsCode: '06000', terminated: false });
    const built = buildNachaFile(
      { immediateDestination: '091000019', immediateDestinationName: 'BANK', immediateOrigin: '1234567890', immediateOriginName: 'ACME', fileIdModifier: 'A', createdAt: new Date('2026-10-18T10:00:00Z') },
      [{ sec: 'CCD', companyName: 'ACME', companyId: '1234567890', entryDescription: 'CHILD SUPP', effectiveDate: '2026-10-19', originatingDfi: '091000010', entries: [{ transactionCode: '22', routingNumber: '011000015', accountNumber: '999888777', amountCents: 10000, individualId: 'RID-9', individualName: 'CA SDU', addenda }] }],
    );
    expect(validateNachaFile(built.content)).toEqual({ ok: true });
    const addendaLine = built.content.split('\n').find((l) => l.startsWith('705'))!;
    expect(addendaLine.slice(3, 83).trim()).toBe(addenda);
    expect(built.totals.addendaCount).toBe(1);
  });

  it('is due within 7 business days of payday, and the advice lists each case', () => {
    expect(remitDueBy('2026-10-16')).toBe('2026-10-27');
    const text = adviceText('CA SDU', '2026-10-19', [
      { deductionId: 'd1', garnishmentId: 'g1', kind: 'CHILD_SUPPORT', caseNumber: 'CS1', employeeName: 'Ann Lee', amount: 100, payDate: '2026-10-16' },
      { deductionId: 'd2', garnishmentId: 'g2', kind: 'CHILD_SUPPORT', caseNumber: 'CS2', employeeName: 'Bo Kim', amount: 50.5, payDate: '2026-10-16' },
    ]);
    expect(text).toContain('CS1');
    expect(text).toContain('Total 150.50 across 2 cases');
  });
});

describe('401(k): match math, safe harbor, eligibility, auto-enroll', () => {
  it('matches in bands: 100% up to 3%, 50% from 3% to 5%', () => {
    const plan = { matchFormula: [{ upToPercent: 3, matchPercent: 100 }, { upToPercent: 5, matchPercent: 50 }], safeHarbor: 'NONE' };
    expect(employerContribution(plan, 2000, 120)).toEqual({ match: 80, safeHarbor: 0 }); // 6%: 3% × 100% = 60, 2% × 50% = 20
    expect(employerContribution(plan, 2000, 40)).toEqual({ match: 40, safeHarbor: 0 }); // 2%
    expect(employerContribution(plan, 2000, 0)).toEqual({ match: 0, safeHarbor: 0 });
  });

  it('safe harbor: basic, enhanced, 3% nonelective', () => {
    expect(employerContribution({ matchFormula: [], safeHarbor: 'BASIC' }, 1000, 100)).toEqual({ match: 0, safeHarbor: 40 });
    expect(employerContribution({ matchFormula: [], safeHarbor: 'ENHANCED' }, 1000, 100)).toEqual({ match: 0, safeHarbor: 40 });
    expect(employerContribution({ matchFormula: [], safeHarbor: 'NONELECTIVE_3' }, 1000, 0)).toEqual({ match: 0, safeHarbor: 30 });
  });

  it('one enrollment, one deduction: a rate becomes cents of this gross; a flat enrollment passes through', () => {
    const plan = { kind: 'RETIREMENT_401K' as const, allowsDeemedRoth: true, employerContributionCentsPerPeriod: 0 };
    const rate = enrollmentFacts({ electedAmountCentsPerPeriod: 0, rothElection: false, electedPercent: 5, rothPercent: 2, plan }, 2000);
    expect(rate.map((f) => [f.electedAmountCentsPerPeriod, f.rothElection])).toEqual([[10000, false], [4000, true]]);
    const flat = enrollmentFacts({ electedAmountCentsPerPeriod: 7500, rothElection: true, electedPercent: null, rothPercent: null, plan }, 2000);
    expect(flat).toEqual([{ electedAmountCentsPerPeriod: 7500, rothElection: true, plan }]);
    const e: PayrollElection = { planId: 'p', matchFormula: [{ upToPercent: 4, matchPercent: 100 }], safeHarbor: 'NONE', loans: [{ loanNumber: 'L-1', perPayAmount: 80 }] };
    const proj = projectRetirement(e, 2000, { pre401k: 100, roth401k: 40, catchUp: 0, catchUpRoth: 0 } as never, 50);
    expect(proj).toMatchObject({ preTax: 100, roth: 40, employerMatch: 80, safeHarbor: 0 });
    expect(proj.loanRepayments).toEqual([{ loanNumber: 'L-1', amount: 50 }]); // only what net pay allows
  });

  it('true-up pays the match a front-loader missed', () => {
    const plan = { matchFormula: [{ upToPercent: 4, matchPercent: 100 }], safeHarbor: 'NONE' };
    // $100k comp; deferred $24,500 by June (match paid only on those checks: $2,000).
    expect(trueUp(plan, { comp: 100000, deferralExCatchUp: 24500, matchPaid: 2000, safeHarborPaid: 0 })).toBe(2000);
    expect(trueUp(plan, { comp: 100000, deferralExCatchUp: 24500, matchPaid: 4000, safeHarborPaid: 0 })).toBe(0);
  });

  it('eligibility: age and service, then the entry date', () => {
    const plan = { eligibilityMinAge: 21, eligibilityServiceDays: 90, entryTiming: 'MONTHLY' };
    expect(eligibleOn(plan, { dob: new Date('1990-01-01'), hireDate: new Date('2026-01-15') })!.toISOString().slice(0, 10)).toBe('2026-05-01');
    expect(eligibleOn(plan, { dob: new Date('2005-08-20'), hireDate: new Date('2026-01-15') })!.toISOString().slice(0, 10)).toBe('2026-09-01');
    expect(eligibleOn({ ...plan, entryTiming: 'QUARTERLY' }, { dob: new Date('1990-01-01'), hireDate: new Date('2026-01-15') })!.toISOString().slice(0, 10)).toBe('2026-07-01');
    expect(eligibleOn(plan, { dob: null, hireDate: new Date('2026-01-15') })).toBeNull();
  });

  it('SECURE 2.0: a plan set up after 2022-12-29 must auto-enroll at 3–10%, escalating to 10–15%', () => {
    const base = { establishedOn: new Date('2024-01-01'), autoEnroll: true, autoEnrollPercent: 3, autoEscalatePercent: 1, autoEscalateMax: 10 };
    expect(autoEnrollProblems(base)).toEqual([]);
    expect(autoEnrollProblems({ ...base, autoEnroll: false }).join(' ')).toMatch(/must auto-enroll/);
    expect(autoEnrollProblems({ ...base, autoEnrollPercent: 2 }).join(' ')).toMatch(/between 3% and 10%/);
    expect(autoEnrollProblems({ ...base, autoEscalateMax: 8 }).join(' ')).toMatch(/at least 10%/);
    expect(autoEnrollProblems({ ...base, establishedOn: new Date('2015-01-01'), autoEnroll: false })).toEqual([]);
  });
});

const row = (over: Partial<ContributionRow> = {}): ContributionRow => ({
  ssn: '123456789', employeeId: 'emp-1', firstName: 'Ann', lastName: 'Lee', dob: '1980-02-03', hireDate: '2020-05-06', termDate: null,
  payDate: '2026-10-16', grossPay: 2000, planComp: 2000, hours: 80, preTax: 100, roth: 40, catchUpPreTax: 0, catchUpRoth: 20,
  employerMatch: 70, safeHarbor: 0, loans: [{ loanNumber: 'L-1', amount: 50 }], ...over,
});

describe('recordkeeper contribution files', () => {
  it('Guideline: one CSV row per person per pay date, loans by id', () => {
    const csv = RECORDKEEPERS.GUIDELINE.contributionFile(null, '2026-10-16', [row()]);
    const rows = parseCsv(csv);
    expect(rows[0]).toContain('Employee Roth');
    const h = rows[0]!;
    const r = rows[1]!;
    expect(r[h.indexOf('SSN')]).toBe('123456789');
    expect(r[h.indexOf('Pay Date')]).toBe('10/16/2026');
    expect(r[h.indexOf('Employee Pre-Tax')]).toBe('100.00');
    expect(r[h.indexOf('Catch-Up Roth')]).toBe('20.00');
    expect(r[h.indexOf('Employer Match')]).toBe('70.00');
    expect(r[h.indexOf('Loan Number')]).toBe('L-1');
    expect(r[h.indexOf('Loan Repayment')]).toBe('50.00');
  });

  it('Empower SFTP: one record per money source with a header and a trailer that totals', () => {
    const txt = RECORDKEEPERS.EMPOWER_SFTP.contributionFile('PLAN-9', '2026-10-16', [row()]);
    const lines = txt.trim().split('\r\n');
    expect(lines[0]).toMatch(/^H\|PLAN-9\|20261016\|/);
    const sources = lines.filter((l) => l.startsWith('D|')).map((l) => l.split('|'));
    expect(sources.map((f) => f[9])).toEqual(['PRE', 'ROTH', 'CUROTH', 'MATCH', 'LOAN']);
    expect(sources.find((f) => f[9] === 'LOAN')![11]).toBe('L-1');
    expect(lines[lines.length - 1]).toBe('T|5|280.00');
  });

  it('Vestwell and the generic layout carry the plan number; totals add up', () => {
    const v = parseCsv(RECORDKEEPERS.VESTWELL.contributionFile('VW-1', '2026-10-16', [row(), row({ ssn: '987654321', loans: [] })]));
    expect(v[1]![0]).toBe('VW-1');
    expect(v).toHaveLength(3);
    expect(contributionTotals([row(), row({ loans: [] })])).toEqual({ people: 2, preTax: 200, roth: 80, catchUp: 40, employer: 140, loans: 50 });
  });

  it('reads deferral changes coming back (CSV and pipe)', () => {
    const csv = 'SSN,Pre-Tax %,Roth %,Effective Date,Opt Out\r\n123-45-6789,6,1,11/01/2026,N\r\n987654321,0,0,2026-11-01,Y\r\n';
    const c = RECORDKEEPERS.GUIDELINE.parseDeferralChanges(csv);
    expect(c[0]).toEqual({ ssn: '123456789', employeeId: null, preTaxPercent: 6, rothPercent: 1, effectiveDate: '2026-11-01', optOut: false });
    expect(c[1]!.optOut).toBe(true);
    const p = RECORDKEEPERS.EMPOWER_SFTP.parseDeferralChanges('H|X\r\n123456789|8|0|20261101|N\r\nT|1\r\n');
    expect(p).toEqual([{ ssn: '123456789', employeeId: null, preTaxPercent: 8, rothPercent: 0, effectiveDate: '2026-11-01', optOut: false }]);
  });
});

describe('EDI 834 (005010X220A1)', () => {
  const env = { senderQualifier: 'ZZ', senderId: 'ACMEHR', receiverQualifier: 'ZZ', receiverId: 'BCBSTX', usage: 'T' as const, controlNumber: 7, createdAt: new Date('2026-10-18T14:05:00Z') };
  const header = { mode: 'CHANGE' as const, referenceId: 'REF7', policyNumber: 'GRP-100', effectiveDate: '2026-10-18', sponsorName: 'Acme Staffing', sponsorTaxId: '123456789', carrierName: 'Blue Cross' };
  const sub: Edi834Member = {
    subscriber: true, relationship: '18', maintenance: '021', reason: '28', employmentStatus: 'FT', subscriberId: '123456789', lastName: 'Lee', firstName: 'Ann', ssn: '123456789',
    dob: '1980-02-03', gender: 'U', phone: '(555) 123-4567', address: { line1: '5 Elm St', line2: null, city: 'Austin', state: 'TX', zip: '78701' }, hireDate: '2020-05-06',
    coverages: [{ maintenance: '021', insuranceLine: 'HLT', planCode: 'PPO500', coverageLevel: 'ESP', begin: '2026-11-01', end: null }],
  };
  const spouse: Edi834Member = { ...sub, subscriber: false, relationship: '01', employmentStatus: null, firstName: 'Bo', ssn: null, phone: null, address: null, hireDate: null, dob: '1982-07-08' };

  it('wraps members in ISA/GS/ST … SE/GE/IEA with matching counts and control numbers', () => {
    const built = build834(env, header, [sub, spouse]);
    const segs = segmentsOf(built.content);
    const ids = segs.map((s) => s[0]);
    expect(ids[0]).toBe('ISA');
    expect(segs[0]!.join('*').length).toBe(105); // ISA is fixed-width: 106 with the terminator
    expect(segs[0]![13]).toBe('000000007');
    expect(segs[0]![15]).toBe('T');
    expect(segs[1]!.slice(0, 2)).toEqual(['GS', 'BE']);
    expect(segs[1]![8]).toBe('005010X220A1');
    expect(ids.slice(-3)).toEqual(['SE', 'GE', 'IEA']);
    const st = ids.indexOf('ST');
    const se = ids.indexOf('SE');
    expect(Number(segs[se]![1])).toBe(se - st + 1);
    expect(segs[ids.indexOf('IEA')]![2]).toBe('000000007');
    expect(segs.find((s) => s[0] === 'BGN')![8]).toBe('2');
    expect(segs.find((s) => s[0] === 'REF' && s[1] === '38')![2]).toBe('GRP-100');
    expect(segs.filter((s) => s[0] === 'N1').map((s) => s[1])).toEqual(['P5', 'IN']);
    expect(segs.find((s) => s[0] === 'QTY' && s[1] === 'DT')![2]).toBe('1');
  });

  it('a subscriber loop: INS, REF*0F, DTP*336, NM1*IL with SSN, PER, N3/N4, DMG, HD, DTP*348', () => {
    const segs = segmentsOf(build834(env, header, [sub, spouse]).content);
    const ins = segs.filter((s) => s[0] === 'INS');
    expect(ins[0]!.slice(0, 6)).toEqual(['INS', 'Y', '18', '021', '28', 'A']);
    expect(ins[0]![8]).toBe('FT');
    expect(ins[1]!.slice(0, 4)).toEqual(['INS', 'N', '01', '021']);
    const nm1 = segs.filter((s) => s[0] === 'NM1');
    expect(nm1[0]).toEqual(['NM1', 'IL', '1', 'LEE', 'ANN', '', '', '', '34', '123456789']);
    expect(nm1[1]).toEqual(['NM1', 'IL', '1', 'LEE', 'BO']); // no SSN for the dependent; trailing empties dropped
    expect(segs.filter((s) => s[0] === 'REF' && s[1] === '0F').map((s) => s[2])).toEqual(['123456789', '123456789']);
    expect(segs.find((s) => s[0] === 'PER')).toEqual(['PER', 'IP', '', 'TE', '5551234567']);
    expect(segs.find((s) => s[0] === 'N4')).toEqual(['N4', 'AUSTIN', 'TX', '78701']);
    expect(segs.find((s) => s[0] === 'DMG')).toEqual(['DMG', 'D8', '19800203', 'U']);
    expect(segs.find((s) => s[0] === 'HD')).toEqual(['HD', '021', '', 'HLT', 'PPO500', 'ESP']);
    expect(segs.find((s) => s[0] === 'DTP' && s[1] === '348')).toEqual(['DTP', '348', 'D8', '20261101']);
    expect(segs.find((s) => s[0] === 'DTP' && s[1] === '336')).toEqual(['DTP', '336', 'D8', '20200506']);
  });

  it('a full file replaces (RX) and audits every member (030); a termination carries DTP*349', () => {
    const full = segmentsOf(build834(env, { ...header, mode: 'FULL' }, [{ ...sub, maintenance: '030', reason: 'XN', coverages: [{ ...sub.coverages[0]!, maintenance: '030' }] }]).content);
    expect(full.find((s) => s[0] === 'BGN')![8]).toBe('RX');
    expect(full.find((s) => s[0] === 'INS')![3]).toBe('030');
    const term = segmentsOf(build834(env, header, [{ ...sub, maintenance: '024', reason: '07', coverages: [{ ...sub.coverages[0]!, maintenance: '024', end: '2026-10-31' }] }]).content);
    expect(term.find((s) => s[0] === 'DTP' && s[1] === '349')).toEqual(['DTP', '349', 'D8', '20261031']);
  });

  it('no delimiter leaks from a value; coverage level from who is covered', () => {
    const odd = build834(env, header, [{ ...sub, lastName: "O'Neil*Smith~Jr" }]).content;
    expect(segmentsOf(odd).find((s) => s[0] === 'NM1')![3]).toBe("O'NEIL SMITH JR");
    expect(coverageLevelFor([])).toBe('EMP');
    expect(coverageLevelFor([{ relation: 'SPOUSE' }])).toBe('ESP');
    expect(coverageLevelFor([{ relation: 'CHILD' }])).toBe('E1D');
    expect(coverageLevelFor([{ relation: 'CHILD' }, { relation: 'CHILD' }])).toBe('ECH');
    expect(coverageLevelFor([{ relation: 'SPOUSE' }, { relation: 'CHILD' }])).toBe('FAM');
  });
});
