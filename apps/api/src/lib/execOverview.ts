import type { Prisma, PrismaClient } from '@prisma/client';
import { METRICS, marginPctOf, type ExecBasis, type ExecChange, type ExecKpi, type ExecKpiId, type ExecOverview, type ExecRisk, type ExecStatus, type ExecTrendPoint, type ExecUnit } from '@alto-people/shared';
import { judge, prorateTarget } from './execPeriods.js';
import { companyWorkweek } from './timeAnomalies.js';
import { cashForecast, type CashForecast } from './cashForecast.js';
import { peopleStandings, turnoverBetween, onTheBooksAt, type Standings } from './peopleStatus.js';
import { fmtDay, fmtDayRange } from './humanDates.js';
import { localDateKey } from './timezone.js';
import { DAY_MS, activeCountsAt, arAsOf, bankBalances, dsoAsOf, execMoney, fillCounts, lastDayKey, plural, weeklyFill, wholeHours, type LaborTotals } from './execFinance.js';
import { laborFor, planAtEnd, planField, weeklyLabor, type ExecContext } from './execFinanceContext.js';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * The chairman's first screen (GET /executive/overview, 2026-10-27): eight
 * measures, each with its comparison, plan, status, 13-week trend,
 * definition, basis and drill-down; the three to five things that changed
 * most; and the footnotes the page prints once.
 *
 * Every figure is the one the rest of the product shows: revenue and margin
 * are the executive summary's arithmetic (the punches split as pay splits
 * them, priced at the standard rates), headcount is the one definition of
 * active, turnover is lib/peopleStatus's formula, fill is the targets card's
 * rule, receivables age by lib/books/aging, cash is the books.
 */

/* ------------------------------------------------------------- the eight */

// Labels and definitions come from the metric dictionary
// (packages/shared/src/metrics.ts): the name a card prints and the sentence
// its tooltip and the board pack's appendix print are the dictionary's, so
// "Gross margin %" or "Days to collect" can never mean one thing here and
// another on Analytics or in Books.

interface KpiSpec {
  id: ExecKpiId;
  label: string;
  /** How the measure is named at the start of a sentence. */
  sentence: string;
  unit: ExecUnit;
  betterWhen: 'up' | 'down';
  basis: ExecBasis;
  definition: string;
  href: string;
}

export const KPI_SPECS: Record<'revenue' | 'grossMargin' | 'marginPct' | 'workforce' | 'fillRate' | 'turnover' | 'overtimePct' | 'dso' | 'cash', KpiSpec> = {
  revenue: {
    id: 'revenue',
    label: METRICS.revenue.label,
    sentence: 'Revenue',
    unit: 'money',
    betterWhen: 'up',
    basis: 'estimate',
    definition: METRICS.revenue.definition,
    href: '/executive/financials',
  },
  grossMargin: {
    id: 'grossMargin',
    label: METRICS.grossMargin.label,
    sentence: 'Gross margin',
    unit: 'money',
    betterWhen: 'up',
    basis: 'estimate',
    definition: METRICS.grossMargin.definition,
    href: '/executive/financials',
  },
  marginPct: {
    id: 'marginPct',
    // The rate beside the dollars (grossMargin) — two cards on Financials, two names.
    label: METRICS.grossMarginPct.label,
    sentence: 'Gross margin',
    unit: 'pct',
    betterWhen: 'up',
    basis: 'estimate',
    definition: METRICS.grossMarginPct.definition,
    href: '/executive/financials',
  },
  workforce: {
    id: 'workforce',
    // "Working", as the People directory and Analytics name the same people —
    // not "active", which other pages have used for "placed".
    label: METRICS.working.label,
    sentence: 'The number working',
    unit: 'count',
    betterWhen: 'up',
    basis: 'live',
    definition: `${METRICS.working.definition} Counted at the end of the period.`,
    href: '/executive/people',
  },
  fillRate: {
    id: 'fillRate',
    label: METRICS.fillRate.label,
    sentence: 'Fill rate',
    unit: 'pct',
    betterWhen: 'up',
    basis: 'live',
    definition: METRICS.fillRate.definition,
    href: '/executive/clients',
  },
  turnover: {
    id: 'turnover',
    label: METRICS.turnover.label,
    sentence: 'Annualized turnover',
    unit: 'pct',
    betterWhen: 'down',
    basis: 'live',
    definition: `${METRICS.turnover.definition} The trend line reads each week’s trailing four weeks.`,
    href: '/executive/people',
  },
  overtimePct: {
    id: 'overtimePct',
    label: METRICS.overtimeShare.label,
    sentence: 'Overtime',
    unit: 'pct',
    betterWhen: 'down',
    basis: 'live',
    definition: METRICS.overtimeShare.definition,
    href: '/executive/people',
  },
  dso: {
    id: 'dso',
    label: METRICS.daysToCollect.label,
    sentence: 'Days to collect',
    unit: 'days',
    betterWhen: 'down',
    basis: 'statements',
    definition: METRICS.daysToCollect.definition,
    href: '/executive/financials',
  },
  cash: {
    id: 'cash',
    label: 'Cash',
    sentence: 'Cash',
    unit: 'money',
    betterWhen: 'up',
    basis: 'books',
    definition: 'Bank balances in the company books at the end of the period’s last day.',
    href: '/executive/financials',
  },
};

/** Value, comparison, delta, plan and status — one measure, assembled. */
export function buildKpi(
  spec: KpiSpec,
  o: {
    value: number | null;
    compare: number | null;
    target: number | null;
    targetLabel: string | null;
    sub: string | null;
    trend: ExecTrendPoint[];
    thresholds?: { good: number; watch: number };
    status?: { status: ExecStatus; label: string };
  },
): ExecKpi {
  // Cents for money, hundredths for the rest: no float dust reaches a delta.
  const places = spec.unit === 'count' ? 0 : 2;
  const round = (v: number | null) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 10 ** places) / 10 ** places);
  const value = round(o.value);
  const compare = round(o.compare);
  const target = round(o.target);
  const delta = value !== null && compare !== null ? round(value - compare) : null;
  const deltaPct = delta !== null && compare !== null && compare !== 0 ? Math.round((delta / Math.abs(compare)) * 1e6) / 1e6 : null;
  const judged = o.status ?? judge(value, spec.betterWhen, target !== null ? { target } : (o.thresholds ?? {}));
  return {
    id: spec.id,
    label: spec.label,
    unit: spec.unit,
    value,
    sub: o.sub,
    compare,
    delta,
    deltaPct,
    betterWhen: spec.betterWhen,
    target,
    targetLabel: o.targetLabel,
    status: judged.status,
    statusLabel: judged.label,
    trend: o.trend.map((p) => ({ start: p.start, value: round(p.value) })),
    basis: spec.basis,
    definition: spec.definition,
    href: spec.href,
  };
}

/* ------------------------------------------------------------ the words */

/** "Eastern time" — the company zone as a person says it. */
export function zoneWords(tz: string): string {
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longGeneric' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value;
    if (name) return name.replace(/\s+Time$/i, '') + ' time';
  } catch {
    // fall through
  }
  return `${tz.split('/').pop()!.replace(/_/g, ' ')} time`;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "Weeks run Saturday to Friday, Eastern time." */
export function workweekNote(): string {
  const { weekStartsOn, timezone } = companyWorkweek();
  return `Weeks run ${DAYS[weekStartsOn % 7]} to ${DAYS[(weekStartsOn + 6) % 7]}, ${zoneWords(timezone)}.`;
}

/** "Revenue and margin are estimates at standard rates: …" */
export function ratesNote(r: ExecContext['rates']): string {
  const parts = [`$${r.billRate.toFixed(2)} an hour billed`, `$${r.payRate.toFixed(2)} an hour paid`, `${r.burdenPct}% employer burden`];
  if (r.overheadPerHour > 0) parts.push(`$${r.overheadPerHour.toFixed(2)} an hour of overhead`);
  return `Revenue and margin are estimates at standard rates: ${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}, overtime at the pay multipliers. Finalized client statements are the invoice-grade record.`;
}

/** How a sentence names the comparison: "on the week of Oct 10", "on the same days of Q3", "on the same span of 2025". */
export function vsWords(ctx: ExecContext): string {
  const c = ctx.w.comparison;
  if (c.key === 'plan') return 'against plan';
  if (!c.start) return '';
  if (c.key === 'year') return `on the same span of ${c.start.slice(0, 4)}`;
  if (ctx.w.period.key === 'week') return `on the week of ${fmtDay(c.start)}`;
  if (ctx.w.period.key === 'month') return `on the same days of ${MONTHS[Number(c.start.slice(5, 7)) - 1]}`;
  if (ctx.w.period.key === 'quarter') return `on the same days of Q${Math.floor((Number(c.start.slice(5, 7)) - 1) / 3) + 1}`;
  return `on the same days of ${c.start.slice(0, 4)}`;
}

/** A value as a sentence writes it. */
export function valueWords(v: number | null, unit: ExecUnit): string {
  if (v === null) return '—';
  if (unit === 'money') return execMoney(v);
  if (unit === 'pct') return `${v.toFixed(1)}%`;
  if (unit === 'days') return plural(Math.round(v), 'day');
  return Math.round(v).toLocaleString('en-US');
}

/** The size of a gap: "4.2%", "1.1 points", "2", "6 days", "$12.3k (6.4%)". */
function gapWords(k: ExecKpi, withMoney: boolean): string {
  const d = Math.abs(k.delta ?? 0);
  if (k.unit === 'pct') return plural(Number(d.toFixed(1)), 'point');
  if (k.unit === 'days') return plural(Math.round(d), 'day');
  if (k.unit === 'count') return Math.round(d).toLocaleString('en-US');
  const rel = k.deltaPct !== null ? `${Math.abs(k.deltaPct * 100).toFixed(1)}%` : null;
  if (withMoney) return rel ? `${execMoney(d)} (${rel})` : execMoney(d);
  return rel ?? execMoney(d);
}

const toneOf = (k: ExecKpi): ExecChange['tone'] => (k.delta === null || k.delta === 0 ? 'neutral' : k.delta > 0 === (k.betterWhen === 'up') ? 'good' : 'bad');

/** One measure's move, as a sentence. */
export function changeSentence(k: ExecKpi, ctx: ExecContext, name: string): string {
  const v = valueWords(k.value, k.unit);
  if (ctx.w.comparison.key === 'plan') {
    const better = toneOf(k) === 'good';
    const words = k.betterWhen === 'up' ? (better ? 'ahead of' : 'short of') : better ? 'under' : 'over';
    return `${name} is ${v}, ${gapWords(k, true)} ${words} plan.`;
  }
  const up = (k.delta ?? 0) > 0;
  // From nothing, or more than doubled: the two figures say it better than a percentage.
  if (k.compare !== null && k.unit !== 'pct' && (k.compare === 0 || Math.abs(k.deltaPct ?? 0) >= 1)) {
    return `${name} ${up ? 'rose' : 'fell'} to ${v} from ${valueWords(k.compare, k.unit)} ${vsWords(ctx)}.`;
  }
  return `${name} ${up ? 'rose' : 'fell'} to ${v}, ${up ? 'up' : 'down'} ${gapWords(k, false)} ${vsWords(ctx)}.`;
}

/** Whether a move is big enough to tell the board. */
function material(k: ExecKpi): boolean {
  if (k.delta === null || k.delta === 0) return false;
  if (k.unit === 'pct') return Math.abs(k.delta) >= 0.5;
  if (k.unit === 'days') return Math.abs(k.delta) >= 1 && (k.deltaPct === null || Math.abs(k.deltaPct) >= 0.03);
  return k.deltaPct === null ? Math.abs(k.delta) >= 1 : Math.abs(k.deltaPct) >= 0.02;
}

/**
 * How much a move matters to a board: money, counts and days by their
 * relative change; a rate by its points against what a big move in it is
 * (five points of margin, ten of fill or overtime, fifty of annualized
 * turnover). Revenue and margin weigh half again.
 */
const POINT_SCALE: Partial<Record<ExecKpiId, number>> = { marginPct: 5, fillRate: 10, overtimePct: 10, turnover: 50 };
const WEIGHT: Partial<Record<ExecKpiId, number>> = { revenue: 1.5, marginPct: 1.5, grossMargin: 1.5 };
function significance(k: ExecKpi): number {
  const base = k.unit === 'pct' ? Math.abs(k.delta ?? 0) / (POINT_SCALE[k.id] ?? 10) : Math.abs(k.deltaPct ?? (k.compare === 0 ? 1 : 0));
  return base * (WEIGHT[k.id] ?? 1);
}

/**
 * Three to five sentences, most significant first: measures off plan, the
 * largest moves on material measures, the top high-severity risk; facts
 * fill in when the comparison has little to say.
 */
export function rankChanges(scorecard: ExecKpi[], ctx: ExecContext, risk: ExecRisk | null, cashFact: string | null = null): ExecChange[] {
  const names = new Map(Object.values(KPI_SPECS).map((s) => [s.id, s.sentence]));
  const scored: Array<{ score: number; change: ExecChange; kpi?: ExecKpiId }> = [];
  const planMode = ctx.w.comparison.key === 'plan';
  for (const k of scorecard) {
    const name = names.get(k.id) ?? k.label;
    if (ctx.w.comparison.available && material(k) && k.compare !== null) {
      const rel = significance(k);
      const offPlan = planMode && k.status === 'bad';
      scored.push({ score: (offPlan ? 10 : 0) + rel, kpi: k.id, change: { id: `move:${k.id}`, tone: toneOf(k), text: changeSentence(k, ctx, name), href: k.href } });
    } else if (!planMode && k.target !== null && k.status === 'bad' && k.value !== null) {
      scored.push({
        score: 10 + Math.abs((k.value - k.target) / (k.target || 1)),
        kpi: k.id,
        change: { id: `plan:${k.id}`, tone: 'bad', text: `${name} is ${valueWords(k.value, k.unit)} against a plan of ${valueWords(k.target, k.unit)}.`, href: k.href },
      });
    }
  }
  if (risk) scored.push({ score: 0.15, change: { id: `risk:${risk.id}`, tone: 'bad', text: `${risk.title.replace(/\.$/, '')}${risk.metric ? ` (${risk.metric})` : ''}.`, href: risk.href } });
  scored.sort((a, b) => b.score - a.score);
  const out = scored.slice(0, 5);

  if (out.length < 3) {
    const said = new Set(out.map((o) => o.kpi).filter(Boolean));
    const by = new Map(scorecard.map((k) => [k.id, k]));
    const fact = (id: ExecKpiId, write: (k: ExecKpi) => string): { id: ExecKpiId; text: string | null } => {
      const k = by.get(id);
      return { id, text: k && k.value !== null ? write(k) : null };
    };
    const facts = [
      fact('revenue', (k) => `Revenue for ${ctx.w.period.label.replace(/^Week/, 'the week')} is ${execMoney(k.value)}${k.sub ? ` on ${k.sub}` : ''}.`),
      fact('workforce', (k) => `${valueWords(k.value, 'count')} ${k.value === 1 ? 'person is' : 'people are'} working${k.sub ? `, ${k.sub}` : ''}.`),
      fact('cash', (k) => cashFact ?? `Cash stands at ${execMoney(k.value)}.`),
      fact('marginPct', (k) => `Gross margin is ${valueWords(k.value, 'pct')}${k.sub ? `, ${k.sub}` : ''}.`),
    ];
    for (const f of facts) {
      if (out.length >= 3) break;
      if (!f.text || said.has(f.id)) continue;
      out.push({ score: 0, kpi: f.id, change: { id: `fact:${f.id}`, tone: 'neutral', text: f.text, href: by.get(f.id)?.href ?? null } });
    }
  }
  return out.map((o) => o.change);
}

/* --------------------------------------------------------------- compute */

export interface OverviewExtras {
  /** The reading the scorecard came from, for the board pack's other pages. */
  standings: Standings;
  forecast: CashForecast | null;
  weekly: LaborTotals[];
  current: LaborTotals;
  compared: LaborTotals | null;
  fill: { published: number; assigned: number };
  openAr: number;
}

const ymd = (d: Date, tz: string) => localDateKey(d, tz);

/** The 13-week cash forecast the cash measure judges by (the slowest read: a caller may start it beside the context). */
export const execCashForecast = (now: Date, tenantId: string): Promise<CashForecast | null> => cashForecast(now, { tenantId, weeks: 13 }).catch(() => null);

export async function computeExecOverview(
  db: Db,
  ctx: ExecContext,
  opts: { risk?: ExecRisk | null; forecast?: Promise<CashForecast | null> } = {},
): Promise<{ overview: ExecOverview; extras: OverviewExtras }> {
  const { w, tz, now, tenantId } = ctx;
  const hasCompare = !!(w.compareFrom && w.compareTo);
  const weekEnds = ctx.weekStarts.map((_, i) => ctx.weekStarts[i + 1] ?? ctx.weeksEnd);
  const periodEnd = new Date(Math.min(w.to.getTime(), now.getTime()));
  const instants = [periodEnd, ...weekEnds, ...(hasCompare ? [w.compareTo!] : [])];
  const cashDays = instants.map((d) => lastDayKey(d, tz));

  const [standings, active, fill, fillCompare, fillWeeks, bank, forecast] = await Promise.all([
    peopleStandings({ tenantId }, now, db),
    activeCountsAt(db, tenantId, instants),
    fillCounts(db, tenantId, w.from, w.to),
    hasCompare ? fillCounts(db, tenantId, w.compareFrom!, w.compareTo!) : Promise.resolve(null),
    weeklyFill(db, tenantId, [...ctx.weekStarts, ctx.weeksEnd]),
    bankBalances(db, tenantId, cashDays),
    opts.forecast ?? execCashForecast(now, tenantId),
  ]);

  const current = laborFor(ctx, w.from, w.to);
  const compared = hasCompare ? laborFor(ctx, w.compareFrom!, w.compareTo!) : null;
  const weekly = weeklyLabor(ctx);

  // A prior/year window with nothing in it at all: no comparison, said why.
  const comparison = { ...w.comparison };
  if (hasCompare && compared && compared.hours === 0 && (fillCompare?.published ?? 0) === 0) {
    comparison.available = false;
    comparison.reason = `There is no recorded work for ${fmtDayRange(comparison.start, comparison.end)} to compare against.`;
  }
  const planMode = comparison.key === 'plan';
  const cmp = <T>(v: T | null): T | null => (comparison.available && !planMode ? v : null);
  const trendOf = (values: Array<number | null>): ExecTrendPoint[] => ctx.weekStarts.map((s, i) => ({ start: ymd(s, tz), value: values[i] ?? null }));
  const pct = (a: number, b: number) => (b > 0 ? (a / b) * 100 : null);

  // ---- revenue
  const revTarget = prorateTarget(planField(ctx, 'revenue'), w.from, w.to, tz);
  const marginTarget = prorateTarget(planField(ctx, 'margin'), w.from, w.to, tz);
  const qLabel = ctx.quarterKeys.length === 1 ? `Q${ctx.quarterKeys[0]!.slice(-1)}` : `Q${ctx.quarterKeys[0]!.slice(-1)}–Q${ctx.quarterKeys[ctx.quarterKeys.length - 1]!.slice(-1)}`;
  const qSum = (field: 'revenue' | 'margin') => ctx.quarterKeys.reduce((n, k) => n + (ctx.plan.get(k)?.[field] ?? 0), 0);
  const proratedTo = w.period.complete ? fmtDayRange(w.period.start, w.period.end) : fmtDay(w.period.end);
  const revenue = buildKpi(KPI_SPECS.revenue, {
    value: current.billed,
    compare: planMode ? revTarget : cmp(compared?.billed ?? null),
    target: revTarget,
    targetLabel: revTarget !== null ? `${qLabel} plan ${execMoney(qSum('revenue'))}, prorated to ${proratedTo}` : null,
    sub: `${wholeHours(current.hours)} paid hours`,
    trend: trendOf(weekly.map((x) => (x.hours > 0 ? x.billed : null))),
  });

  // ---- margin %
  const marginPctTarget = revTarget !== null && marginTarget !== null && revTarget > 0 ? (marginTarget / revTarget) * 100 : null;
  // Gross margin % by the dictionary's formula: (revenue − pay, burden, overhead) ÷ revenue.
  const marginPct = buildKpi(KPI_SPECS.marginPct, {
    value: marginPctOf(current.billed, current.cost),
    compare: planMode ? marginPctTarget : cmp(compared ? marginPctOf(compared.billed, compared.cost) : null),
    target: marginPctTarget,
    targetLabel: marginPctTarget !== null ? `${qLabel} plan: ${execMoney(qSum('margin'))} margin on ${execMoney(qSum('revenue'))}` : null,
    sub: `${execMoney(current.margin)} margin`,
    trend: trendOf(weekly.map((x) => marginPctOf(x.billed, x.cost))),
  });

  // ---- workforce
  const activeAt = (d: Date) => active.get(d.getTime()) ?? null;
  const headTarget = planAtEnd(ctx, 'headcount');
  const workforce = buildKpi(KPI_SPECS.workforce, {
    value: activeAt(periodEnd),
    compare: planMode ? headTarget : cmp(hasCompare ? activeAt(w.compareTo!) : null),
    target: headTarget,
    targetLabel: headTarget !== null ? `${qLabel} plan ${headTarget.toLocaleString('en-US')} working` : null,
    sub: `of ${onTheBooksAt(standings, periodEnd).toLocaleString('en-US')} on the books`,
    trend: trendOf(weekEnds.map((d) => activeAt(d))),
  });

  // ---- fill rate
  const fillTarget = planAtEnd(ctx, 'fillRatePct');
  const fillRate = buildKpi(KPI_SPECS.fillRate, {
    value: pct(fill.assigned, fill.published),
    compare: planMode ? fillTarget : cmp(fillCompare ? pct(fillCompare.assigned, fillCompare.published) : null),
    target: fillTarget,
    targetLabel: fillTarget !== null ? `${qLabel} plan ${fillTarget.toFixed(1)}%` : null,
    sub: fill.published > 0 ? `${fill.assigned.toLocaleString('en-US')} of ${plural(fill.published, 'shift')} filled` : 'No published shifts',
    trend: trendOf(fillWeeks),
    thresholds: { good: 95, watch: 90 },
  });

  // ---- turnover
  const turn = turnoverBetween(standings, w.from, periodEnd);
  const turnCompare = hasCompare ? turnoverBetween(standings, w.compareFrom!, w.compareTo!) : null;
  const turnTarget = planAtEnd(ctx, 'turnoverPct');
  const turnover = buildKpi(KPI_SPECS.turnover, {
    value: turn.annualizedPct,
    compare: planMode ? turnTarget : cmp(turnCompare?.annualizedPct ?? null),
    target: turnTarget,
    targetLabel: turnTarget !== null ? `${qLabel} plan ${turnTarget.toFixed(1)}% a year` : null,
    sub: plural(turn.separations, 'separation'),
    trend: trendOf(weekEnds.map((d) => turnoverBetween(standings, new Date(d.getTime() - 28 * DAY_MS), d).annualizedPct)),
  });

  // ---- overtime
  const overtimePct = buildKpi(KPI_SPECS.overtimePct, {
    value: pct(current.otHours, current.hours),
    compare: planMode ? null : cmp(compared ? pct(compared.otHours, compared.hours) : null),
    target: null,
    targetLabel: null,
    sub: `${wholeHours(current.otHours)} overtime hours`,
    trend: trendOf(weekly.map((x) => pct(x.otHours, x.hours))),
    thresholds: { good: 5, watch: 10 },
  });

  // ---- days to collect
  const openAr = arAsOf(ctx.ar, periodEnd).reduce((n, s) => n + s.open, 0);
  const dso = buildKpi(KPI_SPECS.dso, {
    value: dsoAsOf(ctx.ar, periodEnd),
    compare: planMode ? null : cmp(hasCompare ? dsoAsOf(ctx.ar, w.compareTo!) : null),
    target: null,
    targetLabel: null,
    sub: openAr > 0 ? `${execMoney(openAr)} open with clients` : 'Nothing open with clients',
    trend: trendOf(weekEnds.map((d) => dsoAsOf(ctx.ar, d))),
    thresholds: { good: 30, watch: 45 },
  });

  // ---- cash
  const cashAt = (d: Date) => bank?.byDay.get(lastDayKey(d, tz)) ?? null;
  const low = forecast?.lowest ?? null;
  const minimum = forecast?.minimumCash ?? null;
  let cashStatus: { status: ExecStatus; label: string };
  // A bank account below zero today is a problem the total hides (MONEY-18): the
  // balance nets it away, so "Positive for 13 weeks" would read beside an overdraft.
  const overdrawn = forecast?.opening?.overdrawn ?? [];
  if (!bank) cashStatus = { status: 'none', label: 'Books not set up' };
  else if (overdrawn.length > 0)
    cashStatus = {
      status: 'bad',
      label: overdrawn.length === 1 ? `${overdrawn[0]!.name} is overdrawn (${execMoney(overdrawn[0]!.balance)})` : `${overdrawn.length} bank accounts overdrawn`,
    };
  else if (!low) cashStatus = { status: 'none', label: 'No forecast yet' };
  else if (minimum !== null && low.balance < minimum) cashStatus = { status: 'bad', label: 'Forecast dips below the floor' };
  else if (minimum !== null && low.balance < minimum * 1.5) cashStatus = { status: 'watch', label: 'Forecast nears the floor' };
  else if (minimum === null && low.balance < 0) cashStatus = { status: 'bad', label: 'Forecast goes below zero' };
  else cashStatus = { status: 'good', label: minimum !== null ? 'Above the floor' : 'Positive for 13 weeks' };
  const cash = buildKpi(KPI_SPECS.cash, {
    value: bank ? cashAt(periodEnd) : null,
    compare: planMode ? null : cmp(bank && hasCompare ? cashAt(w.compareTo!) : null),
    target: null,
    targetLabel: minimum !== null ? `Cash floor ${execMoney(minimum)}` : null,
    sub: bank && low ? `13-week low ${execMoney(low.balance)}` : null,
    trend: trendOf(weekEnds.map((d) => (bank ? cashAt(d) : null))),
    status: cashStatus,
  });

  const scorecard = [revenue, marginPct, workforce, fillRate, turnover, overtimePct, dso, cash];
  const cashFact = cash.value !== null ? `Cash stands at ${execMoney(cash.value)}${low ? `, with a 13-week forecast low of ${execMoney(low.balance)} in the week of ${fmtDay(low.weekStart)}` : ''}.` : null;
  const changes = rankChanges(scorecard, { ...ctx, w: { ...w, comparison } }, opts.risk ?? null, cashFact);
  const notes = [
    ratesNote(ctx.rates),
    workweekNote(),
    'The workforce, fill rate, turnover and overtime are counted from the live records; days to collect reads finalized client statements; cash reads the company books.',
  ];

  return {
    overview: {
      period: w.period,
      comparison,
      scorecard,
      changes,
      plan: { quarter: ctx.quarterKeys[ctx.quarterKeys.length - 1]!, set: ctx.planSet },
      notes,
    },
    extras: { standings, forecast, weekly, current, compared, fill, openAr },
  };
}
