import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { aggregateW2Wages } from '../../lib/w2Aggregator.js';
import { hasW2cDelta } from '../../lib/w2cAggregator.js';
import { generateReturn } from '../../lib/payrollTaxReturns.js';
import { personVariances, yearEndReconciliation } from '../../lib/yearEndReconciliation.js';
import { createAssociate, createClient, prisma, truncateAll } from '../../../test/db.js';

/**
 * Filings rebuilt from itemized deductions and the tax engine's lines: the
 * W-2's boxes, the 941 and 940 lines, the SUI wage base, and the year-end
 * reconciliation that puts them side by side.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

type Ded = { code: string; category: 'PRE_TAX' | 'POST_TAX' | 'EMPLOYER'; employee?: number; employer?: number; exemptFrom?: string[]; box12?: string; box14?: string; box10?: boolean };
type Line = { code: string; kind: string; label?: string; resident?: boolean; workState?: string | null; wages: number; amount: number; employer?: boolean };

async function paid(opts: {
  associateId: string;
  clientId?: string | null;
  date: string;
  gross: number;
  fit?: number;
  ss?: number;
  medicare?: number;
  state?: string | null;
  stateTax?: number;
  preTax?: number;
  retirement?: number;
  deds?: Ded[];
  lines?: Line[];
  employerSuta?: number;
  employerFuta?: number;
}) {
  const run = await prisma.payrollRun.create({
    data: { clientId: opts.clientId ?? null, periodStart: new Date(opts.date), periodEnd: new Date(opts.date), status: 'DISBURSED', disbursedAt: new Date(`${opts.date}T15:00:00Z`) },
  });
  const ss = opts.ss ?? 0;
  const med = opts.medicare ?? 0;
  const item = await prisma.payrollItem.create({
    data: {
      payrollRunId: run.id,
      associateId: opts.associateId,
      hoursWorked: 40,
      hourlyRate: 25,
      grossPay: opts.gross,
      federalWithholding: opts.fit ?? 0,
      fica: ss,
      medicare: med,
      employerFica: ss,
      employerMedicare: med,
      employerFuta: opts.employerFuta ?? 0,
      employerSuta: opts.employerSuta ?? 0,
      stateWithholding: opts.stateTax ?? 0,
      preTaxDeductions: opts.preTax ?? 0,
      preTaxRetirement: opts.retirement ?? 0,
      taxState: opts.state ?? null,
      netPay: opts.gross,
      status: 'DISBURSED',
    },
  });
  for (const d of opts.deds ?? []) {
    await prisma.payrollItemDeduction.create({
      data: { payrollItemId: item.id, code: d.code, category: d.category, label: d.code, employeeAmount: d.employee ?? 0, employerAmount: d.employer ?? 0, exemptFrom: d.exemptFrom ?? [], w2Box12Code: d.box12 ?? null, w2Box14Label: d.box14 ?? null, w2Box10: d.box10 ?? false },
    });
  }
  for (const l of opts.lines ?? []) {
    await prisma.payrollItemTaxLine.create({
      data: { payrollItemId: item.id, code: l.code, kind: l.kind, label: l.label ?? l.code, resident: l.resident ?? false, workState: l.workState ?? null, wages: l.wages, amount: l.amount, employer: l.employer ?? false },
    });
  }
  return { run, item };
}

const SEC125 = ['FIT', 'SS', 'MEDICARE', 'FUTA', 'SIT:PA', 'SIT:NJ', 'SIT:NY', 'SUI:PA', 'SUI:NJ', 'SUI:NY', 'SUI:CA', 'LOCAL'];

describe('W-2 from itemized deductions', () => {
  it('401(k), §125 medical, HSA, dependent care, group-term life and DD land in the right boxes', async () => {
    const a = await createAssociate({ firstName: 'Ana', lastName: 'Diaz' });
    // Gross includes $30 of imputed group-term life over $50,000.
    await paid({
      associateId: a.id,
      date: '2026-03-13',
      gross: 3030,
      fit: 250,
      ss: 172,
      medicare: 40,
      state: 'PA',
      deds: [
        { code: 'RET_401K', category: 'PRE_TAX', employee: 150, exemptFrom: ['FIT'], box12: 'D' },
        { code: 'MEDICAL', category: 'PRE_TAX', employee: 100, exemptFrom: SEC125, box12: 'DD' },
        { code: 'HSA', category: 'PRE_TAX', employee: 50, exemptFrom: ['FIT', 'SS', 'MEDICARE', 'FUTA', 'SIT:PA'], box12: 'W' },
        { code: 'DCAP', category: 'PRE_TAX', employee: 200, exemptFrom: SEC125, box10: true },
        { code: 'ER_HEALTH', category: 'EMPLOYER', employer: 400, box12: 'DD' },
        { code: 'ER_HSA', category: 'EMPLOYER', employer: 25, box12: 'W' },
        { code: 'LIFE', category: 'EMPLOYER', employer: 30, box12: 'C' },
        { code: 'UNION_DUES', category: 'POST_TAX', employee: 20, box14: 'UNION DUES' },
      ],
    });
    const w2 = await aggregateW2Wages(prisma, a.id, 2026);
    // Box 1: gross − 401(k) − medical − HSA − DCAP.
    expect(w2.box1Wages).toBe(3030 - 150 - 100 - 50 - 200);
    // Boxes 3 and 5 keep the 401(k): gross − medical − HSA − DCAP.
    expect(w2.box3SsWages).toBe(3030 - 100 - 50 - 200);
    expect(w2.box5MedicareWages).toBe(3030 - 100 - 50 - 200);
    expect(w2.box10DependentCare).toBe(200);
    expect(w2.box12).toEqual([
      { code: 'C', amount: 30 },
      { code: 'D', amount: 150 },
      { code: 'W', amount: 75 },
      { code: 'DD', amount: 500 },
    ]);
    expect(w2.box13RetirementPlan).toBe(true);
    expect(w2.box14Other).toEqual([{ label: 'UNION DUES', amount: 20 }]);
    // Pennsylvania taxes 401(k) deferrals: state wages add them back (no SIT:PA on the 401(k) line).
    expect(w2.stateLines).toEqual([{ state: 'PA', stateWages: 3030 - 100 - 50 - 200, stateIncomeTax: 0 }]);
  });

  it('a check from before itemized lines keeps the lump rule — and PA adds the 401(k) back', async () => {
    const a = await createAssociate();
    await paid({ associateId: a.id, date: '2026-02-13', gross: 2000, state: 'PA', stateTax: 61.4, preTax: 200, retirement: 150 });
    const w2 = await aggregateW2Wages(prisma, a.id, 2026);
    expect(w2.box1Wages).toBe(1800);
    expect(w2.box3SsWages).toBe(1950);
    expect(w2.stateLines).toEqual([{ state: 'PA', stateWages: 1950, stateIncomeTax: 61.4 }]);
  });

  it('a NJ worker: state wages from the engine, SDI and FLI in box 14', async () => {
    const a = await createAssociate();
    await paid({
      associateId: a.id,
      date: '2026-04-10',
      gross: 1500,
      state: 'NJ',
      lines: [
        { code: 'ST-NJ', kind: 'STATE', resident: true, workState: 'NJ', wages: 1500, amount: 33.2 },
        { code: 'NJ_TDI', kind: 'STATE_PROGRAM', label: 'NJ disability insurance', workState: 'NJ', wages: 1500, amount: 3.45 },
        { code: 'NJ_FLI', kind: 'STATE_PROGRAM', label: 'NJ family leave insurance', workState: 'NJ', wages: 1500, amount: 4.8 },
        { code: 'SUI-NJ', kind: 'SUI', workState: 'NJ', wages: 1500, amount: 0 },
      ],
    });
    const w2 = await aggregateW2Wages(prisma, a.id, 2026);
    expect(w2.stateLines).toEqual([{ state: 'NJ', stateWages: 1500, stateIncomeTax: 33.2, resident: true }]);
    expect(w2.box14Other).toEqual([
      { label: 'NJFLI', amount: 4.8 },
      { label: 'NJSDI', amount: 3.45 },
    ]);
  });

  it('a two-state worker reports both states; local taxes fill boxes 18–20', async () => {
    const a = await createAssociate();
    await paid({
      associateId: a.id,
      date: '2026-05-08',
      gross: 2000,
      lines: [
        { code: 'ST-PA', kind: 'STATE', resident: true, workState: 'PA', wages: 2000, amount: 61.4 },
        { code: 'ST-OH', kind: 'STATE', resident: false, workState: 'OH', wages: 800, amount: 20 },
        { code: '700101', kind: 'LOCAL', label: 'Pittsburgh EIT', workState: 'PA', wages: 1200, amount: 36 },
        { code: 'LST-700101', kind: 'OLT', label: 'Pittsburgh LST', workState: 'PA', wages: 1200, amount: 2 },
        { code: 'OH-COLUMBUS', kind: 'LOCAL', label: 'Columbus', workState: 'OH', wages: 800, amount: 20 },
        { code: 'OR-TRIMET-ER', kind: 'EMPLOYER', label: 'TriMet employer', workState: 'OR', wages: 100, amount: 0.8, employer: true },
      ],
    });
    const w2 = await aggregateW2Wages(prisma, a.id, 2026);
    expect(w2.stateLines.map((s) => [s.state, s.stateWages, s.stateIncomeTax])).toEqual([
      ['OH', 800, 20],
      ['PA', 2000, 61.4],
    ]);
    expect(w2.localLines!.map((l) => [l.state, l.locality, l.localWages, l.localIncomeTax])).toEqual([
      ['OH', 'Columbus', 800, 20],
      ['PA', 'Pittsburgh EIT', 1200, 36],
      ['PA', 'Pittsburgh LST', 1200, 2],
    ]);
  });

  it('a W-2c sees a change in box 14 or the local boxes', async () => {
    const a = await createAssociate();
    await paid({ associateId: a.id, date: '2026-05-08', gross: 1000 });
    const w2 = await aggregateW2Wages(prisma, a.id, 2026);
    expect(hasW2cDelta(w2, { ...w2, box14Other: [{ label: 'CASDI', amount: 12 }] })).toBe(true);
    expect(hasW2cDelta(w2, { ...w2, localLines: [{ state: 'OH', locality: 'Columbus', code: 'X', kind: 'LOCAL', localWages: 1, localIncomeTax: 1 }] })).toBe(true);
    expect(hasW2cDelta(w2, { ...w2 })).toBe(false);
  });
});

describe('returns from the same bases', () => {
  it('941: Social Security stops at the wage base across quarters; 5d picks up wages over $200,000', async () => {
    const big = await createAssociate({ firstName: 'Big', lastName: 'Earner' });
    const small = await createAssociate({ firstName: 'Small', lastName: 'Earner' });
    // Q1–Q3: $180,000 for the big earner.
    await paid({ associateId: big.id, date: '2026-02-13', gross: 180_000, ss: 11_160, medicare: 2610 });
    // Q4: another $30,000 → only $4,500 more is Social Security wages (2026 base $184,500), $10,000 over $200k.
    await paid({ associateId: big.id, date: '2026-11-13', gross: 30_000, fit: 6000, ss: 279, medicare: 525 });
    await paid({ associateId: small.id, date: '2026-11-13', gross: 1000, fit: 80, ss: 62, medicare: 14.5 });
    const cfg = await prisma.payrollConfig.findUnique({ where: { year: 2026 }, select: { ssWageBase: true } });
    const base = Number(cfg!.ssWageBase);
    const q4 = await generateReturn(prisma, 'F941', 'US', '2026-Q4');
    expect(q4.totals.line2_wages).toBe(31_000);
    expect(q4.totals.line5a_socialSecurityWages).toBe(base - 180_000 + 1000);
    expect(q4.totals.line5c_medicareWages).toBe(31_000);
    expect(q4.totals.line5d_additionalMedicareWages).toBe(10_000);
    expect(q4.totals.line5d_additionalMedicareTax).toBe(90);
    expect(q4.rows).toEqual([{ day: '2026-11-13', liability: expect.any(Number) }]);
  });

  it('940: §125 is exempt (line 4), a 401(k) deferral is not; wages over $7,000 come off; a CA credit reduction adds Schedule A', async () => {
    const a = await createAssociate();
    await paid({
      associateId: a.id,
      date: '2026-03-13',
      gross: 10_000,
      lines: [{ code: 'SUI-CA', kind: 'SUI', workState: 'CA', wages: 10_000, amount: 0 }],
      deds: [
        { code: 'MEDICAL', category: 'PRE_TAX', employee: 500, exemptFrom: SEC125 },
        { code: 'RET_401K', category: 'PRE_TAX', employee: 1000, exemptFrom: ['FIT'] },
      ],
    });
    const f940 = await generateReturn(prisma, 'F940', 'US', '2026');
    expect(f940.totals.line3_totalPayments).toBe(10_000);
    expect(f940.totals.line4_exemptPayments).toBe(500);
    expect(f940.totals.line5_paymentsOver7000).toBe(2500);
    expect(f940.totals.line7_taxableFutaWages).toBe(7000);
    expect(f940.totals.line8_futaTax).toBe(42);
    expect(f940.totals.line11_creditReduction).toBeGreaterThan(0);
    expect(f940.rows[0]).toMatchObject({ state: 'CA', taxableWages: 7000 });
    expect(f940.totals.line16a_q1Liability).toBe(42);
  });

  it('a SUI wage report counts the 401(k) as UI wages and caps at the base', async () => {
    const a = await createAssociate({ firstName: 'Uma', lastName: 'Ivers' });
    await prisma.taxAgencyAccount.create({ data: { kind: 'STATE_UNEMPLOYMENT', jurisdiction: 'NJ', agencyName: 'NJ Department of Labor', status: 'ACTIVE', wageBase: 43_300, rate: 0.028 } });
    await paid({ associateId: a.id, date: '2026-04-10', gross: 5000, state: 'NJ', deds: [{ code: 'RET_401K', category: 'PRE_TAX', employee: 400, exemptFrom: ['FIT', 'SIT:NJ'] }] });
    const r = await generateReturn(prisma, 'SUI_WAGE_REPORT', 'NJ', '2026-Q2');
    expect(r.rows[0]).toMatchObject({ lastName: 'Ivers', quarterWages: 5000, taxableWages: 5000 });
    expect(r.totals.contributionDue).toBe(140);
  });

  it('a state paid-leave report: each person’s subject wages and contributions', async () => {
    const a = await createAssociate({ firstName: 'Wes', lastName: 'Ash' });
    await paid({
      associateId: a.id,
      date: '2026-07-10',
      gross: 2000,
      lines: [
        { code: 'WA_PFML', kind: 'STATE_PROGRAM', workState: 'WA', wages: 2000, amount: 14.2 },
        { code: 'WA_PFML', kind: 'STATE_PROGRAM', workState: 'WA', wages: 2000, amount: 6.8, employer: true },
        { code: 'WA_CARES', kind: 'STATE_PROGRAM', workState: 'WA', wages: 2000, amount: 11.6 },
      ],
    });
    const r = await generateReturn(prisma, 'STATE_PROGRAM_REPORT', 'WA', '2026-Q3');
    expect(r.totals).toMatchObject({ employees: 1, WA_PFML_employee: 14.2, WA_PFML_employer: 6.8, WA_CARES_employee: 11.6, taxDue: 32.6 });
    expect(r.rows).toHaveLength(2);
    const w2 = await aggregateW2Wages(prisma, a.id, 2026);
    expect(w2.box14Other).toEqual([
      { label: 'WA CARES', amount: 11.6 },
      { label: 'WA PFML', amount: 14.2 },
    ]);
  });
});

describe('year-end reconciliation', () => {
  it('agrees when nothing is wrong, and finds a planted W-2 variance and the person behind it', async () => {
    await createClient();
    const a = await createAssociate({ firstName: 'Rae', lastName: 'Lind' });
    const b = await createAssociate({ firstName: 'Bo', lastName: 'Kim' });
    await paid({ associateId: a.id, date: '2026-03-13', gross: 4000, fit: 400, ss: 248, medicare: 58, state: 'PA', stateTax: 122.8 });
    await paid({ associateId: b.id, date: '2026-03-13', gross: 3000, fit: 300, ss: 186, medicare: 43.5, state: 'PA', stateTax: 92.1 });

    const clean = await yearEndReconciliation(prisma, 2026);
    const fed = clean.sections.find((s) => s.key === 'federal')!;
    expect(fed.rows.find((r) => r.key === 'wages')).toMatchObject({ ok: true, values: { paychecks: 7000, f941: 7000, w2: 7000 } });
    expect(clean.generatedQuarters).toContain('2026-Q1');
    expect(clean.checklist.map((c) => c.code)).toEqual(expect.arrayContaining(['missing_ssn', 'missing_address', 'no_941']));

    // A W-2 on file for Rae that says $3,500 — someone edited it by hand.
    const w2 = await aggregateW2Wages(prisma, a.id, 2026);
    await prisma.taxForm.create({ data: { kind: 'W2', taxYear: 2026, associateId: a.id, amounts: { ...w2, box1Wages: 3500 } as object, status: 'FILED' } });
    const off = await yearEndReconciliation(prisma, 2026);
    const wages = off.sections.find((s) => s.key === 'federal')!.rows.find((r) => r.key === 'wages')!;
    expect(wages.ok).toBe(false);
    expect(wages.variance).toBe(500);
    expect(off.checklist.find((c) => c.code === 'w2_stale')?.people?.[0]?.name).toBe('Rae Lind');

    const people = await personVariances(prisma, 2026, 'box1');
    expect(people[0]).toMatchObject({ name: 'Rae Lind', paychecks: 4000, w2: 3500, difference: -500, w2Source: 'stored' });
    expect(people[1]).toMatchObject({ name: 'Bo Kim', difference: 0, w2Source: 'computed' });
  });
});
