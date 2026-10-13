import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { env } from '../config/env.js';
import { aggregatePayrollProjection } from './payrollAggregator.js';
import { activeAssociateIds, activeWindowDays } from './activeDefinition.js';
import { startOfWeekUTC, endOfWeekUTC } from './timeAnomalies.js';
import { ACTIVE_COUNT_SITES, DISTINCT_ACTIVE_RULES } from './activeInventory.js';

/**
 * Reconciliation: platform vs payroll for one pay period (Brief 1A-1).
 *
 *   The platform side is what the payroll engine itself would pay for the
 *   period (the same aggregator the run wizard uses), beside the current
 *   compensation record and the employment status. The payroll side is a
 *   CSV export from Synchros, read through a column map that is filled in
 *   once the export's columns are known. The two meet on the associate's
 *   email (or, when the export carries one, the employee number), and
 *   every nonzero difference is a line in the report.
 *
 *   Read-only. Nothing here writes.
 */

type Db = PrismaClient;

// ---------------------------------------------------------------------------
// The payroll export
// ---------------------------------------------------------------------------

/**
 * Column map for the Synchros export. Each entry names the CSV header that
 * carries the value. The defaults are placeholders: the owner supplies the
 * real column names and the map is completed (or overridden on the command
 * line with --map "hours=Reg Hours,gross=Gross Pay,...").
 *
 * TODO(1A-1): replace the placeholder headers with the Synchros export's
 * columns when they arrive. Every header listed here is matched
 * case-insensitively and with surrounding whitespace trimmed.
 */
export const PAYROLL_COLUMNS = {
  /** Something that identifies the person: email by default. */
  email: 'Email',
  /** The four-digit employee number, when the export has it. */
  employeeNumber: 'Employee Number',
  firstName: 'First Name',
  lastName: 'Last Name',
  /** Hours paid in the period. If the export splits regular and overtime, map `hours` to regular and `overtimeHours` to the OT column. */
  hours: 'Hours',
  overtimeHours: 'Overtime Hours',
  /** The hourly rate the period was paid at. */
  rate: 'Rate',
  /** Gross pay for the period. */
  gross: 'Gross',
  /** Employment status as payroll sees it (Active, Terminated, ...). */
  status: 'Status',
} as const;

export type PayrollColumnKey = keyof typeof PAYROLL_COLUMNS;
export type PayrollColumnMap = Record<PayrollColumnKey, string>;

export interface PayrollRow {
  email: string | null;
  employeeNumber: string | null;
  name: string;
  hours: number;
  rate: number | null;
  gross: number | null;
  status: string | null;
  /** The raw line, for the report. */
  line: number;
}

/** RFC 4180: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

const num = (s: string | undefined): number | null => {
  if (s == null) return null;
  const cleaned = s.replace(/[$,\s]/g, '');
  if (cleaned === '' || cleaned === '-') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
};

/** Reads the export with the column map; unknown columns are ignored, missing ones are null. */
export function parsePayrollCsv(text: string, map: PayrollColumnMap = PAYROLL_COLUMNS): { rows: PayrollRow[]; missingColumns: PayrollColumnKey[] } {
  const table = parseCsv(text);
  if (table.length === 0) return { rows: [], missingColumns: Object.keys(map) as PayrollColumnKey[] };
  const header = table[0]!.map((h) => h.trim().toLowerCase());
  const idx = (key: PayrollColumnKey): number => header.indexOf(map[key].trim().toLowerCase());
  const col = Object.fromEntries((Object.keys(map) as PayrollColumnKey[]).map((k) => [k, idx(k)])) as Record<PayrollColumnKey, number>;
  const missingColumns = (Object.keys(map) as PayrollColumnKey[]).filter((k) => col[k] < 0);
  const cell = (r: string[], k: PayrollColumnKey): string | undefined => (col[k] >= 0 ? r[col[k]]?.trim() : undefined);
  const rows: PayrollRow[] = [];
  table.slice(1).forEach((r, i) => {
    const first = cell(r, 'firstName') ?? '';
    const last = cell(r, 'lastName') ?? '';
    rows.push({
      email: cell(r, 'email')?.toLowerCase() || null,
      employeeNumber: cell(r, 'employeeNumber') || null,
      name: `${first} ${last}`.trim(),
      hours: (num(cell(r, 'hours')) ?? 0) + (num(cell(r, 'overtimeHours')) ?? 0),
      rate: num(cell(r, 'rate')),
      gross: num(cell(r, 'gross')),
      status: cell(r, 'status') || null,
      line: i + 2,
    });
  });
  return { rows, missingColumns };
}

/** `--map hours=Reg Hours,gross=Gross Pay` on top of the defaults. */
export function columnMapFromArg(arg: string | undefined, base: PayrollColumnMap = PAYROLL_COLUMNS): PayrollColumnMap {
  const map = { ...base };
  if (!arg) return map;
  for (const pair of arg.split(',')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const key = pair.slice(0, eq).trim() as PayrollColumnKey;
    if (key in map) map[key] = pair.slice(eq + 1).trim();
  }
  return map;
}

// ---------------------------------------------------------------------------
// The platform side
// ---------------------------------------------------------------------------

export type PlatformStatus = 'ACTIVE' | 'PLACED_NOT_ACTIVE' | 'NOT_PLACED' | 'SEPARATED' | 'DEACTIVATED';

export interface PlatformRow {
  associateId: string;
  email: string;
  name: string;
  employmentType: string;
  /** Hours the payroll engine would pay for the period. */
  hours: number;
  regularHours: number;
  overtimeHours: number;
  /** Rate the engine used, and where it came from. */
  rate: number;
  rateSource: 'OVERRIDE' | 'COMP' | 'DEFAULT' | 'SALARY' | 'NONE';
  /** The compensation record in force at the end of the period, if any. */
  compRate: number | null;
  compPayType: string | null;
  gross: number;
  /** Time entries in the period that are not yet approved — the usual reason hours differ. */
  pendingEntries: number;
  rejectedEntries: number;
  status: PlatformStatus;
  separatedAt: string | null;
}

export interface PlatformSide {
  periodStart: string;
  periodEnd: string;
  rows: PlatformRow[];
  headcount: {
    /** Brief 1A-2's one definition, trailing window in days. */
    activeByDefinition: number;
    windowDays: number;
    /** Associates the engine would pay for the period (hours > 0). */
    paidByPlatform: number;
    /** Associates on an ASSIGNED shift in the org week that contains `now`. */
    scheduledThisWeek: number;
    /** Every associate row that is not deleted. */
    onFile: number;
  };
  totals: { hours: number; gross: number };
}

const dayStart = (s: string) => new Date(`${s}T00:00:00.000Z`);

export async function platformSide(db: Db, period: { start: string; end: string }, now: Date = new Date(), windowDaysOverride?: number): Promise<PlatformSide> {
  const windowDays = windowDaysOverride ?? (await activeWindowDays(db));
  const periodStart = dayStart(period.start);
  const periodEndExclusive = new Date(dayStart(period.end).getTime() + 86_400_000);

  const [projection, associates, active] = await Promise.all([
    aggregatePayrollProjection(db, { periodStart, periodEndExclusive, clientId: null, defaultRate: env.DEFAULT_ASSOCIATE_PAY_RATE }),
    db.associate.findMany({
      where: { deletedAt: null },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        employmentType: true,
        separatedAt: true,
        deactivatedAt: true,
        assignments: { where: { endedAt: null }, select: { id: true }, take: 1 },
        compRecords: {
          where: { effectiveFrom: { lte: periodEndExclusive }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: periodStart } }] },
          orderBy: { effectiveFrom: 'desc' },
          take: 1,
          select: { amount: true, payType: true },
        },
      },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    }),
    activeAssociateIds({ windowDays }, now, db),
  ]);
  const byAssociate = new Map(projection.items.map((i) => [i.associateId, i]));
  const entryCounts = await db.timeEntry.groupBy({
    by: ['associateId', 'status'],
    where: { clockInAt: { gte: periodStart, lt: periodEndExclusive } },
    _count: { _all: true },
  });
  const pending = new Map<string, number>();
  const rejected = new Map<string, number>();
  for (const e of entryCounts) {
    if (e.status === 'COMPLETED' || e.status === 'ACTIVE') pending.set(e.associateId, (pending.get(e.associateId) ?? 0) + e._count._all);
    if (e.status === 'REJECTED') rejected.set(e.associateId, (rejected.get(e.associateId) ?? 0) + e._count._all);
  }
  const weekStart = startOfWeekUTC(now);
  const weekEnd = endOfWeekUTC(now);
  const scheduled = await db.shift.findMany({
    where: { status: 'ASSIGNED', assignedAssociateId: { not: null }, startsAt: { gte: weekStart, lt: weekEnd } },
    select: { assignedAssociateId: true },
    distinct: ['assignedAssociateId'],
  });

  const rows: PlatformRow[] = associates.map((a) => {
    const p = byAssociate.get(a.id);
    const comp = a.compRecords[0] ?? null;
    const status: PlatformStatus = a.separatedAt ? 'SEPARATED' : a.deactivatedAt ? 'DEACTIVATED' : active.has(a.id) ? 'ACTIVE' : a.assignments.length ? 'PLACED_NOT_ACTIVE' : 'NOT_PLACED';
    return {
      associateId: a.id,
      email: a.email.toLowerCase(),
      name: `${a.firstName} ${a.lastName}`.trim(),
      employmentType: a.employmentType,
      hours: p?.hoursWorked ?? 0,
      regularHours: p?.regularHours ?? 0,
      overtimeHours: p?.overtimeHours ?? 0,
      rate: p?.hourlyRate ?? (comp ? Number(comp.amount) : 0),
      rateSource: p?.rateSource ?? 'NONE',
      compRate: comp ? Number(comp.amount) : null,
      compPayType: comp?.payType ?? null,
      gross: p?.grossPay ?? 0,
      pendingEntries: pending.get(a.id) ?? 0,
      rejectedEntries: rejected.get(a.id) ?? 0,
      status,
      separatedAt: a.separatedAt?.toISOString() ?? null,
    };
  });
  return {
    periodStart: period.start,
    periodEnd: period.end,
    rows,
    headcount: {
      activeByDefinition: active.size,
      windowDays,
      paidByPlatform: rows.filter((r) => r.hours > 0).length,
      scheduledThisWeek: scheduled.length,
      onFile: rows.length,
    },
    totals: { hours: round2(rows.reduce((s, r) => s + r.hours, 0)), gross: round2(rows.reduce((s, r) => s + r.gross, 0)) },
  };
}

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

export interface ReconcileLine {
  key: string;
  name: string;
  platformHours: number | null;
  payrollHours: number | null;
  hoursDiff: number | null;
  platformRate: number | null;
  payrollRate: number | null;
  rateDiff: number | null;
  platformGross: number | null;
  payrollGross: number | null;
  grossDiff: number | null;
  platformStatus: PlatformStatus | null;
  payrollStatus: string | null;
  /** Why the line is here, in words a person can act on. */
  causes: string[];
}

export interface ReconcileResult {
  period: { start: string; end: string };
  matchedOn: 'email' | 'employeeNumber';
  lines: ReconcileLine[];
  /** Every line with a nonzero difference or a one-sided match. */
  variances: ReconcileLine[];
  totals: {
    headcount: { platformActive: number; platformPaid: number; payrollPaid: number; variance: number };
    hours: { platform: number; payroll: number; variance: number };
    gross: { platform: number; payroll: number; variance: number };
  };
  /** Causes ranked by how many lines they explain. */
  topCauses: { cause: string; lines: number }[];
  payrollProvided: boolean;
  missingColumns: PayrollColumnKey[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const diff = (a: number | null, b: number | null): number | null => (a == null || b == null ? null : round2(a - b));

export function reconcile(
  platform: PlatformSide,
  payroll: { rows: PayrollRow[]; missingColumns: PayrollColumnKey[] } | null,
  matchedOn: 'email' | 'employeeNumber' = 'email',
  employeeNumbers: Map<string, string> = new Map(),
): ReconcileResult {
  const keyOfPlatform = (r: PlatformRow) => (matchedOn === 'email' ? r.email : (employeeNumbers.get(r.associateId) ?? `no-number:${r.email}`));
  const keyOfPayroll = (r: PayrollRow) => (matchedOn === 'email' ? (r.email ?? `no-email:line-${r.line}`) : (r.employeeNumber ?? `no-number:line-${r.line}`));
  const payrollBy = new Map<string, PayrollRow>();
  for (const r of payroll?.rows ?? []) payrollBy.set(keyOfPayroll(r), r);

  const lines: ReconcileLine[] = [];
  const seen = new Set<string>();
  for (const p of platform.rows) {
    const key = keyOfPlatform(p);
    const pay = payrollBy.get(key) ?? null;
    if (pay) seen.add(key);
    const causes: string[] = [];
    if (!payroll) {
      // Platform only: nothing to compare yet.
    } else if (!pay) {
      if (p.hours > 0) causes.push('Paid by the platform, absent from payroll');
    } else {
      const hd = diff(p.hours, pay.hours);
      if (hd != null && Math.abs(hd) >= 0.01) {
        if (p.pendingEntries > 0) causes.push('Hours differ and the platform has unapproved time entries');
        else if (p.rejectedEntries > 0) causes.push('Hours differ and the platform has rejected time entries');
        else if (hd > 0) causes.push('Platform hours exceed payroll hours');
        else causes.push('Payroll hours exceed platform hours');
      }
      const rd = diff(p.rate, pay.rate);
      if (rd != null && Math.abs(rd) >= 0.01) causes.push(p.rateSource === 'DEFAULT' ? 'Rate differs; the platform used the default rate (no compensation record)' : 'Rate differs from the compensation record');
      const gd = diff(p.gross, pay.gross);
      if (gd != null && Math.abs(gd) >= 0.01 && causes.length === 0) causes.push('Gross differs with equal hours and rate (deductions, add-ons or rounding)');
      if (p.status === 'SEPARATED' && pay.hours > 0) causes.push('Separated on the platform but paid hours');
      if (p.status === 'NOT_PLACED' && pay.hours > 0) causes.push('Paid but not placed at any site on the platform');
    }
    lines.push({
      key,
      name: p.name,
      platformHours: p.hours,
      payrollHours: pay ? pay.hours : null,
      hoursDiff: pay ? diff(p.hours, pay.hours) : null,
      platformRate: p.rate,
      payrollRate: pay?.rate ?? null,
      rateDiff: pay ? diff(p.rate, pay.rate) : null,
      platformGross: p.gross,
      payrollGross: pay?.gross ?? null,
      grossDiff: pay ? diff(p.gross, pay.gross) : null,
      platformStatus: p.status,
      payrollStatus: pay?.status ?? null,
      causes,
    });
  }
  for (const r of payroll?.rows ?? []) {
    const key = keyOfPayroll(r);
    if (seen.has(key)) continue;
    lines.push({
      key,
      name: r.name || key,
      platformHours: null,
      payrollHours: r.hours,
      hoursDiff: null,
      platformRate: null,
      payrollRate: r.rate,
      rateDiff: null,
      platformGross: null,
      payrollGross: r.gross,
      grossDiff: null,
      platformStatus: null,
      payrollStatus: r.status,
      causes: [matchedOn === 'email' && !r.email ? 'Payroll row has no email to match on' : 'On payroll, not found on the platform'],
    });
  }

  const variances = lines.filter((l) => l.causes.length > 0);
  const counts = new Map<string, number>();
  for (const l of variances) for (const c of l.causes) counts.set(c, (counts.get(c) ?? 0) + 1);
  const topCauses = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([cause, n]) => ({ cause, lines: n }));

  const payrollPaid = (payroll?.rows ?? []).filter((r) => r.hours > 0).length;
  const payrollHours = round2((payroll?.rows ?? []).reduce((s, r) => s + r.hours, 0));
  const payrollGross = round2((payroll?.rows ?? []).reduce((s, r) => s + (r.gross ?? 0), 0));
  return {
    period: { start: platform.periodStart, end: platform.periodEnd },
    matchedOn,
    lines,
    variances,
    totals: {
      headcount: { platformActive: platform.headcount.activeByDefinition, platformPaid: platform.headcount.paidByPlatform, payrollPaid, variance: platform.headcount.paidByPlatform - payrollPaid },
      hours: { platform: platform.totals.hours, payroll: payrollHours, variance: round2(platform.totals.hours - payrollHours) },
      gross: { platform: platform.totals.gross, payroll: payrollGross, variance: round2(platform.totals.gross - payrollGross) },
    },
    topCauses,
    payrollProvided: payroll != null,
    missingColumns: payroll?.missingColumns ?? [],
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const csvCell = (v: unknown): string => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function reconcileCsv(r: ReconcileResult): string {
  const head = ['key', 'name', 'platformHours', 'payrollHours', 'hoursDiff', 'platformRate', 'payrollRate', 'rateDiff', 'platformGross', 'payrollGross', 'grossDiff', 'platformStatus', 'payrollStatus', 'causes'];
  const lines = [head.join(',')];
  for (const l of r.lines) {
    lines.push([l.key, l.name, l.platformHours, l.payrollHours, l.hoursDiff, l.platformRate, l.payrollRate, l.rateDiff, l.platformGross, l.payrollGross, l.grossDiff, l.platformStatus, l.payrollStatus, l.causes.join('; ')].map(csvCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function reconcileMarkdown(r: ReconcileResult, platform: PlatformSide): string {
  const out: string[] = [];
  out.push(`# Reconciliation: platform vs payroll, ${r.period.start} to ${r.period.end}`);
  out.push('');
  if (!r.payrollProvided) {
    out.push('**No payroll export was given.** This is the platform side only; run again with `--payroll <file.csv>` once the Synchros export is available.');
    out.push('');
  } else if (r.missingColumns.length) {
    out.push(`**Columns not found in the export:** ${r.missingColumns.join(', ')}. Map them with \`--map key=Header,...\` or complete PAYROLL_COLUMNS in src/lib/reconcilePayroll.ts.`);
    out.push('');
  }
  out.push('## Totals');
  out.push('');
  out.push('| Measure | Platform | Payroll | Variance |');
  out.push('|---|---|---|---|');
  out.push(`| Active headcount (definition, ${platform.headcount.windowDays}-day window) | ${r.totals.headcount.platformActive} | — | — |`);
  out.push(`| Paid this period | ${r.totals.headcount.platformPaid} | ${r.payrollProvided ? r.totals.headcount.payrollPaid : '—'} | ${r.payrollProvided ? r.totals.headcount.variance : '—'} |`);
  out.push(`| Scheduled this week | ${platform.headcount.scheduledThisWeek} | — | — |`);
  out.push(`| On file | ${platform.headcount.onFile} | — | — |`);
  out.push(`| Total hours | ${r.totals.hours.platform} | ${r.payrollProvided ? r.totals.hours.payroll : '—'} | ${r.payrollProvided ? r.totals.hours.variance : '—'} |`);
  out.push(`| Total gross | ${money(r.totals.gross.platform)} | ${r.payrollProvided ? money(r.totals.gross.payroll) : '—'} | ${r.payrollProvided ? money(r.totals.gross.variance) : '—'} |`);
  out.push('');
  if (r.payrollProvided) {
    out.push(`## Variances (${r.variances.length} of ${r.lines.length} lines)`);
    out.push('');
    if (r.topCauses.length) {
      out.push('Top causes:');
      out.push('');
      for (const c of r.topCauses) out.push(`- ${c.cause}: ${c.lines} line${c.lines === 1 ? '' : 's'}`);
      out.push('');
    }
    out.push('| Who | Hours (platform / payroll / diff) | Rate (platform / payroll) | Gross (platform / payroll / diff) | Status (platform / payroll) | Cause |');
    out.push('|---|---|---|---|---|---|');
    for (const l of r.variances) {
      out.push(`| ${l.name} | ${l.platformHours ?? '—'} / ${l.payrollHours ?? '—'} / ${l.hoursDiff ?? '—'} | ${l.platformRate ?? '—'} / ${l.payrollRate ?? '—'} | ${l.platformGross != null ? money(l.platformGross) : '—'} / ${l.payrollGross != null ? money(l.payrollGross) : '—'} / ${l.grossDiff != null ? money(l.grossDiff) : '—'} | ${l.platformStatus ?? '—'} / ${l.payrollStatus ?? '—'} | ${l.causes.join('; ')} |`);
    }
    out.push('');
  }
  out.push('## Definition of active: every computation on the platform today');
  out.push('');
  out.push('The one shared definition is `src/lib/activeDefinition.ts` (Brief 1A-2): employed, placed at a site, and either a non-rejected clock-in in the trailing window or a future assigned shift. Sites marked ✓ read it; the rest mean something else (on the floor now, scheduled, a pool of people who can be scheduled) and say so.');
  out.push('');
  out.push('| Surface | Where | Label | Shared | Rule it read before 1A-2 |');
  out.push('|---|---|---|---|---|');
  for (const s of ACTIVE_COUNT_SITES) out.push(`| ${s.surface} | \`${s.file}:${s.line}\` | ${s.label} | ${s.shared ? '✓' : ''} | ${s.rule} |`);
  out.push('');
  out.push('Distinct rules in use:');
  out.push('');
  for (const d of DISTINCT_ACTIVE_RULES) out.push(`- ${d.rule} (${d.sites} site${d.sites === 1 ? '' : 's'})`);
  out.push('');
  return `${out.join('\n')}\n`;
}

export async function runReconciliation(
  db: Db,
  opts: { start: string; end: string; payrollCsv?: string | null; map?: PayrollColumnMap; now?: Date; windowDays?: number },
): Promise<{ result: ReconcileResult; platform: PlatformSide; csv: string; markdown: string }> {
  const platform = await platformSide(db, { start: opts.start, end: opts.end }, opts.now ?? new Date(), opts.windowDays);
  const payroll = opts.payrollCsv != null ? parsePayrollCsv(opts.payrollCsv, opts.map ?? PAYROLL_COLUMNS) : null;
  const result = reconcile(platform, payroll, 'email');
  return { result, platform, csv: reconcileCsv(result), markdown: reconcileMarkdown(result, platform) };
}

/** Keep the totals so the Headcount screen shows the variance beside today's numbers. */
export async function persistReconciliation(db: Db, r: ReconcileResult, platform: PlatformSide, now: Date = new Date()): Promise<string> {
  const row = await db.reconciliationSnapshot.create({
    data: {
      periodStart: new Date(`${r.period.start}T00:00:00.000Z`),
      periodEnd: new Date(`${r.period.end}T00:00:00.000Z`),
      ranAt: now,
      windowDays: platform.headcount.windowDays,
      platformActive: platform.headcount.activeByDefinition,
      platformPaid: platform.headcount.paidByPlatform,
      payrollPaid: r.payrollProvided ? r.totals.headcount.payrollPaid : null,
      platformHours: platform.totals.hours,
      payrollHours: r.payrollProvided ? r.totals.hours.payroll : null,
      platformGross: platform.totals.gross,
      payrollGross: r.payrollProvided ? r.totals.gross.payroll : null,
      varianceLines: r.payrollProvided ? r.variances.length : null,
      payrollProvided: r.payrollProvided,
      notes: r.missingColumns.length ? `Columns not found in the export: ${r.missingColumns.join(', ')}` : null,
    },
    select: { id: true },
  });
  return row.id;
}

export { defaultPrisma as reconcileDb };
