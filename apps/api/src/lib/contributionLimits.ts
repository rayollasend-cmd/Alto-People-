/**
 * The annual contribution limits payroll enforces, and the SECURE 2.0 Roth
 * catch-up rule.
 *
 *   402(g)        elective deferrals to a 401(k)/403(b), pre-tax + Roth combined
 *   catch-up      extra deferrals for a participant 50+ by year end (IRC §414(v))
 *   super catch-up ages 60–63 at year end get a larger catch-up (SECURE 2.0 §109)
 *   HSA           self-only / family, + $1,000 at 55+ (IRC §223)
 *   health FSA    IRC §125(i)
 *   dependent care FSA  IRC §129 — $7,500 from 2026 (One Big Beautiful Bill Act)
 *
 * Roth catch-up (SECURE 2.0 §603, final regs Sept 2025; good-faith compliance
 * for 2026): a participant whose prior-year FICA wages (W-2 Box 3) from this
 * employer exceeded the indexed threshold must make catch-up contributions
 * as Roth. The threshold that applies to a plan year is the one indexed for
 * the PRIOR year's wages: 2026 catch-ups look at 2025 wages against $150,000.
 *
 * Sources: IRS Notice 2024-80 (2025 limits), IRS Notice 2025-67 / IRS news
 * release IR-2025-111 (2026 limits); 26 CFR 1.414(v)-2 (Roth catch-up).
 * A year with no row falls back to the latest known year — payroll never
 * runs without a limit — and the readiness page says so.
 */

export interface YearLimits {
  year: number;
  deferral402g: number;
  catchUp50: number;
  /** Ages 60–63 at year end, in place of catchUp50. */
  superCatchUp60to63: number;
  hsaSelf: number;
  hsaFamily: number;
  hsaCatchUp55: number;
  healthFsa: number;
  dependentCareFsa: number;
  /** Prior-year FICA wages above this make the next year's catch-up Roth-only. */
  rothCatchUpWageThreshold: number;
}

export const LIMITS: Record<number, YearLimits> = {
  2025: {
    year: 2025,
    deferral402g: 23_500,
    catchUp50: 7_500,
    superCatchUp60to63: 11_250,
    hsaSelf: 4_300,
    hsaFamily: 8_550,
    hsaCatchUp55: 1_000,
    healthFsa: 3_300,
    dependentCareFsa: 5_000,
    // Plan year 2025 looks at 2024 wages: $145,000 (the statutory base).
    rothCatchUpWageThreshold: 145_000,
  },
  2026: {
    year: 2026,
    deferral402g: 24_500,
    catchUp50: 8_000,
    superCatchUp60to63: 11_250,
    hsaSelf: 4_400,
    hsaFamily: 8_750,
    hsaCatchUp55: 1_000,
    healthFsa: 3_400,
    dependentCareFsa: 7_500,
    // Plan year 2026 looks at 2025 FICA wages, indexed to $150,000.
    rothCatchUpWageThreshold: 150_000,
  },
};

export function limitsFor(year: number): YearLimits & { fallback: boolean } {
  const exact = LIMITS[year];
  if (exact) return { ...exact, fallback: false };
  const known = Object.keys(LIMITS).map(Number).sort((a, b) => a - b);
  const pick = year < known[0]! ? known[0]! : known[known.length - 1]!;
  return { ...LIMITS[pick]!, year, fallback: true };
}

/** Age at the END of the calendar year — the catch-up tests use year-end age. */
export function ageAtYearEnd(dob: Date | null | undefined, year: number): number | null {
  if (!dob) return null;
  return year - dob.getUTCFullYear();
}

/** The catch-up a person may add this year: 0 under 50, the super amount at 60–63. */
export function catchUpAllowance(dob: Date | null | undefined, year: number): number {
  const age = ageAtYearEnd(dob, year);
  if (age === null || age < 50) return 0;
  const l = limitsFor(year);
  return age >= 60 && age <= 63 ? l.superCatchUp60to63 : l.catchUp50;
}

export interface DeferralSplit {
  /** Deferral within the 402(g) limit. */
  regular: number;
  /** Deferral above 402(g), within the catch-up allowance. */
  catchUp: number;
  /** Elected but not taken: the annual limit is reached. */
  stopped: number;
}

/**
 * Split this check's elected deferral into the part within 402(g), the
 * catch-up past it, and what the annual limit stops — given what the person
 * has already deferred this year (pre-tax + Roth, every plan).
 */
export function splitDeferral(elected: number, ytdDeferred: number, base402g: number, catchUpAllowed: number): DeferralSplit {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const want = Math.max(0, elected);
  const regularRoom = Math.max(0, base402g - ytdDeferred);
  const regular = Math.min(want, regularRoom);
  const catchUpUsed = Math.max(0, ytdDeferred - base402g);
  const catchUpRoom = Math.max(0, catchUpAllowed - catchUpUsed);
  const catchUp = Math.min(want - regular, catchUpRoom);
  return { regular: r2(regular), catchUp: r2(catchUp), stopped: r2(want - regular - catchUp) };
}

/** Whether prior-year FICA wages make this year's catch-up Roth-only. */
export function isRothCatchUpHigherEarner(priorYearFicaWages: number, year: number): boolean {
  return priorYearFicaWages > limitsFor(year).rothCatchUpWageThreshold;
}
