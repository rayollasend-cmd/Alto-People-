/**
 * The in-house engine's local tax tables and the state reciprocity table.
 *
 * Every row names its tax year, where the figure came from and how sure we
 * are. None of them withholds until a payroll admin records "reviewed with
 * our tax adviser" for that jurisdiction and year (LocalTaxAcknowledgment):
 * the rate is a starting point for the review, not a promise. A tenant that
 * connects Symmetry or Vertex (lib/taxEngine/external) uses their tables
 * instead.
 *
 * Rates are fractions of wages unless a row says otherwise.
 */

export type Confidence = 'high' | 'medium' | 'low';

export type LocalKind = 'LOCAL' | 'SCHOOL' | 'TRANSIT' | 'OLT' | 'EMPLOYER';

export interface LocalJurisdiction {
  /** Stable code, e.g. "PA-PHILADELPHIA", "OH-COLUMBUS". */
  code: string;
  state: string;
  name: string;
  kind: LocalKind;
  /** How the tax attaches to a worker. */
  basis:
    | 'PA_EIT' // Act 32 earned income tax: resident rate vs work-location nonresident rate, higher wins
    | 'PA_LST' // local services tax: a flat yearly amount by work location, prorated per paycheck
    | 'PHILADELPHIA' // wage tax: resident rate on all wages; nonresident rate on wages earned in the city
    | 'WORK_CITY' // withheld for the city worked in (Ohio municipal, KY occupational, Wilmington)
    | 'RESIDENT_OR_WORK' // resident rate for residents (all wages), nonresident rate on wages earned there (MI cities, KC, St. Louis)
    | 'RESIDENT_ONLY' // residents only (NYC, Ohio school districts, Indiana county, Lexington school)
    | 'PERCENT_OF_STATE' // a percentage of the state's withholding (Yonkers resident)
    | 'EMPLOYER_PAYROLL'; // employer-paid, not withheld (TriMet, Lane Transit)
  /** Rate for residents (fraction). */
  residentRate?: number;
  /** Rate for nonresidents working there (fraction). */
  nonresidentRate?: number;
  /** PA LST: dollars per year; LST_EXEMPT_BELOW: the low-income line. */
  annualAmount?: number;
  lowIncomeExemptBelow?: number;
  /** Graduated resident brackets on annualized wages (NYC). */
  residentBrackets?: Array<{ over: number; rate: number; base: number }>;
  /** Yonkers: share of the state withholding. */
  shareOfState?: number;
  /** Ohio school districts: which wages the district taxes. */
  schoolBase?: 'TRADITIONAL' | 'EARNED_INCOME';
  /** Who collects it, for the return and the payment (RITA, CCA, the city itself). */
  administeredBy?: string;
  /** Cities this jurisdiction answers for (lower-case), to resolve an address. */
  cities?: string[];
  /** Counties (lower-case), for Indiana and Kentucky county taxes. */
  counties?: string[];
  /** PA political subdivision codes this row answers for. */
  psdCodes?: string[];
  taxYear: number;
  source: string;
  confidence: Confidence;
  note?: string;
}

const PA_DCED = 'PA DCED Municipal Statistics — EIT/LST register (dced.pa.gov), Act 32 of 2008';

export const LOCAL_JURISDICTIONS: readonly LocalJurisdiction[] = [
  // ----- Pennsylvania -----------------------------------------------------
  {
    code: 'PA-PHILADELPHIA',
    state: 'PA',
    name: 'Philadelphia wage tax',
    kind: 'LOCAL',
    basis: 'PHILADELPHIA',
    residentRate: 0.0374,
    nonresidentRate: 0.0343,
    cities: ['philadelphia'],
    psdCodes: ['510101'],
    administeredBy: 'City of Philadelphia Department of Revenue',
    taxYear: 2026,
    source: 'City of Philadelphia Department of Revenue — Wage Tax rates effective July 1, 2025',
    confidence: 'medium',
    note: 'Philadelphia wage tax replaces the Act 32 EIT for the city. A PA resident elsewhere who works in the city has the nonresident rate withheld.',
  },
  {
    code: 'PA-PITTSBURGH',
    state: 'PA',
    name: 'Pittsburgh earned income tax',
    kind: 'LOCAL',
    basis: 'PA_EIT',
    residentRate: 0.03,
    nonresidentRate: 0.01,
    cities: ['pittsburgh'],
    psdCodes: ['700102'],
    administeredBy: 'Jordan Tax Service (Allegheny County collector)',
    taxYear: 2026,
    source: `${PA_DCED}; City of Pittsburgh Finance — EIT 1% city + 2% Pittsburgh SD for residents`,
    confidence: 'medium',
  },
  {
    code: 'PA-PITTSBURGH-LST',
    state: 'PA',
    name: 'Pittsburgh local services tax',
    kind: 'LOCAL',
    basis: 'PA_LST',
    annualAmount: 52,
    lowIncomeExemptBelow: 12_000,
    cities: ['pittsburgh'],
    psdCodes: ['700102'],
    taxYear: 2026,
    source: `${PA_DCED}; City of Pittsburgh Finance — Local Services Tax`,
    confidence: 'high',
  },
  {
    code: 'PA-HARRISBURG',
    state: 'PA',
    name: 'Harrisburg earned income tax',
    kind: 'LOCAL',
    basis: 'PA_EIT',
    residentRate: 0.025,
    nonresidentRate: 0.01,
    cities: ['harrisburg'],
    administeredBy: 'Keystone Collections Group',
    taxYear: 2026,
    source: PA_DCED,
    confidence: 'low',
    note: 'PSD code and the school-district share to confirm against the DCED register.',
  },
  {
    code: 'PA-HARRISBURG-LST',
    state: 'PA',
    name: 'Harrisburg local services tax',
    kind: 'LOCAL',
    basis: 'PA_LST',
    annualAmount: 156,
    lowIncomeExemptBelow: 15_600,
    cities: ['harrisburg'],
    taxYear: 2026,
    source: `${PA_DCED} — distressed-city LST above $52 (Act 199 of 2014)`,
    confidence: 'low',
  },
  {
    code: 'PA-ALLENTOWN',
    state: 'PA',
    name: 'Allentown earned income tax',
    kind: 'LOCAL',
    basis: 'PA_EIT',
    residentRate: 0.01975,
    nonresidentRate: 0.0128,
    cities: ['allentown'],
    administeredBy: 'Berkheimer',
    taxYear: 2026,
    source: PA_DCED,
    confidence: 'low',
  },
  {
    code: 'PA-READING',
    state: 'PA',
    name: 'Reading earned income tax',
    kind: 'LOCAL',
    basis: 'PA_EIT',
    residentRate: 0.036,
    nonresidentRate: 0.013,
    cities: ['reading'],
    administeredBy: 'Berks EIT Bureau',
    taxYear: 2026,
    source: PA_DCED,
    confidence: 'low',
  },
  {
    code: 'PA-SCRANTON',
    state: 'PA',
    name: 'Scranton earned income tax',
    kind: 'LOCAL',
    basis: 'PA_EIT',
    residentRate: 0.034,
    nonresidentRate: 0.01,
    cities: ['scranton'],
    administeredBy: 'Berkheimer',
    taxYear: 2026,
    source: PA_DCED,
    confidence: 'low',
  },
  {
    code: 'PA-ERIE',
    state: 'PA',
    name: 'Erie earned income tax',
    kind: 'LOCAL',
    basis: 'PA_EIT',
    residentRate: 0.0218,
    nonresidentRate: 0.01,
    cities: ['erie'],
    administeredBy: 'Berkheimer',
    taxYear: 2026,
    source: PA_DCED,
    confidence: 'low',
  },
  // ----- Ohio municipal ---------------------------------------------------
  {
    code: 'OH-COLUMBUS',
    state: 'OH',
    name: 'Columbus income tax',
    kind: 'LOCAL',
    basis: 'WORK_CITY',
    residentRate: 0.025,
    nonresidentRate: 0.025,
    cities: ['columbus'],
    administeredBy: 'City of Columbus Income Tax Division',
    taxYear: 2026,
    source: 'City of Columbus Income Tax Division — 2.5% rate (since Oct 2020)',
    confidence: 'high',
  },
  {
    code: 'OH-CLEVELAND',
    state: 'OH',
    name: 'Cleveland income tax',
    kind: 'LOCAL',
    basis: 'WORK_CITY',
    residentRate: 0.025,
    nonresidentRate: 0.025,
    cities: ['cleveland'],
    administeredBy: 'Central Collection Agency (CCA)',
    taxYear: 2026,
    source: 'Central Collection Agency — City of Cleveland 2.5%',
    confidence: 'high',
  },
  {
    code: 'OH-CINCINNATI',
    state: 'OH',
    name: 'Cincinnati income tax',
    kind: 'LOCAL',
    basis: 'WORK_CITY',
    residentRate: 0.018,
    nonresidentRate: 0.018,
    cities: ['cincinnati'],
    administeredBy: 'City of Cincinnati Income Tax Division',
    taxYear: 2026,
    source: 'City of Cincinnati Income Tax Division — 1.8% (Oct 2020)',
    confidence: 'high',
  },
  {
    code: 'OH-TOLEDO',
    state: 'OH',
    name: 'Toledo income tax',
    kind: 'LOCAL',
    basis: 'WORK_CITY',
    residentRate: 0.025,
    nonresidentRate: 0.025,
    cities: ['toledo'],
    administeredBy: 'City of Toledo Division of Taxation',
    taxYear: 2026,
    source: 'City of Toledo Division of Taxation — 2.5%',
    confidence: 'high',
  },
  {
    code: 'OH-AKRON',
    state: 'OH',
    name: 'Akron income tax',
    kind: 'LOCAL',
    basis: 'WORK_CITY',
    residentRate: 0.025,
    nonresidentRate: 0.025,
    cities: ['akron'],
    administeredBy: 'City of Akron Income Tax Division',
    taxYear: 2026,
    source: 'City of Akron Income Tax Division — 2.5%',
    confidence: 'medium',
  },
  {
    code: 'OH-DAYTON',
    state: 'OH',
    name: 'Dayton income tax',
    kind: 'LOCAL',
    basis: 'WORK_CITY',
    residentRate: 0.025,
    nonresidentRate: 0.025,
    cities: ['dayton'],
    administeredBy: 'City of Dayton Division of Revenue and Taxation',
    taxYear: 2026,
    source: 'City of Dayton — 2.5%',
    confidence: 'medium',
  },
  // ----- Ohio school districts (residents only) ---------------------------
  {
    code: 'OH-SD-2502',
    state: 'OH',
    name: 'Big Walnut LSD school district income tax',
    kind: 'SCHOOL',
    basis: 'RESIDENT_ONLY',
    residentRate: 0.0075,
    schoolBase: 'TRADITIONAL',
    administeredBy: 'Ohio Department of Taxation',
    taxYear: 2026,
    source: 'Ohio Department of Taxation — school district income tax rate table (SD 100 instructions)',
    confidence: 'low',
    note: 'District number and rate to confirm against the Department of Taxation finder for each worker’s address.',
  },
  {
    code: 'OH-SD-4901',
    state: 'OH',
    name: 'Fairfield Union LSD school district income tax',
    kind: 'SCHOOL',
    basis: 'RESIDENT_ONLY',
    residentRate: 0.0125,
    schoolBase: 'EARNED_INCOME',
    administeredBy: 'Ohio Department of Taxation',
    taxYear: 2026,
    source: 'Ohio Department of Taxation — school district income tax rate table (SD 100 instructions)',
    confidence: 'low',
  },
  // ----- New York ---------------------------------------------------------
  {
    code: 'NY-NYC',
    state: 'NY',
    name: 'New York City resident income tax',
    kind: 'LOCAL',
    basis: 'RESIDENT_ONLY',
    residentBrackets: [
      { over: 0, rate: 0.03078, base: 0 },
      { over: 12_000, rate: 0.03762, base: 369.36 },
      { over: 25_000, rate: 0.03819, base: 858.42 },
      { over: 50_000, rate: 0.03876, base: 1813.17 },
    ],
    cities: ['new york', 'new york city', 'brooklyn', 'bronx', 'queens', 'staten island', 'manhattan'],
    administeredBy: 'NYS Department of Taxation and Finance (with the state return)',
    taxYear: 2026,
    source: 'NYS Publication NYS-50-T-NYC — New York City withholding; resident tax rate schedule',
    confidence: 'medium',
    note: 'Withheld for residents only; nonresidents owe no city income tax. Brackets are the resident rate schedule (single); NYS-50-T-NYC tables to confirm.',
  },
  {
    code: 'NY-YONKERS',
    state: 'NY',
    name: 'Yonkers income tax',
    kind: 'LOCAL',
    basis: 'PERCENT_OF_STATE',
    shareOfState: 0.1675,
    nonresidentRate: 0.005,
    cities: ['yonkers'],
    administeredBy: 'NYS Department of Taxation and Finance',
    taxYear: 2026,
    source: 'NYS Publication NYS-50-T-Y — resident surcharge 16.75% of NYS tax; nonresident earnings tax 0.5%',
    confidence: 'medium',
  },
  // ----- Michigan cities --------------------------------------------------
  ...(
    [
      ['DETROIT', 'Detroit', 0.024, 0.012, 'high'],
      ['GRAND-RAPIDS', 'Grand Rapids', 0.015, 0.0075, 'high'],
      ['LANSING', 'Lansing', 0.01, 0.005, 'medium'],
      ['FLINT', 'Flint', 0.01, 0.005, 'medium'],
      ['SAGINAW', 'Saginaw', 0.015, 0.0075, 'medium'],
      ['PONTIAC', 'Pontiac', 0.01, 0.005, 'medium'],
      ['BATTLE-CREEK', 'Battle Creek', 0.01, 0.005, 'medium'],
      ['JACKSON', 'Jackson', 0.01, 0.005, 'medium'],
    ] as const
  ).map(
    ([code, city, res, non, conf]): LocalJurisdiction => ({
      code: `MI-${code}`,
      state: 'MI',
      name: `${city} income tax`,
      kind: 'LOCAL',
      basis: 'RESIDENT_OR_WORK',
      residentRate: res,
      nonresidentRate: non,
      cities: [city.toLowerCase()],
      administeredBy: city === 'Detroit' ? 'Michigan Department of Treasury (City of Detroit)' : `City of ${city} Income Tax Department`,
      taxYear: 2026,
      source: 'Michigan Department of Treasury — City Income Tax rates (Form 5121 / city ordinances)',
      confidence: conf,
    }),
  ),
  // ----- Indiana counties (resident county on January 1; work county for nonresidents of Indiana) ---
  ...(
    [
      ['MARION', 'Marion', 0.0202, 'medium', ['indianapolis', 'lawrence', 'speedway', 'beech grove']],
      ['ALLEN', 'Allen', 0.0159, 'low', ['fort wayne', 'new haven']],
      ['HAMILTON', 'Hamilton', 0.011, 'medium', ['carmel', 'fishers', 'noblesville', 'westfield']],
      ['LAKE', 'Lake', 0.015, 'medium', ['gary', 'hammond', 'merrillville', 'crown point', 'east chicago']],
      ['ST-JOSEPH', 'St. Joseph', 0.0175, 'low', ['south bend', 'mishawaka']],
      ['ELKHART', 'Elkhart', 0.02, 'low', ['elkhart', 'goshen']],
      ['VANDERBURGH', 'Vanderburgh', 0.012, 'low', ['evansville']],
      ['TIPPECANOE', 'Tippecanoe', 0.0128, 'low', ['lafayette', 'west lafayette']],
      ['MONROE', 'Monroe', 0.01345, 'low', ['bloomington']],
    ] as const
  ).map(
    ([code, county, rate, conf, cities]): LocalJurisdiction => ({
      code: `IN-${code}`,
      state: 'IN',
      name: `${county} County income tax`,
      kind: 'LOCAL',
      basis: 'RESIDENT_ONLY',
      residentRate: rate,
      nonresidentRate: rate,
      counties: [county.toLowerCase()],
      // The main cities, so a work site (which has no county) still resolves.
      cities: [...cities],
      administeredBy: 'Indiana Department of Revenue (with the state)',
      taxYear: 2026,
      source: 'Indiana DOR Departmental Notice #1 — county income tax rates',
      confidence: conf,
      note: 'An Indiana resident pays the rate of the county they lived in on January 1; an out-of-state resident pays the rate of the county they work in.',
    }),
  ),
  // ----- Kentucky occupational license taxes ------------------------------
  {
    code: 'KY-LOUISVILLE',
    state: 'KY',
    name: 'Louisville Metro occupational license tax',
    kind: 'OLT',
    basis: 'RESIDENT_OR_WORK',
    residentRate: 0.022,
    nonresidentRate: 0.0145,
    cities: ['louisville'],
    counties: ['jefferson'],
    administeredBy: 'Louisville Metro Revenue Commission',
    taxYear: 2026,
    source: 'Louisville Metro Revenue Commission — occupational license tax (city + school + TARC)',
    confidence: 'medium',
  },
  {
    code: 'KY-LEXINGTON',
    state: 'KY',
    name: 'Lexington-Fayette occupational license tax',
    kind: 'OLT',
    basis: 'WORK_CITY',
    residentRate: 0.0225,
    nonresidentRate: 0.0225,
    cities: ['lexington'],
    counties: ['fayette'],
    administeredBy: 'Lexington-Fayette Urban County Government Revenue',
    taxYear: 2026,
    source: 'LFUCG Division of Revenue — 2.25% occupational license fee',
    confidence: 'medium',
  },
  {
    code: 'KY-LEXINGTON-SCHOOL',
    state: 'KY',
    name: 'Fayette County school district occupational tax',
    kind: 'SCHOOL',
    basis: 'RESIDENT_ONLY',
    residentRate: 0.005,
    counties: ['fayette'],
    cities: ['lexington'],
    taxYear: 2026,
    source: 'Fayette County Public Schools — 0.5% occupational license tax',
    confidence: 'low',
  },
  {
    code: 'KY-COVINGTON',
    state: 'KY',
    name: 'Covington occupational license tax',
    kind: 'OLT',
    basis: 'WORK_CITY',
    residentRate: 0.025,
    nonresidentRate: 0.025,
    cities: ['covington'],
    taxYear: 2026,
    source: 'City of Covington Finance — occupational license tax',
    confidence: 'low',
  },
  // ----- Missouri ---------------------------------------------------------
  {
    code: 'MO-KANSAS-CITY',
    state: 'MO',
    name: 'Kansas City earnings tax',
    kind: 'LOCAL',
    basis: 'RESIDENT_OR_WORK',
    residentRate: 0.01,
    nonresidentRate: 0.01,
    cities: ['kansas city'],
    administeredBy: 'Kansas City, MO Revenue Division',
    taxYear: 2026,
    source: 'Kansas City, Missouri Revenue Division — 1% earnings tax',
    confidence: 'high',
  },
  {
    code: 'MO-ST-LOUIS',
    state: 'MO',
    name: 'St. Louis earnings tax',
    kind: 'LOCAL',
    basis: 'RESIDENT_OR_WORK',
    residentRate: 0.01,
    nonresidentRate: 0.01,
    cities: ['st. louis', 'st louis', 'saint louis'],
    administeredBy: 'City of St. Louis Collector of Revenue',
    taxYear: 2026,
    source: 'City of St. Louis Collector of Revenue — 1% earnings tax',
    confidence: 'high',
  },
  // ----- Delaware ---------------------------------------------------------
  {
    code: 'DE-WILMINGTON',
    state: 'DE',
    name: 'Wilmington earned income tax',
    kind: 'LOCAL',
    basis: 'RESIDENT_OR_WORK',
    residentRate: 0.0125,
    nonresidentRate: 0.0125,
    cities: ['wilmington'],
    administeredBy: 'City of Wilmington Finance — Earned Income Tax',
    taxYear: 2026,
    source: 'City of Wilmington — 1.25% wage tax on residents and on nonresidents working in the city',
    confidence: 'high',
  },
  // ----- Oregon transit (employer-paid; the statewide 0.1% is withheld with the state) ---
  {
    code: 'OR-TRIMET',
    state: 'OR',
    name: 'TriMet transit payroll tax (employer)',
    kind: 'EMPLOYER',
    basis: 'EMPLOYER_PAYROLL',
    nonresidentRate: 0.008237,
    residentRate: 0.008237,
    cities: ['portland', 'beaverton', 'gresham', 'hillsboro', 'tigard', 'lake oswego', 'tualatin'],
    administeredBy: 'Oregon Department of Revenue (TriMet district)',
    taxYear: 2026,
    source: 'Oregon DOR — TriMet transit payroll tax 0.8237% (2025)',
    confidence: 'medium',
    note: 'Employer-paid on wages for work inside the TriMet district; never withheld from the paycheck.',
  },
  {
    code: 'OR-LTD',
    state: 'OR',
    name: 'Lane Transit District payroll tax (employer)',
    kind: 'EMPLOYER',
    basis: 'EMPLOYER_PAYROLL',
    nonresidentRate: 0.008,
    residentRate: 0.008,
    cities: ['eugene', 'springfield'],
    administeredBy: 'Oregon Department of Revenue (LTD)',
    taxYear: 2026,
    source: 'Oregon DOR — Lane Transit District payroll tax',
    confidence: 'low',
  },
];

const BY_CODE = new Map(LOCAL_JURISDICTIONS.map((j) => [j.code, j]));
export const localJurisdiction = (code: string): LocalJurisdiction | undefined => BY_CODE.get(code);

/* ----- State reciprocity ---------------------------------------------------- */

/**
 * States that agree not to tax each other's residents' wages: a resident of
 * the key working in a listed state owes (and has withheld) only their home
 * state's tax — once the employer has the nonresidency certificate.
 */
export const RECIPROCITY: Readonly<Record<string, { states: string[]; form: string }>> = {
  DC: { states: ['MD', 'VA'], form: 'D-4A' },
  IL: { states: ['IA', 'KY', 'MI', 'WI'], form: 'IL-W-5-NR' },
  IN: { states: ['KY', 'MI', 'OH', 'PA', 'WI'], form: 'WH-47' },
  IA: { states: ['IL'], form: '44-016' },
  KY: { states: ['IL', 'IN', 'MI', 'OH', 'VA', 'WV', 'WI'], form: '42A809' },
  MD: { states: ['DC', 'PA', 'VA', 'WV'], form: 'MW 507' },
  MI: { states: ['IL', 'IN', 'KY', 'MN', 'OH', 'WI'], form: 'MI-W4' },
  MN: { states: ['MI', 'ND'], form: 'MWR' },
  MT: { states: ['ND'], form: 'MW-4' },
  NJ: { states: ['PA'], form: 'NJ-165' },
  ND: { states: ['MN', 'MT'], form: 'NDW-R' },
  OH: { states: ['IN', 'KY', 'MI', 'PA', 'WV'], form: 'IT 4NR' },
  PA: { states: ['IN', 'MD', 'NJ', 'OH', 'VA', 'WV'], form: 'REV-419' },
  VA: { states: ['DC', 'KY', 'MD', 'PA', 'WV'], form: 'VA-4' },
  WV: { states: ['KY', 'MD', 'OH', 'PA', 'VA'], form: 'WV/IT-104R' },
  WI: { states: ['IL', 'IN', 'KY', 'MI'], form: 'W-220' },
};
export const RECIPROCITY_SOURCE =
  'Each state revenue department’s nonresident withholding guidance (forms named per state), as compiled 2026-10; confirm with the work state before relying on it.';

/**
 * The form the WORK state accepts from a resident of `resident` to stop
 * withholding — reciprocity runs from the work state's side.
 */
export function reciprocityBetween(resident: string, work: string): { form: string } | null {
  const w = RECIPROCITY[work.toUpperCase()];
  if (!w || !w.states.includes(resident.toUpperCase())) return null;
  return { form: w.form };
}

/** DC never taxes nonresidents' wages, whoever they are. */
export const NO_NONRESIDENT_TAX = new Set(['DC']);

/**
 * States that source a nonresident's work-from-home days to the employer's
 * office when the remote work is for the worker's convenience, not the
 * employer's necessity. Alto allocates by the site of each time entry, so
 * this is a note on the work-state line for payroll to check remote days
 * against. Source: each state's published guidance as summarised by the
 * Federation of Tax Administrators; confidence medium — confirm with your
 * tax adviser (New Jersey and Connecticut apply theirs only against
 * residents of states that have one).
 */
export const CONVENIENCE_OF_EMPLOYER: Record<string, string> = {
  NY: 'New York',
  DE: 'Delaware',
  NE: 'Nebraska',
  PA: 'Pennsylvania',
  CT: 'Connecticut (against states with their own rule)',
  NJ: 'New Jersey (against states with their own rule)',
};

/**
 * Resident states whose employers must withhold the full resident tax with
 * no credit for the work state's withholding. Empty by default: no state
 * could be confirmed from a primary source, so every resident state credits
 * (up to its own tax on those wages). Add a state here only after review
 * with your tax adviser.
 */
export const NO_WITHHOLDING_CREDIT = new Set<string>();
