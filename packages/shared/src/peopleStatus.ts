import { z } from 'zod';

/**
 * ONE STATUS PER PERSON (Fortune 500 fix-up, SH-4).
 *
 * Every page that says where a person stands reads this vocabulary, from
 * the one rule in apps/api/src/lib/peopleStatus.ts. It used to be three:
 * the directory's ACTIVE / PENDING / INACTIVE (INACTIVE lumped "paused",
 * "separated" and "approved but no shift in 14 days"), the payroll
 * reconciliation's PlatformStatus, and the Workforce roster's account
 * status. The same person read Inactive on one page and Active on the next.
 *
 *   ACTIVE             Working           the one definition of active
 *                                        (lib/activeDefinition): placed, and
 *                                        worked in the window or has a shift ahead
 *   PLACED_NOT_ACTIVE  No recent shifts  placed at a site, no work in the
 *                                        window and nothing scheduled
 *   NOT_PLACED         Not placed        hired, placed nowhere
 *   ONBOARDING         Onboarding        an application in flight and none
 *                                        approved: not hired yet
 *   DEACTIVATED        Paused            paused by hand; still employed
 *   SEPARATED          Separated         separation recorded (and no rehire in flight)
 *
 * The first wins in that order after SEPARATED and DEACTIVATED, which
 * override everything (a separated person is never "working").
 *
 * Two headline numbers come from it, named the same on every page:
 *   On the books  hired and not separated: Working + No recent shifts +
 *                 Not placed + Paused
 *   Working       ACTIVE, over the company's active window (OrgSetting.activeWindowDays)
 */
export const WORK_STATUSES = ['ACTIVE', 'PLACED_NOT_ACTIVE', 'NOT_PLACED', 'ONBOARDING', 'DEACTIVATED', 'SEPARATED'] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];
export const WorkStatusSchema = /* @__PURE__ */ (() => z.enum(WORK_STATUSES))();

/** English labels (the web reads its own i18n keys, `people.ws.<STATUS>`). */
export const WORK_STATUS_LABELS: Record<WorkStatus, string> = {
  ACTIVE: 'Working',
  PLACED_NOT_ACTIVE: 'No recent shifts',
  NOT_PLACED: 'Not placed',
  ONBOARDING: 'Onboarding',
  DEACTIVATED: 'Paused',
  SEPARATED: 'Separated',
};

/** Hired and not separated. */
export const ON_THE_BOOKS_STATUSES: readonly WorkStatus[] = ['ACTIVE', 'PLACED_NOT_ACTIVE', 'NOT_PLACED', 'DEACTIVATED'];

export function isOnTheBooks(s: WorkStatus): boolean {
  return ON_THE_BOOKS_STATUSES.includes(s);
}

/**
 * The older three-word directory status, derived from the one status so the
 * two can never disagree: Working is ACTIVE, Onboarding is PENDING, the rest
 * INACTIVE.
 */
export function directoryStatusOf(s: WorkStatus): 'ACTIVE' | 'PENDING' | 'INACTIVE' {
  return s === 'ACTIVE' ? 'ACTIVE' : s === 'ONBOARDING' ? 'PENDING' : 'INACTIVE';
}

/** How many people stand where, with the two headline numbers. */
export const WorkStatusCountsSchema = /* @__PURE__ */ (() =>
  z.object({
    ACTIVE: z.number().int().nonnegative(),
    PLACED_NOT_ACTIVE: z.number().int().nonnegative(),
    NOT_PLACED: z.number().int().nonnegative(),
    ONBOARDING: z.number().int().nonnegative(),
    DEACTIVATED: z.number().int().nonnegative(),
    SEPARATED: z.number().int().nonnegative(),
    /** Hired and not separated (ON_THE_BOOKS_STATUSES). */
    onTheBooks: z.number().int().nonnegative(),
    /** Everyone on file (not deleted). */
    total: z.number().int().nonnegative(),
    /** The active window "Working" is measured over, in days. */
    windowDays: z.number().int().positive(),
  }))();
export type WorkStatusCounts = z.infer<typeof WorkStatusCountsSchema>;
