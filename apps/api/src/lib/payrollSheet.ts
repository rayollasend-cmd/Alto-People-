// Payroll-ready sheet aggregation.
//
// Turns a flat list of APPROVED time entries into a per-associate sheet:
// the dates each person worked + the duration on each date, plus their
// regular / overtime / double-time totals for the window. The split is the
// labor-rules engine's (lib/laborRules/hours.splitHours) — the very split
// the paycheck pays — so the sheet and the check can't disagree: before,
// this file ran its own daily rule off the HOME state's table and read a
// California 9-hour day as overtime while pay paid it straight (pay only
// applies daily overtime where a jurisdiction is LIVE).
//
// Pure — takes pre-fetched rows (and the tenant's live rules) so it's
// trivially unit-testable and never touches the DB.

import { NO_LIVE_RULES, splitHours, type LaborSite, type PayRules } from './laborRules/hours.js';
import type { BreakFacts } from './timeAnomalies.js';

export interface PayrollSheetInputRow {
  id?: string;
  associateId: string;
  associateName: string;
  clockInAt: Date;
  clockOutAt: Date | null;
  breaks: BreakFacts[];
  /**
   * Where the hours were worked: its zone decides the day and the week, and
   * its jurisdiction (when LIVE) the daily rules. Null: the company zone and
   * the federal weekly split.
   */
  site?: LaborSite | null;
  /** The meal the worker attested they waived (lib/timeCorrections), as pay reads it. */
  mealWaived?: boolean;
}

export interface PayrollSheetDay {
  /** YYYY-MM-DD, the work site's calendar date of the clock-in. */
  date: string;
  /** Net worked minutes that day (breaks excluded). */
  minutes: number;
}

export interface PayrollSheetAssociate {
  associateId: string;
  name: string;
  /** Dates worked, ascending, with that day's net duration. */
  days: PayrollSheetDay[];
  regularMinutes: number;
  overtimeMinutes: number;
  /** Hours past a live jurisdiction's double-time line (CA past 12 a day); 0 elsewhere. */
  doubleTimeMinutes: number;
  /** The multipliers pay applies to the overtime and double-time hours (1.5×, 2×). */
  overtimeMultiplier: number;
  doubleMultiplier: number;
  totalMinutes: number;
  /**
   * Premiums the engine names for these hours (meal, rest, spread of hours…),
   * signed rules only. What one pays depends on the person's rate
   * (penaltyAmount: spread of hours is offset by pay above the minimum), so
   * the paycheck — which knows the rate — prints a line only where it's owed.
   */
  premiums: Array<{ label: string; kind: string; date: string; hours: number; cents?: number; rateCents?: number; offsetHours?: number }>;
  /** Why the hours split as they did: the engine's reason lines. */
  reasons: string[];
  /** Sum of assigned-shift minutes in the window — scheduled vs actual.
   *  Stamped by the route (needs a Shift query); absent in unit builds. */
  scheduledMinutes?: number;
}

export interface PayrollSheet {
  associates: PayrollSheetAssociate[];
  totalRegularMinutes: number;
  totalOvertimeMinutes: number;
  totalDoubleTimeMinutes: number;
  totalMinutes: number;
  /** See PayrollSheetAssociate.scheduledMinutes. */
  totalScheduledMinutes?: number;
}

/** Hours (already rounded like the paycheck) → minutes, without float dust. */
const toMin = (h: number) => Math.round(h * 60 * 100) / 100;

/**
 * Build the payroll sheet from APPROVED entries: each associate's hours split
 * by the engine exactly as their paycheck splits them (regular, overtime,
 * double time, each rounded to the hundredth of an hour like the paystub).
 */
export function buildPayrollSheet(rows: PayrollSheetInputRow[], rules: PayRules = NO_LIVE_RULES): PayrollSheet {
  const byAssoc = new Map<string, { name: string; rows: PayrollSheetInputRow[] }>();
  for (const r of rows) {
    const acc = byAssoc.get(r.associateId) ?? { name: r.associateName, rows: [] };
    acc.rows.push(r);
    byAssoc.set(r.associateId, acc);
  }

  const associates: PayrollSheetAssociate[] = [];
  let totalRegularMinutes = 0;
  let totalOvertimeMinutes = 0;
  let totalDoubleTimeMinutes = 0;

  for (const [associateId, acc] of byAssoc) {
    const split = splitHours(
      rules,
      acc.rows.map((r) => ({ id: r.id, clockInAt: r.clockInAt, clockOutAt: r.clockOutAt, breaks: r.breaks, site: r.site ?? null, mealWaived: r.mealWaived })),
    );
    const days = new Map<string, number>();
    for (const e of split.entries) {
      if (e.workedHours <= 0) continue;
      days.set(e.date, (days.get(e.date) ?? 0) + e.workedHours);
    }
    const regularMinutes = toMin(split.regularHours);
    const overtimeMinutes = toMin(split.overtimeHours);
    const doubleTimeMinutes = toMin(split.doubleTimeHours);
    totalRegularMinutes += regularMinutes;
    totalOvertimeMinutes += overtimeMinutes;
    totalDoubleTimeMinutes += doubleTimeMinutes;
    associates.push({
      associateId,
      name: acc.name,
      days: [...days.entries()].map(([date, h]) => ({ date, minutes: toMin(h) })).sort((a, b) => a.date.localeCompare(b.date)),
      regularMinutes,
      overtimeMinutes,
      doubleTimeMinutes,
      overtimeMultiplier: split.overtimeMultiplier,
      doubleMultiplier: split.doubleMultiplier,
      totalMinutes: toMin(split.regularHours + split.overtimeHours + split.doubleTimeHours),
      premiums: split.penalties.map((p) => ({
        label: p.label,
        kind: p.kind,
        date: p.date,
        hours: p.hours,
        ...(p.cents != null ? { cents: p.cents } : {}),
        ...(p.rateCents != null ? { rateCents: p.rateCents } : {}),
        ...(p.offsetHours != null ? { offsetHours: p.offsetHours } : {}),
      })),
      reasons: split.reasons,
    });
  }

  associates.sort((a, b) => a.name.localeCompare(b.name));

  return {
    associates,
    totalRegularMinutes: Math.round(totalRegularMinutes * 100) / 100,
    totalOvertimeMinutes: Math.round(totalOvertimeMinutes * 100) / 100,
    totalDoubleTimeMinutes: Math.round(totalDoubleTimeMinutes * 100) / 100,
    totalMinutes: Math.round((totalRegularMinutes + totalOvertimeMinutes + totalDoubleTimeMinutes) * 100) / 100,
  };
}

/** Minutes → decimal hours string, e.g. 150 → "2.50". */
export function minutesToHours(min: number): string {
  return (min / 60).toFixed(2);
}

/** The include a sheet's entries need: the person's name, the breaks and the work site. */
export const PAYROLL_SHEET_ENTRY_INCLUDE = {
  associate: { select: { firstName: true, lastName: true } },
  breaks: true,
  location: { select: { id: true, state: true, city: true, timezone: true } },
} as const;

/**
 * The sheet from database entries, through the paycheck's own inputs
 * (lib/laborRules/payContext): the tenant's live rules, punch rounding and
 * the meal waivers pay reads. The payroll sheet and the external bureau
 * sheet both build here, so they reconcile with each other and the check.
 */
export async function buildPayrollSheetForPay(
  db: import('@prisma/client').PrismaClient,
  entries: ReadonlyArray<{
    id: string;
    associateId: string;
    locationId: string | null;
    clockInAt: Date;
    clockOutAt: Date | null;
    breaks: BreakFacts[];
    associate: { firstName: string; lastName: string };
    location: LaborSite | null;
  }>,
): Promise<PayrollSheet> {
  const { loadPayContext } = await import('./laborRules/payContext.js');
  const [pay, waivers] = await Promise.all([
    loadPayContext(db),
    entries.length ? db.breakAttestation.findMany({ where: { timeEntryId: { in: entries.map((e) => e.id) }, meal: 'WAIVED' }, select: { timeEntryId: true } }) : Promise.resolve([] as Array<{ timeEntryId: string }>),
  ]);
  const waived = new Set(waivers.map((w) => w.timeEntryId));
  return buildPayrollSheet(
    entries.map((raw) => {
      const e = pay.forPay(raw);
      return {
        id: e.id,
        associateId: e.associateId,
        associateName: `${e.associate.firstName} ${e.associate.lastName}`,
        clockInAt: e.clockInAt,
        clockOutAt: e.clockOutAt,
        breaks: e.breaks,
        site: e.location,
        mealWaived: waived.has(e.id),
      };
    }),
    pay.rules,
  );
}
