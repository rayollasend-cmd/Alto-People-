/**
 * Group-term life insurance over $50,000 — IRS Pub 15-B, Table I.
 *
 * The cost of employer-provided group-term life coverage over $50,000 is
 * taxable income to the employee, figured from the IRS uniform premium
 * table by the employee's age on the last day of the calendar year, per
 * $1,000 of coverage over $50,000, per month. Anything the employee paid
 * toward the coverage with after-tax dollars comes off. The result is
 * subject to Social Security and Medicare (and reported in W-2 Box 12,
 * Code C and Boxes 1, 3, 5); withholding federal income tax on it is the
 * employer's choice (we withhold, so the employee's return is not short);
 * it is exempt from FUTA.
 *
 * Table I (Pub 15-B, "Cost Per $1,000 of Protection for 1 Month"), in effect
 * since 1999 and unchanged through the 2026 publication. CONFIRM each year
 * against the current Pub 15-B.
 */
export const TABLE_I_MONTHLY_PER_1000: ReadonlyArray<{ maxAge: number; rate: number }> = [
  { maxAge: 24, rate: 0.05 },
  { maxAge: 29, rate: 0.06 },
  { maxAge: 34, rate: 0.08 },
  { maxAge: 39, rate: 0.09 },
  { maxAge: 44, rate: 0.1 },
  { maxAge: 49, rate: 0.15 },
  { maxAge: 54, rate: 0.23 },
  { maxAge: 59, rate: 0.43 },
  { maxAge: 64, rate: 0.66 },
  { maxAge: 69, rate: 1.27 },
  { maxAge: Infinity, rate: 2.06 },
];

export const GTL_EXCLUSION_CENTS = 50_000 * 100;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Table I monthly cost per $1,000 for an age. */
export function tableIRate(age: number): number {
  for (const band of TABLE_I_MONTHLY_PER_1000) if (age <= band.maxAge) return band.rate;
  return TABLE_I_MONTHLY_PER_1000[TABLE_I_MONTHLY_PER_1000.length - 1]!.rate;
}

/** The age the table uses: attained on the last day of the tax year. */
export function ageAtYearEnd(dob: Date, taxYear: number): number {
  const end = Date.UTC(taxYear, 11, 31);
  let age = taxYear - dob.getUTCFullYear();
  if (Date.UTC(taxYear, dob.getUTCMonth(), dob.getUTCDate()) > end) age -= 1;
  return Math.max(0, age);
}

export interface GroupTermLifeInput {
  /** Face amount of the coverage, in cents. */
  coverageCents: number;
  /** Date of birth; without one the coverage can't be costed and nothing is imputed. */
  dob: Date | null;
  taxYear: number;
  /** Pay periods in the year (26 biweekly …): the monthly cost is spread across them. */
  periodsPerYear: number;
  /** What the employee paid toward the coverage this period with after-tax dollars, in cents. */
  employeeAfterTaxCents?: number;
}

export interface GroupTermLifeResult {
  /** Taxable cost this pay period, dollars (0 when at or under $50,000). */
  imputedIncome: number;
  age: number | null;
  ratePer1000Month: number | null;
  excessThousands: number;
  annualCost: number;
}

/**
 * This period's imputed income: the annual Table I cost of the excess
 * coverage (rate × thousands over $50,000 × 12), spread over the pay
 * periods, less the employee's after-tax contribution. Never negative.
 */
export function groupTermLifeImputed(input: GroupTermLifeInput): GroupTermLifeResult {
  const excessCents = Math.max(0, input.coverageCents - GTL_EXCLUSION_CENTS);
  if (excessCents <= 0 || !input.dob || input.periodsPerYear <= 0) {
    return { imputedIncome: 0, age: input.dob ? ageAtYearEnd(input.dob, input.taxYear) : null, ratePer1000Month: null, excessThousands: 0, annualCost: 0 };
  }
  const age = ageAtYearEnd(input.dob, input.taxYear);
  const rate = tableIRate(age);
  // The table is per $1,000 of excess coverage; a partial thousand counts as its fraction.
  const excessThousands = excessCents / 100 / 1000;
  const annualCost = round2(rate * excessThousands * 12);
  const perPeriod = annualCost / input.periodsPerYear;
  const employeePaid = (input.employeeAfterTaxCents ?? 0) / 100;
  return {
    imputedIncome: round2(Math.max(0, perPeriod - employeePaid)),
    age,
    ratePer1000Month: rate,
    excessThousands: round2(excessThousands),
    annualCost,
  };
}
