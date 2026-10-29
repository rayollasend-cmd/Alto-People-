import { Prisma, type BillPayment, type BillPaymentApplication, type PrismaClient } from '@prisma/client';
import type { BooksBillPayment, BooksBillPaymentBatchInput, BooksBillPaymentInput, BooksPayFromAccount } from '@alto-people/shared';
import { HttpError } from '../../../middleware/error.js';
import { enqueueAudit } from '../../audit.js';
import { bankingProfile, originate, usesOurAch } from '../../banking/ach.js';
import { tenantIdForWrite } from '../../tenant.js';
import { emitBooksChange } from '../events.js';
import { postEntry, voidEntry } from '../ledger.js';
import { cents, dateOnly, dollars, money, todayYmd, ymd, type Db } from './shared.js';
import { vendorBank, vendorInReach } from './vendors.js';

/**
 * Paying vendors. One payment can settle several of a vendor's approved
 * bills, in part or in full; it posts BILL_PAYMENT (AP debited for the
 * vendor, the bank or card account credited) and lowers each bill's
 * balance. When the company sends its own ACH (payroll banking on ACH), a
 * payment can go out as an ACH credit to the vendor's bank; otherwise it
 * records a payment made elsewhere (a check, the bank's own bill pay, a card).
 */

export type PaymentWithApps = BillPayment & { applications: BillPaymentApplication[] };

/** The accounts a payment can come out of: active BANK and CREDIT_CARD ledger accounts. */
export async function payFromAccounts(db: Db): Promise<BooksPayFromAccount[]> {
  const rows = await db.ledgerAccount.findMany({
    where: { tenantId: tenantIdForWrite(), isActive: true, subtype: { in: ['BANK', 'CREDIT_CARD'] } },
    orderBy: { code: 'asc' },
    select: { id: true, code: true, name: true, subtype: true },
  });
  return rows;
}

export async function paymentInReach(db: Db, id: string): Promise<PaymentWithApps> {
  const p = /^[0-9a-f-]{36}$/i.test(id) ? await db.billPayment.findFirst({ where: { id, tenantId: tenantIdForWrite() }, include: { applications: true } }) : null;
  if (!p) throw new HttpError(404, 'payment_not_found', 'Payment not found.');
  return p;
}

function statusFor(balance: number, total: number): 'APPROVED' | 'PARTIALLY_PAID' | 'PAID' {
  if (balance <= 0) return 'PAID';
  return balance < total ? 'PARTIALLY_PAID' : 'APPROVED';
}

export async function payBills(db: PrismaClient, input: BooksBillPaymentInput, actorUserId: string, now: Date = new Date()): Promise<PaymentWithApps> {
  const tenantId = tenantIdForWrite();
  const vendor = await vendorInReach(db, input.vendorId);
  const from = await db.ledgerAccount.findFirst({ where: { id: input.bankAccountId, tenantId } });
  if (!from || (from.subtype !== 'BANK' && from.subtype !== 'CREDIT_CARD')) throw new HttpError(400, 'not_a_bank_account', 'Pay from a bank or credit card account.');
  if (!from.isActive) throw new HttpError(400, 'inactive_account', `${from.code} ${from.name} is inactive.`);
  if (input.method === 'CARD' && from.subtype !== 'CREDIT_CARD') throw new HttpError(400, 'card_from_bank', 'A card payment comes out of a credit card account.');
  if (input.sendAch && input.method !== 'ACH') throw new HttpError(400, 'ach_only', 'Only an ACH payment can be sent over ACH.');

  // Merge repeats of the same bill, then check each against what it still owes.
  const want = new Map<string, number>();
  for (const a of input.applications) want.set(a.billId, (want.get(a.billId) ?? 0) + cents(a.amount));
  const bills = await db.bill.findMany({ where: { tenantId, id: { in: [...want.keys()] } } });
  if (bills.length !== want.size) throw new HttpError(404, 'bill_not_found', 'One of those bills was not found.');
  for (const b of bills) {
    if (b.vendorId !== vendor.id) throw new HttpError(400, 'bill_other_vendor', `Bill ${b.billNumber ?? b.id.slice(0, 8)} is from another vendor.`);
    if (b.status !== 'APPROVED' && b.status !== 'PARTIALLY_PAID') throw new HttpError(409, 'bill_not_payable', `Bill ${b.billNumber ?? b.id.slice(0, 8)} is ${b.status.toLowerCase().replace(/_/g, ' ')} — only approved bills are paid.`);
    if (want.get(b.id)! > cents(b.balance)) throw new HttpError(400, 'overpayment', `Bill ${b.billNumber ?? b.id.slice(0, 8)} has ${money(dollars(cents(b.balance)))} left to pay.`);
  }
  const totalCents = [...want.values()].reduce((s, c) => s + c, 0);

  // Over the company's own ACH: checked before anything is written.
  let bank: { routing: string; account: string } | null = null;
  let profile = null;
  if (input.sendAch) {
    profile = await bankingProfile(db);
    if (!usesOurAch(profile)) throw new HttpError(409, 'own_ach_off', 'Payroll banking isn’t sending its own ACH, so this payment can only be recorded, not sent. Pay it from the bank and record it here.');
    bank = vendorBank(vendor);
    if (!bank) throw new HttpError(409, 'vendor_no_bank', `${vendor.name} has no bank details on file.`);
  }

  const paidOn = input.paidOn;
  const payment = await db.$transaction(async (tx) => {
    const p = await tx.billPayment.create({
      data: {
        tenantId,
        vendorId: vendor.id,
        paidOn: dateOnly(paidOn),
        method: input.method,
        amount: new Prisma.Decimal(dollars(totalCents)),
        bankAccountId: from.id,
        reference: input.reference ?? null,
        checkNumber: input.checkNumber ?? null,
        status: paidOn > todayYmd(now) ? 'SCHEDULED' : 'SENT',
        createdById: actorUserId,
        applications: { create: [...want.entries()].map(([billId, c]) => ({ tenantId, billId, amount: new Prisma.Decimal(dollars(c)) })) },
      },
      include: { applications: true },
    });
    // Claim, then act (deep audit CODE-18). The checks above read the bills
    // outside this transaction; two payments sent at once both passed them
    // and both wrote `stale balance − amount` (a lost update — the bill paid
    // twice, its balance down once). Each bill is now lowered by a
    // conditional decrement that only lands while it is still payable and
    // still owes at least this much: the second payment waits on the row
    // lock, re-reads the lowered balance, matches nothing and rolls back
    // whole — no payment row, no entry, no ACH file.
    for (const b of bills) {
      const amount = new Prisma.Decimal(dollars(want.get(b.id)!));
      const claimed = await tx.bill.updateMany({
        where: { id: b.id, tenantId, status: { in: ['APPROVED', 'PARTIALLY_PAID'] }, balance: { gte: amount } },
        data: { balance: { decrement: amount } },
      });
      if (claimed.count !== 1) {
        const now = await tx.bill.findUnique({ where: { id: b.id }, select: { balance: true, status: true } });
        throw new HttpError(
          409,
          'bill_changed',
          `Bill ${b.billNumber ?? b.id.slice(0, 8)} changed while this payment was being made${now ? ` — it now has ${money(dollars(cents(now.balance)))} left to pay` : ''}. Nothing was paid; look again and retry.`,
        );
      }
      const after = await tx.bill.findUniqueOrThrow({ where: { id: b.id }, select: { balance: true, total: true } });
      await tx.bill.update({ where: { id: b.id }, data: { status: statusFor(cents(after.balance), cents(after.total)) } });
    }
    return p;
  });

  const entry = await postEntry(db, {
    date: paidOn,
    memo: `Payment to ${vendor.name}${input.reference ? ` (${input.reference})` : input.checkNumber ? ` (check ${input.checkNumber})` : ''}`,
    source: 'BILL_PAYMENT',
    sourceType: 'BillPayment',
    sourceId: payment.id,
    sourceKey: `bill-payment:${payment.id}`,
    createdById: actorUserId,
    lines: [
      { account: 'AP', debit: dollars(totalCents), memo: vendor.name, vendorId: vendor.id },
      { account: from.id, credit: dollars(totalCents), memo: vendor.name, vendorId: vendor.id },
    ],
  });
  let updated = await db.billPayment.update({ where: { id: payment.id }, data: { journalEntryId: entry.id }, include: { applications: true } });

  if (input.sendAch && bank && profile) {
    let result;
    try {
      result = await originate(db, profile, {
      purpose: 'VENDOR',
      effectiveDate: paidOn > todayYmd(now) ? paidOn : todayYmd(now),
      sameDay: false,
      entryDescription: 'VENDOR PAY',
      createdById: actorUserId,
      entries: [
        {
          kind: 'CREDIT',
          sec: 'CCD',
          amountCents: totalCents,
          routingNumber: bank.routing,
          accountNumber: bank.account,
          accountType: 'CHECKING',
          name: vendor.name.slice(0, 22),
          individualId: (input.reference ?? payment.id).slice(0, 15),
        },
      ],
      });
    } catch (err) {
      // Nothing went to the bank: take the payment back off the books.
      await voidPayment(db, updated, 'The ACH file could not be made', actorUserId);
      throw err;
    }
    updated =await db.billPayment.update({ where: { id: payment.id }, data: { achFileId: result.file.id }, include: { applications: true } });
  }

  enqueueAudit(
    { actorUserId, clientId: null, action: 'books.bill_payment', entityType: 'BillPayment', entityId: payment.id, metadata: { vendor: vendor.name, amount: dollars(totalCents), method: input.method, bills: [...want.keys()], achFileId: updated.achFileId } },
    'books.payables',
  );
  emitBooksChange({ localType: 'BillPayment', localId: payment.id, op: 'UPSERT' });
  for (const b of bills) emitBooksChange({ localType: 'Bill', localId: b.id, op: 'UPSERT' });
  return updated;
}

/**
 * Finance walk 8 — pay several vendors in one run. Every vendor's payment
 * is checked first (the bills, the balances, the account, the ACH rail);
 * then each posts through payBills in turn. A failure part-way voids what
 * already posted, so the run lands whole or not at all.
 */
export async function payBillsBatch(db: PrismaClient, input: BooksBillPaymentBatchInput, actorUserId: string, now: Date = new Date()): Promise<PaymentWithApps[]> {
  const tenantId = tenantIdForWrite();
  const from = await db.ledgerAccount.findFirst({ where: { id: input.bankAccountId, tenantId } });
  if (!from || (from.subtype !== 'BANK' && from.subtype !== 'CREDIT_CARD')) throw new HttpError(400, 'not_a_bank_account', 'Pay from a bank or credit card account.');
  if (!from.isActive) throw new HttpError(400, 'inactive_account', `${from.code} ${from.name} is inactive.`);
  const seen = new Set<string>();
  for (const v of input.vendors) {
    if (seen.has(v.vendorId)) throw new HttpError(400, 'vendor_repeated', 'Each vendor once per run.');
    seen.add(v.vendorId);
    const vendor = await vendorInReach(db, v.vendorId);
    const want = new Map<string, number>();
    for (const a of v.applications) want.set(a.billId, (want.get(a.billId) ?? 0) + cents(a.amount));
    const bills = await db.bill.findMany({ where: { tenantId, id: { in: [...want.keys()] } } });
    if (bills.length !== want.size) throw new HttpError(404, 'bill_not_found', `One of ${vendor.name}’s bills was not found.`);
    for (const b of bills) {
      if (b.vendorId !== vendor.id) throw new HttpError(400, 'bill_other_vendor', `Bill ${b.billNumber ?? b.id.slice(0, 8)} is not ${vendor.name}’s.`);
      if (b.status !== 'APPROVED' && b.status !== 'PARTIALLY_PAID') throw new HttpError(409, 'bill_not_payable', `Bill ${b.billNumber ?? b.id.slice(0, 8)} is ${b.status.toLowerCase().replace(/_/g, ' ')} — only approved bills are paid.`);
      if (want.get(b.id)! > cents(b.balance)) throw new HttpError(400, 'overpayment', `Bill ${b.billNumber ?? b.id.slice(0, 8)} has ${money(dollars(cents(b.balance)))} left to pay.`);
    }
    if (input.sendAch && !vendorBank(vendor)) throw new HttpError(409, 'vendor_no_bank', `${vendor.name} has no bank details on file — take ACH off, or pay them from the bank.`);
  }
  if (input.sendAch) {
    const profile = await bankingProfile(db);
    if (!usesOurAch(profile)) throw new HttpError(409, 'own_ach_off', 'Payroll banking isn’t sending its own ACH, so this run can only be recorded, not sent.');
  }
  const posted: PaymentWithApps[] = [];
  for (const v of input.vendors) {
    try {
      posted.push(
        await payBills(
          db,
          { vendorId: v.vendorId, paidOn: input.paidOn, method: input.method, bankAccountId: input.bankAccountId, reference: v.reference ?? null, checkNumber: v.checkNumber ?? null, sendAch: input.sendAch ?? false, applications: v.applications },
          actorUserId,
          now,
        ),
      );
    } catch (err) {
      // All or nothing: take back what this run already posted.
      for (const p of posted.reverse()) await voidPayment(db, p, 'A later payment in the same run failed', actorUserId).catch(() => undefined);
      throw err;
    }
  }
  enqueueAudit({ actorUserId, clientId: null, action: 'books.bill_run', entityType: 'BillPayment', entityId: posted[0]?.id ?? 'none', metadata: { vendors: posted.length, total: dollars(posted.reduce((s, p) => s + cents(p.amount), 0)), method: input.method, paidOn: input.paidOn } }, 'books.payables');
  return posted;
}

/** Take a payment back: its entry voided (or reversed, its month closed) and the bills owed again. */
export async function voidPayment(db: PrismaClient, payment: PaymentWithApps, reason: string, actorUserId: string): Promise<PaymentWithApps> {
  if (payment.status === 'VOID') throw new HttpError(409, 'payment_void', 'This payment is already void.');
  if (payment.achFileId) {
    const file = await db.achFile.findFirst({ where: { id: payment.achFileId } });
    if (file && file.status !== 'CREATED' && file.status !== 'REJECTED') {
      throw new HttpError(409, 'ach_already_sent', 'This payment already went to the bank over ACH. Ask the vendor to send it back, then record the refund.');
    }
  }
  if (payment.journalEntryId) await voidEntry(db, payment.journalEntryId, { reason: `Payment voided: ${reason}`, userId: actorUserId });
  const updated = await db.$transaction(async (tx) => {
    // Claim the void first (deep audit CODE-18): two voids at once used to
    // both give the bills their money back. Only the one that flips the
    // payment to VOID restores them.
    const claimed = await tx.billPayment.updateMany({ where: { id: payment.id, status: { not: 'VOID' } }, data: { status: 'VOID', voidedAt: new Date() } });
    if (claimed.count !== 1) throw new HttpError(409, 'payment_void', 'This payment is already void.');
    for (const a of payment.applications) {
      // An atomic increment (it takes the row lock), then the status from
      // the balance as it now stands — never a read-then-write of a stale balance.
      const bumped = await tx.bill.updateMany({ where: { id: a.billId, status: { not: 'VOID' } }, data: { balance: { increment: a.amount } } });
      if (bumped.count !== 1) continue;
      const b = await tx.bill.findUniqueOrThrow({ where: { id: a.billId }, select: { balance: true, total: true } });
      const left = Math.min(cents(b.balance), cents(b.total));
      await tx.bill.update({ where: { id: a.billId }, data: { balance: new Prisma.Decimal(dollars(left)), status: statusFor(left, cents(b.total)) } });
    }
    return tx.billPayment.findUniqueOrThrow({ where: { id: payment.id }, include: { applications: true } });
  });
  enqueueAudit({ actorUserId, clientId: null, action: 'books.bill_payment_voided', entityType: 'BillPayment', entityId: payment.id, metadata: { reason, amount: Number(payment.amount) } }, 'books.payables');
  emitBooksChange({ localType: 'BillPayment', localId: payment.id, op: 'DELETE' });
  for (const a of payment.applications) emitBooksChange({ localType: 'Bill', localId: a.billId, op: 'UPSERT' });
  return updated;
}

export async function shapePayments(db: Db, payments: PaymentWithApps[]): Promise<BooksBillPayment[]> {
  if (payments.length === 0) return [];
  const [vendors, accounts, bills] = await Promise.all([
    db.vendor.findMany({ where: { id: { in: [...new Set(payments.map((p) => p.vendorId))] } }, select: { id: true, name: true } }),
    db.ledgerAccount.findMany({ where: { id: { in: [...new Set(payments.map((p) => p.bankAccountId))] } }, select: { id: true, code: true, name: true } }),
    db.bill.findMany({ where: { id: { in: [...new Set(payments.flatMap((p) => p.applications.map((a) => a.billId)))] } }, select: { id: true, billNumber: true } }),
  ]);
  const vName = new Map(vendors.map((v) => [v.id, v.name]));
  const aName = new Map(accounts.map((a) => [a.id, `${a.code} ${a.name}`]));
  const bNo = new Map(bills.map((b) => [b.id, b.billNumber]));
  return payments.map((p) => ({
    id: p.id,
    vendorId: p.vendorId,
    vendorName: vName.get(p.vendorId) ?? 'A vendor',
    paidOn: ymd(p.paidOn),
    method: p.method as BooksBillPayment['method'],
    amount: dollars(cents(p.amount)),
    bankAccountId: p.bankAccountId,
    bankAccountName: aName.get(p.bankAccountId) ?? 'An account',
    reference: p.reference,
    checkNumber: p.checkNumber,
    status: p.status,
    achFileId: p.achFileId,
    journalEntryId: p.journalEntryId,
    applications: p.applications.map((a) => ({ billId: a.billId, billNumber: bNo.get(a.billId) ?? null, amount: dollars(cents(a.amount)) })),
    createdAt: p.createdAt.toISOString(),
  }));
}
