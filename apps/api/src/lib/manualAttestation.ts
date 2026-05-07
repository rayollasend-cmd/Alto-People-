// Manual compliance attestation — config + period helpers.
//
// The "Coming soon" rows on the billing/invoicing scorecard tile are
// signals where the actual action lives in Fieldglass / the Walmart
// vendor portal. Building real integrations for those is months of work
// and politically hard. Manual attestation lets HR confirm "I did this
// for this period" with a date, an outcome, and optional evidence —
// good enough for audit, and the scorecard severity flips green/red on
// the same axis as a real integration would.
//
// Each signal here gets a config row defining its cadence (weekly /
// monthly), how soon before due to start reminding, and how long after
// the due date counts as overdue. Adding a new signal is one entry in
// this file plus a UI row — no migration needed (key is a string column
// on ManualComplianceAttestation, not a Prisma enum).

export type AttestationCadence = 'WEEKLY' | 'MONTHLY';

export interface AttestationConfig {
  /** Stable identifier; mirrored 1:1 with ManualComplianceAttestation.key. */
  key: string;
  /** Operator-facing label shown on the scorecard tile. */
  label: string;
  /** Short helper text shown under the label and in the attestation drawer. */
  description: string;
  cadence: AttestationCadence;
  /**
   * Days from period start until the attestation is "due". For WEEKLY
   * the period runs Monday → Sunday (UTC); a dueOffsetDays of 0 means
   * "due same day as period start" (i.e. by Monday). For MONTHLY the
   * period runs day 1 → last day of month; dueOffsetDays of 4 means
   * "due by the 5th of the month".
   */
  dueOffsetDays: number;
  /**
   * How many days before due to start nudging via in-app notifications.
   * 3 = reminders kick in 3 days before due.
   */
  reminderLeadDays: number;
}

export const ATTESTATION_CONFIGS: ReadonlyArray<AttestationConfig> = [
  {
    key: 'MONTHLY_REPORT',
    label: 'Monthly compliance report submitted',
    description:
      'Walmart SOW requires a monthly compliance report. Submit through the vendor portal and confirm here once filed.',
    cadence: 'MONTHLY',
    dueOffsetDays: 4, // by the 5th
    reminderLeadDays: 3,
  },
  {
    key: 'INVOICE_FORFEITURE',
    label: 'Invoices reviewed for 90-day forfeiture window',
    description:
      'Walmart MSA — invoices not submitted within 90 days are forfeit. Review the AR aging in QBO weekly and confirm any approaching 90 days have been escalated.',
    cadence: 'WEEKLY',
    dueOffsetDays: 4, // by Friday (Mon → Sun period)
    reminderLeadDays: 1,
  },
  {
    key: 'FIELDGLASS_TIMESHEET',
    label: 'Fieldglass timesheet submitted (Mon 2pm PST)',
    description:
      "Walmart SOW — Fieldglass timesheet must be submitted by Monday 2pm PST every week. Confirm here once it's filed.",
    cadence: 'WEEKLY',
    dueOffsetDays: 0, // due Monday
    reminderLeadDays: 0, // remind on the day
  },
];

export function getAttestationConfig(key: string): AttestationConfig | null {
  return ATTESTATION_CONFIGS.find((c) => c.key === key) ?? null;
}

/**
 * Period covering `now` for the given cadence. Boundaries are calendar-
 * aligned in UTC so the same period boundary is computed regardless of
 * which Railway region runs the cron.
 *
 *   - WEEKLY: Monday 00:00 UTC → next Monday 00:00 UTC (exclusive end).
 *     periodStart/periodEnd stored as DATE columns, so we surface the
 *     end as Sunday (inclusive).
 *   - MONTHLY: 1st 00:00 UTC → 1st of next month 00:00 UTC. periodEnd
 *     surfaces as the last day of the month (inclusive).
 */
export function periodForNow(
  cadence: AttestationCadence,
  now: Date = new Date(),
): { periodStart: Date; periodEnd: Date } {
  if (cadence === 'WEEKLY') {
    const utc = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const dow = utc.getUTCDay(); // 0=Sun .. 6=Sat
    // Convert to Mon=0..Sun=6 so subtracting always lands on Monday.
    const offsetFromMonday = (dow + 6) % 7;
    const periodStart = new Date(utc);
    periodStart.setUTCDate(periodStart.getUTCDate() - offsetFromMonday);
    const periodEnd = new Date(periodStart);
    periodEnd.setUTCDate(periodEnd.getUTCDate() + 6); // Sunday inclusive
    return { periodStart, periodEnd };
  }
  // MONTHLY
  const periodStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  );
  const periodEnd = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0), // last day of month
  );
  return { periodStart, periodEnd };
}

/** Date the attestation must be filed by, given its config + period. */
export function dueDateFor(
  config: AttestationConfig,
  periodStart: Date,
): Date {
  const due = new Date(periodStart);
  due.setUTCDate(due.getUTCDate() + config.dueOffsetDays);
  return due;
}

export type AttestationStatus = 'attested' | 'due_soon' | 'overdue' | 'upcoming';

export function classifyStatus(
  config: AttestationConfig,
  periodStart: Date,
  attested: boolean,
  now: Date = new Date(),
): AttestationStatus {
  if (attested) return 'attested';
  const due = dueDateFor(config, periodStart);
  // Operators read "due May 5" as "by end of May 5", not "by midnight at
  // start of May 5". Push the overdue threshold to start-of-next-day so
  // the entire due day is still due_soon, not already overdue.
  const overdueAt = new Date(due);
  overdueAt.setUTCDate(overdueAt.getUTCDate() + 1);
  const reminderStart = new Date(due);
  reminderStart.setUTCDate(reminderStart.getUTCDate() - config.reminderLeadDays);
  if (now >= overdueAt) return 'overdue';
  if (now >= reminderStart) return 'due_soon';
  return 'upcoming';
}

export function isInReminderWindow(
  config: AttestationConfig,
  periodStart: Date,
  now: Date = new Date(),
): boolean {
  const status = classifyStatus(config, periodStart, false, now);
  return status === 'due_soon' || status === 'overdue';
}
