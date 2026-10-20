import { z } from 'zod';

/**
 * Running payroll in-house: every company-level account and setting a real
 * payroll needs, checked for this tenant, with where to fix each one.
 *
 *   GET /payroll/go-live → PayrollGoLive   (process:payroll)
 *
 * DONE is set up. MISSING blocks a real payroll. WARNING won't stop a run
 * but will cost you (a filing done by hand, people who won't be paid right).
 * INFO is a choice the company made that's worth knowing (no QuickBooks).
 */

export const GoLiveStatusSchema = z.enum(['DONE', 'MISSING', 'WARNING', 'INFO']);
export type GoLiveStatus = z.infer<typeof GoLiveStatusSchema>;

export const GoLiveCheckSchema = z.object({
  key: z.string(),
  title: z.string(),
  status: GoLiveStatusSchema,
  /** One or two plain sentences: what's there, or what's missing and why it matters. */
  detail: z.string(),
  fix: z.object({ label: z.string(), to: z.string() }).nullable(),
});
export type GoLiveCheck = z.infer<typeof GoLiveCheckSchema>;

export const GoLiveSectionSchema = z.object({
  key: z.enum(['company', 'federal', 'states', 'filing', 'paying', 'people', 'controls', 'books']),
  title: z.string(),
  checks: z.array(GoLiveCheckSchema),
});
export type GoLiveSection = z.infer<typeof GoLiveSectionSchema>;

export const PayrollGoLiveSchema = z.object({
  /** No MISSING anywhere. */
  ready: z.boolean(),
  missing: z.number().int(),
  warnings: z.number().int(),
  done: z.number().int(),
  total: z.number().int(),
  /** The states payroll withholds for: where people live and where they work. */
  states: z.array(z.string()),
  sections: z.array(GoLiveSectionSchema),
  generatedAt: z.string(),
});
export type PayrollGoLive = z.infer<typeof PayrollGoLiveSchema>;
