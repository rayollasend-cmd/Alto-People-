import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { employerFor } from './employment.js';
import { decryptString } from './crypto.js';
import type { PaystubData, PaystubEarningLine, PaystubLine } from './paystub.js';
import { emptyDeferrals, readDeferrals, type DeferralRecord } from './retirementDeferrals.js';

/**
 * Single source of truth for turning a PayrollItem into the PaystubData
 * the renderer consumes — used by both the on-demand download route and
 * the email-on-disburse path so the two are always identical. Async
 * because it computes live year-to-date figures (the item only snapshots
 * ytdWages).
 */

const round2 = (n: number) => Math.round(n * 100) / 100;

const EARNING_LABEL: Record<string, string> = {
  REGULAR: 'Regular',
  OVERTIME: 'Overtime',
  DOUBLE_TIME: 'Double time / premium',
  HOLIDAY: 'Holiday',
  SICK: 'Sick',
  VACATION: 'Vacation / PTO',
  BONUS: 'Bonus',
  COMMISSION: 'Commission',
  TIPS: 'Tips',
  REIMBURSEMENT: 'Reimbursement',
  RETRO: 'Retroactive pay',
  PREMIUM: 'Labor-law premium',
};

const ITEM_INCLUDE = {
  payrollRun: {
    include: {
      client: {
        select: {
          name: true,
          legalName: true,
          ein: true,
          addressLine1: true,
          city: true,
          state: true,
          zip: true,
        },
      },
    },
  },
  associate: {
    include: { payoutMethods: { where: { isPrimary: true }, take: 1 }, user: { select: { language: true } } },
  },
  earnings: true,
  deductions: true,
} satisfies Prisma.PayrollItemInclude;

export type PaystubItem = Prisma.PayrollItemGetPayload<{ include: typeof ITEM_INCLUDE }>;

export function paystubItemInclude() {
  return ITEM_INCLUDE;
}

/**
 * Year-to-date through this check: prior DISBURSED items in non-cancelled
 * runs whose period starts before this run's, plus this item itself.
 * Mirrors payrollYtd.ts's inclusion rules (AMENDMENT signed deltas sum
 * naturally; voided/pending excluded) so the stub reconciles with the
 * engine.
 */
type PrismaLike = Pick<PrismaClient, 'payrollItem'>;

export async function computePaystubYtd(
  prisma: PrismaLike,
  item: PaystubItem,
): Promise<Record<string, number>> {
  const year = item.payrollRun.periodStart.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const prior = await prisma.payrollItem.aggregate({
    where: {
      associateId: item.associateId,
      status: 'DISBURSED',
      id: { not: item.id },
      payrollRun: {
        status: { not: 'CANCELLED' },
        periodStart: { gte: yearStart, lt: item.payrollRun.periodStart },
      },
    },
    _sum: {
      grossPay: true,
      federalWithholding: true,
      fica: true,
      medicare: true,
      stateWithholding: true,
      localWithholding: true,
      preTaxDeductions: true,
      postTaxDeductions: true,
      reimbursementsTotal: true,
      netPay: true,
      rideChargesCents: true,
    },
  });
  const s = prior._sum;
  const add = (priorVal: Prisma.Decimal | null, thisVal: Prisma.Decimal) =>
    round2(Number(priorVal ?? 0) + Number(thisVal));
  return {
    gross: add(s.grossPay, item.grossPay),
    fit: add(s.federalWithholding, item.federalWithholding),
    ss: add(s.fica, item.fica),
    medicare: add(s.medicare, item.medicare),
    state: add(s.stateWithholding, item.stateWithholding),
    local: add(s.localWithholding, item.localWithholding),
    preTax: add(s.preTaxDeductions, item.preTaxDeductions),
    postTax: add(s.postTaxDeductions, item.postTaxDeductions),
    rides: round2(((s.rideChargesCents ?? 0) + item.rideChargesCents) / 100),
    reimb: add(s.reimbursementsTotal, item.reimbursementsTotal),
    net: add(s.netPay, item.netPay),
  };
}

/**
 * Year-to-date deferral detail, tips and qualified overtime through this
 * check — the same inclusion rule as computePaystubYtd.
 */
export async function computeDeferralYtd(
  prisma: PrismaLike,
  item: PaystubItem,
): Promise<{ deferrals: DeferralRecord; tips: number; overtime: number }> {
  const year = item.payrollRun.periodStart.getUTCFullYear();
  const prior = await prisma.payrollItem.findMany({
    where: {
      associateId: item.associateId,
      status: 'DISBURSED',
      id: { not: item.id },
      payrollRun: { status: { not: 'CANCELLED' }, periodStart: { gte: new Date(Date.UTC(year, 0, 1)), lt: item.payrollRun.periodStart } },
    },
    select: { deferrals: true, preTaxRetirement: true, qualifiedTips: true, qualifiedOvertime: true },
  });
  const deferrals = emptyDeferrals();
  let tips = 0;
  let overtime = 0;
  for (const row of [...prior, item]) {
    const d = readDeferrals(row.deferrals, Number(row.preTaxRetirement));
    for (const k of Object.keys(deferrals) as Array<keyof DeferralRecord>) {
      if (k !== 'highEarner') (deferrals[k] as number) = round2((deferrals[k] as number) + (d[k] as number));
    }
    tips = round2(tips + Number(row.qualifiedTips ?? 0));
    overtime = round2(overtime + Number(row.qualifiedOvertime ?? 0));
  }
  return { deferrals, tips, overtime };
}

const money2 = (n: number) => `$${n.toFixed(2)}`;

function earningLines(item: PaystubItem): PaystubEarningLine[] {
  // Use the per-kind breakdown, excluding REIMBURSEMENT (shown separately
  // as non-taxable). Fall back to a single synthesized line for older
  // items with no earning rows.
  const taxable = item.earnings.filter((e) => e.kind !== 'REIMBURSEMENT');
  if (taxable.length > 0) {
    return taxable.map((e) => ({
      label: e.notes?.trim() || EARNING_LABEL[e.kind] || e.kind,
      hours: e.hours != null ? Number(e.hours) : null,
      rate: e.rate != null ? Number(e.rate) : null,
      amount: round2(Number(e.amount)),
    }));
  }
  const reimb = Number(item.reimbursementsTotal);
  return [
    {
      label: 'Regular',
      hours: Number(item.hoursWorked) || null,
      rate: Number(item.hourlyRate) || null,
      amount: round2(Number(item.grossPay) - (reimb > 0 ? 0 : 0)),
    },
  ];
}

function payDistribution(item: PaystubItem): PaystubData['payDistribution'] {
  // A deposit the bank returned and the re-send that followed: the stub
  // says so, in the person's own words of where the money went.
  const reroute = (item as { rerouteDetail?: unknown }).rerouteDetail as
    | { returnedAt: string; returnedReason: string; reroutedAt: string; to: string }
    | null
    | undefined;
  if (reroute?.to) {
    return {
      label: `Re-sent to ${reroute.to}`,
      detail: `The original deposit was returned on ${reroute.returnedAt.slice(0, 10)} (${reroute.returnedReason}) and re-sent on ${reroute.reroutedAt.slice(0, 10)}.`,
    };
  }
  const pm = item.associate.payoutMethods[0];
  // Paid by paper check (the company pays by check, payroll chose a check
  // for this payday, or the person has no account): the stub names the check.
  const checkNo = /^CHECK-(\d+)$/.exec(item.disbursementRef ?? '')?.[1];
  if (checkNo) {
    return {
      label: `Paper check #${checkNo}`,
      detail: pm && (pm.branchCardId || pm.accountNumberEnc) ? 'Paid by paper check this payday instead of your usual deposit' : 'Paid by paper check',
    };
  }
  if (!pm) return undefined;
  if (pm.branchCardId) return { label: 'Branch card', detail: 'Loaded to your Branch card' };
  if (pm.accountNumberEnc) {
    let last4 = '';
    try {
      last4 = decryptString(pm.accountNumberEnc).slice(-4);
    } catch {
      /* leave blank if the key rotated */
    }
    const type = pm.accountType === 'SAVINGS' ? 'savings' : 'checking';
    return {
      label: 'Direct deposit',
      detail: `${type[0].toUpperCase()}${type.slice(1)} account${last4 ? ` ending ${last4}` : ''}`,
    };
  }
  return undefined;
}

/**
 * Per-jurisdiction state and local rows with YTD (null when they don't
 * reconcile with the check's withholding), and the state program
 * contributions withheld (CA SDI, NJ TDI/FLI, WA PFML …) as their own named
 * rows — always shown, since no PayrollItem column carries them.
 */
async function jurisdictionTaxLines(prisma: PrismaLike, item: PaystubItem): Promise<{ jurisdictions: PaystubLine[] | null; programs: PaystubLine[] }> {
  const year = item.payrollRun.periodStart.getUTCFullYear();
  const rows = await prisma.payrollItem.findMany({
    where: {
      associateId: item.associateId,
      OR: [
        { id: item.id },
        {
          status: 'DISBURSED',
          payrollRun: { status: { not: 'CANCELLED' }, periodStart: { gte: new Date(Date.UTC(year, 0, 1)), lt: item.payrollRun.periodStart } },
        },
      ],
    },
    select: { id: true, taxLines: { where: { employer: false, kind: { not: 'SUI' } }, select: { code: true, kind: true, label: true, amount: true } } },
  });
  const ytdBy = new Map<string, number>();
  for (const r of rows) for (const l of r.taxLines) ytdBy.set(l.code, round2((ytdBy.get(l.code) ?? 0) + Number(l.amount)));
  const all = rows.find((r) => r.id === item.id)?.taxLines ?? [];
  const programs = all
    .filter((l) => l.kind === 'STATE_PROGRAM' && Number(l.amount) !== 0)
    .map((l) => ({ label: l.label, current: Number(l.amount), ytd: ytdBy.get(l.code) ?? Number(l.amount) }));
  const mine = all.filter((l) => l.kind !== 'STATE_PROGRAM');
  if (mine.length === 0) return { jurisdictions: null, programs };
  const sum = (ls: typeof mine, state: boolean) => round2(ls.filter((l) => (l.kind === 'STATE') === state).reduce((a, l) => a + Number(l.amount), 0));
  if (Math.abs(sum(mine, true) - Number(item.stateWithholding)) > 0.01 || Math.abs(sum(mine, false) - Number(item.localWithholding)) > 0.01) return { jurisdictions: null, programs };
  const jurisdictions = mine
    .filter((l) => Number(l.amount) !== 0 || l.kind === 'STATE')
    .sort((a, b) => (a.kind === 'STATE' ? 0 : 1) - (b.kind === 'STATE' ? 0 : 1))
    .map((l) => ({ label: l.label, current: Number(l.amount), ytd: ytdBy.get(l.code) ?? Number(l.amount) }));
  return { jurisdictions, programs };
}

/** The grouped lines of a check from before itemized deductions (no PayrollItemDeduction rows). */
async function legacyDeductionLines(
  item: PaystubItem,
  ytd: Record<string, number>,
  cur: DeferralRecord,
  dy: { deferrals: DeferralRecord },
): Promise<{ preTaxDeductions: PaystubLine[]; postTaxDeductions: PaystubLine[] }> {
  // Pre-tax deductions by kind: retirement, HSA and FSAs from the check's
  // deferral record; everything else under §125 stays "Health & benefits".
  const preTaxDeductions: PaystubLine[] = [];
  const named: Array<[string, keyof DeferralRecord]> = [
    ['401(k)', 'pre401k'],
    ['403(b)', 'pre403b'],
    ['HSA', 'hsa'],
    ['Health FSA', 'fsa'],
    ['Dependent care FSA', 'dcap'],
  ];
  let namedCur = 0;
  let namedYtd = 0;
  for (const [label, k] of named) {
    const c = cur[k] as number;
    const yv = dy.deferrals[k] as number;
    namedCur += c;
    namedYtd += yv;
    if (c > 0) preTaxDeductions.push({ label, current: c, ytd: yv });
  }
  const otherPreTax = round2(Number(item.preTaxDeductions) - namedCur);
  if (otherPreTax > 0) preTaxDeductions.push({ label: 'Health & benefits', current: otherPreTax, ytd: round2(ytd.preTax - namedYtd) });
  // Roth deferrals are post-tax; they get their own lines.
  const rothLines: PaystubLine[] = [];
  if (cur.roth401k > 0) rothLines.push({ label: 'Roth 401(k)', current: cur.roth401k, ytd: dy.deferrals.roth401k });
  if (cur.roth403b > 0) rothLines.push({ label: 'Roth 403(b)', current: cur.roth403b, ytd: dy.deferrals.roth403b });
  const rothCur = round2(cur.roth401k + cur.roth403b);
  const rothYtd = round2(dy.deferrals.roth401k + dy.deferrals.roth403b);
  // Brief 1A-3: van ride charges are their own line — what this check
  // took, and when the minimum-wage guard held part back, the statement
  // says so in the label. Other post-tax deductions keep their line.
  const rideCurrent = round2(item.rideChargesCents / 100);
  const rideDeferred = round2(item.rideChargesDeferredCents / 100);
  const guard = (item.rideChargeGuard ?? null) as { minimumWageCents?: number; state?: string } | null;
  const otherPostTax = round2(Number(item.postTaxDeductions) - rideCurrent);
  const postTaxDeductions: PaystubLine[] = [...rothLines];
  if (rideCurrent > 0 || rideDeferred > 0) {
    const guardNote =
      rideDeferred > 0 && guard?.minimumWageCents
        ? ` — $${rideDeferred.toFixed(2)} carried to a later check so pay stays at the ${guard.state && guard.state !== 'FEDERAL' ? guard.state + ' ' : ''}minimum wage of $${(guard.minimumWageCents / 100).toFixed(2)}/h`
        : '';
    postTaxDeductions.push({ label: `Van rides${guardNote}`, current: rideCurrent, ytd: ytd.rides });
  }
  // Earned-wage advances this check recovered get their own line; the
  // rest of the post-tax bucket keeps its generic one.
  const ewaRows = await defaultPrisma.earnedWageAdvance.findMany({
    where: { associateId: item.associateId, recoveryLog: { array_contains: [{ runId: item.payrollRunId }] } },
    select: { recoveryLog: true },
  });
  const ewaCurrent = round2(
    ewaRows.reduce((s, r) => {
      const log = Array.isArray(r.recoveryLog) ? (r.recoveryLog as Array<{ runId: string; cents: number }>) : [];
      return s + log.filter((l) => l.runId === item.payrollRunId).reduce((x, l) => x + l.cents, 0) / 100;
    }, 0),
  );
  if (ewaCurrent > 0) {
    postTaxDeductions.push({ label: 'Earned-wage advance repaid', current: ewaCurrent, ytd: ewaCurrent });
  }
  const remainingPostTax = round2(otherPostTax - ewaCurrent - rothCur);
  if (remainingPostTax > 0) {
    postTaxDeductions.push({ label: 'Post-tax deductions', current: remainingPostTax, ytd: round2(ytd.postTax - ytd.rides - ewaCurrent - rothYtd) });
  }


  return { preTaxDeductions, postTaxDeductions };
}

const PRE_ORDER = ['RET_401K', 'RET_403B', 'RET_457B', 'MEDICAL', 'DENTAL', 'VISION', 'HSA', 'HEALTH_FSA', 'DCAP', 'LIFE', 'DISABILITY'];
const POST_ORDER = ['ROTH_401K', 'ROTH_403B', 'RET_LOAN', 'GARNISHMENT', 'GARNISHMENT_FEE', 'UNION_DUES', 'RIDES', 'EWA_RECOVERY', 'AFTER_TAX_OTHER'];
const ER_ORDER = ['ER_401K_MATCH', 'ER_HEALTH', 'ER_HSA'];

/**
 * The check's deduction lines with year-to-date per line: the same plan,
 * order or loan (code + source) summed over this year's paid checks, the
 * same inclusion rule as computePaystubYtd. Run the backfill
 * (scripts/backfill-deduction-lines.ts) so earlier checks count too.
 */
async function itemizedDeductions(prisma: PrismaLike, item: PaystubItem): Promise<{ preTaxDeductions: PaystubLine[]; postTaxDeductions: PaystubLine[]; employer: PaystubLine[] }> {
  const year = item.payrollRun.periodStart.getUTCFullYear();
  const prior = await prisma.payrollItem.findMany({
    where: {
      associateId: item.associateId,
      status: 'DISBURSED',
      id: { not: item.id },
      payrollRun: { status: { not: 'CANCELLED' }, periodStart: { gte: new Date(Date.UTC(year, 0, 1)), lt: item.payrollRun.periodStart } },
    },
    select: { deductions: { select: { code: true, sourceId: true, employeeAmount: true, employerAmount: true } } },
  });
  const key = (l: { code: string; sourceId: string | null }) => `${l.code}|${l.sourceId ?? ''}`;
  const ytdBy = new Map<string, { employee: number; employer: number }>();
  for (const row of prior) {
    for (const l of row.deductions) {
      const k = key(l);
      const v = ytdBy.get(k) ?? { employee: 0, employer: 0 };
      ytdBy.set(k, { employee: round2(v.employee + Number(l.employeeAmount)), employer: round2(v.employer + Number(l.employerAmount)) });
    }
  }
  // Two lines of the same plan or order on one check fold into one row.
  const merged = new Map<string, { code: string; category: string; label: string; employee: number; employer: number; k: string }>();
  for (const l of item.deductions) {
    const k = key(l);
    const m = merged.get(k);
    if (m) {
      m.employee = round2(m.employee + Number(l.employeeAmount));
      m.employer = round2(m.employer + Number(l.employerAmount));
    } else merged.set(k, { code: l.code, category: l.category, label: l.label, employee: Number(l.employeeAmount), employer: Number(l.employerAmount), k });
  }
  const rows = [...merged.values()];
  const rank = (order: string[], code: string) => {
    const i = order.indexOf(code);
    return i === -1 ? order.length : i;
  };
  const rideDeferred = round2(item.rideChargesDeferredCents / 100);
  const guard = (item.rideChargeGuard ?? null) as { minimumWageCents?: number; state?: string } | null;
  const rideNote =
    rideDeferred > 0 && guard?.minimumWageCents
      ? ` — $${rideDeferred.toFixed(2)} carried to a later check so pay stays at the ${guard.state && guard.state !== 'FEDERAL' ? guard.state + ' ' : ''}minimum wage of $${(guard.minimumWageCents / 100).toFixed(2)}/h`
      : '';
  const toLine = (r: (typeof rows)[number], employerSide: boolean): PaystubLine => {
    const prev = ytdBy.get(r.k) ?? { employee: 0, employer: 0 };
    const current = employerSide ? r.employer : r.employee;
    return {
      label: r.code === 'RIDES' ? `${r.label}${rideNote}` : r.label,
      current,
      ytd: round2((employerSide ? prev.employer : prev.employee) + current),
    };
  };
  const pick = (category: string, order: string[]) =>
    rows
      .filter((r) => r.category === category && r.code !== 'ER_TRUMP_ACCOUNT')
      .sort((a, b) => rank(order, a.code) - rank(order, b.code) || a.label.localeCompare(b.label));
  return {
    preTaxDeductions: pick('PRE_TAX', PRE_ORDER).filter((r) => r.employee !== 0).map((r) => toLine(r, false)),
    postTaxDeductions: pick('POST_TAX', POST_ORDER).filter((r) => r.employee !== 0).map((r) => toLine(r, false)),
    // The Trump account contribution is already shown for the record (Box 12 TA).
    employer: pick('EMPLOYER', ER_ORDER).filter((r) => r.employer !== 0).map((r) => toLine(r, true)),
  };
}

export async function buildPaystubDataFromItem(
  prisma: PrismaLike,
  item: PaystubItem,
  issuedAt: Date = new Date(),
): Promise<PaystubData> {
  const ytd = await computePaystubYtd(prisma, item);
  const client = item.payrollRun.client;
  const stateLabel = item.taxState ? `${item.taxState} state income tax` : 'State income tax';

  const taxes: PaystubLine[] = [
    { label: 'Federal income tax', current: Number(item.federalWithholding), ytd: ytd.fit },
    { label: 'Social Security', current: Number(item.fica), ytd: ytd.ss },
    { label: 'Medicare', current: Number(item.medicare), ytd: ytd.medicare },
    { label: stateLabel, current: Number(item.stateWithholding), ytd: ytd.state },
  ];
  if (Number(item.localWithholding) > 0) {
    taxes.push({ label: 'Local income tax', current: Number(item.localWithholding), ytd: ytd.local });
  }
  // The tax engine's lines (lib/taxEngine): each state and local jurisdiction
  // on its own row — when they add up to the check's withholding (an
  // amendment or a pre-engine check keeps the two summary rows).
  const { jurisdictions: byJurisdiction, programs } = await jurisdictionTaxLines(prisma, item);
  if (byJurisdiction) taxes.splice(3, taxes.length - 3, ...byJurisdiction);
  // State disability / paid leave / employee UI: withheld, so a tax row.
  taxes.push(...programs);
  const taxesCurrent = round2(taxes.reduce((a, t) => a + t.current, 0));

  const cur = readDeferrals(item.deferrals, Number(item.preTaxRetirement));
  const dy = await computeDeferralYtd(prisma, item);
  // Itemized (PayrollItemDeduction): every plan, order and loan on its own
  // line with its own year-to-date. A check from before itemizing keeps the
  // grouped lines it always had.
  const itemized = item.deductions.length > 0 ? await itemizedDeductions(prisma, item) : null;
  const { preTaxDeductions, postTaxDeductions } = itemized ?? (await legacyDeductionLines(item, ytd, cur, dy));
  const employerContributions = itemized?.employer ?? [];

  // For the record: the 2026 W-2 Box 12 amounts (OBBBA §§70201, 70202, 70204).
  const informational: PaystubLine[] = [];
  const payYear = item.payrollRun.periodStart.getUTCFullYear();
  if (payYear >= 2026) {
    if (Number(item.qualifiedTips) > 0 || dy.tips > 0) informational.push({ label: 'Tips reported (W-2 box 12 TP)', current: Number(item.qualifiedTips), ytd: dy.tips });
    if (Number(item.qualifiedOvertime) > 0 || dy.overtime > 0) informational.push({ label: 'Qualified overtime premium (W-2 box 12 TT)', current: Number(item.qualifiedOvertime), ytd: dy.overtime });
    if (cur.trumpAccountEmployer > 0 || dy.deferrals.trumpAccountEmployer > 0) informational.push({ label: 'Employer Trump account contribution (W-2 box 12 TA)', current: cur.trumpAccountEmployer, ytd: dy.deferrals.trumpAccountEmployer });
  }
  const notes: string[] = [];
  if (cur.catchUpRoth > 0 && cur.highEarner) notes.push(`Your catch-up contribution of ${money2(cur.catchUpRoth)} was taken as Roth (after tax). Federal law requires this when last year's Social Security wages were over the limit.`);
  if (cur.catchUpStoppedNoRoth > 0) notes.push(`Your catch-up contribution of ${money2(cur.catchUpStoppedNoRoth)} was not taken. Federal law requires it to be Roth for you, and your plan does not offer Roth. Ask HR about your options.`);
  if (cur.limitStopped > 0) notes.push(`${money2(cur.limitStopped)} you elected was not deducted because you reached this year's limit.`);

  // CA Labor Code §246(i): paid sick leave available, on the wage statement.
  const sick = await defaultPrisma.timeOffBalance.findUnique({
    where: { associateId_category: { associateId: item.associateId, category: 'SICK' } },
    select: { balanceMinutes: true },
  });
  const hoursTotal = Number(item.hoursWorked) > 0 ? round2(Number(item.hoursWorked)) : null;

  // Brief 2-1b: the company block is the employer of record. A client that
  // carries no legal facts of its own keeps its name on the stub, as before.
  const employer = await employerFor(defaultPrisma, item.associateId, item.payrollRun.periodEnd);
  const company =
    employer.kind !== 'TENANT' || !client
      ? { name: employer.legalName, addressLine1: employer.addressLine1, city: employer.city, state: employer.state, zip: employer.zip, ein: employer.ein, phone: employer.phone }
      : { name: client.legalName || client.name, addressLine1: client.addressLine1 ?? null, city: client.city ?? null, state: client.state ?? null, zip: client.zip ?? null, ein: client.ein ?? null, phone: employer.phone };
  return {
    company,
    associate: {
      firstName: item.associate.firstName,
      lastName: item.associate.lastName,
      email: item.associate.email,
      addressLine1: item.associate.addressLine1,
      city: item.associate.city,
      state: item.associate.state,
      zip: item.associate.zip,
      employeeId: item.associateId.slice(0, 8).toUpperCase(),
    },
    period: {
      start: ymd(item.payrollRun.periodStart),
      end: ymd(item.payrollRun.periodEnd),
      payDate: item.payrollRun.disbursedAt ? ymd(item.payrollRun.disbursedAt) : null,
    },
    earnings: earningLines(item),
    gross: { current: Number(item.grossPay), ytd: ytd.gross },
    taxes,
    taxesTotal: { current: taxesCurrent, ytd: round2(taxes.reduce((a, t) => a + t.ytd, 0)) },
    preTaxDeductions,
    postTaxDeductions,
    ...(employerContributions.length > 0 ? { employerContributions } : {}),
    ...(Number(item.reimbursementsTotal) > 0
      ? { reimbursements: { current: Number(item.reimbursementsTotal), ytd: ytd.reimb } }
      : {}),
    net: { current: Number(item.netPay), ytd: ytd.net },
    employer: {
      fica: Number(item.employerFica),
      medicare: Number(item.employerMedicare),
      futa: Number(item.employerFuta),
      suta: Number(item.employerSuta),
    },
    payDistribution: payDistribution(item),
    // The statement reads in the person's own language when the renderer has it (English otherwise).
    ...(item.associate.user?.language === 'es' ? { language: 'es' as const } : {}),
    hoursTotal,
    ...(informational.length > 0 ? { informational } : {}),
    ...(sick ? { sickLeave: { availableHours: round2(sick.balanceMinutes / 60) } } : {}),
    ...(notes.length > 0 ? { notes } : {}),
    meta: { runId: item.payrollRunId, itemId: item.id, issuedAt: issuedAt.toISOString() },
    ...(item.payrollRun.kind === 'AMENDMENT' && item.payrollRun.amendsRunId
      ? { amendment: { reason: item.payrollRun.amendmentReason ?? '', sourceRunId: item.payrollRun.amendsRunId } }
      : {}),
    ...(item.payrollRun.status === 'CANCELLED' || item.status === 'VOIDED'
      ? {
          voided: {
            voidedAt: (item.payrollRun.cancelledAt ?? item.voidedAt ?? new Date()).toISOString(),
            reason: item.payrollRun.cancelReason,
          },
        }
      : {}),
  };
}

/** Load the item with the full include and build its PaystubData. */
export async function buildPaystubDataById(
  prisma: Pick<PrismaClient, 'payrollItem'>,
  itemId: string,
  issuedAt: Date = new Date(),
): Promise<{ item: PaystubItem; data: PaystubData } | null> {
  const item = await prisma.payrollItem.findUnique({
    where: { id: itemId },
    include: ITEM_INCLUDE,
  });
  if (!item) return null;
  return { item, data: await buildPaystubDataFromItem(prisma, item, issuedAt) };
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

