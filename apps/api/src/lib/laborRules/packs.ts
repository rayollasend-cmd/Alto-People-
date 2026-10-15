import type { MinorBand, RuleSetDef } from './params.js';

/**
 * Brief 2-2 step 1 — the shipped packs (owner's decision 3: in code, with
 * citations, a change is a reviewed commit; step 2 seeds them into
 * LaborRuleSet by migration).
 *
 *   Every value below is the rule to encode, to be CONFIRMED BY COUNSEL
 *   against the cited source before the pack is ACTIVE (decision 10). They
 *   ship DRAFT: the engine computes with them (shadow, the Rules page) and
 *   refuses them for pay until someone signs.
 *
 *   Florida's and Alabama's adult rules are the federal ones (weekly 40 at
 *   1.5×, no daily overtime, no meal or rest law), which is exactly what
 *   today's pay engine does — the golden test holds the engine to it.
 */

const SCHOOL_KIDS_FEDERAL: MinorBand = {
  minAge: 14,
  maxAge: 15,
  schoolDayMaxHours: 3,
  schoolWeekMaxHours: 18,
  nonSchoolDayMaxHours: 8,
  nonSchoolWeekMaxHours: 40,
  earliest: '07:00',
  latest: '19:00',
  summerLatest: '21:00',
  schoolNightLatest: null,
  mealAfterHours: null,
};

/** Under 14: not employable in these occupations (29 CFR 570.2). Any hour is over the limit. */
const UNDER_14: MinorBand = {
  minAge: 0,
  maxAge: 13,
  schoolDayMaxHours: 0,
  schoolWeekMaxHours: 0,
  nonSchoolDayMaxHours: 0,
  nonSchoolWeekMaxHours: 0,
  earliest: null,
  latest: null,
  summerLatest: null,
  schoolNightLatest: null,
  mealAfterHours: null,
};

export const FEDERAL_PACK: RuleSetDef = {
  jurisdiction: 'FEDERAL',
  level: 'FEDERAL',
  effectiveFrom: '2009-07-24',
  version: 1,
  params: {
    overtime: { weeklyThreshold: 40, weeklyMultiplier: 1.5, dailyThreshold: null, dailyMultiplier: 1.5, dailyDoubleThreshold: null, doubleMultiplier: 2, seventhDayRule: false },
    meal: { requiredAfterHours: null, minMinutes: 0, secondRequiredAfterHours: null, penaltyHours: 0, waiverAllowed: false },
    rest: { perHours: null, minMinutes: 0, minimumDayHours: 0, penaltyHours: 0 },
    restBetweenShifts: { minHours: null, premiumHours: 0, premiumMultiplierInGap: 0 },
    minors: { bands: [UNDER_14, SCHOOL_KIDS_FEDERAL], severity: 'block' },
    predictive: { noticeDays: null, changePremiums: [], goodFaithEstimate: false },
    minimumWage: { rateCents: 725 },
    severity: { overtime: 'warn', restBetweenShifts: 'warn', predictive: 'warn' },
  },
  source: '29 U.S.C. §206, §207; 29 CFR Part 778; 29 CFR Part 570 (Subpart C); U.S. DOL Wage and Hour Division, https://www.dol.gov/agencies/whd',
  sourceDate: '2026-10-15',
  status: 'DRAFT',
  approvedBy: null,
};

const FL_MINORS: MinorBand[] = [
  { minAge: 14, maxAge: 15, schoolDayMaxHours: 3, schoolWeekMaxHours: 15, nonSchoolDayMaxHours: 8, nonSchoolWeekMaxHours: 40, earliest: '07:00', latest: '19:00', summerLatest: '21:00', schoolNightLatest: null, mealAfterHours: 4 },
  { minAge: 16, maxAge: 17, schoolDayMaxHours: 8, schoolWeekMaxHours: 30, nonSchoolDayMaxHours: null, nonSchoolWeekMaxHours: null, earliest: '06:30', latest: null, summerLatest: null, schoolNightLatest: '23:00', mealAfterHours: 4 },
];

const FL_SOURCE = 'Fla. Const. Art. X §24; Fla. Stat. §448.110; Fla. Stat. Ch. 450 Part I (§450.081); Florida Department of Commerce minimum wage notice';

/** Florida's minimum wage steps under Art. X §24 (Amendment 2, 2020): each 30 September. */
export const FLORIDA_PACKS: RuleSetDef[] = [
  { cents: 1300, from: '2024-09-30' },
  { cents: 1400, from: '2025-09-30' },
  { cents: 1500, from: '2026-09-30' },
].map(({ cents, from }) => ({
  jurisdiction: 'US-FL',
  level: 'STATE' as const,
  effectiveFrom: from,
  version: 1,
  params: {
    minimumWage: { rateCents: cents },
    minors: { bands: FL_MINORS, severity: 'block' as const },
  },
  source: FL_SOURCE,
  sourceDate: '2026-10-15',
  status: 'DRAFT' as const,
  approvedBy: null,
}));

export const ALABAMA_PACK: RuleSetDef = {
  jurisdiction: 'US-AL',
  level: 'STATE',
  effectiveFrom: '2009-07-24',
  version: 1,
  params: {
    // No state minimum wage: the federal rate applies (inherited).
    minors: {
      bands: [
        { minAge: 14, maxAge: 15, schoolDayMaxHours: 3, schoolWeekMaxHours: 18, nonSchoolDayMaxHours: 8, nonSchoolWeekMaxHours: 40, earliest: '07:00', latest: '19:00', summerLatest: '21:00', schoolNightLatest: null, mealAfterHours: 5 },
        { minAge: 16, maxAge: 17, schoolDayMaxHours: null, schoolWeekMaxHours: null, nonSchoolDayMaxHours: null, nonSchoolWeekMaxHours: null, earliest: '05:00', latest: null, summerLatest: null, schoolNightLatest: '22:00', mealAfterHours: null },
      ],
      severity: 'block',
    },
  },
  source: 'Ala. Code §25-8-30 et seq. (Child Labor Law); Alabama Department of Labor, Child Labor Division',
  sourceDate: '2026-10-15',
  status: 'DRAFT',
  approvedBy: null,
};

/** Every shipped pack. California, New York City and Chicago arrive in step 5, after counsel. */
export const SHIPPED_PACKS: readonly RuleSetDef[] = [FEDERAL_PACK, ...FLORIDA_PACKS, ALABAMA_PACK];

/** Cities whose pack key is not their name as written on a site. */
const CITY_KEYS: Record<string, string> = { 'NY-NEW-YORK': 'NYC', 'NY-NEW-YORK-CITY': 'NYC', 'NY-BROOKLYN': 'NYC', 'NY-BRONX': 'NYC', 'NY-QUEENS': 'NYC', 'NY-STATEN-ISLAND': 'NYC', 'NY-MANHATTAN': 'NYC' };

/** The jurisdiction keys a site resolves through, most general first: FEDERAL, US-<state>, US-<state>-<CITY>. */
export function jurisdictionsFor(site: { state: string | null; city?: string | null }): string[] {
  const out = ['FEDERAL'];
  const st = site.state?.trim().toUpperCase();
  if (st && /^[A-Z]{2}$/.test(st)) {
    out.push(`US-${st}`);
    const city = site.city?.trim().toUpperCase().replace(/[^A-Z]+/g, '-').replace(/^-|-$/g, '');
    if (city) out.push(`US-${st}-${CITY_KEYS[`${st}-${city}`] ?? city}`);
  }
  return out;
}
