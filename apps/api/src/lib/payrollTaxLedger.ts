import { Prisma, type PrismaClient, type TaxAgencyAccount, type TaxAgencyKind, type TaxPayment } from '@prisma/client';
import { HttpError } from '../middleware/error.js';
import { enqueueAudit } from './audit.js';
import { createApprovalRequest, registerApplyHandler } from './approvalRequests.js';
import { secondPersonExists } from './approvalPolicy.js';
import { filingMode, withProvider } from './embeddedPayroll/index.js';
import { depositDue, isDepositFrequency, quarterLabel, type DepositFrequency } from './payrollTaxCalendar.js';
import { tenantIdForWrite } from './tenant.js';
import { booksAfterTaxPayment } from './books/posting/hooks.js';

/**
 * The payroll-tax liability ledger.
 *
 * Every disbursed run posts what it owes each agency — the IRS for the 941
 * (income tax withheld plus both halves of Social Security and Medicare)
 * and the 940 (FUTA), each state's withholding and unemployment accounts,
 * each local — with the due date that agency's deposit schedule gives.
 * Payments settle liabilities: through the connected embedded payroll
 * provider (a second person approves, because it moves money), or in
 * house, where the customer pays on EFTPS or the agency's site and records
 * the confirmation. A liability that arrives in a state with no account
 * opens one "waiting on registration", which is the register-in-a-new-state
 * checklist.
 *
 * Posting is idempotent (one row per run × agency) and never touches a row
 * already scheduled or paid.
 */

type Db = PrismaClient | Prisma.TransactionClient;

const round2 = (n: number) => Math.round(n * 100) / 100;
const NEXT_DAY_THRESHOLD = 100_000;

export const STATE_NAMES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine',
  MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', PR: 'Puerto Rico',
};

/** States with no wage income tax: no withholding account to open there. */
export const NO_INCOME_TAX_STATES = new Set(['AK', 'FL', 'NV', 'NH', 'SD', 'TN', 'TX', 'WA', 'WY']);

export const KIND_LABEL: Record<TaxAgencyKind, string> = {
  FEDERAL_WITHHOLDING: 'Federal withholding and FICA (941)',
  FEDERAL_UNEMPLOYMENT: 'Federal unemployment (940)',
  STATE_WITHHOLDING: 'State withholding',
  STATE_UNEMPLOYMENT: 'State unemployment',
  LOCAL: 'Local tax',
};

/** The agency's name as a person reads it. */
export function agencyNameFor(kind: TaxAgencyKind, jurisdiction: string): string {
  if (kind === 'FEDERAL_WITHHOLDING' || kind === 'FEDERAL_UNEMPLOYMENT') return 'Internal Revenue Service';
  if (kind === 'LOCAL') {
    const [st, name] = jurisdiction.split(':');
    return `${name ?? jurisdiction}${st ? `, ${STATE_NAMES[st] ?? st}` : ''}`;
  }
  const state = STATE_NAMES[jurisdiction] ?? jurisdiction;
  return kind === 'STATE_WITHHOLDING' ? `${state} withholding` : `${state} unemployment insurance`;
}

/** The schedule an account starts on before the customer sets the agency's own. */
async function defaultFrequency(db: Db, kind: TaxAgencyKind): Promise<DepositFrequency> {
  if (kind === 'FEDERAL_WITHHOLDING') {
    const profile = await db.submitterProfile.findUnique({ where: { tenantId: tenantIdForWrite() }, select: { depositSchedule: true } });
    return profile?.depositSchedule === 'SEMIWEEKLY' ? 'SEMIWEEKLY' : 'MONTHLY';
  }
  if (kind === 'STATE_WITHHOLDING') return 'MONTHLY';
  return 'QUARTERLY';
}

/** The employer of record a run's tax belongs to: the client's own when it has one, else the tenant's default. */
/** The employer a client's pay belongs to: its own employer record, else the tenant's default. */
export async function employerFor(db: Db, clientId: string | null): Promise<string | null> {
  if (clientId) {
    const own = await db.employerOrganization.findFirst({ where: { tenantId: tenantIdForWrite(), clientId }, select: { id: true } });
    if (own) return own.id;
  }
  const def = await db.employerOrganization.findFirst({ where: { tenantId: tenantIdForWrite(), isDefault: true }, select: { id: true } });
  return def?.id ?? null;
}

/** The account for an agency, opening one (waiting on registration, except the IRS) when the employer has none. */
export async function resolveAccount(db: Db, employerOrgId: string | null, kind: TaxAgencyKind, jurisdiction: string): Promise<TaxAgencyAccount> {
  const found = await db.taxAgencyAccount.findFirst({
    where: { tenantId: tenantIdForWrite(), kind, jurisdiction, employerOrgId, status: { in: ['ACTIVE', 'PENDING_REGISTRATION'] } },
    orderBy: { createdAt: 'asc' },
  });
  if (found) return found;
  const federal = kind === 'FEDERAL_WITHHOLDING' || kind === 'FEDERAL_UNEMPLOYMENT';
  return db.taxAgencyAccount.create({
    data: {
      tenantId: tenantIdForWrite(),
      employerOrgId,
      kind,
      jurisdiction,
      agencyName: agencyNameFor(kind, jurisdiction),
      depositFrequency: await defaultFrequency(db, kind),
      status: federal ? 'ACTIVE' : 'PENDING_REGISTRATION',
    },
  });
}

export function dueFor(account: TaxAgencyAccount, payday: Date, amount: number): Date {
  if (account.kind === 'FEDERAL_WITHHOLDING' && amount >= NEXT_DAY_THRESHOLD) return depositDue(payday, 'NEXT_DAY');
  const freq = isDepositFrequency(account.depositFrequency) ? account.depositFrequency : 'MONTHLY';
  return depositDue(payday, freq, account.dueDayOfMonth);
}

interface Posting {
  kind: TaxAgencyKind;
  jurisdiction: string;
  amount: number;
  breakdown: Record<string, number | boolean | string>;
}

/** What one run owes, grouped by agency. Exported for tests. */
export function postingsFor(items: Array<{
  federalWithholding: Prisma.Decimal | number;
  fica: Prisma.Decimal | number;
  medicare: Prisma.Decimal | number;
  employerFica: Prisma.Decimal | number;
  employerMedicare: Prisma.Decimal | number;
  employerFuta: Prisma.Decimal | number;
  employerSuta: Prisma.Decimal | number;
  stateWithholding: Prisma.Decimal | number;
  localWithholding: Prisma.Decimal | number;
  taxState: string | null;
  localJurisdiction?: string | null;
  /**
   * The tax engine's per-jurisdiction lines for this check (PayrollItemTaxLine).
   * When present they decide where state, local and program money is owed —
   * a two-state worker owes two states — instead of the check's one taxState.
   */
  lines?: Array<{ kind: string; code: string; label: string; workState: string | null; amount: Prisma.Decimal | number; employer: boolean }>;
}>): Posting[] {
  const n = (v: Prisma.Decimal | number) => Number(v);
  const out: Posting[] = [];
  const fit = round2(items.reduce((a, i) => a + n(i.federalWithholding), 0));
  const ssEe = round2(items.reduce((a, i) => a + n(i.fica), 0));
  const ssEr = round2(items.reduce((a, i) => a + n(i.employerFica), 0));
  const medEe = round2(items.reduce((a, i) => a + n(i.medicare), 0));
  const medEr = round2(items.reduce((a, i) => a + n(i.employerMedicare), 0));
  const fed = round2(fit + ssEe + ssEr + medEe + medEr);
  if (fed > 0) out.push({ kind: 'FEDERAL_WITHHOLDING', jurisdiction: 'US', amount: fed, breakdown: { federalIncomeTax: fit, socialSecurityEmployee: ssEe, socialSecurityEmployer: ssEr, medicareEmployee: medEe, medicareEmployer: medEr } });
  const futa = round2(items.reduce((a, i) => a + n(i.employerFuta), 0));
  if (futa > 0) out.push({ kind: 'FEDERAL_UNEMPLOYMENT', jurisdiction: 'US', amount: futa, breakdown: { futa } });

  const byState = new Map<string, { wh: number; sui: number; pgm: number; people: number }>();
  const byLocal = new Map<string, { amount: number; people: number }>();
  const stateOf = (l: { code: string; workState: string | null }) => (l.workState ?? l.code.slice(0, 2)).toUpperCase().trim();
  const addState = (st: string, wh: number, sui: number, seen: Set<string>, pgm = 0) => {
    if (!st) return;
    const cur = byState.get(st) ?? { wh: 0, sui: 0, pgm: 0, people: 0 };
    cur.wh += wh;
    cur.sui += sui;
    cur.pgm += pgm;
    if (!seen.has(`S:${st}`)) {
      cur.people += 1;
      seen.add(`S:${st}`);
    }
    byState.set(st, cur);
  };
  const addLocal = (key: string, amount: number, seen: Set<string>) => {
    const cur = byLocal.get(key) ?? { amount: 0, people: 0 };
    cur.amount += amount;
    if (!seen.has(`L:${key}`)) {
      cur.people += 1;
      seen.add(`L:${key}`);
    }
    byLocal.set(key, cur);
  };
  for (const i of items) {
    const seen = new Set<string>();
    const lines = (i.lines ?? []).filter((l) => n(l.amount) !== 0);
    const engineLines = lines.filter((l) => l.kind !== 'TAX_ENGINE');
    if (engineLines.some((l) => l.kind === 'STATE' || l.kind === 'LOCAL' || l.kind === 'SCHOOL' || l.kind === 'OLT' || l.kind === 'TRANSIT' || l.kind === 'STATE_PROGRAM' || l.kind === 'EMPLOYER')) {
      // State withholding by state; local taxes by "XX:Name" (the key the local return files under);
      // disability / paid-leave contributions with the state's employment agency, as the program report files.
      let stateWithheld = 0;
      for (const l of engineLines) {
        const amt = n(l.amount);
        if (l.kind === 'STATE' && !l.employer) {
          addState(stateOf(l), amt, 0, seen);
          stateWithheld += amt;
        } else if (l.kind === 'STATE_PROGRAM') {
          addState(stateOf(l), 0, 0, seen, amt);
        } else if (l.kind === 'LOCAL' || l.kind === 'SCHOOL' || l.kind === 'OLT' || l.kind === 'TRANSIT' || l.kind === 'EMPLOYER') {
          addLocal(`${stateOf(l)}:${l.label}`, amt, seen);
        }
      }
      // Withholding the lines don't place (a pre-engine amendment) stays with the check's state.
      const rest = round2(n(i.stateWithholding) - stateWithheld);
      const home = (i.taxState ?? '').toUpperCase().trim();
      if (Math.abs(rest) >= 0.01 && home) addState(home, rest, 0, seen);
      // Employer unemployment goes to the state the engine reported UI to, else the check's state.
      const sui = engineLines.find((l) => l.kind === 'SUI');
      const suiState = sui ? stateOf(sui) : home;
      if (suiState) addState(suiState, 0, n(i.employerSuta), seen);
      continue;
    }
    const st = (i.taxState ?? '').toUpperCase().trim();
    if (st) addState(st, n(i.stateWithholding), n(i.employerSuta), seen);
    const local = i.localJurisdiction ?? null;
    if (local && n(i.localWithholding) > 0) addLocal(local, n(i.localWithholding), seen);
  }
  for (const [st, v] of [...byState.entries()].sort()) {
    if (round2(v.wh) > 0) out.push({ kind: 'STATE_WITHHOLDING', jurisdiction: st, amount: round2(v.wh), breakdown: { stateIncomeTax: round2(v.wh), people: v.people } });
    // Disability / paid-leave contributions file with the state's employment agency, next to unemployment.
    if (round2(v.sui + v.pgm) > 0) out.push({ kind: 'STATE_UNEMPLOYMENT', jurisdiction: st, amount: round2(v.sui + v.pgm), breakdown: { unemployment: round2(v.sui), ...(round2(v.pgm) > 0 ? { disabilityAndPaidLeave: round2(v.pgm) } : {}), people: v.people } });
  }
  for (const [loc, v] of [...byLocal.entries()].sort()) out.push({ kind: 'LOCAL', jurisdiction: loc, amount: round2(v.amount), breakdown: { localTax: round2(v.amount), people: v.people } });
  return out;
}

/** "PA:Pittsburgh" from an associate's local tax rule. */
export function localJurisdictionOf(rule: { state: string; name: string } | null | undefined): string | null {
  return rule ? `${rule.state.toUpperCase()}:${rule.name}` : null;
}

/** Post a disbursed run's liabilities. Idempotent; never touches a scheduled or paid row. */
export async function postLiabilitiesForRun(db: Db, runId: string): Promise<number> {
  const run = await db.payrollRun.findFirst({
    where: { id: runId, tenantId: tenantIdForWrite() },
    select: {
      id: true,
      clientId: true,
      disbursedAt: true,
      items: {
        where: { status: 'DISBURSED' },
        select: {
          federalWithholding: true, fica: true, medicare: true, employerFica: true, employerMedicare: true,
          employerFuta: true, employerSuta: true, stateWithholding: true, localWithholding: true, taxState: true,
          associate: { select: { localTaxRule: { select: { state: true, name: true } } } },
          taxLines: { select: { kind: true, code: true, label: true, workState: true, amount: true, employer: true } },
        },
      },
    },
  });
  if (!run || run.items.length === 0) return 0;
  const payday = run.disbursedAt ?? new Date();
  const employerOrgId = await employerFor(db, run.clientId);
  const postings = postingsFor(run.items.map((i) => ({ ...i, lines: i.taxLines, localJurisdiction: localJurisdictionOf(i.associate.localTaxRule) })));
  let posted = 0;
  for (const p of postings) {
    const account = await resolveAccount(db, employerOrgId, p.kind, p.jurisdiction);
    const dueDate = dueFor(account, payday, p.amount);
    const existing = await db.taxLiability.findUnique({ where: { payrollRunId_kind_jurisdiction: { payrollRunId: run.id, kind: p.kind, jurisdiction: p.jurisdiction } } });
    if (existing && existing.status !== 'OPEN') continue;
    const data = {
      accountId: account.id,
      employerOrgId,
      periodLabel: quarterLabel(payday),
      liabilityDate: payday,
      dueDate,
      amount: p.amount,
      breakdown: p.breakdown as Prisma.InputJsonValue,
    };
    if (existing) await db.taxLiability.update({ where: { id: existing.id }, data });
    else await db.taxLiability.create({ data: { ...data, tenantId: tenantIdForWrite(), payrollRunId: run.id, kind: p.kind, jurisdiction: p.jurisdiction } });
    posted += 1;
  }
  return posted;
}

/** Post every disbursed run in a range (backfill, or after an account's schedule changed). */
export async function rebuildLiabilities(db: Db, from: Date, toExclusive: Date): Promise<{ runs: number; postings: number }> {
  const runs = await db.payrollRun.findMany({
    where: { tenantId: tenantIdForWrite(), status: 'DISBURSED', disbursedAt: { gte: from, lt: toExclusive } },
    select: { id: true },
    orderBy: { disbursedAt: 'asc' },
  });
  let postings = 0;
  for (const r of runs) postings += await postLiabilitiesForRun(db, r.id);
  return { runs: runs.length, postings };
}

/* ----- Payments ---------------------------------------------------------------- */

const methodFor = (kind: TaxAgencyKind): string => (kind === 'FEDERAL_WITHHOLDING' || kind === 'FEDERAL_UNEMPLOYMENT' ? 'EFTPS' : kind === 'LOCAL' ? 'LOCAL_PORTAL' : 'STATE_PORTAL');

export interface PaymentActor {
  id: string;
  role: import('@prisma/client').Role;
}

/**
 * Settle open liabilities for one agency with one payment. With a provider
 * connected it is sent through the provider — after a second person
 * approves when one exists (it moves money); in house it is scheduled for
 * the customer to pay and record.
 */
export async function createPayment(db: PrismaClient, actor: PaymentActor, liabilityIds: string[]): Promise<{ payment: TaxPayment; pending: { approvalId: string; title: string } | null }> {
  if (liabilityIds.length === 0) throw new HttpError(400, 'nothing_selected', 'Pick at least one liability to pay.');
  const rows = await db.taxLiability.findMany({ where: { id: { in: liabilityIds }, tenantId: tenantIdForWrite() } });
  if (rows.length !== liabilityIds.length) throw new HttpError(404, 'liability_not_found', 'One of those liabilities is not yours or no longer exists.');
  if (rows.some((r) => r.status !== 'OPEN')) throw new HttpError(409, 'already_scheduled', 'One of those is already scheduled or paid.');
  const first = rows[0]!;
  if (rows.some((r) => r.kind !== first.kind || r.jurisdiction !== first.jurisdiction || r.accountId !== first.accountId)) {
    throw new HttpError(400, 'mixed_agencies', 'A payment goes to one agency. Pick liabilities for the same agency and account.');
  }
  const amount = round2(rows.reduce((a, r) => a + Number(r.amount), 0));
  const dueDate = rows.reduce((d, r) => (r.dueDate < d ? r.dueDate : d), first.dueDate);
  const periods = [...new Set(rows.map((r) => r.periodLabel))].sort();
  const mode = await filingMode();
  const payment = await db.$transaction(async (tx) => {
    const p = await tx.taxPayment.create({
      data: {
        tenantId: tenantIdForWrite(),
        accountId: first.accountId,
        kind: first.kind,
        jurisdiction: first.jurisdiction,
        periodLabel: periods.length === 1 ? periods[0]! : `${periods[0]}…`,
        amount,
        dueDate,
        method: mode.mode === 'PROVIDER' ? 'PROVIDER' : methodFor(first.kind),
        providerConnectionId: mode.connectionId,
        createdById: actor.id,
      },
    });
    await tx.taxLiability.updateMany({ where: { id: { in: liabilityIds } }, data: { status: 'SCHEDULED', paymentId: p.id } });
    return p;
  });
  enqueueAudit({ actorUserId: actor.id, action: 'payroll_tax.payment_created', entityType: 'TaxPayment', entityId: payment.id, metadata: { kind: payment.kind, jurisdiction: payment.jurisdiction, amount, method: payment.method, liabilities: liabilityIds.length } }, 'payrollTaxLedger');

  if (mode.mode !== 'PROVIDER') return { payment, pending: null };
  if (await secondPersonExists(db, 'process:payroll', actor.id)) {
    const title = `Send ${agencyNameFor(payment.kind, payment.jurisdiction)} $${amount.toLocaleString('en-US', { minimumFractionDigits: 2 })} through ${mode.providerLabel}`;
    const approval = await createApprovalRequest(db, {
      kind: 'TAX_PAYMENT',
      subjectType: 'TaxPayment',
      subjectId: payment.id,
      title,
      summary: `Due ${dueDate.toISOString().slice(0, 10)} · ${KIND_LABEL[payment.kind]} · ${rows.length} payroll${rows.length === 1 ? '' : 's'}`,
      proposed: { paymentId: payment.id, amount },
      requesterUserId: actor.id,
      approver: { capability: 'process:payroll' },
    });
    return { payment, pending: { approvalId: approval.id, title } };
  }
  enqueueAudit({ actorUserId: actor.id, action: 'payroll_tax.payment_no_second_person', entityType: 'TaxPayment', entityId: payment.id, metadata: { note: 'No second approver was available; sent on the requester’s authority.' } }, 'payrollTaxLedger');
  return { payment: await submitPaymentToProvider(db, payment.id, actor.id), pending: null };
}

/** Send a scheduled payment through the connected provider. */
export async function submitPaymentToProvider(db: PrismaClient, paymentId: string, actorUserId: string): Promise<TaxPayment> {
  const p = await db.taxPayment.findFirst({ where: { id: paymentId, tenantId: tenantIdForWrite() }, include: { account: true } });
  if (!p) throw new HttpError(404, 'payment_not_found', 'Payment not found.');
  if (p.status !== 'SCHEDULED') throw new HttpError(409, 'not_scheduled', 'Only a scheduled payment can be sent.');
  try {
    const r = await withProvider('tax.payment', (adapter, ctx) =>
      adapter.submitTaxPayment(ctx, {
        idempotencyKey: `alto-taxpay-${p.id}`,
        kind: p.kind,
        jurisdiction: p.jurisdiction,
        periodLabel: p.periodLabel,
        amount: Number(p.amount),
        dueDate: p.dueDate.toISOString().slice(0, 10),
        accountNumber: p.account?.accountNumber ?? null,
      }),
    );
    const paid = r.status === 'PAID';
    const updated = await db.taxPayment.update({
      where: { id: p.id },
      data: { status: paid ? 'PAID' : r.status === 'FAILED' || r.status === 'REJECTED' ? 'FAILED' : 'SUBMITTED', providerRef: r.providerRef || null, confirmationNumber: r.confirmationNumber, submittedAt: new Date(), ...(paid ? { paidAt: new Date() } : {}) },
    });
    if (paid) await settleLiabilities(db, updated, actorUserId);
    enqueueAudit({ actorUserId, action: 'payroll_tax.payment_submitted', entityType: 'TaxPayment', entityId: p.id, metadata: { providerRef: r.providerRef, status: r.status } }, 'payrollTaxLedger');
    return updated;
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'The provider refused the payment.';
    return db.taxPayment.update({ where: { id: p.id }, data: { status: 'FAILED', failureReason: reason.slice(0, 500) } });
  }
}

/** A payment's liabilities are paid; the federal 941 deposit rows follow so the older ledger agrees. */
async function settleLiabilities(db: Db, payment: TaxPayment, actorUserId: string | null): Promise<void> {
  await db.taxLiability.updateMany({ where: { paymentId: payment.id }, data: { status: 'PAID' } });
  // The books: the liabilities paid out of payroll checking (lib/books/posting).
  booksAfterTaxPayment(payment.id);
  if (payment.kind === 'FEDERAL_WITHHOLDING') {
    const runs = (await db.taxLiability.findMany({ where: { paymentId: payment.id }, select: { payrollRunId: true } })).map((r) => r.payrollRunId).filter((x): x is string => !!x);
    if (runs.length) {
      await db.taxDeposit.updateMany({
        where: { payrollRunId: { in: runs }, status: 'PENDING' },
        data: { status: 'PAID', paidAt: payment.paidAt ?? new Date(), paidById: actorUserId, confirmationNumber: payment.confirmationNumber },
      });
    }
  }
}

/** In house: the customer paid on EFTPS or the agency's site; record it with the confirmation. */
export async function markPaymentPaid(db: PrismaClient, paymentId: string, input: { confirmationNumber: string; paidOn?: string | null }, actorUserId: string): Promise<TaxPayment> {
  const p = await db.taxPayment.findFirst({ where: { id: paymentId, tenantId: tenantIdForWrite() } });
  if (!p) throw new HttpError(404, 'payment_not_found', 'Payment not found.');
  if (p.status === 'PAID') throw new HttpError(409, 'already_paid', 'This payment is already recorded as paid.');
  if (p.status === 'CANCELLED') throw new HttpError(409, 'cancelled', 'This payment was cancelled.');
  const paidAt = input.paidOn ? new Date(`${input.paidOn}T12:00:00Z`) : new Date();
  const updated = await db.taxPayment.update({ where: { id: p.id }, data: { status: 'PAID', confirmationNumber: input.confirmationNumber, paidAt, paidById: actorUserId } });
  await settleLiabilities(db, updated, actorUserId);
  enqueueAudit({ actorUserId, action: 'payroll_tax.payment_paid', entityType: 'TaxPayment', entityId: p.id, metadata: { confirmationNumber: input.confirmationNumber, paidOn: paidAt.toISOString().slice(0, 10), late: paidAt > p.dueDate } }, 'payrollTaxLedger');
  return updated;
}

/** Undo a payment that never went out: its liabilities are open again. */
export async function cancelPayment(db: PrismaClient, paymentId: string, actorUserId: string): Promise<TaxPayment> {
  const p = await db.taxPayment.findFirst({ where: { id: paymentId, tenantId: tenantIdForWrite() } });
  if (!p) throw new HttpError(404, 'payment_not_found', 'Payment not found.');
  if (p.status !== 'SCHEDULED' && p.status !== 'FAILED') throw new HttpError(409, 'not_cancellable', 'Only a payment that has not gone out can be cancelled.');
  const updated = await db.$transaction(async (tx) => {
    await tx.taxLiability.updateMany({ where: { paymentId: p.id }, data: { status: 'OPEN', paymentId: null } });
    return tx.taxPayment.update({ where: { id: p.id }, data: { status: 'CANCELLED' } });
  });
  enqueueAudit({ actorUserId, action: 'payroll_tax.payment_cancelled', entityType: 'TaxPayment', entityId: p.id, metadata: {} }, 'payrollTaxLedger');
  return updated;
}

/** Ask the provider where each submitted payment stands. */
export async function refreshProviderPayments(db: PrismaClient): Promise<number> {
  const open = await db.taxPayment.findMany({ where: { tenantId: tenantIdForWrite(), status: 'SUBMITTED', method: 'PROVIDER', providerRef: { not: null } }, take: 100 });
  let changed = 0;
  for (const p of open) {
    try {
      const r = await withProvider('tax.payment.status', (adapter, ctx) => adapter.status(ctx, 'payment', p.providerRef!));
      if (r.status === 'PAID') {
        const u = await db.taxPayment.update({ where: { id: p.id }, data: { status: 'PAID', paidAt: new Date(), confirmationNumber: r.confirmationNumber ?? p.confirmationNumber } });
        await settleLiabilities(db, u, null);
        changed += 1;
      } else if (r.status === 'FAILED' || r.status === 'REJECTED') {
        await db.taxPayment.update({ where: { id: p.id }, data: { status: 'FAILED', failureReason: r.message?.slice(0, 500) ?? 'The provider reported a failure.' } });
        changed += 1;
      }
    } catch {
      /* health is recorded on the connection; try again next time */
    }
  }
  return changed;
}

// The approval engine applies a TAX_PAYMENT by sending it; a rejection reopens its liabilities.
registerApplyHandler(
  'TAX_PAYMENT',
  async (db, row, decider) => {
    const { paymentId } = row.proposed as { paymentId: string };
    await submitPaymentToProvider(db, paymentId, decider.id);
  },
  async (db, row, decider) => {
    const { paymentId } = row.proposed as { paymentId: string };
    await cancelPayment(db, paymentId, decider.id);
  },
);

/* ----- Registrations ------------------------------------------------------------ */

export interface RegistrationNeed {
  kind: TaxAgencyKind;
  jurisdiction: string;
  agencyName: string;
  accountId: string | null;
  reason: string;
  steps: string[];
}

function stepsFor(kind: TaxAgencyKind, jurisdiction: string): string[] {
  if (kind === 'FEDERAL_WITHHOLDING') return ['Get the company’s EIN from the IRS if it has none.', 'Enroll in EFTPS to make federal deposits.', 'Enter the deposit schedule the IRS assigned (monthly or semiweekly).'];
  if (kind === 'FEDERAL_UNEMPLOYMENT') return ['Use the same EIN and EFTPS enrollment as federal withholding.', 'Add the federal unemployment account so FUTA deposits and Form 940 are tracked.'];
  const state = STATE_NAMES[jurisdiction.split(':')[0] ?? ''] ?? jurisdiction;
  if (kind === 'STATE_WITHHOLDING') return [`Register for a withholding account with ${state}’s revenue department.`, 'Enter the account number and the deposit schedule the state assigns.', 'Re-check the state certificate for each person working there.'];
  if (kind === 'STATE_UNEMPLOYMENT') return [`Register with ${state}’s workforce (unemployment insurance) agency.`, 'Enter the account number and this year’s assigned rate and wage base.', 'Post the state’s unemployment poster at the work site.'];
  return [`Register with the local tax collector for ${jurisdiction.split(':')[1] ?? jurisdiction}.`, 'Enter the account number and how often it wants deposits.'];
}

/**
 * Every tax account the company still has to register — the one list the
 * Agencies tab, the overview and the go-live checklist read (F500 G3: the
 * desk listed only Florida's unemployment account while go-live said the
 * federal 941/940 accounts were missing too). Federal withholding and
 * unemployment first, then each state where tax is owed or people live or
 * worked in the last 120 days, then accounts waiting on registration.
 */
export async function registrationsNeeded(db: Db, now: Date = new Date()): Promise<RegistrationNeed[]> {
  const tenantId = tenantIdForWrite();
  const pending = await db.taxAgencyAccount.findMany({ where: { tenantId, status: 'PENDING_REGISTRATION' }, orderBy: [{ kind: 'asc' }, { jurisdiction: 'asc' }] });
  const out: RegistrationNeed[] = [];
  const have = await db.taxAgencyAccount.findMany({ where: { tenantId, kind: { in: ['FEDERAL_WITHHOLDING', 'FEDERAL_UNEMPLOYMENT', 'STATE_WITHHOLDING', 'STATE_UNEMPLOYMENT'] }, status: { not: 'CLOSED' } }, select: { kind: true, jurisdiction: true } });
  // Federal: every employer needs both before its first payroll.
  for (const kind of ['FEDERAL_WITHHOLDING', 'FEDERAL_UNEMPLOYMENT'] as const) {
    if (have.some((h) => h.kind === kind)) continue;
    out.push({ kind, jurisdiction: 'US', agencyName: agencyNameFor(kind, 'US'), accountId: null, reason: kind === 'FEDERAL_WITHHOLDING' ? 'Every employer needs it: federal withholding, Social Security and Medicare (Form 941).' : 'Every employer needs it: federal unemployment (Form 940).', steps: stepsFor(kind, 'US') });
  }
  out.push(...pending.map((a) => ({ kind: a.kind, jurisdiction: a.jurisdiction, agencyName: a.agencyName, accountId: a.id, reason: 'Tax is owed here and the account is not set up yet.', steps: stepsFor(a.kind, a.jurisdiction) })));
  // Where people live, or worked in the last 120 days, with no account at all (before the first payroll there) —
  // the same states the go-live checklist checks.
  const homes = await db.associate.findMany({
    where: { tenantId, deletedAt: null, deactivatedAt: null, state: { not: null } },
    select: { state: true },
    distinct: ['state'],
  });
  const worked = await db.timeEntry.findMany({
    where: { tenantId, clockInAt: { gte: new Date(now.getTime() - 120 * 86_400_000) }, location: { state: { not: null } } },
    select: { location: { select: { state: true } } },
    distinct: ['locationId'],
  });
  const states = [...homes.map((h) => h.state), ...worked.map((w) => w.location?.state ?? null)].map((s) => ({ state: s }));
  const key = (k: string, j: string) => `${k}|${j}`;
  const seen = new Set([...have.map((h) => key(h.kind, h.jurisdiction)), ...out.map((o) => key(o.kind, o.jurisdiction))]);
  for (const s of states) {
    const st = (s.state ?? '').trim().toUpperCase();
    if (!STATE_NAMES[st]) continue;
    for (const kind of ['STATE_WITHHOLDING', 'STATE_UNEMPLOYMENT'] as const) {
      if (kind === 'STATE_WITHHOLDING' && NO_INCOME_TAX_STATES.has(st)) continue;
      if (seen.has(key(kind, st))) continue;
      seen.add(key(kind, st));
      out.push({ kind, jurisdiction: st, agencyName: agencyNameFor(kind, st), accountId: null, reason: 'People live or work here and there is no account yet.', steps: stepsFor(kind, st) });
    }
  }
  return out;
}


/* ----- Inbox -------------------------------------------------------------------- */

/**
 * What the payroll-tax desk needs from someone today: each deposit (agency
 * × due date) due within 7 days or overdue and not yet paid, each failed
 * payment, each drafted return due within 14 days, and each agency notice
 * that is new or whose response is due within 7 days.
 */
export async function payrollTaxesNeedingYou(db: Db, now = new Date()): Promise<number> {
  const tenantId = tenantIdForWrite();
  const day = new Date(now.toISOString().slice(0, 10) + 'T00:00:00Z');
  const in7 = new Date(day.getTime() + 7 * 86_400_000);
  const in14 = new Date(day.getTime() + 14 * 86_400_000);
  const [deposits, failed, returns, notices] = await Promise.all([
    db.taxLiability.groupBy({ by: ['kind', 'jurisdiction', 'dueDate'], where: { tenantId, status: { in: ['OPEN', 'SCHEDULED'] }, dueDate: { lte: in7 } } }),
    db.taxPayment.count({ where: { tenantId, status: 'FAILED' } }),
    db.taxReturn.count({ where: { tenantId, status: { in: ['DRAFT', 'REJECTED'] }, dueDate: { lte: in14 } } }),
    db.agencyNotice.count({ where: { tenantId, OR: [{ status: 'NEW' }, { status: 'IN_REVIEW', responseDueAt: { lte: in7 } }] } }),
  ]);
  return deposits.length + failed + returns + notices;
}

/**
 * The employer's state withholding account numbers, by state (W-2 box 15,
 * EFW2 RS record). An account of this employer wins over a tenant-wide one;
 * closed accounts and ones still waiting on registration don't count.
 */
export async function stateAccountNumbers(db: Db, employerOrgId: string | null): Promise<Record<string, string>> {
  const rows = await db.taxAgencyAccount.findMany({
    where: { tenantId: tenantIdForWrite(), kind: 'STATE_WITHHOLDING', status: { notIn: ['CLOSED', 'PENDING_REGISTRATION'] }, accountNumber: { not: null } },
    select: { jurisdiction: true, accountNumber: true, employerOrgId: true },
    orderBy: { createdAt: 'asc' },
  });
  const out: Record<string, string> = {};
  for (const r of rows) {
    const st = r.jurisdiction.toUpperCase();
    if (!r.accountNumber) continue;
    if (r.employerOrgId && employerOrgId && r.employerOrgId === employerOrgId) out[st] = r.accountNumber;
    else if (!out[st]) out[st] = r.accountNumber;
  }
  return out;
}
