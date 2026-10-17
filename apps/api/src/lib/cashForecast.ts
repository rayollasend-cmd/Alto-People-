import { prisma } from '../db.js';
import { DEFAULT_TIMEZONE, localDateKey } from './timezone.js';
import { round2 } from './payroll.js';
import { getNextPayday, getPeriodAfter, type PeriodWindow } from './payrollSchedule.js';
import { depositDueDate } from './taxDeposits.js';
import { aggregatePayrollProjection } from './payrollAggregator.js';

/**
 * The cash forecast: what leaves and what arrives over the next weeks,
 * from the records that already know —
 *
 *   payroll          the next two paydays: the run that exists for the
 *                    period (its net), else a projection of the open
 *                    period, else the last run paid
 *   tax deposits     pending FED_941 / FUTA rows by due date, plus the
 *                    deposit each forecast payday will create
 *   garnishments     pending remittances, assumed a week after payday
 *   receivables      unpaid FINAL statements on their due date (terms),
 *                    overdue ones expected within the week
 *
 * There is no bank balance here — the product does not hold one — so the
 * answer is the net movement per week and its running total.
 */

export type CashLineKind = 'PAYROLL' | 'TAX_DEPOSIT' | 'GARNISHMENT' | 'RECEIVABLE';

export interface CashLine {
  date: string;
  kind: CashLineKind;
  label: string;
  /** Signed: money in positive, money out negative. */
  amount: number;
  /** scheduled = a record with a date and an amount; estimated = our projection; overdue = past due, expected soon. */
  confidence: 'scheduled' | 'estimated' | 'overdue';
  linkUrl: string;
}

export interface CashWeek {
  weekStart: string;
  weekEnd: string;
  inflow: number;
  outflow: number;
  net: number;
  cumulative: number;
}

export interface CashForecast {
  generatedAt: string;
  from: string;
  to: string;
  weeks: CashWeek[];
  lines: CashLine[];
  totals: { inflow: number; outflow: number; net: number };
}

const DAY_MS = 86_400_000;
const addDays = (ymd: string, n: number) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const ymdOf = (d: Date) => d.toISOString().slice(0, 10);

export async function cashForecast(now: Date = new Date(), opts: { tenantId?: string; weeks?: number } = {}): Promise<CashForecast> {
  const T = opts.tenantId ? { tenantId: opts.tenantId } : {};
  const horizonWeeks = opts.weeks ?? 4;
  const today = localDateKey(now, DEFAULT_TIMEZONE);
  const end = addDays(today, horizonWeeks * 7);
  const lines: CashLine[] = [];
  const inHorizon = (ymd: string) => ymd >= today && ymd < end;

  // ---- Payroll: the next two paydays ------------------------------------
  const select = { id: true, name: true, frequency: true, anchorDate: true, payDateOffsetDays: true } as const;
  const live = { isActive: true, deletedAt: null, ...T };
  const schedule =
    (await prisma.payrollSchedule.findFirst({ where: { ...live, clientId: null }, orderBy: { createdAt: 'asc' }, select })) ??
    (await prisma.payrollSchedule.findFirst({ where: live, orderBy: { createdAt: 'asc' }, select }));
  const [lastRun, profile] = await Promise.all([
    prisma.payrollRun.findFirst({ where: { ...T, status: 'DISBURSED', kind: 'REGULAR' }, orderBy: { disbursedAt: 'desc' }, select: { totalNet: true, totalTax: true, totalGross: true, items: { select: { employerFica: true, employerMedicare: true, fica: true, medicare: true, federalWithholding: true }, take: 10_000 } } }),
    prisma.submitterProfile.findUnique({ where: { id: 'singleton' }, select: { depositSchedule: true } }),
  ]);
  const depositSchedule = profile?.depositSchedule ?? 'MONTHLY';
  // The federal deposit a payday creates, as a share of net, from the last run paid.
  let depositPerNet = 0;
  if (lastRun && Number(lastRun.totalNet) > 0) {
    const fed = lastRun.items.reduce(
      (s, i) => s + Number(i.federalWithholding) + Number(i.fica) + Number(i.medicare) + Number(i.employerFica) + Number(i.employerMedicare),
      0,
    );
    depositPerNet = fed / Number(lastRun.totalNet);
  }

  if (schedule) {
    let w: PeriodWindow = getNextPayday(schedule, new Date(`${today}T12:00:00Z`));
    if (w.payDate < today) w = getPeriodAfter(schedule, w);
    const windows = [w, getPeriodAfter(schedule, w)];
    for (const [i, win] of windows.entries()) {
      if (!inHorizon(win.payDate)) continue;
      const run = await prisma.payrollRun.findFirst({
        where: {
          ...T,
          kind: 'REGULAR',
          status: { in: ['DRAFT', 'FINALIZED', 'DISBURSED'] },
          periodStart: { lte: new Date(`${win.periodEnd}T00:00:00Z`) },
          periodEnd: { gte: new Date(`${win.periodStart}T00:00:00Z`) },
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true, status: true, totalNet: true, totalTax: true, items: { select: { fica: true, medicare: true, federalWithholding: true, employerFica: true, employerMedicare: true }, take: 10_000 } },
      });
      if (run?.status === 'DISBURSED') continue; // already out the door
      let net: number;
      let confidence: CashLine['confidence'];
      let fed: number | null = null;
      if (run) {
        net = Number(run.totalNet);
        fed = run.items.reduce((s, x) => s + Number(x.federalWithholding) + Number(x.fica) + Number(x.medicare) + Number(x.employerFica) + Number(x.employerMedicare), 0);
        confidence = run.status === 'FINALIZED' ? 'scheduled' : 'estimated';
      } else if (i === 0) {
        // The open period: project it from approved hours so far.
        const ps = new Date(`${win.periodStart}T00:00:00Z`);
        const pe = new Date(`${win.periodEnd}T00:00:00Z`);
        pe.setUTCDate(pe.getUTCDate() + 1);
        try {
          const proj = await aggregatePayrollProjection(prisma, { periodStart: ps, periodEndExclusive: pe, clientId: null, defaultRate: 15 });
          net = proj.totals.totalNet;
          fed = proj.items.reduce((s, x) => s + x.federalIncomeTax + x.fica + x.medicare + x.employerFica + x.employerMedicare, 0);
          // A period that is barely begun projects low; the last run is the better guess until it is half over.
          const daysIn = Math.max(0, (Date.parse(`${today}T00:00:00Z`) - ps.getTime()) / DAY_MS);
          const days = Math.max(1, (pe.getTime() - ps.getTime()) / DAY_MS);
          if (lastRun && daysIn / days < 0.5 && net < Number(lastRun.totalNet) * 0.5) {
            net = Number(lastRun.totalNet);
            fed = null;
          }
        } catch {
          net = lastRun ? Number(lastRun.totalNet) : 0;
        }
        confidence = 'estimated';
      } else {
        net = lastRun ? Number(lastRun.totalNet) : 0;
        confidence = 'estimated';
      }
      if (net <= 0) continue;
      lines.push({
        date: win.payDate,
        kind: 'PAYROLL',
        label: `Payroll ${win.periodStart} – ${win.periodEnd}${run ? ` (${run.status.toLowerCase()})` : ' (projected)'}`,
        amount: -round2(net),
        confidence,
        linkUrl: run ? `/payroll?run=${run.id}` : '/payroll',
      });
      const deposit = round2(fed ?? net * depositPerNet);
      if (deposit > 0) {
        const payday = new Date(`${win.payDate}T12:00:00Z`);
        const { dueDate } = depositDueDate(payday, depositSchedule, deposit);
        const due = ymdOf(dueDate);
        if (inHorizon(due)) {
          lines.push({
            date: due,
            kind: 'TAX_DEPOSIT',
            label: `Federal deposit for the ${win.payDate} payday`,
            amount: -deposit,
            confidence: 'estimated',
            linkUrl: '/payroll/tax',
          });
        }
      }
    }
  }

  // ---- Tax deposits already on the ledger --------------------------------
  const deposits = await prisma.taxDeposit.findMany({
    where: { ...T, status: 'PENDING', dueDate: { lt: new Date(`${end}T00:00:00Z`) } },
    select: { id: true, kind: true, periodLabel: true, dueDate: true, amount: true },
  });
  for (const d of deposits) {
    const due = ymdOf(d.dueDate);
    const overdue = due < today;
    lines.push({
      date: overdue ? today : due,
      kind: 'TAX_DEPOSIT',
      label: `${d.kind === 'FUTA' ? 'FUTA' : 'Federal 941'} deposit — ${d.periodLabel}${overdue ? ' (past due)' : ''}`,
      amount: -round2(Number(d.amount)),
      confidence: overdue ? 'overdue' : 'scheduled',
      linkUrl: '/payroll/tax',
    });
  }

  // ---- Garnishment remittances -------------------------------------------
  const remittances = await prisma.garnishmentRemittance.findMany({
    where: { ...T, status: 'PENDING' },
    select: { id: true, payeeName: true, amount: true, payrollRun: { select: { disbursedAt: true } } },
  });
  for (const r of remittances) {
    const base = r.payrollRun.disbursedAt ? ymdOf(r.payrollRun.disbursedAt) : today;
    const due = addDays(base, 7);
    const date = due < today ? today : due;
    if (!inHorizon(date)) continue;
    lines.push({
      date,
      kind: 'GARNISHMENT',
      label: `Remit to ${r.payeeName}`,
      amount: -round2(Number(r.amount)),
      confidence: due < today ? 'overdue' : 'scheduled',
      linkUrl: '/payroll/tax',
    });
  }

  // ---- Receivables -------------------------------------------------------
  const [unpaid, paidRecent] = await Promise.all([
    prisma.clientStatement.findMany({
      where: { ...T, status: 'FINAL', paidAt: null },
      select: { id: true, number: true, clientId: true, finalizedAt: true, dueAt: true, snapshot: true, client: { select: { name: true, paymentTermsDays: true } } },
    }),
    prisma.clientStatement.findMany({
      where: { ...T, status: 'FINAL', paidAt: { not: null, gte: new Date(now.getTime() - 120 * DAY_MS) } },
      select: { finalizedAt: true, paidAt: true },
    }),
  ]);
  const lags = paidRecent.filter((s) => s.finalizedAt && s.paidAt).map((s) => (s.paidAt!.getTime() - s.finalizedAt!.getTime()) / DAY_MS);
  const avgDays = lags.length ? Math.round(lags.reduce((a, b) => a + b, 0) / lags.length) : null;
  for (const s of unpaid) {
    const snap = s.snapshot as { totals?: { amount?: number } } | null;
    const amount = typeof snap?.totals?.amount === 'number' ? snap.totals.amount : 0;
    if (amount <= 0) continue;
    const expected = s.dueAt
      ? ymdOf(s.dueAt)
      : s.finalizedAt
        ? addDays(ymdOf(s.finalizedAt), avgDays ?? s.client.paymentTermsDays)
        : today;
    const overdue = expected < today;
    const date = overdue ? addDays(today, 6) : expected;
    if (!inHorizon(date)) continue;
    lines.push({
      date,
      kind: 'RECEIVABLE',
      label: `${s.client.name} — statement ${s.number !== null ? `No. ${String(s.number).padStart(4, '0')}` : 'draft'}${overdue ? ' (past due)' : ''}`,
      amount: round2(amount),
      confidence: overdue ? 'overdue' : s.dueAt ? 'scheduled' : 'estimated',
      linkUrl: `/clients/statements?statement=${s.id}`,
    });
  }

  lines.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));

  const weeks: CashWeek[] = [];
  let cumulative = 0;
  for (let i = 0; i < horizonWeeks; i++) {
    const ws = addDays(today, i * 7);
    const we = addDays(ws, 6);
    const mine = lines.filter((l) => l.date >= ws && l.date <= we);
    const inflow = round2(mine.filter((l) => l.amount > 0).reduce((s, l) => s + l.amount, 0));
    const outflow = round2(mine.filter((l) => l.amount < 0).reduce((s, l) => s - l.amount, 0));
    const net = round2(inflow - outflow);
    cumulative = round2(cumulative + net);
    weeks.push({ weekStart: ws, weekEnd: we, inflow, outflow, net, cumulative });
  }
  const inflow = round2(lines.filter((l) => l.amount > 0).reduce((s, l) => s + l.amount, 0));
  const outflow = round2(lines.filter((l) => l.amount < 0).reduce((s, l) => s - l.amount, 0));
  return { generatedAt: now.toISOString(), from: today, to: addDays(end, -1), weeks, lines, totals: { inflow, outflow, net: round2(inflow - outflow) } };
}
