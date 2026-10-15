import { z } from 'zod';

/**
 * Brief 2-2 step 1 — the rule families (docs/labor-rules-investigation.md §4.1).
 *
 *   Each family is a typed parameter block. A rule set (a pack, or a tenant
 *   or site override) sets only the families and fields it names; resolution
 *   (resolve.ts) layers them federal → state → city → tenant → site, the most
 *   specific winning per field, except where law says the more protective
 *   value wins (the higher minimum wage, the lower OT threshold).
 *
 *   These live with the API, not in packages/shared: the shared barrel ships
 *   in the web's main chunk, which has no room, and the web reads rules
 *   through the API (step 2's Rules page).
 */

const hours = z.number().min(0).max(24 * 7);
const multiplier = z.number().min(1).max(4);

export const OvertimeSchema = z
  .object({
    /** Hours in a workweek before overtime. FLSA: 40. */
    weeklyThreshold: hours.nullable(),
    weeklyMultiplier: multiplier,
    /** Hours in a day before overtime (CA 8); null: no daily overtime. */
    dailyThreshold: hours.nullable(),
    dailyMultiplier: multiplier,
    /** Hours in a day before double time (CA 12); null: none. */
    dailyDoubleThreshold: hours.nullable(),
    doubleMultiplier: multiplier,
    /** CA: the seventh consecutive day worked in a workweek pays its first 8 h at 1.5× and beyond at 2×. */
    seventhDayRule: z.boolean(),
  })
  .partial();

export const MealSchema = z
  .object({
    /** A meal must begin before this many hours worked; null: no meal law. */
    requiredAfterHours: hours.nullable(),
    minMinutes: z.number().int().min(0).max(120),
    /** A second meal before this many hours (CA 10); null: none. */
    secondRequiredAfterHours: hours.nullable(),
    /** Hours of pay owed for a missed, short or late meal (CA 1), at most once a day. 0: no penalty. */
    penaltyHours: z.number().min(0).max(4),
    /** A meal may be waived by the person within the law's conditions. */
    waiverAllowed: z.boolean(),
  })
  .partial();

export const RestSchema = z
  .object({
    /** One rest per this many hours worked (or major fraction); null: no rest law. */
    perHours: hours.nullable(),
    minMinutes: z.number().int().min(0).max(60),
    /** No rest owed on a day shorter than this (CA 3.5). */
    minimumDayHours: hours,
    penaltyHours: z.number().min(0).max(4),
  })
  .partial();

export const RestBetweenShiftsSchema = z
  .object({
    /** Fewer hours than this between two shifts is a short rest; null: none. */
    minHours: hours.nullable(),
    /** Hours of pay owed for a short rest (a premium), 0 if the law only warns. */
    premiumHours: z.number().min(0).max(8),
    /** Pay the premium at this multiple of the regular rate for the hours worked inside the gap (Chicago 1.25), 0: none. */
    premiumMultiplierInGap: z.number().min(0).max(4),
  })
  .partial();

const MinorBandSchema = z.object({
  /** Inclusive age range. */
  minAge: z.number().int().min(0).max(17),
  maxAge: z.number().int().min(0).max(17),
  schoolDayMaxHours: hours.nullable(),
  schoolWeekMaxHours: hours.nullable(),
  nonSchoolDayMaxHours: hours.nullable(),
  nonSchoolWeekMaxHours: hours.nullable(),
  /** Local hour-of-day window, "07:00"–"19:00"; null: no window. */
  earliest: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
  latest: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
  /** The later end allowed in summer (June 1 to Labor Day under FLSA), null: same as latest. */
  summerLatest: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
  /** Latest on a night before a school day, if the law sets one apart (FL 16–17: 23:00). */
  schoolNightLatest: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
  /** A meal break owed after this many hours (AL under 16: 5), null: none. */
  mealAfterHours: hours.nullable(),
});
export type MinorBand = z.infer<typeof MinorBandSchema>;

export const MinorsSchema = z
  .object({
    bands: z.array(MinorBandSchema),
    /** Minors' limits block at scheduling (owner's decision 7: not overridable). */
    severity: z.literal('block'),
  })
  .partial();

export const PredictiveSchema = z
  .object({
    /** Days of advance notice the schedule needs; null: no predictive law. */
    noticeDays: z.number().int().min(0).max(31).nullable(),
    /** Premium hours owed per change, by notice band: changes made with fewer than `withinDays` days' notice. */
    changePremiums: z.array(z.object({ withinDays: z.number().min(0).max(31), premiumHours: z.number().min(0).max(8), kind: z.enum(['added', 'reduced', 'cancelled', 'moved']).array() })),
    /** Whether the law requires a good-faith estimate of hours at hire. */
    goodFaithEstimate: z.boolean(),
  })
  .partial();

export const MinimumWageSchema = z
  .object({
    /** Cents an hour. */
    rateCents: z.number().int().min(0).max(100_000),
  })
  .partial();

export const CustomSchema = z.record(z.string().regex(/^[a-z][a-zA-Z0-9_]{0,59}$/), z.union([z.number(), z.boolean(), z.string().max(120)]));

export type Severity = 'warn' | 'block';

export const SeveritySchema = z
  .object({
    overtime: z.enum(['warn', 'block']),
    restBetweenShifts: z.enum(['warn', 'block']),
    predictive: z.enum(['warn', 'block']),
  })
  .partial();

export const RuleParamsSchema = z
  .object({
    overtime: OvertimeSchema,
    meal: MealSchema,
    rest: RestSchema,
    restBetweenShifts: RestBetweenShiftsSchema,
    minors: MinorsSchema,
    predictive: PredictiveSchema,
    minimumWage: MinimumWageSchema,
    severity: SeveritySchema,
    custom: CustomSchema,
  })
  .partial()
  .strict();
export type RuleParams = z.infer<typeof RuleParamsSchema>;

export type RuleLevel = 'FEDERAL' | 'STATE' | 'CITY' | 'TENANT' | 'SITE';

/** A rule set: a pack (jurisdiction), or a tenant or site override. */
export interface RuleSetDef {
  /** FEDERAL, US-FL, US-NY-NYC…; for an override, TENANT or SITE:<id>. */
  jurisdiction: string;
  level: RuleLevel;
  /** YYYY-MM-DD, the first work date it applies to. */
  effectiveFrom: string;
  version: number;
  params: RuleParams;
  /** Citation: statute, regulation or agency page. */
  source: string;
  sourceDate: string;
  /** DRAFT until counsel signs (owner's decision 10); the engine refuses a DRAFT set for pay. */
  status: 'DRAFT' | 'ACTIVE' | 'RETIRED';
  approvedBy: string | null;
}

/** The fully resolved parameters for one site on one day. Families a layer never set are absent. */
export interface ResolvedRules {
  params: RuleParams;
  /** The sets that contributed, most general first: "US-FL 2025-09-30 v1". */
  layers: string[];
  /** Stable id of the combination, recorded with every outcome. */
  fingerprint: string;
  /** Whether every contributing set is ACTIVE (pay may use it). */
  payable: boolean;
  /** Which layer set each field, for the reason lines: "overtime.weeklyThreshold" → "FEDERAL 2009-07-24 v1". */
  origin: Record<string, string>;
}
