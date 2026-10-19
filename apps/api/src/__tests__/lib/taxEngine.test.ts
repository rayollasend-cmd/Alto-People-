import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeStateIncomeTax } from '../../lib/payrollTax.js';
import {
  __resetLocalAcknowledgmentsForTesting,
  allocateWages,
  calculateInHouse,
  calculateTaxes,
  inHouseEngine,
  jurisdictionsAt,
  localAwaitingReview,
  reciprocityBetween,
  type EmployeePeriodInput,
  type TaxEngineProvider,
} from '../../lib/taxEngine/index.js';
import { symmetryEngine, vertexEngine } from '../../lib/taxEngine/external.js';
import type { ProviderContext } from '../../lib/providers/connections.js';

/**
 * The tax engine (lib/taxEngine): wages allocated by work site, state
 * reciprocity and credits, every local jurisdiction type, the review gate,
 * and a licensed engine that fails falling back to Alto's.
 */

type Place = { state: string | null; city: string | null; county?: string | null };

function input(over: Partial<EmployeePeriodInput> & { home?: Place & Partial<EmployeePeriodInput['residence']>; at?: Array<Place & { hours: number }> } = {}): EmployeePeriodInput {
  const { home, at, ...rest } = over;
  return {
    wages: 1000,
    payFrequency: 'BIWEEKLY',
    residence: home ?? { state: 'PA', city: 'Pittsburgh' },
    work: at ?? [{ ...(home ?? { state: 'PA', city: 'Pittsburgh' }), hours: 80 }],
    certificates: [],
    federalFilingStatus: 'SINGLE',
    federalCycleWithholding: 0,
    stateW4s: {},
    ...rest,
  };
}

const line = (r: ReturnType<typeof calculateInHouse>, code: string) => r.lines.find((l) => l.code === code);
const sit = (state: string, wages: number) =>
  computeStateIncomeTax({ grossPay: wages, state, payFrequency: 'BIWEEKLY', stateW4: null, federalFilingStatus: 'SINGLE', federalCycleWithholding: 0 });

describe('wage allocation', () => {
  it('splits a check across work sites by hours, rounding into the last slice', () => {
    const s = allocateWages(1000, [
      { state: 'PA', city: 'Pittsburgh', hours: 30 },
      { state: 'OH', city: 'Columbus', hours: 10 },
    ], null);
    expect(s.map((x) => [x.state, x.wages])).toEqual([['PA', 750], ['OH', 250]]);
    const thirds = allocateWages(100, [
      { state: 'NY', city: 'Yonkers', hours: 1 },
      { state: 'NY', city: 'New York', hours: 1 },
      { state: 'NJ', city: 'Newark', hours: 1 },
    ], null);
    expect(thirds.reduce((a, x) => a + x.wages, 0)).toBeCloseTo(100, 6);
  });

  it('falls back to the home state when there are no hours (salaried)', () => {
    expect(allocateWages(500, [], 'TX')).toEqual([{ state: 'TX', city: null, county: null, wages: 500 }]);
  });

  it('resolves an address to its jurisdictions, city first then county', () => {
    expect(jurisdictionsAt('PA', 'Pittsburgh').map((j) => j.code).sort()).toEqual(['PA-PITTSBURGH', 'PA-PITTSBURGH-LST']);
    expect(jurisdictionsAt('IN', null, 'Marion County').map((j) => j.code)).toEqual(['IN-MARION']);
    expect(jurisdictionsAt('IN', 'Fort Wayne').map((j) => j.code)).toEqual(['IN-ALLEN']);
    expect(jurisdictionsAt('TX', 'Houston')).toEqual([]);
  });
});

describe('multi-state and reciprocity', () => {
  it('a single-state worker gets exactly the state calculator’s withholding', () => {
    const r = calculateInHouse(input({ home: { state: 'PA', city: 'Harrisburg' } }));
    expect(r.stateTotal).toBe(sit('PA', 1000));
    expect(r.wagesByState).toEqual({ PA: 1000 });
  });

  it('withholds the work state and the resident state, less the credit', () => {
    const r = calculateInHouse(input({ wages: 2000, home: { state: 'NJ', city: 'Hoboken' }, at: [{ state: 'NY', city: 'Albany', hours: 40 }, { state: 'NJ', city: 'Hoboken', hours: 40 }] }));
    const ny = line(r, 'ST-NY')!;
    const nj = line(r, 'ST-NJ')!;
    expect(ny.wages).toBe(1000);
    expect(ny.amount).toBe(sit('NY', 1000));
    const fullNj = sit('NJ', 2000);
    const credit = Math.min(ny.amount, fullNj * 0.5);
    expect(nj.amount).toBeCloseTo(Math.max(0, fullNj - credit), 1);
    expect(nj.note).toMatch(/less a credit/);
    expect(ny.note).toMatch(/convenience-of-employer/);
    expect(r.stateTotal).toBeCloseTo(ny.amount + nj.amount, 2);
  });

  it('reciprocity: with the nonresidency certificate only the home state is withheld', () => {
    expect(reciprocityBetween('PA', 'NJ')).toEqual({ form: 'NJ-165' });
    const base = { home: { state: 'PA', city: 'Philadelphia' }, at: [{ state: 'NJ', city: 'Camden', hours: 80 }] };
    const without = calculateInHouse(input(base));
    expect(line(without, 'ST-NJ')!.amount).toBeGreaterThan(0);
    expect(line(without, 'ST-NJ')!.note).toMatch(/collect NJ-165/);
    const withCert = calculateInHouse(input({ ...base, certificates: [{ kind: 'NONRESIDENCY', state: 'NJ', jurisdictionCode: null }] }));
    expect(line(withCert, 'ST-NJ')!.amount).toBe(0);
    expect(line(withCert, 'ST-PA')!.amount).toBe(sit('PA', 1000));
  });

  it('DC never taxes nonresidents', () => {
    const r = calculateInHouse(input({ home: { state: 'MD', city: 'Bethesda' }, at: [{ state: 'DC', city: 'Washington', hours: 80 }] }));
    expect(line(r, 'ST-DC')).toMatchObject({ amount: 0 });
    expect(line(r, 'ST-MD')!.amount).toBeGreaterThan(0);
  });

  it('reports unemployment by the four-factor test', () => {
    const localized = calculateInHouse(input({ home: { state: 'NJ', city: 'Newark' }, at: [{ state: 'NY', city: 'Albany', hours: 76 }, { state: 'NJ', city: 'Newark', hours: 4 }] }));
    expect(localized.sui.state).toBe('NY');
    expect(localized.sui.reason).toMatch(/incidental/);
    const base = calculateInHouse(input({ home: { state: 'NJ', city: 'Newark' }, at: [{ state: 'NY', city: 'Albany', hours: 40 }, { state: 'NJ', city: 'Newark', hours: 40 }] }));
    expect(base.sui).toMatchObject({ state: 'NJ' });
    expect(base.sui.reason).toMatch(/Base of operations/);
  });
});

describe('local taxes by jurisdiction type', () => {
  it('Philadelphia: resident and nonresident wage tax', () => {
    const res = calculateInHouse(input({ home: { state: 'PA', city: 'Philadelphia' } }));
    expect(line(res, 'PA-PHILADELPHIA')).toMatchObject({ resident: true, amount: 37.4 });
    const non = calculateInHouse(input({ home: { state: 'NJ', city: 'Cherry Hill' }, at: [{ state: 'PA', city: 'Philadelphia', hours: 80 }] }));
    expect(line(non, 'PA-PHILADELPHIA')).toMatchObject({ resident: false, amount: 34.3 });
  });

  it('PA Act 32: the higher of the home and work rates, and the LST at the work location', () => {
    const r = calculateInHouse(input({ home: { state: 'PA', city: 'Pittsburgh' }, at: [{ state: 'PA', city: 'Harrisburg', hours: 80 }] }));
    expect(line(r, 'PA-PITTSBURGH')).toMatchObject({ amount: 30, resident: true });
    expect(line(r, 'PA-HARRISBURG-LST')!.amount).toBe(6);
    const back = calculateInHouse(input({ home: { state: 'PA', city: 'Allentown' }, at: [{ state: 'PA', city: 'Reading', hours: 80 }] }));
    // Allentown resident 1.975% vs Reading nonresident 1.3%: home wins.
    expect(line(back, 'PA-ALLENTOWN')!.amount).toBe(19.75);
    const ohio = calculateInHouse(input({ home: { state: 'OH', city: 'Dublin' }, at: [{ state: 'PA', city: 'Pittsburgh', hours: 80 }] }));
    expect(line(ohio, 'PA-PITTSBURGH')).toMatchObject({ amount: 10, resident: false });
  });

  it('LST: prorated per check, exempt under the low-income line or with the certificate', () => {
    const r = calculateInHouse(input({ home: { state: 'PA', city: 'Pittsburgh' } }));
    expect(line(r, 'PA-PITTSBURGH-LST')!.amount).toBe(2);
    const low = calculateInHouse(input({ wages: 400, home: { state: 'PA', city: 'Pittsburgh' } }));
    expect(line(low, 'PA-PITTSBURGH-LST')).toMatchObject({ amount: 0 });
    const cert = calculateInHouse(input({ home: { state: 'PA', city: 'Pittsburgh' }, certificates: [{ kind: 'LST_EXEMPTION', state: 'PA', jurisdictionCode: null }] }));
    expect(line(cert, 'PA-PITTSBURGH-LST')!.amount).toBe(0);
    expect(cert.jurisdictionsUsed).not.toContain('PA-PITTSBURGH-LST');
  });

  it('a Pennsylvania resident with no PSD code is an open question', () => {
    const r = calculateInHouse(input({ home: { state: 'PA', city: 'Smalltown' } }));
    expect(r.unresolved).toContain('PA_RESIDENT_PSD');
    const byPsd = calculateInHouse(input({ home: { state: 'PA', city: 'Smalltown', psdCode: '700102' } }));
    expect(byPsd.unresolved).toEqual([]);
  });

  it('Ohio: the work city withholds; the resident school district on top', () => {
    const r = calculateInHouse(input({ home: { state: 'OH', city: 'Dublin', schoolDistrict: '2502' }, at: [{ state: 'OH', city: 'Columbus', hours: 80 }] }));
    expect(line(r, 'OH-COLUMBUS')).toMatchObject({ amount: 25, resident: false });
    expect(line(r, 'OH-SD-2502')).toMatchObject({ kind: 'SCHOOL', amount: 7.5 });
  });

  it('New York City residents by the brackets; Yonkers as a share of state tax', () => {
    const nyc = calculateInHouse(input({ wages: 2000, home: { state: 'NY', city: 'Brooklyn' } }));
    // NYS-50-T-NYC 2026: 52,000 − 5,000 = 47,000 → 783 + 22,000 × 4.15% = 1,696 ÷ 26.
    expect(line(nyc, 'NY-NYC')!.amount).toBeCloseTo(1_696 / 26, 2);
    const yRes = calculateInHouse(input({ home: { state: 'NY', city: 'Yonkers' } }));
    expect(line(yRes, 'NY-YONKERS')!.amount).toBeCloseTo(line(yRes, 'ST-NY')!.amount * 0.1675, 2);
    const yNon = calculateInHouse(input({ home: { state: 'NJ', city: 'Fort Lee' }, at: [{ state: 'NY', city: 'Yonkers', hours: 80 }] }));
    expect(line(yNon, 'NY-YONKERS')).toMatchObject({ amount: 5, resident: false });
    // NYC doesn't tax nonresidents.
    const commuter = calculateInHouse(input({ home: { state: 'NJ', city: 'Hoboken' }, at: [{ state: 'NY', city: 'New York', hours: 80 }] }));
    expect(line(commuter, 'NY-NYC')).toBeUndefined();
  });

  it('Michigan cities: work-city tax credited against the home city', () => {
    const r = calculateInHouse(input({ home: { state: 'MI', city: 'Detroit' }, at: [{ state: 'MI', city: 'Grand Rapids', hours: 80 }] }));
    expect(line(r, 'MI-GRAND-RAPIDS')!.amount).toBe(7.5);
    expect(line(r, 'MI-DETROIT')!.amount).toBe(16.5);
  });

  it('Indiana: the resident county on January 1; the work county for nonresidents', () => {
    const r = calculateInHouse(input({ home: { state: 'IN', city: 'Indianapolis' } }));
    expect(line(r, 'IN-MARION')!.amount).toBe(20.2);
    const moved = calculateInHouse(input({ home: { state: 'IN', city: 'Indianapolis', countyJan1: 'Hamilton' } }));
    expect(line(moved, 'IN-HAMILTON')!.amount).toBe(11);
    const unknown = calculateInHouse(input({ home: { state: 'IN', city: 'Nowhere' } }));
    expect(unknown.unresolved).toContain('IN_COUNTY_JAN1');
    const ohioan = calculateInHouse(input({ home: { state: 'IL', city: 'Chicago' }, at: [{ state: 'IN', city: 'Gary', hours: 80 }] }));
    expect(line(ohioan, 'IN-LAKE')).toMatchObject({ amount: 15, resident: false });
  });

  it('Kentucky occupational license taxes, Kansas City, Wilmington', () => {
    const lex = calculateInHouse(input({ home: { state: 'KY', city: 'Georgetown' }, at: [{ state: 'KY', city: 'Lexington', hours: 80 }] }));
    expect(line(lex, 'KY-LEXINGTON')).toMatchObject({ kind: 'OLT', amount: 22.5 });
    const kc = calculateInHouse(input({ home: { state: 'KS', city: 'Overland Park' }, at: [{ state: 'MO', city: 'Kansas City', hours: 80 }] }));
    expect(line(kc, 'MO-KANSAS-CITY')!.amount).toBe(10);
    const wil = calculateInHouse(input({ home: { state: 'DE', city: 'Wilmington' } }));
    expect(line(wil, 'DE-WILMINGTON')!.amount).toBe(12.5);
  });

  it('Oregon transit is employer-paid and never leaves the paycheck', () => {
    const r = calculateInHouse(input({ home: { state: 'OR', city: 'Portland' } }));
    expect(line(r, 'OR-TRIMET')).toMatchObject({ employer: true, amount: 8.24 });
    expect(r.employerLocalTotal).toBe(8.24);
    expect(r.localTotal).toBe(0);
  });
});

describe('the review gate', () => {
  it('every local jurisdiction awaits review until the tenant’s acknowledgments say otherwise', () => {
    __resetLocalAcknowledgmentsForTesting();
    expect(localAwaitingReview('PA-PITTSBURGH')).toMatchObject({ code: 'PA-PITTSBURGH', taxYear: 2026 });
    expect(localAwaitingReview('NOT-A-PLACE')).toBeNull();
  });
});

describe('licensed engines and the fallback', () => {
  const ctx = (provider: 'SYMMETRY_STE' | 'VERTEX_PAYROLL'): ProviderContext => ({
    connectionId: 'c1',
    tenantId: null,
    provider,
    environment: 'SANDBOX',
    baseUrl: 'https://engine.example.test/api',
    credentials: { apiKey: 'k', accessToken: 't' },
    settings: {},
    webhookSecret: null,
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('Alto’s engine answers without a fallback', async () => {
    const r = await calculateTaxes(inHouseEngine, input());
    expect(r).toMatchObject({ engine: 'IN_HOUSE', fallbackReason: null });
  });

  it('reads a Symmetry answer and keeps federal taxes with Alto', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          taxes: [
            { uniqueTaxId: '42-000-0000-SIT-000', description: 'PA state income tax', taxType: 'STATE', taxableWages: 1000, amount: 30.7, state: 'PA' },
            { uniqueTaxId: '42-003-1152-CITY-000', description: 'Pittsburgh EIT', taxType: 'CITY', taxableWages: 1000, amount: 30, isResident: true, state: 'PA' },
            { uniqueTaxId: '00-000-0000-FIT-000', description: 'Federal income tax', taxType: 'FEDERAL', taxableWages: 1000, amount: 90 },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const r = await calculateTaxes(symmetryEngine(ctx('SYMMETRY_STE')), input());
    expect(r.engine).toBe('SYMMETRY_STE');
    expect(r.fallbackReason).toBeNull();
    expect(r.stateTotal).toBe(30.7);
    expect(r.localTotal).toBe(30);
    expect(r.lines.some((l) => /Federal/.test(l.label))).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith('https://engine.example.test/api/calculate', expect.objectContaining({ method: 'POST' }));
  });

  it('falls back to Alto’s engine when Vertex fails, and says why', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"down"}', { status: 503 })));
    const r = await calculateTaxes(vertexEngine(ctx('VERTEX_PAYROLL')), input());
    expect(r.engine).toBe('IN_HOUSE');
    expect(r.fallbackReason).toMatch(/Vertex didn’t answer/);
    expect(r.stateTotal).toBe(sit('PA', 1000));
  });

  it('falls back when an engine throws outright', async () => {
    const broken: TaxEngineProvider = {
      key: 'SYMMETRY_STE',
      calculate: async () => {
        throw new Error('license expired');
      },
      resolveJurisdictions: async () => [],
    };
    const r = await calculateTaxes(broken, input());
    expect(r).toMatchObject({ engine: 'IN_HOUSE' });
    expect(r.fallbackReason).toMatch(/Symmetry didn’t answer \(license expired\)/);
  });
});

describe('each state taxes its own wage base (lib/deductionTaxability)', () => {
  it('a PA resident working half in NJ with a $200 401(k): PA counts the deferral, NJ does not', () => {
    // Federal base 1,800 (2,000 gross − 200 deferral). PA and NJ both tax 401(k) deferrals for income tax… except NJ
    // here is given its base without it to prove the engine reads each state's own figure.
    const r = calculateInHouse(
      input({
        wages: 1800,
        home: { state: 'PA', city: 'Harrisburg' },
        at: [
          { state: 'NJ', city: 'Camden', hours: 40 },
          { state: 'PA', city: 'Harrisburg', hours: 40 },
        ],
        bases: { stateIncome: { PA: 2000, NJ: 1800 }, local: 2000 },
      }),
    );
    const pa = line(r, 'ST-PA')!;
    const nj = line(r, 'ST-NJ')!;
    expect(pa.wages).toBe(2000); // resident: all wages, deferral included
    expect(nj.wages).toBe(900); // half the hours × NJ's base, deferral excluded
    expect(pa.amount).toBeGreaterThan(0);
    // wagesByState (SUI, reporting) stays the federal-base allocation.
    expect(r.wagesByState).toEqual({ NJ: 900, PA: 900 });
    // Local EIT reads the local base, allocated by hours: Harrisburg's half is 1,000.
    const eit = r.lines.filter((l) => l.kind === 'LOCAL' && l.workState === 'PA');
    for (const l of eit) expect(l.wages).toBe(1000);
  });

  it('without bases every state uses the federal base (unchanged behaviour)', () => {
    const r = calculateInHouse(input({ wages: 1800, home: { state: 'PA', city: 'Harrisburg' }, at: [{ state: 'NJ', city: 'Camden', hours: 40 }, { state: 'PA', city: 'Harrisburg', hours: 40 }] }));
    expect(line(r, 'ST-PA')!.wages).toBe(1800);
    expect(line(r, 'ST-NJ')!.wages).toBe(900);
  });
});
