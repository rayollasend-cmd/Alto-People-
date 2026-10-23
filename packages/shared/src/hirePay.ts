import { z } from 'zod';

/**
 * A new hire's starting pay (owner, 2026-10-23): the onboarding desk sets the
 * first wage and the pay schedule while the person onboards, without reading
 * or changing anyone else's pay.
 *
 * The one rule (API lib/hirePay.ts): a person is a NEW HIRE for pay while they
 * are onboarding (an application in flight) or were hired in the last
 * NEW_HIRE_WINDOW_DAYS days — AND have never been paid on a run, AND have no
 * compensation record but the starting one (reason HIRE). Inside it,
 * `set:hire-pay` reads their pay and sets or corrects the starting pay through
 * POST /comp/associates/:id/records (reason HIRE). Outside it, it is a pay
 * change, and pay changes are manage:comp's.
 *
 * A starting wage above the position's ceiling — the pay band's maximum or the
 * rate card's pay for the client and position, the lower when both exist —
 * waits on a manage:comp holder (202 pending); at or below it, it applies at
 * once.
 *
 *   GET /comp/associates/:id/hire-pay  → HirePayStatus (set:hire-pay or manage:comp; the person in reach)
 */

export const NEW_HIRE_WINDOW_DAYS = 30;

const Ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Id = z.string().uuid();
const PayTypeSchema = z.enum(['HOURLY', 'SALARY']);
/** Decimal as a string with two places, so the wire stays exact. */
const Money = z.string().regex(/^\d+\.\d{2}$/);

/** Where a person stands against the window. */
export const HirePayWhySchema = z.enum([
  'NEW_HIRE',
  /** Not onboarding, and hired more than the window ago (or never). */
  'NOT_NEW_HIRE',
  /** Paid on a run already. */
  'PAID',
  /** A pay change other than the starting pay is on file. */
  'PAY_CHANGED',
  /** Separated or paused. */
  'SEPARATED',
]);
export type HirePayWhy = z.infer<typeof HirePayWhySchema>;

export const HirePayCeilingSchema = z.object({
  payType: PayTypeSchema,
  amount: Money,
  source: z.enum(['BAND', 'RATE_CARD']),
  /** "the rate card's pay for Housekeeper at Coastal Resort" */
  label: z.string(),
});
export type HirePayCeiling = z.infer<typeof HirePayCeilingSchema>;

export const HirePayStatusSchema = z.object({
  associateId: Id,
  newHire: z.boolean(),
  why: HirePayWhySchema,
  /** Plain words for someone outside the window; null inside it. */
  message: z.string().nullable(),
  /** This caller may set or correct the starting pay here, now. */
  canSet: z.boolean(),
  /** This caller sets it at once whatever the amount (manage:comp, by the usual pay-change rules). */
  compAccess: z.boolean(),
  /** Their first day: the application's start date, else the hire date. */
  startDate: Ymd.nullable(),
  client: z.object({ id: Id, name: z.string() }).nullable(),
  position: z.string().nullable(),
  /** The pay in force. Left out (not null) for a caller who may not read this person's pay. */
  current: z
    .object({ id: Id, payType: PayTypeSchema, amount: Money, effectiveFrom: Ymd, reason: z.string() })
    .nullable()
    .optional(),
  /** What to prefill: the accepted offer, else the rate card, else the posting's pay. */
  suggested: z
    .object({ payType: PayTypeSchema, amount: Money, source: z.enum(['OFFER', 'RATE_CARD', 'POSTING']), label: z.string() })
    .nullable(),
  /** Per pay type, the most a starting wage may be before a compensation approver decides it. */
  ceilings: z.object({ HOURLY: HirePayCeilingSchema.nullable(), SALARY: HirePayCeilingSchema.nullable() }),
  /** A starting wage waiting on a second person. */
  pending: z
    .object({ id: Id, title: z.string(), payType: PayTypeSchema, amount: Money, effectiveFrom: Ymd, requestedAt: z.string().datetime() })
    .nullable(),
});
export type HirePayStatus = z.infer<typeof HirePayStatusSchema>;

/** POST /comp/associates/:id/records answers one of these. */
export type HirePaySaveResult = { ok: true } | { pending: true; approvalId: string; title: string };
