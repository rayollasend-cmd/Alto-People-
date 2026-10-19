import { computeStateIncomeTax, NO_SIT_STATES, type PayFrequency } from '../payrollTax.js';
import {
  CONVENIENCE_OF_EMPLOYER,
  LOCAL_JURISDICTIONS,
  NO_NONRESIDENT_TAX,
  NO_WITHHOLDING_CREDIT,
  localJurisdiction,
  reciprocityBetween,
  type LocalJurisdiction,
} from './jurisdictions.js';
import type {
  EmployeePeriodInput,
  EmployeePeriodResult,
  TaxEngineProvider,
  TaxLine,
  WorkAllocation,
} from './types.js';
import { programLines } from './statePrograms.js';

/**
 * Alto's own tax engine: state withholding allocated across the states a
 * worker actually worked in (staffing assignments cross state lines), with
 * reciprocity and the resident state's credit, and the local taxes —
 * Pennsylvania Act 32 EIT and LST, Philadelphia, Ohio cities and school
 * districts, NYC and Yonkers, Michigan cities, Indiana counties, Kentucky
 * occupational taxes, Kansas City and St. Louis, Wilmington, Oregon transit.
 *
 * Wages are allocated to a state (and a city) in proportion to the payable
 * hours worked there this period. A single-state worker gets exactly the
 * withholding the state calculator always gave.
 */

const PERIODS: Record<PayFrequency, number> = { WEEKLY: 52, BIWEEKLY: 26, SEMIMONTHLY: 24, MONTHLY: 12, DAILY: 260 };
const round2 = (n: number) => Math.round(n * 100) / 100;
const lc = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();
const uc = (s: string | null | undefined) => (s ?? '').trim().toUpperCase() || null;

interface Slice {
  state: string | null;
  city: string | null;
  county: string | null;
  wages: number;
}

/** Split the check's wages across work locations by hours, rounding into the last slice. */
export function allocateWages(wages: number, work: WorkAllocation[], fallbackState: string | null): Slice[] {
  const rows = work.filter((w) => w.hours > 0);
  if (rows.length === 0 || wages <= 0) {
    return [{ state: fallbackState, city: null, county: null, wages: round2(wages) }];
  }
  // Group by state + city so two stores in one city are one slice.
  const groups = new Map<string, { state: string | null; city: string | null; county: string | null; hours: number }>();
  for (const w of rows) {
    const key = `${uc(w.state) ?? ''}|${lc(w.city)}`;
    const g = groups.get(key) ?? { state: uc(w.state), city: w.city?.trim() || null, county: w.county?.trim() || null, hours: 0 };
    g.hours += w.hours;
    groups.set(key, g);
  }
  const list = [...groups.values()].sort((a, b) => b.hours - a.hours);
  const total = list.reduce((s, g) => s + g.hours, 0);
  const out: Slice[] = [];
  let given = 0;
  list.forEach((g, i) => {
    const share = i === list.length - 1 ? round2(wages - given) : round2((wages * g.hours) / total);
    given = round2(given + share);
    out.push({ state: g.state ?? fallbackState, city: g.city, county: g.county, wages: share });
  });
  return out;
}

const hasCert = (input: EmployeePeriodInput, kind: string, state: string | null, code?: string) =>
  input.certificates.some(
    (c) => c.kind === kind && (state === null || uc(c.state) === state) && (code === undefined || c.jurisdictionCode === code),
  );

/** The local jurisdictions an address falls in (city first, then county). */
export function jurisdictionsAt(state: string | null, city: string | null, county?: string | null): LocalJurisdiction[] {
  const s = uc(state);
  if (!s) return [];
  const c = lc(city);
  const k = lc(county);
  return LOCAL_JURISDICTIONS.filter(
    (j) => j.state === s && ((c && j.cities?.includes(c)) || (k && j.counties?.includes(k.replace(/ county$/, '')))),
  );
}

function stateTax(input: EmployeePeriodInput, state: string, wages: number): number {
  return computeStateIncomeTax({
    grossPay: wages,
    state,
    payFrequency: input.payFrequency,
    stateW4: input.stateW4s[state] ?? null,
    federalFilingStatus: input.federalFilingStatus,
    federalCycleWithholding: input.federalCycleWithholding,
  });
}

const line = (l: Omit<TaxLine, 'note' | 'employer'> & { note?: string | null; employer?: boolean }): TaxLine => ({
  note: null,
  employer: false,
  ...l,
  wages: round2(l.wages),
  amount: round2(l.amount),
});

/* ----- State ---------------------------------------------------------------- */

/**
 * A state's income-tax base for the whole check (lib/deductionTaxability:
 * PA and NJ tax 401(k) deferrals, CA and NJ tax HSA contributions …),
 * falling back to the federal base.
 */
const stateBase = (input: EmployeePeriodInput, state: string) => input.bases?.stateIncome?.[state] ?? input.wages;
/** The share of the check's hours worked in a slice, from the federal-base allocation. */
const shareOf = (input: EmployeePeriodInput, allocated: number) => (input.wages > 0 ? allocated / input.wages : 0);

function stateLines(input: EmployeePeriodInput, slices: Slice[]): { lines: TaxLine[]; byState: Record<string, number> } {
  const resident = uc(input.residence.state);
  const byState: Record<string, number> = {};
  for (const s of slices) {
    if (!s.state) continue;
    byState[s.state] = round2((byState[s.state] ?? 0) + s.wages);
  }
  const lines: TaxLine[] = [];
  const workTaxes: Array<{ state: string; share: number; tax: number }> = [];
  for (const [state, allocated] of Object.entries(byState)) {
    // Each state taxes its own base, allocated by hours exactly as the federal base is.
    const share = shareOf(input, allocated);
    const wages = input.wages > 0 ? round2(stateBase(input, state) * share) : allocated;
    if (state === resident) continue;
    if (NO_SIT_STATES.has(state)) continue;
    if (NO_NONRESIDENT_TAX.has(state)) {
      lines.push(line({ code: `ST-${state}`, kind: 'STATE', label: `${state} state income tax`, resident: false, workState: state, wages, amount: 0, note: `${state} doesn’t tax nonresidents’ wages.` }));
      continue;
    }
    const recip = resident ? reciprocityBetween(resident, state) : null;
    if (recip && hasCert(input, 'NONRESIDENCY', state)) {
      lines.push(line({ code: `ST-${state}`, kind: 'STATE', label: `${state} state income tax`, resident: false, workState: state, wages, amount: 0, note: `Reciprocity with ${resident}: ${recip.form} on file, so only ${resident} tax is withheld.` }));
      continue;
    }
    const tax = stateTax(input, state, wages);
    workTaxes.push({ state, share, tax });
    lines.push(
      line({
        code: `ST-${state}`,
        kind: 'STATE',
        label: `${state} state income tax`,
        resident: false,
        workState: state,
        wages,
        amount: tax,
        note:
          (recip ? `${resident} and ${state} have reciprocity — collect ${recip.form} from the worker to stop ${state} withholding.` : `Nonresident wages for work in ${state}.`) +
          (CONVENIENCE_OF_EMPLOYER[state] ? ` ${state} applies the convenience-of-employer rule: days worked from home for the worker’s convenience stay ${state} wages.` : ''),
      }),
    );
  }
  if (resident && !NO_SIT_STATES.has(resident)) {
    // The resident state taxes all wages under its own base.
    const total = stateBase(input, resident);
    const full = stateTax(input, resident, total);
    // The resident state credits tax paid to the work state, up to its own tax on those wages.
    let credit = 0;
    if (!NO_WITHHOLDING_CREDIT.has(resident)) {
      for (const w of workTaxes) credit += Math.min(w.tax, full * w.share);
    }
    const amount = Math.max(0, full - credit);
    const away = workTaxes.length > 0;
    lines.unshift(
      line({
        code: `ST-${resident}`,
        kind: 'STATE',
        label: `${resident} state income tax`,
        resident: true,
        workState: byState[resident] !== undefined ? resident : null,
        wages: total,
        amount,
        note: away
          ? NO_WITHHOLDING_CREDIT.has(resident)
            ? `${resident} doesn’t let the employer credit tax withheld by ${workTaxes.map((w) => w.state).join(', ')}; the worker claims it on their return.`
            : `Resident tax on all wages, less a credit of ${round2(credit).toFixed(2)} for tax withheld by ${workTaxes.map((w) => w.state).join(', ')}.`
          : null,
      }),
    );
  }
  return { lines, byState };
}

/* ----- Local ---------------------------------------------------------------- */

function residentJurisdictions(input: EmployeePeriodInput): LocalJurisdiction[] {
  const r = input.residence;
  const out: LocalJurisdiction[] = [];
  if (r.localCode) {
    const j = localJurisdiction(r.localCode);
    if (j) out.push(j);
  }
  if (r.psdCode) {
    for (const j of LOCAL_JURISDICTIONS) if (j.psdCodes?.includes(r.psdCode) && !out.includes(j)) out.push(j);
  }
  const state = uc(r.state);
  // Indiana taxes by the county lived in on January 1: when it's set, it beats today's city.
  const city = state === 'IN' && r.countyJan1 ? null : (r.municipality ?? r.city);
  const county = state === 'IN' ? (r.countyJan1 ?? r.county) : r.county;
  for (const j of jurisdictionsAt(state, city ?? null, county ?? null)) if (!out.includes(j)) out.push(j);
  if (r.schoolDistrict && state === 'OH') {
    const sd = localJurisdiction(`OH-SD-${r.schoolDistrict}`);
    if (sd && !out.includes(sd)) out.push(sd);
  }
  return out;
}

function localLines(input: EmployeePeriodInput, slices: Slice[], stateRes: TaxLine[]): { lines: TaxLine[]; unresolved: string[] } {
  const lines: TaxLine[] = [];
  const unresolved: string[] = [];
  const resState = uc(input.residence.state);
  const resJs = residentJurisdictions(input);
  const periods = PERIODS[input.payFrequency];
  const annualized = input.wages * periods;
  const has = (j: LocalJurisdiction | undefined, basis: LocalJurisdiction['basis']) => !!j && j.basis === basis;

  // ---- Pennsylvania: Philadelphia wage tax, Act 32 EIT, LST ----
  const resPhilly = resJs.find((j) => has(j, 'PHILADELPHIA'));
  const resEit = resJs.find((j) => has(j, 'PA_EIT'));
  if (resState === 'PA' && !resPhilly && !resEit && !input.residence.localCode) {
    unresolved.push('PA_RESIDENT_PSD');
  }
  if (resPhilly) {
    lines.push(line({ code: resPhilly.code, kind: 'LOCAL', label: `${resPhilly.name} (resident)`, resident: true, workState: null, wages: input.wages, amount: input.wages * (resPhilly.residentRate ?? 0) }));
  }
  let lstTaken = false;
  // LST is owed once, to the primary work location — the slice with the most wages.
  const paSlices = slices.filter((s) => s.state === 'PA').sort((a, b) => b.wages - a.wages);
  for (const s of slices) {
    const here = jurisdictionsAt(s.state, s.city, s.county);
    const workPhilly = here.find((j) => has(j, 'PHILADELPHIA'));
    const workEit = here.find((j) => has(j, 'PA_EIT'));
    if (s.state === 'PA') {
      if (workPhilly && !resPhilly) {
        lines.push(line({ code: workPhilly.code, kind: 'LOCAL', label: `${workPhilly.name} (nonresident)`, resident: false, workState: 'PA', wages: s.wages, amount: s.wages * (workPhilly.nonresidentRate ?? 0), note: resState === 'PA' ? 'Philadelphia’s nonresident tax is credited against the home EIT, so no EIT is withheld on these wages.' : null }));
      } else if (!resPhilly) {
        // Act 32: the higher of the resident's total rate and the work location's nonresident rate.
        const resRate = resState === 'PA' ? (resEit?.residentRate ?? 0) : 0;
        const nonRate = workEit?.nonresidentRate ?? 0;
        if (!workEit && resState !== 'PA') {
          unresolved.push(`PA_WORK_EIT:${s.city ?? 'unknown'}`);
        } else if (!workEit && resState === 'PA' && !resEit) {
          // Already flagged as an unresolved resident.
        } else {
          const useResident = resRate >= nonRate;
          const j = useResident ? resEit! : workEit!;
          const rate = useResident ? resRate : nonRate;
          if (rate > 0) {
            lines.push(
              line({
                code: j.code,
                kind: 'LOCAL',
                label: `${j.name}${useResident ? ' (resident rate)' : ' (work location rate)'}`,
                resident: useResident,
                workState: 'PA',
                wages: s.wages,
                amount: s.wages * rate,
                note: workEit && resEit && workEit.code !== resEit.code ? `Act 32: the higher of ${(resRate * 100).toFixed(3)}% (home) and ${(nonRate * 100).toFixed(3)}% (work) is withheld.` : null,
              }),
            );
          }
        }
      }
      // LST at the primary PA work location.
      if (!lstTaken && paSlices[0] === s) {
        const lst = here.find((j) => has(j, 'PA_LST'));
        if (lst) {
          lstTaken = true;
          const exempt = hasCert(input, 'LST_EXEMPTION', 'PA', lst.code) || hasCert(input, 'LST_EXEMPTION', 'PA') || annualized < (lst.lowIncomeExemptBelow ?? 0);
          lines.push(
            line({
              code: lst.code,
              kind: 'LOCAL',
              label: lst.name,
              resident: false,
              workState: 'PA',
              wages: s.wages,
              amount: exempt ? 0 : (lst.annualAmount ?? 0) / periods,
              note: exempt ? 'Exempt: earnings here are under the low-income line, or the exemption certificate is on file.' : `$${lst.annualAmount}/year, spread over ${periods} paychecks.`,
            }),
          );
        }
      }
    } else if (resState === 'PA' && resEit && !resPhilly) {
      // A PA resident working outside the state still owes the home EIT.
      if ((resEit.residentRate ?? 0) > 0) {
        lines.push(line({ code: resEit.code, kind: 'LOCAL', label: `${resEit.name} (resident)`, resident: true, workState: s.state, wages: s.wages, amount: s.wages * (resEit.residentRate ?? 0) }));
      }
    }
  }

  // ---- Ohio: work-city municipal tax; resident school district ----
  for (const s of slices) {
    if (s.state !== 'OH') continue;
    const city = jurisdictionsAt('OH', s.city).find((j) => has(j, 'WORK_CITY'));
    if (city) {
      lines.push(line({ code: city.code, kind: 'LOCAL', label: city.name, resident: false, workState: 'OH', wages: s.wages, amount: s.wages * (city.nonresidentRate ?? 0), note: city.administeredBy ? `Collected by ${city.administeredBy}.` : null }));
    }
  }
  const sd = resJs.find((j) => j.state === 'OH' && j.kind === 'SCHOOL');
  if (sd && resState === 'OH') {
    lines.push(line({ code: sd.code, kind: 'SCHOOL', label: sd.name, resident: true, workState: null, wages: input.wages, amount: input.wages * (sd.residentRate ?? 0), note: sd.schoolBase === 'EARNED_INCOME' ? 'Earned-income base: wages only.' : 'Traditional base: withheld on wages; settled on the district return.' }));
  }

  // ---- New York: NYC and Yonkers ----
  const nyc = resJs.find((j) => j.code === 'NY-NYC');
  if (nyc && resState === 'NY' && nyc.residentBrackets) {
    // NYS-50-T-NYC: annual wages less the deduction (by IT-2104 status) and $1,000 per exemption.
    const it2104 = input.stateW4s['NY'];
    const married = (it2104?.filingStatus ?? input.federalFilingStatus ?? '').toUpperCase().startsWith('MARRIED');
    const d = nyc.residentDeduction;
    const net = d ? annualized - (married ? d.married : d.single) - d.perExemption * Math.max(0, it2104?.allowances ?? 0) : annualized;
    const brackets = [...nyc.residentBrackets].reverse();
    const b = brackets.find((x) => net > x.over) ?? brackets[brackets.length - 1]!;
    const annualTax = net <= 0 ? 0 : b.base + (net - b.over) * b.rate;
    lines.push(line({ code: nyc.code, kind: 'LOCAL', label: nyc.name, resident: true, workState: null, wages: input.wages, amount: Math.max(0, annualTax / periods) }));
  }
  const yonkersRes = resJs.find((j) => j.code === 'NY-YONKERS');
  if (yonkersRes && resState === 'NY') {
    const nyState = stateRes.find((l) => l.code === 'ST-NY')?.amount ?? 0;
    lines.push(line({ code: yonkersRes.code, kind: 'LOCAL', label: `${yonkersRes.name} (resident)`, resident: true, workState: null, wages: input.wages, amount: nyState * (yonkersRes.shareOfState ?? 0), note: '16.75% of the New York State withholding.' }));
  } else {
    for (const s of slices) {
      if (s.state !== 'NY') continue;
      const y = jurisdictionsAt('NY', s.city).find((j) => j.code === 'NY-YONKERS');
      if (y) lines.push(line({ code: y.code, kind: 'LOCAL', label: `${y.name} (nonresident)`, resident: false, workState: 'NY', wages: s.wages, amount: s.wages * (y.nonresidentRate ?? 0) }));
    }
  }

  // ---- Resident-or-work cities: MI, KC, St. Louis, Wilmington, Louisville ----
  const resCity = resJs.find((j) => has(j, 'RESIDENT_OR_WORK'));
  let creditable = 0;
  for (const s of slices) {
    const work = jurisdictionsAt(s.state, s.city, s.county).find((j) => has(j, 'RESIDENT_OR_WORK'));
    if (!work || (resCity && work.code === resCity.code)) continue;
    const amount = s.wages * (work.nonresidentRate ?? 0);
    creditable += Math.min(amount, s.wages * (resCity?.nonresidentRate ?? 0));
    lines.push(line({ code: work.code, kind: work.kind === 'OLT' ? 'OLT' : 'LOCAL', label: `${work.name} (nonresident)`, resident: false, workState: work.state, wages: s.wages, amount }));
  }
  if (resCity && uc(resCity.state) === resState) {
    const full = input.wages * (resCity.residentRate ?? 0);
    lines.push(
      line({
        code: resCity.code,
        kind: resCity.kind === 'OLT' ? 'OLT' : 'LOCAL',
        label: `${resCity.name} (resident)`,
        resident: true,
        workState: null,
        wages: input.wages,
        amount: Math.max(0, full - creditable),
        note: creditable > 0 ? `Less a credit of ${round2(creditable).toFixed(2)} for city tax withheld where the work was done.` : null,
      }),
    );
  }

  // ---- Work-city occupational taxes (Lexington, Covington) ----
  for (const s of slices) {
    if (s.state !== 'KY') continue;
    for (const j of jurisdictionsAt('KY', s.city, s.county)) {
      if (j.basis !== 'WORK_CITY') continue;
      lines.push(line({ code: j.code, kind: 'OLT', label: j.name, resident: false, workState: 'KY', wages: s.wages, amount: s.wages * (j.nonresidentRate ?? 0) }));
    }
  }
  const kySchool = resJs.find((j) => j.state === 'KY' && j.kind === 'SCHOOL');
  if (kySchool && resState === 'KY') {
    lines.push(line({ code: kySchool.code, kind: 'SCHOOL', label: kySchool.name, resident: true, workState: null, wages: input.wages, amount: input.wages * (kySchool.residentRate ?? 0) }));
  }

  // ---- Indiana county tax ----
  if (resState === 'IN') {
    const county = resJs.find((j) => j.state === 'IN');
    if (county) {
      lines.push(line({ code: county.code, kind: 'LOCAL', label: county.name, resident: true, workState: null, wages: input.wages, amount: input.wages * (county.residentRate ?? 0), note: 'The rate of the county lived in on January 1.' }));
    } else {
      unresolved.push('IN_COUNTY_JAN1');
    }
  } else {
    for (const s of slices) {
      if (s.state !== 'IN') continue;
      const county = jurisdictionsAt('IN', s.city, s.county).find((j) => j.state === 'IN');
      if (county) {
        lines.push(line({ code: county.code, kind: 'LOCAL', label: `${county.name} (work county)`, resident: false, workState: 'IN', wages: s.wages, amount: s.wages * (county.nonresidentRate ?? 0) }));
      } else {
        unresolved.push(`IN_WORK_COUNTY:${s.city ?? 'unknown'}`);
      }
    }
  }

  // ---- Oregon transit districts (employer-paid) ----
  for (const s of slices) {
    if (s.state !== 'OR') continue;
    for (const j of jurisdictionsAt('OR', s.city)) {
      if (j.basis !== 'EMPLOYER_PAYROLL') continue;
      lines.push(line({ code: j.code, kind: 'EMPLOYER', label: j.name, resident: false, workState: 'OR', wages: s.wages, amount: s.wages * (j.nonresidentRate ?? 0), employer: true, note: 'Employer-paid; not taken from the paycheck.' }));
    }
  }

  return { lines, unresolved: [...new Set(unresolved)] };
}

/* ----- SUI localization (the four-factor test) ------------------------------ */

function suiState(input: EmployeePeriodInput, byState: Record<string, number>): { state: string | null; reason: string } {
  const entries = Object.entries(byState).filter(([, w]) => w > 0).sort((a, b) => b[1] - a[1]);
  const resident = uc(input.residence.state);
  if (entries.length === 0) return { state: resident, reason: 'No work this period; reported where the worker lives.' };
  if (entries.length === 1) return { state: entries[0]![0], reason: `Localized: all work this period was in ${entries[0]![0]}.` };
  const total = entries.reduce((s, [, w]) => s + w, 0);
  const [top, topW] = entries[0]!;
  if (topW / total >= 0.9) return { state: top, reason: `Localized: work outside ${top} was incidental this period.` };
  if (resident && byState[resident]) return { state: resident, reason: `Base of operations: lives and works in ${resident}.` };
  return { state: resident ?? top, reason: 'Not localized and no base of operations: reported where the worker lives (residence test). Check where the work is directed from.' };
}

/* ----- The engine ----------------------------------------------------------- */

export function calculateInHouse(input: EmployeePeriodInput): EmployeePeriodResult {
  const fallback = uc(input.residence.state);
  const slices = allocateWages(input.wages, input.work, input.work.find((w) => w.state)?.state ?? fallback);
  const st = stateLines(input, slices);
  // Local income taxes read their own base (PA EIT includes 401(k) deferrals …), allocated the same way.
  const localBase = input.bases?.local ?? input.wages;
  const factor = input.wages > 0 ? localBase / input.wages : 1;
  const localSlices = factor === 1 ? slices : slices.map((sl) => ({ ...sl, wages: round2(sl.wages * factor) }));
  const loc = localLines({ ...input, wages: localBase }, localSlices, st.lines);
  const lines = [...st.lines, ...loc.lines];
  const sui = suiState(input, st.byState);
  lines.push(line({ code: `SUI-${sui.state ?? 'NONE'}`, kind: 'SUI', label: `Unemployment insurance: ${sui.state ?? 'not set'}`, resident: false, workState: sui.state, wages: input.wages, amount: 0, note: sui.reason }));
  // State disability, paid leave and employee UI shares follow the UI state.
  const programs = input.includePrograms ? programLines(input, sui.state) : [];
  lines.push(...programs);
  const stateTotal = round2(st.lines.reduce((s, l) => s + l.amount, 0));
  const localTotal = round2(loc.lines.filter((l) => !l.employer).reduce((s, l) => s + l.amount, 0));
  const employerLocalTotal = round2(loc.lines.filter((l) => l.employer).reduce((s, l) => s + l.amount, 0));
  return {
    lines,
    stateTotal,
    localTotal,
    employerLocalTotal,
    programTotal: round2(programs.filter((l) => !l.employer).reduce((s, l) => s + l.amount, 0)),
    employerProgramTotal: round2(programs.filter((l) => l.employer).reduce((s, l) => s + l.amount, 0)),
    wagesByState: st.byState,
    sui,
    jurisdictionsUsed: [...new Set(loc.lines.filter((l) => l.amount > 0 || l.employer).map((l) => l.code))],
    unresolved: loc.unresolved,
    engine: 'IN_HOUSE',
  };
}

export const inHouseEngine: TaxEngineProvider = {
  key: 'IN_HOUSE',
  async calculate(input) {
    return calculateInHouse(input);
  },
  async resolveJurisdictions(address) {
    return jurisdictionsAt(address.state, address.city, address.county).map((j) => j.code);
  },
};
