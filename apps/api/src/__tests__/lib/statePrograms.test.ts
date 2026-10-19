import { describe, expect, it } from 'vitest';
import { calculateInHouse, type EmployeePeriodInput } from '../../lib/taxEngine/index.js';
import { PROGRAMS_NOT_YET_LIVE, STATE_PROGRAMS_2026, programLines, programsAwaitingReview } from '../../lib/taxEngine/statePrograms.js';

/**
 * State disability, paid-leave and employee unemployment contributions
 * (taxEngine/statePrograms.ts), each against the 2026 rate and cap its
 * agency published (the source is on every row).
 */

type Place = { state: string; city: string | null };
function input(state: string, over: Partial<EmployeePeriodInput> = {}): EmployeePeriodInput {
  const home: Place = { state, city: null };
  return {
    wages: 2000,
    payFrequency: 'BIWEEKLY',
    residence: home,
    work: [{ ...home, hours: 80 }],
    certificates: [],
    federalFilingStatus: 'SINGLE',
    federalCycleWithholding: 0,
    stateW4s: {},
    includePrograms: true,
    ...over,
  };
}
const amount = (lines: ReturnType<typeof programLines>, code: string) => lines.find((l) => l.code === code)?.amount;

describe('state programs, 2026', () => {
  it('every program cites its source and is verified for 2026; Maryland FAMLI is listed as starting in 2027', () => {
    for (const p of STATE_PROGRAMS_2026) {
      expect(p.source.length).toBeGreaterThan(20);
      expect(p.taxYear).toBe(2026);
    }
    expect(programsAwaitingReview('CA')).toEqual([]);
    expect(PROGRAMS_NOT_YET_LIVE.find((p) => p.state === 'MD')?.startsOn).toBe('2027-01-01');
  });

  it('CA SDI: 1.3% of every dollar (EDD DE 44, no wage ceiling since 2024)', () => {
    const lines = programLines(input('CA'), 'CA');
    expect(amount(lines, 'CA_SDI')).toBe(26);
    const big = programLines(input('CA', { wages: 50_000, ytdProgramWages: { CA_SDI: 400_000 } }), 'CA');
    expect(amount(big, 'CA_SDI')).toBe(650);
  });

  it('NJ: TDI 0.19% and FLI 0.23% to $171,100; UI/WF 0.425% to $44,800, each capped by year to date', () => {
    const lines = programLines(input('NJ'), 'NJ');
    expect(amount(lines, 'NJ_TDI')).toBe(3.8);
    expect(amount(lines, 'NJ_FLI')).toBe(4.6);
    expect(amount(lines, 'NJ_UI_WF')).toBe(8.5);
    // $500 of UI room left: 0.425% of $500.
    const capped = programLines(input('NJ', { ytdProgramWages: { NJ_UI_WF: 44_300 } }), 'NJ');
    expect(amount(capped, 'NJ_UI_WF')).toBe(2.13);
    expect(capped.find((l) => l.code === 'NJ_UI_WF')?.note).toMatch(/annual wage cap/);
  });

  it('NY: DBL 0.5% but not more than $0.60 a week; PFL 0.432% to the $411.91 annual maximum', () => {
    const lines = programLines(input('NY'), 'NY');
    expect(amount(lines, 'NY_DBL')).toBe(1.2); // two weeks × $0.60
    expect(amount(lines, 'NY_PFL')).toBe(8.64);
    // At the cap: nothing more.
    const done = programLines(input('NY', { ytdProgramWages: { NY_PFL: 100_000 } }), 'NY');
    expect(amount(done, 'NY_PFL')).toBe(0);
  });

  it('WA: PFML 1.13% split 71.43 / 28.57 (employer share only at 50+), WA Cares 0.58% unless exempt', () => {
    const big = programLines(input('WA'), 'WA');
    expect(amount(big, 'WA_PFML')).toBe(16.14);
    expect(amount(big, 'WA_PFML_ER')).toBe(6.46);
    expect(amount(big, 'WA_CARES')).toBe(11.6);
    const small = programLines(input('WA', { employerSize: 12 }), 'WA');
    expect(amount(small, 'WA_PFML_ER')).toBeUndefined();
    const exempt = programLines(input('WA', { certificates: [{ kind: 'WA_CARES_EXEMPT', state: 'WA', jurisdictionCode: null }] }), 'WA');
    expect(amount(exempt, 'WA_CARES')).toBe(0);
  });

  it('MA, OR, CO, CT, RI, HI, DE, MN, PA, AK and DC at their published shares', () => {
    expect(amount(programLines(input('MA'), 'MA'), 'MA_PFML')).toBe(9.2);
    expect(amount(programLines(input('MA', { employerSize: 10 }), 'MA'), 'MA_PFML_ER')).toBeUndefined();
    expect(amount(programLines(input('OR'), 'OR'), 'OR_PAID_LEAVE')).toBe(12);
    expect(amount(programLines(input('OR'), 'OR'), 'OR_PAID_LEAVE_ER')).toBe(8);
    expect(amount(programLines(input('CO'), 'CO'), 'CO_FAMLI')).toBe(8.8);
    expect(amount(programLines(input('CT'), 'CT'), 'CT_PFML')).toBe(10);
    expect(amount(programLines(input('RI'), 'RI'), 'RI_TDI')).toBe(22);
    expect(amount(programLines(input('HI'), 'HI'), 'HI_TDI')).toBe(10); // 0.5% = $10, under the $15 two-week ceiling
    expect(amount(programLines(input('HI', { wages: 5000 }), 'HI'), 'HI_TDI')).toBe(15); // capped at $7.50 a week
    expect(amount(programLines(input('DE'), 'DE'), 'DE_PFML')).toBe(8);
    expect(amount(programLines(input('DE', { employerSize: 15 }), 'DE'), 'DE_PFML')).toBe(3.2);
    expect(amount(programLines(input('MN'), 'MN'), 'MN_PFML')).toBe(8.8);
    expect(amount(programLines(input('PA'), 'PA'), 'PA_UC_EE')).toBe(1.4);
    expect(amount(programLines(input('AK'), 'AK'), 'AK_UI_EE')).toBe(10);
    const dc = programLines(input('DC'), 'DC');
    expect(dc.find((l) => l.code === 'DC_UPL')).toBeUndefined();
    expect(amount(dc, 'DC_UPL_ER')).toBe(15);
  });

  it('reads the state’s own base when the deduction rules supply one (a 401(k) deferral is in the SDI base)', () => {
    const lines = programLines(input('CA', { wages: 1800, bases: { stateProgram: { CA: 2000 } } }), 'CA');
    expect(amount(lines, 'CA_SDI')).toBe(26);
    const ui = programLines(input('PA', { wages: 1800, bases: { stateUi: { PA: 2000 } } }), 'PA');
    expect(amount(ui, 'PA_UC_EE')).toBe(1.4);
  });

  it('the engine follows the unemployment state, totals employee and employer apart, and stays silent unless asked', () => {
    const r = calculateInHouse(input('WA'));
    expect(r.programTotal).toBe(27.74); // 16.14 + 11.60
    expect(r.employerProgramTotal).toBe(6.46);
    expect(r.localTotal).toBe(0);
    expect(r.lines.filter((l) => l.kind === 'STATE_PROGRAM').length).toBe(3);
    const off = calculateInHouse(input('WA', { includePrograms: false }));
    expect(off.programTotal).toBe(0);
    expect(off.lines.some((l) => l.kind === 'STATE_PROGRAM')).toBe(false);
    // A worker localized in NJ, living in PA: NJ programs, not PA's.
    const cross = calculateInHouse(input('PA', { work: [{ state: 'NJ', city: null, hours: 80 }] }));
    expect(cross.lines.some((l) => l.code === 'NJ_TDI')).toBe(true);
    expect(cross.lines.some((l) => l.code === 'PA_UC_EE')).toBe(false);
  });
});
