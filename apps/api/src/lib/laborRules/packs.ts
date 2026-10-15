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
    // Rest breaks of 20 minutes or less are hours worked (29 CFR 785.18). Today's pay engine docks every
    // break; the shadow surfaces any short break it docked, for the owner and counsel (report §6.5).
    breaks: { paidUpToMinutes: 20 },
    minimumWage: { rateCents: 725 },
    severity: { overtime: 'warn', restBetweenShifts: 'warn', predictive: 'warn' },
  },
  source: '29 U.S.C. §206, §207; 29 CFR Part 778; 29 CFR 785.18 (short breaks); 29 CFR Part 570 (Subpart C); U.S. DOL Wage and Hour Division, https://www.dol.gov/agencies/whd',
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

/*
 * Step 5 — California, New York (with New York City) and Illinois (with
 * Chicago). Shipped DRAFT like every pack: the engine computes their
 * premiums and shows them, and nothing is paid until counsel signs each one
 * (decisions 8 and 10). Whether a tenant is covered by a city's Fair Workweek
 * law (industry, employer size) is a decision the pack names in `coverage`,
 * never assumed.
 */

const minWageSteps = (jurisdiction: string, level: 'STATE' | 'CITY', steps: Array<[string, number]>, rest: RuleSetDef['params'], source: string): RuleSetDef[] =>
  steps.map(([from, cents]) => ({
    jurisdiction,
    level,
    effectiveFrom: from,
    version: 1,
    params: { ...rest, minimumWage: { rateCents: cents } },
    source,
    sourceDate: '2026-10-15',
    status: 'DRAFT' as const,
    approvedBy: null,
  }));

export const CALIFORNIA_PACKS: RuleSetDef[] = minWageSteps(
  'US-CA',
  'STATE',
  [
    ['2025-01-01', 1650],
    ['2026-01-01', 1690],
  ],
  {
    overtime: { weeklyThreshold: 40, weeklyMultiplier: 1.5, dailyThreshold: 8, dailyMultiplier: 1.5, dailyDoubleThreshold: 12, doubleMultiplier: 2, seventhDayRule: true },
    // A meal may be waived by mutual consent only on a day of 6 hours or less; the waiver is recorded per day.
    meal: { requiredAfterHours: 5, minMinutes: 30, secondRequiredAfterHours: 10, penaltyHours: 1, waiverAllowed: true },
    rest: { perHours: 4, minMinutes: 10, minimumDayHours: 3.5, penaltyHours: 1 },
    minors: {
      bands: [
        { minAge: 14, maxAge: 15, schoolDayMaxHours: 3, schoolWeekMaxHours: 18, nonSchoolDayMaxHours: 8, nonSchoolWeekMaxHours: 40, earliest: '07:00', latest: '19:00', summerLatest: '21:00', schoolNightLatest: null, mealAfterHours: 5 },
        { minAge: 16, maxAge: 17, schoolDayMaxHours: 4, schoolWeekMaxHours: 48, nonSchoolDayMaxHours: 8, nonSchoolWeekMaxHours: 48, earliest: '05:00', latest: null, summerLatest: null, schoolNightLatest: '22:00', mealAfterHours: 5 },
      ],
      severity: 'block',
    },
  },
  'Cal. Lab. Code §510 (daily and seventh-day overtime), §512 and §226.7 (meal and rest premiums), §1182.12 (minimum wage), §1391 (minors); IWC Wage Orders 5 (public housekeeping) and 7 (mercantile); DLSE, https://www.dir.ca.gov/dlse',
);

export const NEW_YORK_PACKS: RuleSetDef[] = minWageSteps(
  'US-NY',
  'STATE',
  [
    ['2025-01-01', 1550],
    ['2026-01-01', 1600],
  ],
  {
    // Lab. Law §162: a 30-minute meal on a shift over 6 hours; no premium pay (a violation is a fine, so penaltyHours 0).
    meal: { requiredAfterHours: 6, minMinutes: 30, secondRequiredAfterHours: null, penaltyHours: 0, waiverAllowed: false },
    minors: {
      bands: [
        { minAge: 14, maxAge: 15, schoolDayMaxHours: 3, schoolWeekMaxHours: 18, nonSchoolDayMaxHours: 8, nonSchoolWeekMaxHours: 40, earliest: '07:00', latest: '19:00', summerLatest: '21:00', schoolNightLatest: null, mealAfterHours: null },
        { minAge: 16, maxAge: 17, schoolDayMaxHours: 4, schoolWeekMaxHours: 28, nonSchoolDayMaxHours: 8, nonSchoolWeekMaxHours: 48, earliest: '06:00', latest: null, summerLatest: null, schoolNightLatest: '22:00', mealAfterHours: null },
      ],
      severity: 'block',
    },
  },
  'N.Y. Lab. Law §652 (minimum wage, rest of state), §162 (meal periods), §130–143 (minors); 12 NYCRR Part 142 (overtime, spread of hours, call-in pay) and Part 146 (hospitality); NYS DOL',
);

export const NEW_YORK_CITY_PACKS: RuleSetDef[] = minWageSteps(
  'US-NY-NYC',
  'CITY',
  [
    ['2025-01-01', 1650],
    ['2026-01-01', 1700],
  ],
  {
    // Fair Workweek, fast food: two weeks' notice; premiums per change by notice band, more when hours are cut.
    predictive: {
      noticeDays: 14,
      changePremiums: [
        { withinDays: 14, premiumHours: 0, premiumCents: 1000, kind: ['added', 'moved'] },
        { withinDays: 14, premiumHours: 0, premiumCents: 2000, kind: ['reduced', 'cancelled'] },
        { withinDays: 7, premiumHours: 0, premiumCents: 1500, kind: ['added', 'moved'] },
        { withinDays: 7, premiumHours: 0, premiumCents: 4500, kind: ['reduced', 'cancelled'] },
      ],
      goodFaithEstimate: true,
      coverage: 'Fast food employers (Admin. Code §20-1221 et seq.); retail employers with 20+ NYC employees have a 72-hour notice and on-call ban instead (§20-1251).',
    },
    // "Clopening": a closing then an opening shift less than 11 hours apart owes $100 (fast food), with written consent.
    restBetweenShifts: { minHours: 11, premiumHours: 0, premiumMultiplierInGap: 0, premiumCents: 10000 },
  },
  'NYC Admin. Code Title 20, Chapter 12 (Fair Workweek: §20-1221 fast food, §20-1251 retail); N.Y. Lab. Law §652 (New York City minimum wage); NYC DCWP, https://www.nyc.gov/site/dca/workers/workersrights/fast-food-workers.page',
);

export const ILLINOIS_PACKS: RuleSetDef[] = minWageSteps(
  'US-IL',
  'STATE',
  [['2025-01-01', 1500]],
  {
    // One Day Rest in Seven Act: a 20-minute meal, begun by hour 5, on a shift of 7.5 hours or more; no premium pay.
    meal: { requiredAfterHours: 5, minMinutes: 20, secondRequiredAfterHours: null, penaltyHours: 0, waiverAllowed: false, minimumDayHours: 7.5 },
  },
  '820 ILCS 105 (Minimum Wage Law, overtime); 820 ILCS 140 (One Day Rest in Seven Act); 820 ILCS 206 (Child Labor Law of 2024); Illinois Department of Labor',
);

export const CHICAGO_PACKS: RuleSetDef[] = minWageSteps(
  'US-IL-CHICAGO',
  'CITY',
  [['2025-07-01', 1660]],
  {
    // Fair Workweek: 14 days' notice; one hour of predictability pay per change under 14 days; half the hours lost when cut under 24 hours.
    predictive: {
      noticeDays: 14,
      changePremiums: [
        { withinDays: 14, premiumHours: 1, kind: ['added', 'moved', 'reduced', 'cancelled'] },
        { withinDays: 1, premiumHours: 0, shareOfHoursLost: 0.5, kind: ['reduced', 'cancelled'] },
      ],
      goodFaithEstimate: true,
      coverage: 'Covered industries (building services, healthcare, hotels, manufacturing, restaurants, retail, warehouse services) with 100+ employees globally (250 for nonprofits), for covered employees under the city income ceiling.',
    },
    // Right to rest: hours worked within 10 hours of the last shift's end are paid at 1.25×.
    restBetweenShifts: { minHours: 10, premiumHours: 0, premiumMultiplierInGap: 1.25, premiumCents: 0 },
  },
  'Chicago Municipal Code ch. 6-110 (Fair Workweek) and ch. 6-105 (Minimum Wage); Chicago Department of Business Affairs and Consumer Protection rules',
);

/** Every shipped pack. A new one reaches the database by a migration (scripts/labor-packs-sql.ts). */
export const SHIPPED_PACKS: readonly RuleSetDef[] = [FEDERAL_PACK, ...FLORIDA_PACKS, ALABAMA_PACK, ...CALIFORNIA_PACKS, ...NEW_YORK_PACKS, ...NEW_YORK_CITY_PACKS, ...ILLINOIS_PACKS, ...CHICAGO_PACKS];

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
