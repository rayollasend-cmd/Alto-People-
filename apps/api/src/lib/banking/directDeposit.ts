import { createHash, randomInt } from 'node:crypto';
import type { AchEntry, PayoutMethod, Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db.js';
import { HttpError } from '../../middleware/error.js';
import { enqueueAudit } from '../audit.js';
import { encryptString, tryDecryptString } from '../crypto.js';
import { accountFingerprint, notifyFinance } from '../financialChanges.js';
import { readRoutingNumber } from '../payoutMethod.js';
import { rerouteReturnedItem } from '../payoutReroute.js';
import { sendPaystubEmail } from '../sendPaystubEmail.js';
import { describeBranchFailure } from '../achReturnCodes.js';
import { tenantIdForWrite } from '../tenant.js';
import type { DisbursementAdapter, DisbursementInput, DisbursementResult } from '../disbursement.js';
import { bankingProfile, originate, usesOurAch, type EntryInput } from './ach.js';
import { applyFundingReturn, loadTenantHolidays, payDateFor } from './funding.js';
import { addBankingDays, easternInstant, isBankingDay, onOrBeforeBankingDay, ymd } from './holidays.js';
import { interpretNoc, isValidRouting } from './nacha.js';

/**
 * Employee pay over our own ACH.
 *
 *   splits     an associate's verified bank accounts with splitKind AMOUNT
 *              or PERCENT take their share first (in splitOrder); the
 *              primary account gets the remainder
 *   prenotes   a zero-dollar test entry to each newly verified account
 *              (after verify-before-pay passed); cleared after two banking
 *              days without a return. NACHA no longer requires waiting for
 *              it, so live pay isn't held — a returned prenote is.
 *   returns    a returned credit re-pays through payoutReroute (the last
 *              verified other account, else a check)
 *   NOC        the bank's correction becomes a new payout method (the old
 *              one is retired, never overwritten), with an audit row
 */

type Db = PrismaClient | Prisma.TransactionClient;

/* ----- splits --------------------------------------------------------------- */

export interface SplitRule {
  id: string;
  splitKind: string | null;
  splitAmountCents: number | null;
  splitPercent: number | null;
  splitOrder: number;
}

/**
 * Divide net pay: AMOUNT and PERCENT accounts take their share in order
 * (a percent is of the whole net, rounded down to the cent), never more
 * than what's left; the remainder account gets the rest.
 */
export function splitNet(netCents: number, splits: SplitRule[], remainderId: string): Array<{ id: string; cents: number }> {
  let left = netCents;
  const out: Array<{ id: string; cents: number }> = [];
  for (const s of [...splits].sort((a, b) => a.splitOrder - b.splitOrder)) {
    if (s.id === remainderId) continue;
    const want = s.splitKind === 'AMOUNT' ? (s.splitAmountCents ?? 0) : s.splitKind === 'PERCENT' ? Math.floor((netCents * (s.splitPercent ?? 0)) / 100) : 0;
    const take = Math.max(0, Math.min(left, want));
    if (take > 0) {
      out.push({ id: s.id, cents: take });
      left -= take;
    }
  }
  if (left > 0) out.push({ id: remainderId, cents: left });
  return out;
}

function methodBank(m: PayoutMethod): { routing: string; account: string } | null {
  if (!m.routingNumberEnc || !m.accountNumberEnc) return null;
  const routing = readRoutingNumber(Buffer.from(m.routingNumberEnc));
  const account = tryDecryptString(Buffer.from(m.accountNumberEnc));
  return routing && account ? { routing, account } : null;
}

const individualId = (associateId: string) => associateId.replace(/-/g, '').slice(0, 15).toUpperCase();
const itemIdOf = (key: string) => key.split(':')[0]!;

/**
 * The credits one paycheck becomes. Splits apply only when the account
 * being paid is the associate's current primary — a paycheck routed to a
 * previous verified account (verify-before-pay) goes there whole.
 */
async function creditsFor(db: Db, input: DisbursementInput, payrollItemId: string): Promise<{ entries: EntryInput[] } | { error: string }> {
  const r = input.recipient;
  if (!r.routingNumber || !r.accountNumber) return { error: 'no_payout_rail: no bank account on file' };
  if (!isValidRouting(r.routingNumber)) return { error: `invalid_routing: ${r.routingNumber} is not a valid routing number` };
  const methods = await db.payoutMethod.findMany({ where: { associateId: r.associateId, type: 'BANK_ACCOUNT' }, orderBy: { createdAt: 'desc' } });
  const fp = accountFingerprint(r.routingNumber, r.accountNumber);
  const paid =
    methods.find((m) => m.accountFingerprint === fp && !m.retiredAt) ??
    methods.find((m) => {
      const b = methodBank(m);
      return !!b && b.routing === r.routingNumber && b.account === r.accountNumber;
    }) ??
    null;
  if (paid?.prenoteStatus === 'RETURNED') return { error: 'prenote_returned: the bank rejected the test deposit to this account — ask for new details' };
  const netCents = Math.round(input.amount * 100);
  const base = (cents: number, routing: string, account: string, type: string | null, methodId: string | null): EntryInput => ({
    kind: 'CREDIT',
    sec: 'PPD',
    amountCents: cents,
    routingNumber: routing,
    accountNumber: account,
    accountType: type === 'SAVINGS' ? 'SAVINGS' : 'CHECKING',
    name: r.fullName,
    individualId: individualId(r.associateId),
    payrollItemId,
    payoutMethodId: methodId,
    associateId: r.associateId,
  });
  if (!paid || !paid.isPrimary || paid.retiredAt) {
    return { entries: [base(netCents, r.routingNumber, r.accountNumber, r.accountType ?? null, paid?.id ?? null)] };
  }
  const splits = methods.filter((m) => m.id !== paid.id && !m.retiredAt && m.verifiedAt && m.splitKind && m.prenoteStatus !== 'RETURNED' && methodBank(m));
  const plan = splitNet(
    netCents,
    splits.map((m) => ({ id: m.id, splitKind: m.splitKind, splitAmountCents: m.splitAmountCents, splitPercent: m.splitPercent == null ? null : Number(m.splitPercent), splitOrder: m.splitOrder })),
    paid.id,
  );
  const byId = new Map(methods.map((m) => [m.id, m]));
  return {
    entries: plan.map((p) => {
      if (p.id === paid.id) return base(p.cents, r.routingNumber!, r.accountNumber!, r.accountType ?? paid.accountType, paid.id);
      const m = byId.get(p.id)!;
      const b = methodBank(m)!;
      return base(p.cents, b.routing, b.account, m.accountType, m.id);
    }),
  };
}

/**
 * When credits can settle: the run's pay date, unless that's too soon to
 * reach the bank now — then the earliest banking day that still can.
 */
export async function creditEffectiveDate(db: Db, runId: string | null, now = new Date()): Promise<{ effectiveDate: string; sameDay: boolean }> {
  const profile = await bankingProfile(db);
  const today = ymd(now);
  const beforeCutoff = isBankingDay(today) && now < easternInstant(today, profile.submitCutoffEt);
  const sendDay = beforeCutoff ? today : addBankingDays(today, 1);
  const sameDayOk = profile.achSpeed === 'SAME_DAY' && beforeCutoff;
  const earliest = sameDayOk ? today : addBankingDays(sendDay, 1);
  let target = earliest;
  if (runId) {
    const payDate = await payDateFor(db, runId);
    if (payDate > earliest) target = onOrBeforeBankingDay(payDate);
  }
  return { effectiveDate: target, sameDay: target === today };
}

/* ----- the disbursement rail ------------------------------------------------ */

/**
 * The "our ACH" rail behind disbursement. In batch mode (the disburse
 * route) each paycheck is collected and answered PENDING; finalize() sends
 * one file for the run and marks every item paid with its trace number, or
 * held. Outside a batch (a re-route, a retry) each call sends its own file.
 */
export class AchRailAdapter implements DisbursementAdapter {
  readonly provider = 'ACH' as const;
  private pending: Array<{ itemId: string; entries: EntryInput[] }> = [];
  constructor(
    private readonly db: PrismaClient = defaultPrisma,
    private readonly batch = false,
    private readonly actorUserId: string | null = null,
  ) {}

  async disburse(input: DisbursementInput): Promise<DisbursementResult> {
    const itemId = itemIdOf(input.idempotencyKey);
    const credits = await creditsFor(this.db, input, itemId);
    if ('error' in credits) return { provider: 'ACH', externalRef: '', status: 'FAILED', failureReason: credits.error };
    if (this.batch) {
      this.pending.push({ itemId, entries: credits.entries });
      return { provider: 'ACH', externalRef: '', status: 'PENDING', failureReason: null };
    }
    const item = await this.db.payrollItem.findUnique({ where: { id: itemId }, select: { payrollRunId: true } });
    await loadTenantHolidays(this.db);
    const when = await creditEffectiveDate(this.db, null);
    const profile = await bankingProfile(this.db);
    const out = await originate(this.db, profile, {
      purpose: 'DIRECT_DEPOSIT',
      effectiveDate: when.effectiveDate,
      sameDay: when.sameDay,
      entryDescription: 'PAYROLL',
      payrollRunId: item?.payrollRunId ?? null,
      createdById: this.actorUserId,
      entries: credits.entries,
    });
    const bad = out.entries.find((e) => !e.accepted);
    if (bad) return { provider: 'ACH', externalRef: '', status: 'FAILED', failureReason: bad.error ?? 'bank_rejected' };
    return { provider: 'ACH', externalRef: out.entries[0]!.traceNumber, status: 'SUCCESS', failureReason: null };
  }

  /** Send the collected paychecks as one file and settle each item. */
  async finalize(): Promise<{ file: string | null; paid: number; held: number }> {
    if (this.pending.length === 0) return { file: null, paid: 0, held: 0 };
    const work = this.pending;
    this.pending = [];
    const first = await this.db.payrollItem.findUnique({ where: { id: work[0]!.itemId }, select: { payrollRunId: true } });
    const runId = first?.payrollRunId ?? null;
    await loadTenantHolidays(this.db);
    const when = await creditEffectiveDate(this.db, runId);
    const profile = await bankingProfile(this.db);
    const now = new Date();
    let out;
    try {
      out = await originate(this.db, profile, {
        purpose: 'DIRECT_DEPOSIT',
        effectiveDate: when.effectiveDate,
        sameDay: when.sameDay,
        entryDescription: 'PAYROLL',
        payrollRunId: runId,
        createdById: this.actorUserId,
        entries: work.flatMap((w) => w.entries),
      });
    } catch (err) {
      const reason = err instanceof HttpError ? err.message : err instanceof Error ? err.message : String(err);
      for (const w of work) {
        await this.db.payrollItem.update({ where: { id: w.itemId }, data: { status: 'HELD', failureReason: `ach_file_failed: ${reason}`.slice(0, 500) } });
      }
      return { file: null, paid: 0, held: work.length };
    }
    let paid = 0;
    let held = 0;
    for (const w of work) {
      const mine = out.entries.filter((e) => e.input.payrollItemId === w.itemId);
      const failed = mine.find((e) => !e.accepted);
      const ref = mine.map((e) => e.traceNumber).join(',').slice(0, 190);
      await this.db.payrollDisbursementAttempt.create({
        data: { payrollItemId: w.itemId, provider: 'ACH', status: failed ? 'FAILED' : 'SUCCESS', externalRef: ref || null, failureReason: failed?.error ?? null, attemptedById: this.actorUserId },
      });
      if (failed) {
        held += 1;
        await this.db.payrollItem.update({ where: { id: w.itemId }, data: { status: 'HELD', failureReason: (failed.error ?? 'bank_rejected').slice(0, 500) } });
      } else {
        paid += 1;
        await this.db.payrollItem.update({ where: { id: w.itemId }, data: { status: 'DISBURSED', disbursementRef: ref, disbursedAt: now, failureReason: null } });
        void sendPaystubEmail(this.db, { payrollItemId: w.itemId });
      }
    }
    return { file: out.file.id, paid, held };
  }
}

/* ----- prenotes --------------------------------------------------------------- */

/** Send a zero-dollar prenote to every verified account that hasn't had one. */
export async function sendDuePrenotes(db: PrismaClient, actorUserId: string | null, now = new Date()): Promise<{ sent: number; file: string | null }> {
  const profile = await bankingProfile(db);
  if (!usesOurAch(profile) || !profile.requirePrenote) return { sent: 0, file: null };
  const due = await db.payoutMethod.findMany({
    where: { tenantId: tenantIdForWrite(), type: 'BANK_ACCOUNT', retiredAt: null, verifiedAt: { not: null }, prenoteStatus: null, accountNumberEnc: { not: null } },
    include: { associate: { select: { firstName: true, lastName: true } } },
    take: 2000,
  });
  const entries: EntryInput[] = [];
  for (const m of due) {
    const b = methodBank(m);
    if (!b || !isValidRouting(b.routing)) continue;
    entries.push({
      kind: 'PRENOTE',
      sec: 'PPD',
      amountCents: 0,
      routingNumber: b.routing,
      accountNumber: b.account,
      accountType: m.accountType === 'SAVINGS' ? 'SAVINGS' : 'CHECKING',
      name: `${m.associate.firstName} ${m.associate.lastName}`,
      individualId: individualId(m.associateId),
      payoutMethodId: m.id,
      associateId: m.associateId,
    });
  }
  if (!entries.length) return { sent: 0, file: null };
  await loadTenantHolidays(db);
  const when = await creditEffectiveDate(db, null, now);
  const out = await originate(db, profile, { purpose: 'PRENOTE', effectiveDate: when.effectiveDate, sameDay: false, entryDescription: 'PRENOTE', createdById: actorUserId, entries }, now);
  const accepted = out.entries.filter((e) => e.accepted && e.input.payoutMethodId);
  await db.payoutMethod.updateMany({
    where: { id: { in: accepted.map((e) => e.input.payoutMethodId!) } },
    data: { prenoteStatus: 'SENT', prenoteSentAt: now, prenoteEffectiveDate: new Date(`${when.effectiveDate}T00:00:00Z`) },
  });
  return { sent: accepted.length, file: out.file.id };
}

/**
 * Prenotes two banking days past their effective date with no return are
 * clear; so are employer accounts verified by prenote.
 */
export async function clearPrenotes(db: Db, now = new Date()): Promise<number> {
  await loadTenantHolidays(db);
  const cutoff = addBankingDays(ymd(now), -2);
  const r = await db.payoutMethod.updateMany({
    where: { tenantId: tenantIdForWrite(), prenoteStatus: 'SENT', prenoteEffectiveDate: { lte: new Date(`${cutoff}T00:00:00Z`) } },
    data: { prenoteStatus: 'CLEARED' },
  });
  const accts = await db.employerBankAccount.updateMany({
    where: { tenantId: tenantIdForWrite(), status: 'PRENOTE_SENT', microDepositSentAt: { lte: new Date(`${cutoff}T23:59:59Z`) } },
    data: { status: 'VERIFIED', verifiedAt: now },
  });
  return r.count + accts.count;
}

/* ----- employer accounts: micro-deposits or prenote ----------------------------- */

const microHash = (accountId: string, a: number, b: number) =>
  createHash('sha256').update(`${accountId}:${Math.min(a, b)}:${Math.max(a, b)}`).digest('hex');

/**
 * Prove the employer controls a new operating account: two small credits
 * (1–99¢ each) whose amounts Finance reads off the statement, or a prenote
 * that verifies after two banking days without a return.
 */
export async function startAccountVerification(db: PrismaClient, accountId: string, method: 'MICRODEPOSITS' | 'PRENOTE', actorUserId: string, now = new Date()): Promise<{ status: string; file: string | null; amountsForTest?: [number, number] }> {
  const account = await db.employerBankAccount.findFirst({ where: { id: accountId, tenantId: tenantIdForWrite() } });
  if (!account) throw new HttpError(404, 'account_not_found', 'That bank account isn’t on file.');
  if (account.status === 'VERIFIED') return { status: 'VERIFIED', file: null };
  const profile = await bankingProfile(db);
  const accountNumber = tryDecryptString(Buffer.from(account.accountNumberEnc));
  if (!accountNumber) throw new HttpError(409, 'account_unreadable', 'This account number can’t be read — add it again.');
  await loadTenantHolidays(db);
  const when = await creditEffectiveDate(db, null, now);
  const common = {
    sec: 'CCD' as const,
    routingNumber: account.routingNumber,
    accountNumber,
    accountType: (account.accountType === 'SAVINGS' ? 'SAVINGS' : 'CHECKING') as 'SAVINGS' | 'CHECKING',
    name: profile.companyName ?? account.label,
    individualId: 'VERIFY',
    bankAccountId: account.id,
  };
  if (method === 'PRENOTE') {
    const out = await originate(db, profile, { purpose: 'PRENOTE', effectiveDate: when.effectiveDate, sameDay: false, entryDescription: 'ACCTVERIFY', createdById: actorUserId, entries: [{ ...common, kind: 'PRENOTE', amountCents: 0 }] }, now);
    if (!out.entries[0]!.accepted) throw new HttpError(502, 'bank_rejected', out.entries[0]!.error ?? 'The bank refused the prenote.');
    await db.employerBankAccount.update({ where: { id: account.id }, data: { status: 'PRENOTE_SENT', microDepositSentAt: new Date(`${when.effectiveDate}T00:00:00Z`) } });
    return { status: 'PRENOTE_SENT', file: out.file.id };
  }
  const a = randomInt(1, 100);
  const b = randomInt(1, 100);
  const out = await originate(
    db,
    profile,
    { purpose: 'MICRODEPOSIT', effectiveDate: when.effectiveDate, sameDay: false, entryDescription: 'ACCTVERIFY', createdById: actorUserId, entries: [{ ...common, kind: 'MICRODEPOSIT', amountCents: a }, { ...common, kind: 'MICRODEPOSIT', amountCents: b }] },
    now,
  );
  if (out.entries.some((e) => !e.accepted)) throw new HttpError(502, 'bank_rejected', out.entries.find((e) => !e.accepted)?.error ?? 'The bank refused the deposits.');
  await db.employerBankAccount.update({ where: { id: account.id }, data: { status: 'MICRODEPOSITS_SENT', microDepositHash: microHash(account.id, a, b), microDepositSentAt: now, microDepositAttempts: 0 } });
  enqueueAudit({ actorUserId, action: 'banking.account_microdeposits_sent', entityType: 'EmployerBankAccount', entityId: account.id, metadata: { last4: account.accountLast4 } }, 'banking');
  return { status: 'MICRODEPOSITS_SENT', file: out.file.id, ...(process.env.NODE_ENV === 'test' ? { amountsForTest: [a, b] as [number, number] } : {}) };
}

export const MAX_MICRO_ATTEMPTS = 5;

/** Check the two amounts Finance read off the statement. Five wrong tries locks the account. */
export async function confirmMicroDeposits(db: PrismaClient, accountId: string, amountsCents: [number, number], actorUserId: string, now = new Date()): Promise<{ status: string; attemptsLeft: number }> {
  const account = await db.employerBankAccount.findFirst({ where: { id: accountId, tenantId: tenantIdForWrite() } });
  if (!account) throw new HttpError(404, 'account_not_found', 'That bank account isn’t on file.');
  if (account.status !== 'MICRODEPOSITS_SENT' || !account.microDepositHash) throw new HttpError(409, 'not_awaiting_deposits', 'Send the two small deposits first.');
  const ok = microHash(account.id, amountsCents[0], amountsCents[1]) === account.microDepositHash;
  const attempts = account.microDepositAttempts + 1;
  if (ok) {
    await db.employerBankAccount.update({ where: { id: account.id }, data: { status: 'VERIFIED', verifiedAt: now, verifiedById: actorUserId, microDepositHash: null } });
    enqueueAudit({ actorUserId, action: 'banking.account_verified', entityType: 'EmployerBankAccount', entityId: account.id, metadata: { last4: account.accountLast4, method: 'MICRODEPOSITS' } }, 'banking');
    return { status: 'VERIFIED', attemptsLeft: 0 };
  }
  const locked = attempts >= MAX_MICRO_ATTEMPTS;
  await db.employerBankAccount.update({ where: { id: account.id }, data: { microDepositAttempts: attempts, ...(locked ? { status: 'FAILED', microDepositHash: null } : {}) } });
  return { status: locked ? 'FAILED' : 'MICRODEPOSITS_SENT', attemptsLeft: Math.max(0, MAX_MICRO_ATTEMPTS - attempts) };
}

/* ----- what comes back ----------------------------------------------------------- */

async function entryByTrace(db: Db, trace: string): Promise<AchEntry | null> {
  return db.achEntry.findFirst({ where: { tenantId: tenantIdForWrite(), traceNumber: trace } });
}

/**
 * An entry the bank returned. A funding debit holds the run; a paycheck is
 * re-paid; a prenote marks the account bad; a micro-deposit fails the
 * account check. Idempotent: a second report of the same return is a no-op.
 */
export async function applyAchReturn(db: PrismaClient, ref: { traceNumber?: string; entryId?: string }, code: string, actorUserId: string | null = null, now = new Date()): Promise<{ applied: boolean; kind?: string; outcome?: string }> {
  const entry = ref.entryId ? await db.achEntry.findFirst({ where: { id: ref.entryId, tenantId: tenantIdForWrite() } }) : ref.traceNumber ? await entryByTrace(db, ref.traceNumber) : null;
  if (!entry) return { applied: false };
  if (entry.status === 'RETURNED') return { applied: false, kind: entry.kind, outcome: 'already_returned' };
  await db.achEntry.update({ where: { id: entry.id }, data: { status: 'RETURNED', returnCode: /^R\d{2}$/i.test(code.trim()) ? code.trim().toUpperCase() : null, returnedAt: now } });
  const reason = describeBranchFailure(code);
  if (entry.kind === 'DEBIT') {
    await applyFundingReturn(db, entry.id, code, now);
    return { applied: true, kind: 'DEBIT', outcome: 'funding_returned' };
  }
  if (entry.kind === 'CREDIT' && entry.payrollItemId) {
    const r = await rerouteReturnedItem(db, { payrollItemId: entry.payrollItemId, reason: code, returnedRef: entry.traceNumber, actorUserId });
    return { applied: true, kind: 'CREDIT', outcome: r.outcome };
  }
  if (entry.kind === 'PRENOTE' && entry.payoutMethodId) {
    await db.payoutMethod.update({ where: { id: entry.payoutMethodId }, data: { prenoteStatus: 'RETURNED' } });
    void notifyFinance({
      subject: `A new pay account failed its bank test (${code})`,
      body: `${entry.individualName}’s account ····${entry.accountLast4} came back: ${reason}. Their pay is held from it until they fix the details.`,
      linkUrl: '/payroll/banking?tab=deposits',
      category: 'finance.returned_deposit',
    }).catch(() => undefined);
    return { applied: true, kind: 'PRENOTE', outcome: 'prenote_returned' };
  }
  if ((entry.kind === 'PRENOTE' || entry.kind === 'MICRODEPOSIT') && entry.bankAccountId) {
    await db.employerBankAccount.update({ where: { id: entry.bankAccountId }, data: { status: 'FAILED', microDepositHash: null } });
    return { applied: true, kind: entry.kind, outcome: 'account_failed' };
  }
  return { applied: true, kind: entry.kind };
}

/**
 * A notification of change: the bank posted the entry but says the details
 * are out of date. The corrected account becomes a new payout method (the
 * old one retired, as every change is) that keeps its verification — the
 * receiving bank is the authority on its own account — and splits.
 */
export async function applyNoc(db: PrismaClient, ref: { traceNumber?: string; entryId?: string }, code: string, correctedData: string, actorUserId: string | null = null, now = new Date()): Promise<{ applied: boolean; reason?: string }> {
  const entry = ref.entryId ? await db.achEntry.findFirst({ where: { id: ref.entryId, tenantId: tenantIdForWrite() } }) : ref.traceNumber ? await entryByTrace(db, ref.traceNumber) : null;
  if (!entry) return { applied: false, reason: 'unknown_entry' };
  if (entry.nocAppliedAt) return { applied: false, reason: 'already_applied' };
  const fix = interpretNoc(code, correctedData);
  await db.achEntry.update({ where: { id: entry.id }, data: { nocCode: code.slice(0, 3), nocData: correctedData.slice(0, 29) } });
  if (!fix || (fix.routingNumber && !isValidRouting(fix.routingNumber))) return { applied: false, reason: 'unsupported_change' };

  if (entry.payoutMethodId) {
    const old = await db.payoutMethod.findUnique({ where: { id: entry.payoutMethodId } });
    const b = old ? methodBank(old) : null;
    if (!old || !b) return { applied: false, reason: 'method_missing' };
    if (old.retiredAt) {
      await db.achEntry.update({ where: { id: entry.id }, data: { nocAppliedAt: now, status: 'CORRECTED' } });
      return { applied: false, reason: 'method_replaced' };
    }
    const routing = fix.routingNumber ?? b.routing;
    const account = fix.accountNumber ?? b.account;
    const type = fix.accountType ?? (old.accountType === 'SAVINGS' ? 'SAVINGS' : 'CHECKING');
    const created = await db.$transaction(async (tx) => {
      await tx.payoutMethod.update({ where: { id: old.id }, data: { isPrimary: false, retiredAt: now } });
      return tx.payoutMethod.create({
        data: {
          tenantId: old.tenantId,
          associateId: old.associateId,
          type: 'BANK_ACCOUNT',
          routingNumberEnc: Buffer.from(routing, 'utf8'),
          accountNumberEnc: encryptString(account),
          accountType: type,
          bankName: old.bankName,
          isPrimary: old.isPrimary,
          verifiedAt: old.verifiedAt ?? now,
          verifiedById: old.verifiedById,
          accountLast4: account.slice(-4),
          accountFingerprint: accountFingerprint(routing, account),
          splitKind: old.splitKind,
          splitAmountCents: old.splitAmountCents,
          splitPercent: old.splitPercent,
          splitOrder: old.splitOrder,
          prenoteStatus: 'CLEARED',
        },
      });
    });
    await db.achEntry.update({ where: { id: entry.id }, data: { nocAppliedAt: now, status: 'CORRECTED' } });
    enqueueAudit(
      {
        actorUserId,
        action: 'payroll.ach_noc_applied',
        entityType: 'PayoutMethod',
        entityId: created.id,
        metadata: { code, previousMethodId: old.id, associateId: old.associateId, before: { last4: old.accountLast4, type: old.accountType, routingLast4: b.routing.slice(-4) }, after: { last4: account.slice(-4), type, routingLast4: routing.slice(-4) }, trace: entry.traceNumber },
      },
      'banking.noc',
    );
    return { applied: true };
  }
  if (entry.bankAccountId) {
    const acct = await db.employerBankAccount.findUnique({ where: { id: entry.bankAccountId } });
    if (!acct) return { applied: false, reason: 'account_missing' };
    const account = fix.accountNumber ?? tryDecryptString(Buffer.from(acct.accountNumberEnc));
    if (!account) return { applied: false, reason: 'account_unreadable' };
    await db.employerBankAccount.update({
      where: { id: acct.id },
      data: {
        routingNumber: fix.routingNumber ?? acct.routingNumber,
        accountNumberEnc: encryptString(account),
        accountLast4: account.slice(-4),
        ...(fix.accountType ? { accountType: fix.accountType } : {}),
      },
    });
    await db.achEntry.update({ where: { id: entry.id }, data: { nocAppliedAt: now, status: 'CORRECTED' } });
    enqueueAudit({ actorUserId, action: 'banking.account_noc_applied', entityType: 'EmployerBankAccount', entityId: acct.id, metadata: { code, before: { last4: acct.accountLast4, routing: acct.routingNumber }, after: { last4: account.slice(-4), routing: fix.routingNumber ?? acct.routingNumber } } }, 'banking.noc');
    return { applied: true };
  }
  return { applied: false, reason: 'nothing_to_correct' };
}

/** Settled: a partner said so, or a credit's effective date passed with no return. */
export async function markEntriesSettled(db: Db, now = new Date()): Promise<number> {
  await loadTenantHolidays(db);
  const cutoff = addBankingDays(ymd(now), -2);
  const files = await db.achFile.findMany({ where: { tenantId: tenantIdForWrite(), effectiveDate: { lte: new Date(`${cutoff}T00:00:00Z`) }, status: { in: ['CREATED', 'DOWNLOADED', 'SUBMITTED'] } }, select: { id: true } });
  if (!files.length) return 0;
  const r = await db.achEntry.updateMany({ where: { achFileId: { in: files.map((f) => f.id) }, status: 'SENT' }, data: { status: 'SETTLED' } });
  await db.achFile.updateMany({ where: { id: { in: files.map((f) => f.id) }, status: { in: ['DOWNLOADED', 'SUBMITTED'] } }, data: { status: 'SETTLED' } });
  return r.count;
}
