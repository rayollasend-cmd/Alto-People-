import { createHash } from 'node:crypto';
import type { PayrollRun, PayrollRunKind, Prisma, PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';
import { HttpError } from '../middleware/error.js';
import { loadApprovalPolicy, rolesHolding, secondPersonExists } from './approvalPolicy.js';
import { enqueueAudit } from './audit.js';
import { notifyUser } from './notify.js';
import { tenantIdForWrite } from './tenant.js';
import { runTotalsChecks } from './payrollRunTotals.js';

/**
 * The pre-payroll review. Before a run's money moves, an accountant reads
 * one report: every paycheck line by line, the totals by department and
 * state, the cash the run needs, the taxes it owes, and what changed since
 * each person's last paycheck (the biggest swings first). They sign off on
 * that exact version of the numbers.
 *
 * A sign-off is pinned by fingerprint, a hash of every paycheck's amounts.
 * Change any amount after the sign-off (an add-on, a recalculation, a voided
 * line) and the fingerprint no longer matches: the sign-off goes stale and
 * the run can't be paid until someone reviews it again.
 *
 * The rule a second person signs holds where one exists (lib/approvalPolicy):
 * a one-person payroll team signs its own run, and the record says so.
 * Daily settlements and manual checks are exempt: one is automatic each
 * night, the other was already paid by hand.
 */

type Db = PrismaClient | Prisma.TransactionClient;

/** Runs a person reviews before they pay out. */
export const REVIEWED_KINDS: PayrollRunKind[] = ['REGULAR', 'OFF_CYCLE', 'AMENDMENT'];

/** A paycheck worth a second look: net moved this much (share) and at least this many dollars. */
export const SWING_SHARE = 0.25;
export const SWING_MIN_DOLLARS = 100;

export type ReviewFlag = 'FIRST_PAYCHECK' | 'NET_UP' | 'NET_DOWN' | 'GROSS_SWING' | 'ZERO_NET' | 'NO_FICA' | 'NO_FEDERAL';

export const FLAG_LABEL: Record<ReviewFlag, string> = {
  FIRST_PAYCHECK: 'First paycheck',
  NET_UP: 'Net pay up sharply',
  NET_DOWN: 'Net pay down sharply',
  GROSS_SWING: 'Gross pay swung sharply',
  ZERO_NET: 'Nothing left to pay',
  NO_FICA: 'No Social Security or Medicare withheld',
  NO_FEDERAL: 'No federal income tax withheld',
};

export interface ReviewRow {
  itemId: string;
  associateId: string;
  name: string;
  department: string | null;
  state: string | null;
  type: 'W2' | 'CONTRACTOR';
  hours: number;
  rate: number;
  gross: number;
  preTax: number;
  federal: number;
  socialSecurity: number;
  medicare: number;
  stateTax: number;
  localTax: number;
  /** State disability and paid-leave contributions withheld (CA SDI, NJ TDI/FLI, NY PFL, WA PFML …). */
  stateProgram: number;
  postTax: number;
  other: number;
  reimbursements: number;
  net: number;
  employerTaxes: number;
  prior: { gross: number; net: number; periodEnd: string } | null;
  netChange: number | null;
  netChangeShare: number | null;
  flags: ReviewFlag[];
}

export interface ReviewGroup {
  name: string;
  people: number;
  gross: number;
  net: number;
  employerTaxes: number;
}

export interface PayrollReviewReport {
  company: string;
  generatedAt: string;
  fingerprint: string;
  run: {
    id: string;
    status: PayrollRun['status'];
    kind: PayrollRunKind;
    clientName: string | null;
    periodStart: string;
    periodEnd: string;
    createdByName: string | null;
    createdAt: string;
    finalizedAt: string | null;
    /** The gross stored on the run itself — beside the paychecks so a run with money and no checks is seen (finance walk 11). */
    storedGross: number;
    /** The net stored on the run itself. */
    storedNet?: number;
    /** Stored totals and paycheck totals agree to the cent (lib/payrollRunTotals) — false: don't sign off. */
    totalsAgree?: boolean;
  };
  totals: {
    people: number;
    contractors: number;
    hours: number;
    gross: number;
    preTax: number;
    employeeTaxes: number;
    postTax: number;
    other: number;
    reimbursements: number;
    net: number;
    employerTaxes: number;
    employerCost: number;
  };
  cash: { lines: Array<{ key: string; label: string; amount: number }>; total: number };
  taxes: { employee: Array<{ key: string; label: string; amount: number }>; employer: Array<{ key: string; label: string; amount: number }>; total: number };
  byDepartment: ReviewGroup[];
  byState: ReviewGroup[];
  previous: { runId: string; periodStart: string; periodEnd: string; people: number; gross: number; net: number; employerTaxes: number } | null;
  flagCounts: Partial<Record<ReviewFlag, number>>;
  rows: ReviewRow[];
  /** Paychecks set to pay by paper check this time (lib/paperChecks). How they're paid, not how much: outside the fingerprint. */
  payByCheck?: Array<{ itemId: string; name: string; reason: string; net: number }>;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (d: Prisma.Decimal | number | null | undefined) => (d == null ? 0 : Number(d));
const ymd = (d: Date) => d.toISOString().slice(0, 10);

const ITEM_SELECT = {
  id: true,
  associateId: true,
  status: true,
  hoursWorked: true,
  hourlyRate: true,
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
  employerFica: true,
  employerMedicare: true,
  employerFuta: true,
  employerSuta: true,
  preTaxRetirement: true,
  taxState: true,
  // State disability / paid-leave contributions (CA SDI, NJ TDI/FLI, WA PFML …) live on the engine's lines.
  taxLines: { where: { kind: 'STATE_PROGRAM' }, select: { amount: true, employer: true } },
} satisfies Prisma.PayrollItemSelect;

type ItemRow = Prisma.PayrollItemGetPayload<{ select: typeof ITEM_SELECT }>;

/**
 * The fingerprint of a run's numbers: every live paycheck's amounts, in a
 * stable order. Status changes that move no money (held, sent) leave it be.
 */
export function reviewFingerprint(items: ItemRow[]): string {
  const lines = items
    .filter((i) => i.status !== 'VOIDED')
    .map((i) =>
      [
        i.id,
        i.associateId,
        num(i.hoursWorked).toFixed(2),
        num(i.grossPay).toFixed(2),
        num(i.federalWithholding).toFixed(2),
        num(i.fica).toFixed(2),
        num(i.medicare).toFixed(2),
        num(i.stateWithholding).toFixed(2),
        num(i.localWithholding).toFixed(2),
        num(i.preTaxDeductions).toFixed(2),
        num(i.postTaxDeductions).toFixed(2),
        num(i.reimbursementsTotal).toFixed(2),
        num(i.netPay).toFixed(2),
        num(i.employerFica).toFixed(2),
        num(i.employerMedicare).toFixed(2),
        num(i.employerFuta).toFixed(2),
        num(i.employerSuta).toFixed(2),
      ].join('|'),
    )
    .sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/** Just the fingerprint, without building the whole report (the payout gate, the inbox). */
export async function currentFingerprint(db: Db, runId: string): Promise<string> {
  const items = await db.payrollItem.findMany({ where: { payrollRunId: runId }, select: ITEM_SELECT });
  return reviewFingerprint(items);
}

export async function buildPayrollReview(db: Db, runId: string): Promise<PayrollReviewReport> {
  const run = await db.payrollRun.findUniqueOrThrow({
    where: { id: runId },
    include: { client: { select: { name: true } }, createdBy: { select: { email: true } } },
  });
  const [items, org, people] = await Promise.all([
    db.payrollItem.findMany({ where: { payrollRunId: runId }, select: ITEM_SELECT }),
    db.orgSetting.findFirst({ where: { tenantId: run.tenantId ?? tenantIdForWrite() }, select: { orgName: true } }),
    db.payrollItem
      .findMany({
        where: { payrollRunId: runId, status: { not: 'VOIDED' } },
        select: { associateId: true, associate: { select: { firstName: true, lastName: true, employmentType: true, department: { select: { name: true } } } } },
      })
      .then((rows) => new Map(rows.map((r) => [r.associateId, r.associate]))),
  ]);
  const live = items.filter((i) => i.status !== 'VOIDED');

  // Each person's last paycheck before this period, from a run that was locked.
  const priorItems = live.length
    ? await db.payrollItem.findMany({
        where: {
          associateId: { in: live.map((i) => i.associateId) },
          status: { not: 'VOIDED' },
          payrollRunId: { not: run.id },
          payrollRun: { kind: 'REGULAR', status: { in: ['FINALIZED', 'DISBURSED'] }, periodEnd: { lt: run.periodStart } },
        },
        select: { associateId: true, grossPay: true, netPay: true, payrollRun: { select: { periodEnd: true } } },
        orderBy: { payrollRun: { periodEnd: 'desc' } },
      })
    : [];
  const prior = new Map<string, (typeof priorItems)[number]>();
  for (const p of priorItems) if (!prior.has(p.associateId)) prior.set(p.associateId, p);

  const rows: ReviewRow[] = live.map((i) => {
    const who = people.get(i.associateId);
    const contractor = who?.employmentType === 'CONTRACTOR_1099_INDIVIDUAL' || who?.employmentType === 'CONTRACTOR_1099_BUSINESS';
    const gross = num(i.grossPay);
    const preTax = num(i.preTaxDeductions);
    const federal = num(i.federalWithholding);
    const ss = num(i.fica);
    const medicare = num(i.medicare);
    const stateTax = num(i.stateWithholding);
    const localTax = num(i.localWithholding);
    const postTax = num(i.postTaxDeductions);
    const reimbursements = num(i.reimbursementsTotal);
    const net = num(i.netPay);
    const stateProgram = round2(i.taxLines.filter((l) => !l.employer).reduce((a, l) => a + num(l.amount), 0));
    const employerProgram = round2(i.taxLines.filter((l) => l.employer).reduce((a, l) => a + num(l.amount), 0));
    // Whatever else came out of the check (garnishments, ride charges, an
    // advance recovered) so each row adds up exactly: gross + reimbursements
    // − taxes − deductions − other = net.
    const other = round2(Math.max(0, gross + reimbursements - federal - ss - medicare - stateTax - localTax - stateProgram - preTax - postTax - net));
    const employerTaxes = round2(num(i.employerFica) + num(i.employerMedicare) + num(i.employerFuta) + num(i.employerSuta) + employerProgram);
    const p = prior.get(i.associateId);
    const priorNet = p ? num(p.netPay) : null;
    const priorGross = p ? num(p.grossPay) : null;
    const netChange = priorNet == null ? null : round2(net - priorNet);
    const netChangeShare = priorNet == null || priorNet === 0 ? null : round2((net - priorNet) / Math.abs(priorNet) * 1000) / 1000;
    const flags: ReviewFlag[] = [];
    if (!p) flags.push('FIRST_PAYCHECK');
    if (netChange != null && Math.abs(netChange) >= SWING_MIN_DOLLARS && (netChangeShare == null || Math.abs(netChangeShare) >= SWING_SHARE)) {
      flags.push(netChange > 0 ? 'NET_UP' : 'NET_DOWN');
    } else if (priorGross != null) {
      const gChange = gross - priorGross;
      if (Math.abs(gChange) >= SWING_MIN_DOLLARS && priorGross > 0 && Math.abs(gChange) / priorGross >= SWING_SHARE) flags.push('GROSS_SWING');
    }
    if (gross > 0 && net <= 0) flags.push('ZERO_NET');
    if (!contractor && gross > 0 && ss + medicare === 0) flags.push('NO_FICA');
    if (!contractor && gross >= 500 && federal === 0) flags.push('NO_FEDERAL');
    return {
      itemId: i.id,
      associateId: i.associateId,
      name: who ? `${who.firstName} ${who.lastName}` : 'Unknown',
      department: who?.department?.name ?? null,
      state: i.taxState,
      type: contractor ? 'CONTRACTOR' : 'W2',
      hours: num(i.hoursWorked),
      rate: num(i.hourlyRate),
      gross,
      preTax,
      federal,
      socialSecurity: ss,
      medicare,
      stateTax,
      localTax,
      stateProgram,
      postTax,
      other,
      reimbursements,
      net,
      employerTaxes,
      prior: p ? { gross: priorGross!, net: priorNet!, periodEnd: ymd(p.payrollRun.periodEnd) } : null,
      netChange,
      netChangeShare,
      flags,
    };
  });
  // Swings first (largest change), then everyone else by name.
  rows.sort((a, b) => {
    const fa = a.flags.length > 0 ? 1 : 0;
    const fb = b.flags.length > 0 ? 1 : 0;
    if (fa !== fb) return fb - fa;
    const da = Math.abs(a.netChange ?? 0);
    const dbb = Math.abs(b.netChange ?? 0);
    if (da !== dbb) return dbb - da;
    return a.name.localeCompare(b.name);
  });

  const sum = (f: (r: ReviewRow) => number) => round2(rows.reduce((s, r) => s + f(r), 0));
  const fed = sum((r) => r.federal);
  const ss = sum((r) => r.socialSecurity);
  const med = sum((r) => r.medicare);
  const st = sum((r) => r.stateTax);
  const loc = sum((r) => r.localTax);
  const pgm = sum((r) => r.stateProgram);
  const erPgm = round2(live.reduce((s, i) => s + i.taxLines.filter((l) => l.employer).reduce((a, l) => a + num(l.amount), 0), 0));
  const erFica = round2(live.reduce((s, i) => s + num(i.employerFica), 0));
  const erMed = round2(live.reduce((s, i) => s + num(i.employerMedicare), 0));
  const erFuta = round2(live.reduce((s, i) => s + num(i.employerFuta), 0));
  const erSuta = round2(live.reduce((s, i) => s + num(i.employerSuta), 0));
  const employeeTaxes = round2(fed + ss + med + st + loc + pgm);
  const employerTaxes = round2(erFica + erMed + erFuta + erSuta + erPgm);
  const gross = sum((r) => r.gross);
  const net = sum((r) => r.net);

  // What leaves the bank because of this run: pay, every tax (both halves), and money owed onward.
  const garnishments = round2(
    num((await db.garnishmentDeduction.aggregate({ where: { payrollRunId: run.id }, _sum: { amount: true } }))._sum.amount),
  );
  const retirement = round2(live.reduce((s, i) => s + num(i.preTaxRetirement), 0));
  const cashLines = [
    { key: 'net', label: 'Net pay to people', amount: net },
    { key: 'employeeTaxes', label: 'Taxes withheld from pay', amount: employeeTaxes },
    { key: 'employerTaxes', label: 'Employer taxes', amount: employerTaxes },
    ...(garnishments > 0 ? [{ key: 'garnishments', label: 'Garnishments to send to agencies', amount: garnishments }] : []),
    ...(retirement > 0 ? [{ key: 'retirement', label: 'Retirement contributions to send', amount: retirement }] : []),
  ];

  const group = (key: (r: ReviewRow) => string): ReviewGroup[] => {
    const m = new Map<string, ReviewGroup>();
    for (const r of rows) {
      const k = key(r);
      const g = m.get(k) ?? { name: k, people: 0, gross: 0, net: 0, employerTaxes: 0 };
      g.people += 1;
      g.gross = round2(g.gross + r.gross);
      g.net = round2(g.net + r.net);
      g.employerTaxes = round2(g.employerTaxes + r.employerTaxes);
      m.set(k, g);
    }
    return [...m.values()].sort((a, b) => b.gross - a.gross);
  };

  // The last locked regular run for the same client, for the run-level comparison.
  const prev = await db.payrollRun.findFirst({
    where: { id: { not: run.id }, clientId: run.clientId, kind: 'REGULAR', status: { in: ['FINALIZED', 'DISBURSED'] }, periodEnd: { lt: run.periodStart } },
    orderBy: { periodEnd: 'desc' },
    select: { id: true, periodStart: true, periodEnd: true, totalGross: true, totalNet: true, totalEmployerTax: true, _count: { select: { items: { where: { status: { not: 'VOIDED' } } } } } },
  });

  const overrides = await db.payrollItemPayoutOverride.findMany({ where: { clearedAt: null, payrollItem: { payrollRunId: run.id } }, select: { payrollItemId: true, reason: true } });
  const rowByItem = new Map(rows.map((r) => [r.itemId, r]));
  const payByCheck = overrides
    .filter((o) => rowByItem.has(o.payrollItemId))
    .map((o) => ({ itemId: o.payrollItemId, name: rowByItem.get(o.payrollItemId)!.name, reason: o.reason, net: rowByItem.get(o.payrollItemId)!.net }));

  const flagCounts: Partial<Record<ReviewFlag, number>> = {};
  for (const r of rows) for (const f of r.flags) flagCounts[f] = (flagCounts[f] ?? 0) + 1;
  const totalsCheck = (await runTotalsChecks(db, [run])).get(run.id)!;

  return {
    company: org?.orgName ?? 'Payroll',
    generatedAt: new Date().toISOString(),
    fingerprint: reviewFingerprint(items),
    run: {
      id: run.id,
      status: run.status,
      kind: run.kind,
      clientName: run.client?.name ?? null,
      periodStart: ymd(run.periodStart),
      periodEnd: ymd(run.periodEnd),
      createdByName: run.createdBy?.email ?? null,
      createdAt: run.createdAt.toISOString(),
      finalizedAt: run.finalizedAt?.toISOString() ?? null,
      storedGross: num(run.totalGross),
      storedNet: num(run.totalNet),
      totalsAgree: totalsCheck.totalsAgree,
    },
    totals: {
      people: rows.length,
      contractors: rows.filter((r) => r.type === 'CONTRACTOR').length,
      hours: sum((r) => r.hours),
      gross,
      preTax: sum((r) => r.preTax),
      employeeTaxes,
      postTax: sum((r) => r.postTax),
      other: sum((r) => r.other),
      reimbursements: sum((r) => r.reimbursements),
      net,
      employerTaxes,
      employerCost: round2(gross + employerTaxes + sum((r) => r.reimbursements)),
    },
    cash: { lines: cashLines, total: round2(cashLines.reduce((s, l) => s + l.amount, 0)) },
    taxes: {
      employee: [
        { key: 'federal', label: 'Federal income tax', amount: fed },
        { key: 'socialSecurity', label: 'Social Security', amount: ss },
        { key: 'medicare', label: 'Medicare', amount: med },
        { key: 'state', label: 'State income tax', amount: st },
        ...(loc > 0 ? [{ key: 'local', label: 'Local income tax', amount: loc }] : []),
        ...(pgm > 0 ? [{ key: 'stateProgram', label: 'State disability & paid leave', amount: pgm }] : []),
      ],
      employer: [
        { key: 'socialSecurity', label: 'Social Security (employer)', amount: erFica },
        { key: 'medicare', label: 'Medicare (employer)', amount: erMed },
        { key: 'futa', label: 'Federal unemployment (FUTA)', amount: erFuta },
        { key: 'suta', label: 'State unemployment (SUTA)', amount: erSuta },
        ...(erPgm > 0 ? [{ key: 'stateProgram', label: 'State paid leave (employer share)', amount: erPgm }] : []),
      ],
      total: round2(employeeTaxes + employerTaxes),
    },
    byDepartment: group((r) => r.department ?? 'No department'),
    byState: group((r) => r.state ?? 'No state'),
    previous: prev
      ? {
          runId: prev.id,
          periodStart: ymd(prev.periodStart),
          periodEnd: ymd(prev.periodEnd),
          people: prev._count.items,
          gross: num(prev.totalGross),
          net: num(prev.totalNet),
          employerTaxes: num(prev.totalEmployerTax),
        }
      : null,
    flagCounts,
    rows,
    payByCheck,
  };
}

/* ---- Sign-off ---------------------------------------------------------- */

export interface SignoffView {
  id: string;
  signedByName: string | null;
  signedAt: string;
  note: string | null;
  soleReviewer: boolean;
}

export interface ReviewState {
  /** The tenant (or the deployment) requires a sign-off before payout, and this kind of run is reviewed. */
  required: boolean;
  /** A sign-off matching the current numbers. */
  current: SignoffView | null;
  /** The latest sign-off, when the numbers changed after it. */
  stale: SignoffView | null;
  history: SignoffView[];
  canSign: boolean;
  cannotSignReason: string | null;
}

export async function reviewRequired(db: Db, run: Pick<PayrollRun, 'kind'>): Promise<boolean> {
  if (!REVIEWED_KINDS.includes(run.kind)) return false;
  if (env.PAYROLL_REQUIRE_SECOND_APPROVAL) return true;
  return (await loadApprovalPolicy(db)).payrollReviewRequired;
}

function view(r: { id: string; signedAt: Date; note: string | null; soleReviewer: boolean; signedBy: { email: string } | null }): SignoffView {
  return { id: r.id, signedByName: r.signedBy?.email ?? null, signedAt: r.signedAt.toISOString(), note: r.note, soleReviewer: r.soleReviewer };
}

/** Why this person can't sign this run, or null when they can. */
async function signBlock(db: Db, run: Pick<PayrollRun, 'status' | 'createdById'>, userId: string): Promise<string | null> {
  if (run.status === 'DISBURSED') return 'This run is already paid.';
  if (run.status === 'CANCELLED') return 'This run was voided.';
  if (run.createdById && run.createdById === userId && (await secondPersonExists(db, 'process:payroll', userId))) {
    return 'You created this run, so someone else who processes payroll signs off on it.';
  }
  return null;
}

export async function reviewState(db: Db, run: Pick<PayrollRun, 'id' | 'kind' | 'status' | 'createdById'>, fingerprint: string, userId: string): Promise<ReviewState> {
  const [required, rows, block] = await Promise.all([
    reviewRequired(db, run),
    db.payrollRunReview.findMany({
      where: { payrollRunId: run.id },
      orderBy: { signedAt: 'desc' },
      take: 10,
      select: { id: true, fingerprint: true, signedAt: true, note: true, soleReviewer: true, signedBy: { select: { email: true } } },
    }),
    signBlock(db, run, userId),
  ]);
  const latest = rows[0] ?? null;
  const current = latest && latest.fingerprint === fingerprint ? view(latest) : null;
  return {
    required,
    current,
    stale: latest && !current ? view(latest) : null,
    history: rows.map(view),
    canSign: !block && !current,
    cannotSignReason: block ?? (current ? 'These numbers are already signed off.' : null),
  };
}

export async function signPayrollReview(
  db: PrismaClient,
  input: { runId: string; userId: string; fingerprint: string; note?: string | null },
): Promise<SignoffView> {
  const run = await db.payrollRun.findUniqueOrThrow({ where: { id: input.runId } });
  const block = await signBlock(db, run, input.userId);
  if (block) throw new HttpError(409, run.createdById === input.userId ? 'self_review' : 'not_reviewable', block);
  const report = await buildPayrollReview(db, run.id);
  if (report.fingerprint !== input.fingerprint) {
    throw new HttpError(409, 'review_changed', 'The numbers changed while you were reviewing. Reload the report and check it again.');
  }
  const latest = await db.payrollRunReview.findFirst({ where: { payrollRunId: run.id }, orderBy: { signedAt: 'desc' }, select: { fingerprint: true } });
  if (latest?.fingerprint === report.fingerprint) throw new HttpError(409, 'already_signed', 'These numbers are already signed off.');
  const sole = !!run.createdById && run.createdById === input.userId;
  const row = await db.$transaction(async (tx) => {
    const created = await tx.payrollRunReview.create({
      data: {
        tenantId: run.tenantId ?? tenantIdForWrite(),
        payrollRunId: run.id,
        fingerprint: report.fingerprint,
        signedById: input.userId,
        note: input.note?.trim() || null,
        soleReviewer: sole,
        totals: { people: report.totals.people, gross: report.totals.gross, net: report.totals.net, cashRequired: report.cash.total } as Prisma.InputJsonValue,
      },
      select: { id: true, signedAt: true, note: true, soleReviewer: true, signedBy: { select: { email: true } } },
    });
    // The sign-off is the run's approval: the existing "approved by" stays true to it.
    await tx.payrollRun.update({ where: { id: run.id }, data: { approvedById: input.userId, approvedAt: created.signedAt } });
    return created;
  });
  enqueueAudit(
    {
      actorUserId: input.userId,
      clientId: run.clientId,
      action: 'payroll.review_signed',
      entityType: 'PayrollRun',
      entityId: run.id,
      metadata: { fingerprint: report.fingerprint, people: report.totals.people, gross: report.totals.gross, net: report.totals.net, cashRequired: report.cash.total, soleReviewer: sole },
    },
    'payrollReview.sign',
  );
  return view(row);
}

/** The payout gate: a run that needs a review pays only with a sign-off on its current numbers. */
export async function assertRunReviewed(db: Db, run: Pick<PayrollRun, 'id' | 'kind'>): Promise<void> {
  if (!(await reviewRequired(db, run))) return;
  const latest = await db.payrollRunReview.findFirst({
    where: { payrollRunId: run.id },
    orderBy: { signedAt: 'desc' },
    select: { fingerprint: true, signedAt: true, signedBy: { select: { email: true } } },
  });
  if (!latest) {
    throw new HttpError(409, 'review_required', 'Someone needs to review this run’s report and sign off before it pays out.');
  }
  if (latest.fingerprint !== (await currentFingerprint(db, run.id))) {
    throw new HttpError(
      409,
      'review_stale',
      `The numbers changed after ${latest.signedBy?.email ?? 'the reviewer'} signed off. Review the report again before paying.`,
    );
  }
}

/** Runs waiting on this person's sign-off: not paid, reviewed kind, no sign-off on today's numbers, and not theirs (unless they're the only one). */
export async function runsAwaitingReview(db: Db, userId: string, where: Prisma.PayrollRunWhereInput): Promise<Array<{ id: string; periodStart: Date; periodEnd: Date }>> {
  if (!(await loadApprovalPolicy(db)).payrollReviewRequired && !env.PAYROLL_REQUIRE_SECOND_APPROVAL) return [];
  const runs = await db.payrollRun.findMany({
    where: { AND: [where, { status: { in: ['DRAFT', 'FINALIZED'] }, kind: { in: REVIEWED_KINDS }, items: { some: {} } }] },
    select: { id: true, periodStart: true, periodEnd: true, createdById: true, reviews: { orderBy: { signedAt: 'desc' }, take: 1, select: { fingerprint: true } } },
    orderBy: { periodEnd: 'asc' },
    take: 25,
  });
  const out: Array<{ id: string; periodStart: Date; periodEnd: Date }> = [];
  let someoneElse: boolean | null = null;
  for (const r of runs) {
    if (r.createdById === userId) {
      someoneElse ??= await secondPersonExists(db, 'process:payroll', userId);
      if (someoneElse) continue;
    }
    const latest = r.reviews[0]?.fingerprint;
    if (latest && latest === (await currentFingerprint(db, r.id))) continue;
    out.push({ id: r.id, periodStart: r.periodStart, periodEnd: r.periodEnd });
  }
  return out;
}

/** Tell the people who can sign that a run is ready for their review. */
export async function notifyReviewers(db: Db, run: Pick<PayrollRun, 'id' | 'kind' | 'createdById' | 'periodStart' | 'periodEnd'>): Promise<void> {
  if (!(await reviewRequired(db, run))) return;
  const roles = rolesHolding('process:payroll');
  const reviewers = await db.user.findMany({
    where: { tenantId: tenantIdForWrite(), status: 'ACTIVE', deletedAt: null, role: { in: roles }, ...(run.createdById ? { id: { not: run.createdById } } : {}) },
    select: { id: true },
    take: 25,
  });
  const ring = reviewers.length ? reviewers.map((r) => r.id) : run.createdById ? [run.createdById] : [];
  for (const id of ring) {
    void notifyUser(id, {
      subject: 'Payroll ready for your review',
      body: `The run for ${ymd(run.periodStart)} to ${ymd(run.periodEnd)} is finalized. Read the review report and sign off so it can pay out.`,
      category: 'payroll',
      linkUrl: `/payroll/runs/${run.id}/review`,
    });
  }
}

