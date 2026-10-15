import { Prisma, type PrismaClient } from '@prisma/client';
import { splitWeeklyOvertime } from '../payroll.js';
import { platformJob } from '../tenantJobs.js';
import { companyWorkweek, startOfWeekForSite } from '../timeAnomalies.js';
import { evaluateTime, type WorkEntry } from './evaluate.js';
import { loadRulePool, rulesForSite } from './store.js';
import type { RuleSetDef } from './params.js';

/**
 * Brief 2-2 step 3 — the engine in shadow (report §6.4).
 *
 *   For a finalized payroll run, every paid associate's approved entries in
 *   the period go through today's split (splitWeeklyOvertime, what the run
 *   paid) and through the engine under the rules of each entry's SITE. A
 *   difference in hours or money is recorded with the engine's reasons;
 *   premiums (meal, rest, rest between shifts) are counted and shown, never
 *   paid. Pay is untouched: this module only reads entries and writes its
 *   own two tables. The dry-run script runs the same comparison without
 *   writing, for the owner to sign (the gate for step 4).
 */

type Db = PrismaClient;

export interface ShadowEntry {
  associateId: string;
  clockInAt: Date;
  clockOutAt: Date | null;
  breaks: Array<{ type: 'MEAL' | 'REST' | null; startedAt: Date; endedAt: Date | null }>;
  site: { id: string; state: string | null; city: string | null; timezone: string } | null;
}

export interface ShadowResult {
  associateId: string;
  hourlyRate: number;
  paid: { regularHours: number; overtimeHours: number };
  engine: { regularHours: number; overtimeHours: number; doubleTimeHours: number; overtimeMultiplier: number; doubleMultiplier: number };
  amountDifference: number;
  penaltyHours: number;
  reasons: string[];
  fingerprints: string[];
  differs: boolean;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** One associate's comparison. Pure, given the rule pool. */
export function shadowAssociate(pool: readonly RuleSetDef[], associateId: string, entries: readonly ShadowEntry[], hourlyRate: number): ShadowResult {
  const closed = entries.filter((e): e is ShadowEntry & { clockOutAt: Date } => !!e.clockOutAt);
  const paid = splitWeeklyOvertime(closed.map((e) => ({ status: 'APPROVED', clockInAt: e.clockInAt, clockOutAt: e.clockOutAt, breaks: e.breaks, location: e.site ? { timezone: e.site.timezone } : null })));
  const fallbackTz = companyWorkweek().timezone;
  const siteOf = new Map<WorkEntry, ShadowEntry['site']>();
  const work: WorkEntry[] = closed.map((e) => {
    const w: WorkEntry = { clockInAt: e.clockInAt, clockOutAt: e.clockOutAt, breaks: e.breaks, timezone: e.site?.timezone ?? fallbackTz };
    siteOf.set(w, e.site);
    return w;
  });
  const out = evaluateTime(work, {
    // An entry with no site resolves under federal law only, and its reasons say which set that was.
    rulesFor: (w, date) => rulesForSite(pool, siteOf.get(w) ?? { id: 'none', state: null, city: null }, date),
    weekStart: (d, tz) => startOfWeekForSite(d, tz),
  });
  const paidAmount = paid.regularHours * hourlyRate + paid.overtimeHours * hourlyRate * 1.5;
  const engineAmount = out.regularHours * hourlyRate + out.overtimeHours * hourlyRate * out.overtimeMultiplier + out.doubleTimeHours * hourlyRate * out.doubleMultiplier;
  const amountDifference = round2(engineAmount - paidAmount);
  const penaltyHours = round2(out.penalties.reduce((a, p) => a + p.hours, 0));
  const differs = out.regularHours !== paid.regularHours || out.overtimeHours !== paid.overtimeHours || out.doubleTimeHours !== 0 || amountDifference !== 0 || penaltyHours !== 0;
  return {
    associateId,
    hourlyRate,
    paid,
    engine: { regularHours: out.regularHours, overtimeHours: out.overtimeHours, doubleTimeHours: out.doubleTimeHours, overtimeMultiplier: out.overtimeMultiplier, doubleMultiplier: out.doubleMultiplier },
    amountDifference,
    penaltyHours,
    reasons: [...out.weeks.flatMap((w) => w.reasons), ...out.penalties.map((p) => `${p.reason} (shown, not paid)`)],
    fingerprints: out.fingerprints,
    differs,
  };
}

/** Every paid associate of a run, compared. Reads only. */
export async function shadowPayrollRun(db: Db, runId: string): Promise<{ run: { id: string; tenantId: string; periodStart: Date; periodEnd: Date }; results: ShadowResult[] }> {
  const run = await db.payrollRun.findUniqueOrThrow({ where: { id: runId }, select: { id: true, tenantId: true, clientId: true, periodStart: true, periodEnd: true } });
  const tenantId = run.tenantId ?? '00000000-0000-4000-8000-000000000001';
  const items = await db.payrollItem.findMany({ where: { payrollRunId: run.id }, select: { associateId: true, hourlyRate: true } });
  const pool = await loadRulePool(db, tenantId);
  const periodEndExclusive = new Date(run.periodEnd.getTime() + 86_400_000);
  const entries = items.length
    ? await db.timeEntry.findMany({
        where: { status: 'APPROVED', associateId: { in: items.map((i) => i.associateId) }, clockInAt: { gte: run.periodStart, lt: periodEndExclusive }, ...(run.clientId ? { clientId: run.clientId } : {}) },
        select: { associateId: true, clockInAt: true, clockOutAt: true, breaks: { select: { type: true, startedAt: true, endedAt: true } }, location: { select: { id: true, state: true, city: true, timezone: true } } },
      })
    : [];
  const byAssociate = new Map<string, ShadowEntry[]>();
  for (const e of entries) {
    const list = byAssociate.get(e.associateId) ?? [];
    list.push({ associateId: e.associateId, clockInAt: e.clockInAt, clockOutAt: e.clockOutAt, breaks: e.breaks, site: e.location });
    byAssociate.set(e.associateId, list);
  }
  const results = items.map((i) => shadowAssociate(pool, i.associateId, byAssociate.get(i.associateId) ?? [], Number(i.hourlyRate)));
  return { run: { id: run.id, tenantId, periodStart: run.periodStart, periodEnd: run.periodEnd }, results };
}

/** Shadow a run once and record it. Returns null if it was already shadowed. */
export async function recordShadowRun(db: Db, runId: string): Promise<{ id: string; differences: number } | null> {
  if (await db.laborShadowRun.findUnique({ where: { payrollRunId: runId }, select: { id: true } })) return null;
  const { run, results } = await shadowPayrollRun(db, runId);
  const diffs = results.filter((r) => r.differs);
  const dec = (n: number) => new Prisma.Decimal(round2(n));
  try {
    const row = await db.laborShadowRun.create({
      data: {
        tenantId: run.tenantId,
        payrollRunId: run.id,
        periodStart: run.periodStart,
        periodEnd: run.periodEnd,
        associates: results.length,
        differences: diffs.length,
        amountDifference: dec(diffs.reduce((a, r) => a + r.amountDifference, 0)),
        penaltyHours: dec(results.reduce((a, r) => a + r.penaltyHours, 0)),
        diffs: {
          create: diffs.map((r) => ({
            tenantId: run.tenantId,
            associateId: r.associateId,
            paidRegular: dec(r.paid.regularHours),
            paidOvertime: dec(r.paid.overtimeHours),
            engineRegular: dec(r.engine.regularHours),
            engineOvertime: dec(r.engine.overtimeHours),
            engineDouble: dec(r.engine.doubleTimeHours),
            hourlyRate: dec(r.hourlyRate),
            amountDifference: dec(r.amountDifference),
            penaltyHours: dec(r.penaltyHours),
            reasons: r.reasons,
            fingerprints: r.fingerprints,
          })),
        },
      },
      select: { id: true, differences: true },
    });
    return row;
  } catch (err) {
    // Two replicas shadowing the same run: the unique payrollRunId keeps one.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return null;
    throw err;
  }
}

/** The sweep: every finalized or disbursed run of the last 120 days not yet shadowed. */
export async function runLaborShadowSweep(db: Db, now: Date = new Date()): Promise<number> {
  const runs = await db.payrollRun.findMany({
    where: { status: { in: ['FINALIZED', 'DISBURSED'] }, periodEnd: { gte: new Date(now.getTime() - 120 * 86_400_000) }, laborShadowRun: null },
    select: { id: true },
    orderBy: { periodEnd: 'asc' },
    take: 25,
  });
  let done = 0;
  for (const r of runs) if (await recordShadowRun(db, r.id)) done += 1;
  return done;
}

let timer: NodeJS.Timeout | null = null;
const SWEEP_MS = 60 * 60 * 1000;

export function startLaborShadowCron(db: Db): void {
  if (timer) return;
  // Platform-wide: every tenant's finalized runs, each recorded under its own tenant.
  const tick = () => void platformJob('laborShadow', () => runLaborShadowSweep(db))().catch((err) => console.error('[alto-people/api] labor shadow sweep failed:', err));
  tick();
  timer = setInterval(tick, SWEEP_MS);
  timer.unref();
  console.log('[alto-people/api] labor rules shadow armed (hourly; finalized runs of the last 120 days)');
}

export function stopLaborShadowCron(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
