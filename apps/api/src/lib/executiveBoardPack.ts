import type { Prisma, PrismaClient } from '@prisma/client';
import type { ExecClients, ExecCompareKey, ExecFinancials, ExecKpi, ExecOverview, ExecPeople, ExecPeriodKey, ExecRisks, ExecStatus } from '@alto-people/shared';
import { prisma as defaultPrisma } from '../db.js';
import { CHART, ReportPdf, axisMoney } from './reportPdf.js';
import { COLOR, SIZE } from './docKit/index.js';
import { currentBrand } from './docKit/brand.js';
import { COMPANY_INFO } from './emailTemplates.js';
import { fmtDay, fmtDayRange } from './humanDates.js';
import { tenantIdForWrite } from './tenant.js';
import type { ExecutiveSummary } from './executiveSummary.js';
import { loadExecContext } from './execFinanceContext.js';
import { computeExecOverview, execCashForecast, valueWords, workweekNote, ratesNote, zoneWords } from './execOverview.js';
import { computeExecFinancials } from './execFinancials.js';
import { execMoney, plural, wholeDollars, wholeHours } from './execFinance.js';
import { computeExecClients } from './execClients.js';
import { computeExecPeople } from './execPeople.js';
import { computeExecRisks } from './execRisks.js';
import { moduleOn } from './tenantProfile.js';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * The board pack (v2, 2026-10-27): a designed document for a period read
 * against a comparison — the same frame, figures and words as the
 * executive portal, laid out for a board meeting.
 *
 *   1 Cover        company, period, comparison, prepared for, generated, contents
 *   2 Scorecard    the eight measures against the comparison and the plan,
 *                  each with its status, and what changed
 *   3 Financials   headline money, the margin walk drawn, 13 weeks of billing
 *                  and margin, cash and its 13-week low, receivables by age
 *   4 Clients      concentration against its line, the client table, pipeline
 *   5 Workforce    counts, hires against separations, turnover, overtime, attendance
 *   6 Risk register
 *   7 Appendix     the eight-week trend, definitions, rates and basis
 *
 * Built here so the download (GET /executive/board-pack.pdf) and the
 * Saturday digest's attachment are the same document: the digest passes
 * its weekly summary and gets the last complete week against the week
 * before.
 */

export interface BoardPackInput {
  tenantId?: string;
  now?: Date;
  period: ExecPeriodKey;
  compare: ExecCompareKey;
  db?: Db;
}

const STATUS_COLOR: Record<ExecStatus, string> = { good: COLOR.good, watch: COLOR.warn, bad: COLOR.bad, none: CHART.slate };
const TONE_COLOR = { good: COLOR.good, bad: COLOR.bad, neutral: CHART.slate } as const;
const BASIS_WORDS: Record<ExecKpi['basis'], string> = { estimate: 'Estimate at standard rates', books: 'Company books', statements: 'Finalized statements', live: 'Live records' };

/** "Tuesday, October 27, 2026 at 11:40 AM Eastern time" — never ISO, never "UTC". */
export function generatedWords(at: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('weekday')}, ${get('month')} ${get('day')}, ${get('year')} at ${get('hour')}:${get('minute')} ${get('dayPeriod')} ${zoneWords(tz)}`;
}

/** The change in the measure's own terms: +$1.2k (+4.0%) · −3.4 points · +2 · −5 days. */
function deltaWords(k: ExecKpi): string | null {
  if (k.delta === null) return null;
  const sign = k.delta > 0 ? '+' : k.delta < 0 ? '−' : '±';
  const abs = Math.abs(k.delta);
  if (k.unit === 'pct') return `${sign}${abs.toFixed(1)} points`;
  if (k.unit === 'days') return `${sign}${plural(Math.round(abs), 'day')}`;
  const main = k.unit === 'money' ? execMoney(abs) : Math.round(abs).toLocaleString('en-US');
  const rel = k.deltaPct !== null && Math.abs(k.deltaPct) >= 0.001 && Math.abs(k.deltaPct) < 10 ? ` (${sign}${(Math.abs(k.deltaPct) * 100).toFixed(1)}%)` : '';
  return `${sign}${main}${rel}`;
}

const toneOf = (k: ExecKpi): keyof typeof TONE_COLOR => (k.delta === null || k.delta === 0 ? 'neutral' : k.delta > 0 === (k.betterWhen === 'up') ? 'good' : 'bad');

/** "Q3, same days" → the column header word for the comparison. */
function compareHeader(o: ExecOverview): string {
  if (o.comparison.key === 'plan') return 'vs plan';
  if (o.comparison.key === 'year') return 'vs last year';
  return o.period.key === 'week' ? 'vs week before' : 'vs prior period';
}

/** The comparison in a sentence, with its days. */
function comparisonWords(o: ExecOverview): string {
  const c = o.comparison;
  if (c.key === 'plan') return c.available ? 'Compared with the plan' : `Compared with the plan. ${c.reason ?? ''}`.trim();
  const span = c.start && c.end ? ` (${fmtDayRange(c.start, c.end, { year: true })})` : '';
  const head = `Compared with ${c.label.replace(/^vs /, '')}${span}.`;
  return c.available ? head : `${head} ${c.reason ?? ''}`.trim();
}

const shortRange = (start: string, end: string) => fmtDayRange(start, end, { year: true });

/** Keep the digest working: its weekly summary means the last complete week against the week before. */
function isSummary(x: BoardPackInput | ExecutiveSummary): x is ExecutiveSummary {
  return (x as ExecutiveSummary).lastWeek !== undefined;
}

export async function buildBoardPack(input: BoardPackInput | ExecutiveSummary, refId: string): Promise<Buffer> {
  const opts: BoardPackInput = isSummary(input) ? { period: 'week', compare: 'prior', now: new Date(input.generatedAt) } : input;
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const tenantId = opts.tenantId ?? tenantIdForWrite();

  const forecast = execCashForecast(now, tenantId);
  const [ctx, risks] = await Promise.all([
    loadExecContext(db, { tenantId, now, period: opts.period, compare: opts.compare }),
    computeExecRisks(db, now).catch(() => null as ExecRisks | null),
  ]);
  const topRisk = risks?.risks.find((r) => r.severity === 'high') ?? null;
  const ov = await computeExecOverview(db, ctx, { risk: topRisk, forecast });
  // A company with no clients (a hotel, a direct employer) has no client page.
  const hasClients = await moduleOn('clientPortal', tenantId).catch(() => true);
  const [fin, clients, people] = await Promise.all([
    computeExecFinancials(db, ctx, { overview: ov }),
    hasClients ? computeExecClients(db, ctx.w).catch(() => null as ExecClients | null) : Promise.resolve(null),
    computeExecPeople(db, ctx.w).catch(() => null as ExecPeople | null),
  ]);
  return renderBoardPack({ overview: ov.overview, fin, clients, people, risks, refId, now, tz: ctx.tz, hasClients });
}

export interface BoardPackData {
  overview: ExecOverview;
  fin: ExecFinancials;
  clients: ExecClients | null;
  people: ExecPeople | null;
  risks: ExecRisks | null;
  refId: string;
  now: Date;
  tz: string;
  /** False for a company with no clients: the Clients page is left out. */
  hasClients?: boolean;
}

/** Draw the pack from its data (pure: no reads), so a test can render any shape. */
export async function renderBoardPack(data: BoardPackData): Promise<Buffer> {
  const { overview: o, fin, clients, people, risks, refId, now, tz, hasClients = true } = data;
  const brand = currentBrand();
  const companyName = brand.name && brand.name !== 'Alto People' ? brand.name : COMPANY_INFO.name;
  const ownCompany = companyName !== COMPANY_INFO.name;
  const periodRange = shortRange(o.period.start, o.period.end);
  // "Week of Oct 17 – 23, 2026" · "Q4 to date, Oct 1 – 27, 2026": the frame said once.
  const frame = o.period.key === 'week' ? `Week of ${periodRange}` : `${o.period.label}, ${periodRange}`;

  const pdf = new ReportPdf({
    title: 'Board pack',
    reference: refId,
    cover: true,
    runningTitle: `Board pack  ·  ${frame}`,
    confidentialityNote: 'Confidential. Prepared for the board of directors; not for distribution.',
    ...(ownCompany ? { company: { name: companyName, contactLine: '' } } : {}),
  });
  const L = pdf.left;
  const W = pdf.contentWidth;
  const sections: Array<{ title: string; note: string; page: number }> = [];
  const startSection = (title: string, note: string) => {
    pdf.newPage();
    sections.push({ title, note, page: pdf.pageIndex() + 1 });
  };

  /* ------------------------------------------------------------- 1 Cover */
  const bandH = 318;
  pdf.box(0, 0, pdf.pageWidth, bandH, COLOR.band);
  pdf.box(0, bandH, pdf.pageWidth, 4, CHART.gold);
  pdf.textAt(companyName, L, 54, { size: SIZE.title, weight: 'semibold', color: COLOR.white, width: W });
  if (!ownCompany) pdf.textAt(COMPANY_INFO.tagline ?? '', L, 72, { size: SIZE.small, color: COLOR.bandSub, width: W });
  pdf.textAt('Board pack', L, 170, { size: SIZE.small, weight: 'semibold', color: CHART.gold, caps: true });
  pdf.textAt(o.period.label, L, 186, { size: 40, family: 'display', weight: 'semibold', color: COLOR.white, width: W });
  pdf.textAt(periodRange + (o.period.complete ? '' : ` · ${o.period.elapsedPct}% of the ${o.period.key} elapsed`), L, 240, { size: SIZE.lead, color: COLOR.white, width: W });
  pdf.paraAt(comparisonWords(o), L, 260, W * 0.85, { size: SIZE.body, color: COLOR.bandSub });

  let cy = bandH + 34;
  const fact = (label: string, value: string, x: number, y: number, w: number) => {
    pdf.textAt(label, x, y, { size: SIZE.label, weight: 'medium', color: COLOR.ink3, caps: true });
    pdf.textAt(value, x, y + 12, { size: SIZE.body + 0.5, weight: 'medium', width: w });
  };
  fact('Prepared for', 'The board of directors', L, cy, W / 2 - 16);
  fact('Plan', o.plan.set ? `Set for Q${o.plan.quarter.slice(-1)} ${o.plan.quarter.slice(0, 4)}` : `Not set for Q${o.plan.quarter.slice(-1)} ${o.plan.quarter.slice(0, 4)}`, L + W / 2, cy, W / 2);
  fact('Generated', generatedWords(now, tz), L, cy + 40, W);
  cy += 92;
  pdf.textAt('Contents', L, cy, { size: SIZE.lead, weight: 'semibold' });
  pdf.ruleAt(L, cy + 17, W, COLOR.ink, 0.8);
  const contentsTop = cy + 28;
  const coverIndex = pdf.pageIndex();

  /* --------------------------------------------------------- 2 Scorecard */
  startSection('Scorecard', 'The eight measures against the comparison and the plan');
  pdf.sectionTitle('Scorecard', 'How the company is doing', `${frame}. ${comparisonWords(o)}`);
  {
    const cols = [
      { key: 'measure', label: 'Measure', w: 112 },
      { key: 'value', label: 'Value', w: 70, right: true },
      { key: 'change', label: compareHeader(o), w: 100, right: true },
      { key: 'plan', label: 'Plan', w: 54, right: true },
      { key: 'trend', label: '13 weeks', w: 52 },
      { key: 'status', label: 'Status', w: W - 112 - 70 - 100 - 54 - 52 },
    ];
    let x = L;
    const xs = cols.map((c) => {
      const at = x;
      x += c.w;
      return at;
    });
    const hy = pdf.y;
    pdf.box(L, hy, W, 20, COLOR.wash);
    cols.forEach((c, i) => {
      const pad = c.key === 'trend' ? 10 : 6;
      pdf.textAt(c.label, xs[i]! + pad, hy + 6.5, { size: SIZE.label, weight: 'medium', color: COLOR.ink3, caps: true, width: c.w - pad - 6, align: c.right ? 'right' : 'left' });
    });
    pdf.ruleAt(L, hy + 20, W, COLOR.ruleStrong, 0.6);
    let ry = hy + 20;
    const rowH = 36;
    for (const k of o.scorecard) {
      pdf.textAt(k.label, xs[0]! + 6, ry + 8, { size: SIZE.body + 0.5, weight: 'semibold', width: cols[0]!.w - 10 });
      pdf.textAt(BASIS_WORDS[k.basis], xs[0]! + 6, ry + 21, { size: SIZE.micro + 0.5, color: COLOR.ink3, width: cols[0]!.w - 10 });
      pdf.textAt(valueWords(k.value, k.unit), xs[1]!, ry + 9, { size: SIZE.lead, weight: 'semibold', width: cols[1]!.w - 6, align: 'right' });
      if (k.sub) pdf.textAt(k.sub, xs[1]! - 20, ry + 22, { size: SIZE.micro + 0.5, color: COLOR.ink3, width: cols[1]!.w + 14, align: 'right' });
      const d = deltaWords(k);
      if (d && o.comparison.available) {
        pdf.textAt(d, xs[2]!, ry + 9, { size: SIZE.small + 0.5, weight: 'semibold', color: TONE_COLOR[toneOf(k)], width: cols[2]!.w - 6, align: 'right' });
        if (k.compare !== null) pdf.textAt(`from ${valueWords(k.compare, k.unit)}`, xs[2]!, ry + 22, { size: SIZE.micro + 0.5, color: COLOR.ink3, width: cols[2]!.w - 6, align: 'right' });
      } else {
        pdf.textAt('—', xs[2]!, ry + 9, { size: SIZE.small + 0.5, color: COLOR.ink3, width: cols[2]!.w - 6, align: 'right' });
      }
      pdf.textAt(k.target !== null ? valueWords(k.target, k.unit) : 'Not set', xs[3]!, ry + 9, { size: SIZE.small + 0.5, color: k.target !== null ? COLOR.ink : COLOR.ink3, width: cols[3]!.w - 6, align: 'right' });
      pdf.sparkline(xs[4]! + 10, ry + 9, cols[4]!.w - 16, 16, k.trend.map((p) => p.value), CHART.navy);
      pdf.dot(xs[5]! + 10, ry + 13.5, 3.4, STATUS_COLOR[k.status]);
      pdf.textAt(k.statusLabel, xs[5]! + 18, ry + 9, { size: SIZE.small + 0.5, weight: 'medium', width: cols[5]!.w - 20 });
      ry += rowH;
      pdf.ruleAt(L, ry, W, COLOR.rule, 0.4);
    }
    pdf.y = ry + 22;
  }
  pdf.subheading('What changed', o.comparison.available ? (o.comparison.key === 'plan' ? 'Against plan' : o.comparison.label.replace(/^vs /, 'Against ')) : undefined);
  pdf.bullets(o.changes.map((c) => ({ text: c.text, color: TONE_COLOR[c.tone] })), { size: SIZE.body + 0.5 });
  {
    const legendY = Math.min(pdf.bottom - 14, pdf.y + 8);
    let lx = L;
    for (const [status, word] of [['good', 'On plan or healthy'], ['watch', 'Watch'], ['bad', 'Off plan or needs attention'], ['none', 'Nothing to judge by']] as Array<[ExecStatus, string]>) {
      pdf.dot(lx + 3, legendY + 3.5, 3, STATUS_COLOR[status]);
      lx += 10 + pdf.textAt(word, lx + 10, legendY, { size: SIZE.label, color: COLOR.ink3 }) + 16;
    }
  }

  /* -------------------------------------------------------- 3 Financials */
  startSection('Financials', 'Revenue, margin, cash and receivables');
  pdf.sectionTitle('Financials', 'Revenue, margin and cash', `${frame}. Revenue and margin are estimates at standard rates; cash is from the company books; receivables from finalized client statements.`);
  {
    const k = new Map(fin.kpis.map((x) => [x.id, x]));
    const tile = (id: ExecKpi['id'], label: string, sub?: string | null) => {
      const x = k.get(id);
      const d = x && o.comparison.available ? deltaWords(x) : null;
      return { label, value: x ? valueWords(x.value, x.unit) : '—', sub: sub ?? x?.sub ?? null, change: d && x ? { text: `${d} ${o.comparison.key === 'plan' ? 'against plan' : ''}`.trim(), color: TONE_COLOR[toneOf(x)] } : null };
    };
    pdf.tiles([
      tile('revenue', 'Revenue'),
      tile('grossMargin', 'Gross margin'),
      tile('cash', 'Cash', fin.cash?.today != null && fin.cash.lowPoint ? `13-week low ${execMoney(fin.cash.lowPoint.balance)}` : null),
      tile('dso', 'Days to collect'),
    ]);

    pdf.subheading('Where the money went', `${o.period.label}, from billing to margin`);
    if (!(fin.waterfall[0]!.amount > 0)) pdf.para('No paid hours were recorded in the period, so there is no margin walk to draw.', { muted: true });
    else pdf.y = pdf.waterfall({
      h: 132,
      steps: fin.waterfall
        .map((s, i) => ({ label: s.label, amount: s.amount, kind: (i === 0 || i === fin.waterfall.length - 1 ? 'total' : 'down') as 'total' | 'down' }))
        .filter((s) => s.kind === 'total' || Math.abs(s.amount) >= 0.5),
      format: execMoney,
      axisFormat: axisMoney,
    }) + 6;

    pdf.subheading('The last 13 weeks', 'Billed, with the margin inside it');
    const weeks = fin.weeks;
    const ly = pdf.y;
    if (weeks.filter((w) => w.hours > 0).length < 4) {
      const worked = weeks.filter((w) => w.hours > 0);
      pdf.para(
        worked.length
          ? `Only ${plural(worked.length, 'week')} of the last 13 had paid hours: ${execMoney(worked.reduce((n, w) => n + w.billed, 0))} billed, ${execMoney(worked.reduce((n, w) => n + w.margin, 0))} margin.`
          : 'No paid hours were recorded in the last 13 weeks.',
        { muted: true },
      );
    } else {
      pdf.legend([{ label: 'Billed', color: CHART.navy }, { label: 'Margin', color: CHART.gold }], L + 40, ly);
      pdf.y = pdf.columnChart({
        y: ly + 6,
        h: 108,
        categories: weeks.map((w) => fmtDay(w.start)),
        series: [{ name: 'Billed', color: CHART.navy, values: weeks.map((w) => (w.hours > 0 ? w.billed : null)) }],
        inner: { name: 'Margin', color: CHART.gold, values: weeks.map((w) => (w.hours > 0 ? w.margin : null)) },
        format: execMoney,
        axisFormat: axisMoney,
      }) + 8;
    }

    // Cash (left) and receivables (right).
    const colW = (W - 24) / 2;
    const top = pdf.y;
    pdf.subheading('Cash', fin.cash ? `${plural(fin.cash.accounts, 'bank account')}` : undefined, L, colW);
    if (fin.cash) {
      const c = fin.cash;
      const lines: Array<[string, string]> = [
        ['Today', execMoney(c.today)],
        ['13-week low', c.lowPoint ? `${execMoney(c.lowPoint.balance)}, week of ${fmtDay(c.lowPoint.weekStart)}` : 'No forecast yet'],
        ['Cash floor', c.minimum !== null ? execMoney(c.minimum) : 'Not set'],
      ];
      let yy = pdf.y;
      for (const [a, b] of lines) {
        pdf.textAt(a, L, yy, { size: SIZE.small, color: COLOR.ink3, width: 80 });
        pdf.textAt(b, L + 80, yy, { size: SIZE.small, weight: 'medium', width: colW - 80 });
        yy += 13;
      }
      if (c.today !== null && c.forecast.length >= 4) {
        pdf.lineChart({
          x: L,
          y: yy + 2,
          w: colW,
          h: 64,
          labels: c.forecast.map((f) => fmtDay(f.weekStart)),
          series: [{ name: 'Forecast balance', color: CHART.navy, values: c.forecast.map((f) => f.balance) }],
          format: execMoney,
          axisFormat: axisMoney,
          labelEvery: 4,
          ...(c.minimum !== null ? { refLine: { value: c.minimum, label: `Floor ${execMoney(c.minimum)}` } } : {}),
        });
      }
    } else {
      pdf.paraAt('The company books hold no bank account yet, so there is no cash position to report.', L, pdf.y, colW, { size: SIZE.small, color: COLOR.ink3 });
    }
    const rx = L + colW + 24;
    pdf.y = top;
    pdf.subheading('Receivables', `${execMoney(fin.receivables.total)} open`, rx, colW);
    const b = fin.receivables.buckets;
    const rows: Array<[string, number]> = [
      ['Not yet due', b.current],
      ['1 to 30 days past due', b.days1to30],
      ['31 to 60 days past due', b.days31to60],
      ['61 to 90 days past due', b.days61to90],
      ['Over 90 days past due', b.over90],
    ];
    let yy = pdf.y;
    for (const [label, amount] of rows) {
      pdf.textAt(label, rx, yy, { size: SIZE.small, color: COLOR.ink2, width: colW - 80 });
      pdf.textAt(wholeDollars(amount), rx + colW - 80, yy, { size: SIZE.small, weight: 'medium', width: 80, align: 'right' });
      yy += 13;
      pdf.ruleAt(rx, yy - 3, colW, COLOR.rule, 0.3);
    }
    pdf.textAt('Total open', rx, yy + 1, { size: SIZE.small, weight: 'semibold', width: colW - 80 });
    pdf.textAt(wholeDollars(fin.receivables.total), rx + colW - 80, yy + 1, { size: SIZE.small, weight: 'semibold', width: 80, align: 'right' });
    yy += 18;
    const dso = k.get('dso');
    pdf.paraAt(
      dso?.value !== null && dso?.value !== undefined
        ? `Days to collect: ${valueWords(dso.value, 'days')}. ${fin.receivables.open.length ? `Oldest open: ${fin.receivables.open[0]!.clientName}, ${wholeDollars(fin.receivables.open[0]!.amount)}${fin.receivables.open[0]!.ageDays > 0 ? `, ${plural(fin.receivables.open[0]!.ageDays, 'day')} past due` : ', not yet due'}.` : ''}`
        : 'No statements were finalized in the last 90 days, so days to collect cannot be measured.',
      rx,
      yy,
      colW,
      { size: SIZE.small, color: COLOR.ink2 },
    );
  }

  /* ----------------------------------------------------------- 4 Clients */
  if (hasClients) startSection('Clients', 'Concentration, the client table and the pipeline');
  if (!hasClients) {
    // No client book to report on.
  } else if (!clients) {
    pdf.sectionTitle('Clients', 'Client portfolio');
    pdf.para('The client figures could not be read for this pack.', { muted: true });
  } else {
    const c = clients.concentration;
    const lede = c.topClientName
      ? `${c.topClientName} is ${c.topSharePct.toFixed(1)}% of estimated billing in ${o.period.label.toLowerCase().startsWith('week') ? 'the week' : o.period.label}${c.topSharePct >= c.thresholdPct ? `, above the ${c.thresholdPct}% concentration line` : `, under the ${c.thresholdPct}% concentration line`}.`
      : 'No client billed in the period.';
    pdf.sectionTitle('Clients', 'Client portfolio', lede);
    const billed = clients.clients.filter((r) => r.billed > 0).sort((a, b) => b.sharePct - a.sharePct);
    if (billed.length) {
      pdf.subheading('Share of billing', `Concentration line ${c.thresholdPct}%`);
      pdf.y = pdf.barList({
        rows: billed.slice(0, 8).map((r) => ({ label: r.name, value: r.sharePct, valueLabel: `${r.sharePct.toFixed(1)}%`, color: r.sharePct >= c.thresholdPct ? CHART.warn : CHART.navy })),
        max: 100,
        threshold: { value: c.thresholdPct, label: `${c.thresholdPct}% line` },
      }) + 8;
    }
    pdf.subheading('Clients', `${o.period.label}`);
    pdf.table(
      [
        { label: 'Client', width: 150 },
        { label: 'Billed', width: 66, align: 'right' },
        { label: 'Margin', width: 52, align: 'right' },
        { label: 'Share', width: 48, align: 'right' },
        { label: 'Active', width: 46, align: 'right' },
        { label: 'Fill', width: 46, align: 'right' },
        { label: 'Health', align: 'left' },
      ],
      clients.clients.slice(0, 14).map((r) => [
        r.name,
        wholeDollars(r.billed),
        r.marginPct !== null ? `${r.marginPct.toFixed(1)}%` : '—',
        `${r.sharePct.toFixed(1)}%`,
        r.headcount.toLocaleString('en-US'),
        r.fillPct !== null ? `${r.fillPct.toFixed(1)}%` : '—',
        r.healthLabel ? `${r.healthLabel}${r.health !== null ? ` (${Math.round(r.health)})` : ''}` : '—',
      ]),
    );
    if (clients.league.length) {
      pdf.subheading('Stores', 'Best margin first');
      pdf.table(
        [
          { label: 'Store', width: 150 },
          { label: 'Client', width: 120 },
          { label: 'Billed', width: 66, align: 'right' },
          { label: 'Margin', width: 60, align: 'right' },
          { label: 'Hours', width: 56, align: 'right' },
          { label: 'Overtime', align: 'right' },
        ],
        clients.league.slice(0, 10).map((r) => [r.name, r.clientName, wholeDollars(r.billed), wholeDollars(r.margin), wholeHours(r.hours), wholeHours(r.otHours)]),
      );
    }
    pdf.subheading('Pipeline', clients.pipeline.weightedAnnual > 0 ? `${execMoney(clients.pipeline.weightedAnnual)} weighted a year` : undefined);
    if (clients.pipeline.stages.length) {
      pdf.table(
        [
          { label: 'Stage', width: 150 },
          { label: 'Prospects', width: 70, align: 'right' },
          { label: 'Weekly value', width: 90, align: 'right' },
          { label: 'Close rate', width: 80, align: 'right' },
          { label: 'Weighted a year', align: 'right' },
        ],
        clients.pipeline.stages.map((s) => [s.label, s.count.toLocaleString('en-US'), wholeDollars(s.weeklyValue), `${Math.round(s.probability * 100)}%`, wholeDollars(s.weightedAnnual)]),
      );
      pdf.para('Weighted a year is the weekly value × 52 × the stage’s close rate.', { muted: true, size: SIZE.small });
    } else {
      pdf.para('No prospects are in the pipeline.', { muted: true });
    }
  }

  /* --------------------------------------------------------- 5 Workforce */
  startSection('Workforce', 'Headcount, hires and separations, turnover, overtime, attendance');
  {
    const wf = o.scorecard.find((x) => x.id === 'workforce');
    const turn = o.scorecard.find((x) => x.id === 'turnover');
    const ot = o.scorecard.find((x) => x.id === 'overtimePct');
    const counts = people?.counts;
    pdf.sectionTitle('Workforce', 'People', `${frame}. Headcount uses the one definition of active: placed at a site and worked recently or scheduled ahead.`);
    const periodHires = people?.kpis.find((x) => x.id === 'hires');
    pdf.tiles([
      { label: 'Active', value: valueWords(wf?.value ?? counts?.active ?? null, 'count'), sub: wf?.sub ?? null, change: wf && o.comparison.available && deltaWords(wf) ? { text: deltaWords(wf)!, color: TONE_COLOR[toneOf(wf)] } : null },
      { label: 'Onboarding', value: counts ? counts.onboarding.toLocaleString('en-US') : '—', sub: 'In flight' },
      { label: 'Hires', value: periodHires?.value !== null && periodHires?.value !== undefined ? Math.round(periodHires.value).toLocaleString('en-US') : '—', sub: 'In the period' },
      { label: 'Turnover', value: valueWords(turn?.value ?? null, 'pct'), sub: turn?.target !== null && turn?.target !== undefined ? `Plan ${turn.target.toFixed(1)}% a year` : 'Annualized' },
      { label: 'Overtime', value: valueWords(ot?.value ?? null, 'pct'), sub: ot?.sub ?? null },
    ]);
    const weeks = people?.weeks ?? [];
    if (weeks.length >= 4 && weeks.some((w) => w.hires > 0 || w.separations > 0)) {
      pdf.subheading('Hires and separations', 'The last 13 weeks');
      const ly = pdf.y;
      pdf.legend([{ label: 'Hires', color: CHART.navy }, { label: 'Separations', color: CHART.slate }], L + 40, ly);
      pdf.y = pdf.columnChart({
        y: ly + 6,
        h: 104,
        categories: weeks.map((w) => fmtDay(w.start)),
        series: [
          { name: 'Hires', color: CHART.navy, values: weeks.map((w) => w.hires) },
          { name: 'Separations', color: CHART.slate, values: weeks.map((w) => w.separations) },
        ],
        format: (v) => Math.round(v).toLocaleString('en-US'),
        valueLabels: true,
        integer: true,
      }) + 8;
    } else {
      const h = weeks.reduce((n, w) => n + w.hires, 0);
      const s = weeks.reduce((n, w) => n + w.separations, 0);
      pdf.subheading('Hires and separations');
      pdf.para(weeks.length ? (h + s > 0 ? `${plural(h, 'hire')} and ${plural(s, 'separation')} in the weeks on record.` : 'No hires or separations in the last 13 weeks.') : 'There is not enough weekly history to chart hires against separations yet.', { muted: true });
    }

    const colW = (W - 24) / 2;
    const top = pdf.y;
    pdf.subheading('Turnover and overtime', undefined, L, colW);
    const tLines: Array<[string, string]> = [];
    if (turn) tLines.push(['Turnover', turn.value === null ? 'Not measurable: nobody was on the books' : `${valueWords(turn.value, 'pct')} annualized${turn.target !== null ? `, against a plan of ${turn.target.toFixed(1)}%` : ''}`]);
    if (people) tLines.push(['Last 90 days', `${plural(people.turnover.separations90d, 'separation')}, about ${execMoney(people.turnover.estCost90d)} to replace`]);
    if (ot) tLines.push(['Overtime', ot.value === null ? 'No paid hours in the period' : `${valueWords(ot.value, 'pct')} of paid hours (${ot.sub ?? ''})`.replace(' ()', '')]);
    if (counts) tLines.push(['On the books', `${counts.onTheBooks.toLocaleString('en-US')}: ${counts.active} active, ${counts.placedNotActive} placed without recent shifts, ${counts.notPlaced} not placed, ${counts.deactivated} paused`]);
    let yy = pdf.y;
    for (const [a, b] of tLines) {
      pdf.textAt(a, L, yy, { size: SIZE.small, color: COLOR.ink3, width: 78 });
      yy += pdf.paraAt(b, L + 78, yy, colW - 78, { size: SIZE.small, lineGap: 1 }) + 5;
    }
    const otWeeks = (ot?.trend ?? []).map((p) => p.value);
    if (otWeeks.filter((v) => v !== null).length >= 4) {
      pdf.lineChart({ x: L, y: yy + 2, w: colW, h: 60, labels: (ot?.trend ?? []).map((p) => fmtDay(p.start)), series: [{ name: 'Overtime', color: CHART.navy, values: otWeeks }], format: (v) => `${v.toFixed(1)}%`, axisFormat: (v) => `${Number(v.toPrecision(3))}%`, labelEvery: 4 });
    }

    const rx = L + colW + 24;
    pdf.y = top;
    pdf.subheading('Attendance', 'Last 8 weeks', rx, colW);
    const att = people?.attendance;
    if (att && att.cells.length) {
      const bySite = new Map<string, { events: number; per: number[] }>();
      for (const cell of att.cells) {
        const s = bySite.get(cell.siteId) ?? { events: 0, per: [] };
        s.events += cell.events;
        if (cell.perHundredShifts !== null) s.per.push(cell.perHundredShifts);
        bySite.set(cell.siteId, s);
      }
      const names = new Map(att.sites.map((s) => [s.id, s.name]));
      const total = [...bySite.values()].reduce((n, s) => n + s.events, 0);
      let ay = pdf.y;
      ay += pdf.paraAt(`${plural(total, 'unexcused event')} (late, call-out or no-call no-show) across ${plural(bySite.size, 'site')}.`, rx, ay, colW, { size: SIZE.small, color: COLOR.ink2 }) + 6;
      const ranked = [...bySite.entries()].sort((a, b) => b[1].events - a[1].events).slice(0, 6);
      for (const [id, s] of ranked) {
        pdf.textAt(names.get(id) ?? 'Site', rx, ay, { size: SIZE.small, color: COLOR.ink2, width: colW - 120 });
        pdf.textAt(plural(s.events, 'event'), rx + colW - 120, ay, { size: SIZE.small, weight: 'medium', width: 60, align: 'right' });
        const avg = s.per.length ? s.per.reduce((a, b) => a + b, 0) / s.per.length : null;
        pdf.textAt(avg !== null ? `${avg.toFixed(1)} per 100 shifts` : '', rx + colW - 60, ay, { size: SIZE.micro + 0.5, color: COLOR.ink3, width: 60, align: 'right' });
        ay += 13;
        pdf.ruleAt(rx, ay - 3, colW, COLOR.rule, 0.3);
      }
    } else {
      pdf.paraAt(people ? 'No unexcused attendance events in the last eight weeks.' : 'The attendance figures could not be read for this pack.', rx, pdf.y, colW, { size: SIZE.small, color: COLOR.ink3 });
    }
  }

  /* ----------------------------------------------------- 6 Risk register */
  startSection('Risk register', 'What could hurt the plan, who owns it, which way it is moving');
  {
    const list = risks?.risks ?? [];
    const high = list.filter((r) => r.severity === 'high').length;
    pdf.sectionTitle('Risk register', 'Risks the board should know', list.length ? `${plural(list.length, 'open risk')}, ${high} of them high. Highest severity first.` : 'No open risks were found when this pack was prepared.');
    if (list.length) {
      const cols = [
        { label: 'Severity', w: 70 },
        { label: 'Risk', w: 250 },
        { label: 'Owner', w: 68 },
        { label: 'Trend', w: 50 },
        { label: 'Measure', w: W - 70 - 250 - 68 - 50 },
      ];
      const xs: number[] = [];
      let x = L;
      for (const c of cols) {
        xs.push(x);
        x += c.w;
      }
      const header = () => {
        const hy = pdf.y;
        pdf.box(L, hy, W, 20, COLOR.wash);
        cols.forEach((c, i) => pdf.textAt(c.label, xs[i]! + 6, hy + 6.5, { size: SIZE.label, weight: 'medium', color: COLOR.ink3, caps: true, width: c.w - 10 }));
        pdf.ruleAt(L, hy + 20, W, COLOR.ruleStrong, 0.6);
        pdf.y = hy + 20;
      };
      header();
      const SEV = { high: { word: 'High', color: COLOR.bad }, medium: { word: 'Medium', color: COLOR.warn }, low: { word: 'Low', color: CHART.slate } } as const;
      const TREND = { rising: 'Rising', steady: 'Steady', easing: 'Easing', new: 'New' } as const;
      for (const r of list) {
        const detailH = pdf.heightOf(r.detail, cols[1]!.w - 12, { size: SIZE.small, lineGap: 1 });
        const titleH = pdf.heightOf(r.title, cols[1]!.w - 12, { size: SIZE.body, weight: 'semibold', lineGap: 1 });
        const metricH = r.metric ? pdf.heightOf(r.metric, cols[4]!.w - 12, { size: SIZE.small, lineGap: 1 }) : 0;
        const h = Math.max(titleH + detailH + 18, metricH + 16, 30);
        if (pdf.y + h > pdf.bottom) {
          pdf.newPage();
          header();
        }
        const y = pdf.y;
        pdf.dot(xs[0]! + 10, y + 12, 3.4, SEV[r.severity].color);
        pdf.textAt(SEV[r.severity].word, xs[0]! + 18, y + 8, { size: SIZE.small + 0.5, weight: 'semibold', width: cols[0]!.w - 22 });
        pdf.paraAt(r.title, xs[1]! + 6, y + 7, cols[1]!.w - 12, { size: SIZE.body, weight: 'semibold', lineGap: 1 });
        pdf.paraAt(r.detail, xs[1]! + 6, y + 9 + titleH, cols[1]!.w - 12, { size: SIZE.small, color: COLOR.ink2, lineGap: 1 });
        pdf.textAt(r.owner, xs[2]! + 6, y + 8, { size: SIZE.small + 0.5, width: cols[2]!.w - 10 });
        pdf.textAt(TREND[r.trend] ?? r.trend, xs[3]! + 6, y + 8, { size: SIZE.small + 0.5, width: cols[3]!.w - 10 });
        if (r.metric) pdf.paraAt(r.metric, xs[4]! + 6, y + 8, cols[4]!.w - 12, { size: SIZE.small, color: COLOR.ink2, lineGap: 1 });
        pdf.y = y + h;
        pdf.ruleAt(L, pdf.y, W, COLOR.rule, 0.4);
      }
    } else if (!risks) {
      pdf.para('The risk register could not be read for this pack.', { muted: true });
    }
  }

  /* ---------------------------------------------------------- 7 Appendix */
  startSection('Appendix', 'The eight-week trend, definitions, rates and basis');
  pdf.sectionTitle('Appendix', 'Trends, definitions and basis');
  {
    pdf.subheading('Eight-week trend', 'Complete weeks, oldest first');
    const weeks = fin.weeks.slice(-8);
    const wf = o.scorecard.find((x) => x.id === 'workforce');
    const fill = o.scorecard.find((x) => x.id === 'fillRate');
    const off = fin.weeks.length - weeks.length;
    pdf.table(
      [
        { label: 'Week of', width: 70 },
        { label: 'Paid hours', width: 64, align: 'right' },
        { label: 'Overtime', width: 60, align: 'right' },
        { label: 'Billed', width: 72, align: 'right' },
        { label: 'Margin', width: 66, align: 'right' },
        { label: 'Margin %', width: 58, align: 'right' },
        { label: 'Fill', width: 54, align: 'right' },
        { label: 'Active', align: 'right' },
      ],
      weeks.map((w, i) => {
        const fv = fill?.trend[off + i]?.value ?? null;
        const av = wf?.trend[off + i]?.value ?? null;
        return [fmtDay(w.start), wholeHours(w.hours), wholeHours(w.otHours), wholeDollars(w.billed), wholeDollars(w.margin), w.marginPct !== null ? `${w.marginPct.toFixed(1)}%` : '—', fv !== null ? `${fv.toFixed(1)}%` : '—', av !== null ? Math.round(av).toLocaleString('en-US') : '—'];
      }),
    );

    pdf.subheading('Definitions');
    for (const k of o.scorecard) {
      const h = pdf.heightOf(k.definition, W - 130, { size: SIZE.small + 0.5, lineGap: 1.5 });
      pdf.ensure(h + 8);
      const y = pdf.y;
      pdf.textAt(k.label, L, y, { size: SIZE.small + 0.5, weight: 'semibold', width: 122 });
      pdf.paraAt(k.definition, L + 130, y, W - 130, { size: SIZE.small + 0.5, color: COLOR.ink2, lineGap: 1.5 });
      pdf.y = y + h + 7;
    }

    pdf.y = pdf.y + 6;
    pdf.subheading('Rates and basis');
    for (const n of [ratesNote(fin.rates), workweekNote(), ...o.notes.slice(2)]) pdf.para(n, { size: SIZE.small + 0.5 });
  }

  /* ----------------------------------------------------- cover contents */
  pdf.onPage(coverIndex, () => {
    let y = contentsTop;
    sections.forEach((s, i) => {
      pdf.textAt(String(i + 1).padStart(2, '0'), L, y, { size: SIZE.small, weight: 'semibold', color: CHART.gold });
      pdf.textAt(s.title, L + 26, y - 1, { size: SIZE.body + 1, weight: 'semibold', width: W - 90 });
      pdf.textAt(s.note, L + 26, y + 12, { size: SIZE.small, color: COLOR.ink3, width: W - 90 });
      pdf.textAt(`Page ${s.page}`, L + W - 60, y, { size: SIZE.small, weight: 'medium', color: COLOR.ink2, width: 60, align: 'right' });
      pdf.ruleAt(L + 26, y + 26, W - 26, COLOR.rule, 0.4);
      y += 33;
    });
  });

  return pdf.render();
}
