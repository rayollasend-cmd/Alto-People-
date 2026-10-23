import { Prisma, type Bill, type BillLine, type PrismaClient } from '@prisma/client';
import type { BooksBill, BooksBillInput, BooksBillLineInput } from '@alto-people/shared';
import { HttpError } from '../../../middleware/error.js';
import { enqueueAudit } from '../../audit.js';
import { createApprovalRequest, mayDecide, registerApplyHandler, type Decider } from '../../approvalRequests.js';
import { tenantIdForWrite } from '../../tenant.js';
import { emitBooksChange } from '../events.js';
import { postEntry, voidEntry } from '../ledger.js';
import { addDays, cents, daysBetween, dollars, money, todayYmd, userNames, ymd, dateOnly, type Db } from './shared.js';
import { vendorInReach } from './vendors.js';

/**
 * Bills — what the company owes its vendors.
 *
 *   DRAFT → (submit) PENDING_APPROVAL → (a second person approves) APPROVED
 *     → PARTIALLY_PAID → PAID;  any unpaid bill can be VOIDed.
 *
 * A bill is owed — on the books, in AP — only once a second holder of
 * manage:books approves it (BILL_APPROVAL; the person who entered it never
 * can). Approval posts the BILL entry: each line's account debited, with its
 * client / site / department / cost center, AP credited for the vendor.
 * Changing an approved, unpaid bill reopens it: its entry is voided and it
 * goes back through approval — a changed amount is never owed unseen.
 */

export type BillWithLines = Bill & { lines: BillLine[] };

export async function billInReach(db: Db, id: string): Promise<BillWithLines> {
  const b = /^[0-9a-f-]{36}$/i.test(id) ? await db.bill.findFirst({ where: { id, tenantId: tenantIdForWrite() }, include: { lines: { orderBy: { lineNo: 'asc' } } } }) : null;
  if (!b) throw new HttpError(404, 'bill_not_found', 'Bill not found.');
  return b;
}

async function assertLineAccounts(db: Db, lines: BooksBillLineInput[]): Promise<void> {
  const ids = [...new Set(lines.map((l) => l.accountId))];
  const accounts = await db.ledgerAccount.findMany({ where: { tenantId: tenantIdForWrite(), id: { in: ids } } });
  const byId = new Map(accounts.map((a) => [a.id, a]));
  for (const id of ids) {
    const a = byId.get(id);
    if (!a) throw new HttpError(400, 'unknown_account', 'A line names a ledger account that does not exist.');
    if (!a.isActive) throw new HttpError(400, 'inactive_account', `${a.code} ${a.name} is inactive.`);
    if (a.subtype === 'AP' || a.subtype === 'BANK' || a.subtype === 'CREDIT_CARD') {
      throw new HttpError(400, 'account_not_for_bills', `${a.code} ${a.name} can’t be a bill line — choose the expense or asset the bill is for.`);
    }
  }
}

function lineRows(tenantId: string, lines: BooksBillLineInput[]) {
  return lines.map((l, i) => ({
    tenantId,
    lineNo: i + 1,
    accountId: l.accountId,
    description: l.description ?? null,
    amount: new Prisma.Decimal(dollars(cents(l.amount))),
    clientId: l.clientId ?? null,
    siteId: l.siteId ?? null,
    departmentId: l.departmentId ?? null,
    costCenterId: l.costCenterId ?? null,
  }));
}

const totalOf = (lines: BooksBillLineInput[]) => dollars(lines.reduce((s, l) => s + cents(l.amount), 0));

export async function createBill(db: Db, input: BooksBillInput, actorUserId: string | null, extra: { recurringId?: string | null } = {}): Promise<BillWithLines> {
  const vendor = await vendorInReach(db, input.vendorId);
  if (!vendor.isActive) throw new HttpError(409, 'vendor_inactive', `${vendor.name} is inactive.`);
  await assertLineAccounts(db, input.lines);
  const tenantId = tenantIdForWrite();
  const total = totalOf(input.lines);
  const dueDate = input.dueDate ?? addDays(input.billDate, vendor.termsDays);
  if (dueDate < input.billDate) throw new HttpError(400, 'due_before_bill', 'The due date is before the bill date.');
  const bill = await db.bill.create({
    data: {
      tenantId,
      vendorId: vendor.id,
      billNumber: input.billNumber ?? null,
      billDate: dateOnly(input.billDate),
      dueDate: dateOnly(dueDate),
      status: 'DRAFT',
      total: new Prisma.Decimal(total),
      balance: new Prisma.Decimal(total),
      memo: input.memo ?? null,
      createdById: actorUserId,
      recurringId: extra.recurringId ?? null,
      lines: { create: lineRows(tenantId, input.lines) },
    },
    include: { lines: { orderBy: { lineNo: 'asc' } } },
  });
  enqueueAudit({ actorUserId, clientId: null, action: 'books.bill_created', entityType: 'Bill', entityId: bill.id, metadata: { vendor: vendor.name, total, recurringId: extra.recurringId ?? null } }, 'books.payables');
  return bill;
}

export async function updateBill(db: PrismaClient, bill: BillWithLines, input: BooksBillInput, actorUserId: string): Promise<BillWithLines> {
  if (bill.status !== 'DRAFT') throw new HttpError(409, 'bill_not_draft', 'Only a draft can be changed. Withdraw it from approval, or reopen it, first.');
  const vendor = await vendorInReach(db, input.vendorId);
  await assertLineAccounts(db, input.lines);
  const tenantId = tenantIdForWrite();
  const total = totalOf(input.lines);
  const dueDate = input.dueDate ?? addDays(input.billDate, vendor.termsDays);
  if (dueDate < input.billDate) throw new HttpError(400, 'due_before_bill', 'The due date is before the bill date.');
  const updated = await db.$transaction(async (tx) => {
    await tx.billLine.deleteMany({ where: { billId: bill.id } });
    return tx.bill.update({
      where: { id: bill.id },
      data: {
        vendorId: vendor.id,
        billNumber: input.billNumber ?? null,
        billDate: dateOnly(input.billDate),
        dueDate: dateOnly(dueDate),
        total: new Prisma.Decimal(total),
        balance: new Prisma.Decimal(total),
        memo: input.memo ?? null,
        lines: { create: lineRows(tenantId, input.lines) },
      },
      include: { lines: { orderBy: { lineNo: 'asc' } } },
    });
  });
  enqueueAudit({ actorUserId, clientId: null, action: 'books.bill_updated', entityType: 'Bill', entityId: bill.id, metadata: { total } }, 'books.payables');
  return updated;
}

/** Send a draft to a second person. */
export async function submitBill(db: Db, bill: BillWithLines, requesterUserId: string | null) {
  if (bill.status !== 'DRAFT') throw new HttpError(409, 'bill_not_draft', 'Only a draft goes to approval.');
  if (bill.lines.length === 0 || cents(bill.total) <= 0) throw new HttpError(400, 'bill_empty', 'A bill needs at least one line with an amount.');
  const vendor = await vendorInReach(db, bill.vendorId);
  const total = dollars(cents(bill.total));
  const approval = await createApprovalRequest(db, {
    kind: 'BILL_APPROVAL',
    subjectType: 'Bill',
    subjectId: bill.id,
    title: `${money(total)} bill from ${vendor.name}`,
    summary: `${bill.billNumber ? `Invoice ${bill.billNumber}, ` : ''}dated ${ymd(bill.billDate)}, due ${ymd(bill.dueDate)}. ${bill.lines.length} ${bill.lines.length === 1 ? 'line' : 'lines'}${bill.memo ? ` — ${bill.memo}` : ''}. Approving puts it on the books as owed.`,
    proposed: { billId: bill.id, vendorId: vendor.id, total, dueDate: ymd(bill.dueDate) },
    requesterUserId,
    approver: { capability: 'manage:books' },
  });
  await db.bill.update({ where: { id: bill.id }, data: { status: 'PENDING_APPROVAL', approvalRequestId: approval.id } });
  enqueueAudit({ actorUserId: requesterUserId, clientId: null, action: 'books.bill_submitted', entityType: 'Bill', entityId: bill.id, metadata: { approvalId: approval.id, total } }, 'books.payables');
  return approval;
}

/** Take a bill back out of approval (the request is withdrawn). */
export async function withdrawBill(db: PrismaClient, bill: BillWithLines, actorUserId: string): Promise<void> {
  if (bill.status !== 'PENDING_APPROVAL') throw new HttpError(409, 'bill_not_pending', 'This bill is not waiting for approval.');
  await db.$transaction(async (tx) => {
    if (bill.approvalRequestId) {
      await tx.approvalRequest.updateMany({ where: { id: bill.approvalRequestId, status: 'PENDING' }, data: { status: 'CANCELLED', decidedById: actorUserId, decidedAt: new Date() } });
    }
    await tx.bill.update({ where: { id: bill.id }, data: { status: 'DRAFT', approvalRequestId: null } });
  });
  enqueueAudit({ actorUserId, clientId: null, action: 'books.bill_withdrawn', entityType: 'Bill', entityId: bill.id, metadata: {} }, 'books.payables');
}

/** The BILL entry: lines debited with their dimensions, AP credited for the vendor. */
export async function postBillEntry(db: PrismaClient, bill: BillWithLines, actorUserId: string | null) {
  const vendor = await db.vendor.findUniqueOrThrow({ where: { id: bill.vendorId } });
  return postEntry(db, {
    date: ymd(bill.billDate),
    memo: `Bill${bill.billNumber ? ` ${bill.billNumber}` : ''} from ${vendor.name}`,
    source: 'BILL',
    sourceType: 'Bill',
    sourceId: bill.id,
    sourceKey: `bill:${bill.id}`,
    createdById: actorUserId,
    lines: [
      ...bill.lines.map((l) => ({
        account: l.accountId,
        debit: Number(l.amount),
        memo: l.description,
        clientId: l.clientId,
        siteId: l.siteId,
        departmentId: l.departmentId,
        costCenterId: l.costCenterId,
        vendorId: vendor.id,
      })),
      { account: 'AP', credit: dollars(cents(bill.total)), memo: vendor.name, vendorId: vendor.id },
    ],
  });
}

registerApplyHandler(
  'BILL_APPROVAL',
  async (db, row, decider: Decider) => {
    const p = row.proposed as { billId: string };
    const bill = await db.bill.findFirst({ where: { id: p.billId }, include: { lines: { orderBy: { lineNo: 'asc' } } } });
    if (!bill) throw new Error('The bill no longer exists.');
    if (bill.status !== 'PENDING_APPROVAL' || bill.approvalRequestId !== row.id) throw new Error('The bill changed after it was sent for approval; send it again.');
    if (cents(bill.total) !== cents((row.proposed as { total: number }).total)) throw new Error('The bill’s total changed after it was sent for approval; send it again.');
    const entry = await postBillEntry(db, bill, decider.id);
    await db.bill.update({ where: { id: bill.id }, data: { status: 'APPROVED', approvedById: decider.id, approvedAt: new Date(), journalEntryId: entry.id } });
    enqueueAudit({ actorUserId: decider.id, clientId: null, action: 'books.bill_approved', entityType: 'Bill', entityId: bill.id, metadata: { approvalId: row.id, entryId: entry.id, total: Number(bill.total) } }, 'books.payables');
    emitBooksChange({ localType: 'Bill', localId: bill.id, op: 'UPSERT' });
  },
  async (db, row, decider) => {
    const p = row.proposed as { billId: string };
    await db.bill.updateMany({ where: { id: p.billId, status: 'PENDING_APPROVAL', approvalRequestId: row.id }, data: { status: 'DRAFT', approvalRequestId: null } });
    enqueueAudit({ actorUserId: decider.id, clientId: null, action: 'books.bill_rejected', entityType: 'Bill', entityId: p.billId, metadata: { approvalId: row.id, reason: row.reason } }, 'books.payables');
  },
);

async function livePayments(db: Db, billId: string): Promise<number> {
  return db.billPaymentApplication.count({ where: { billId, payment: { status: { not: 'VOID' } } } });
}

/** An approved bill nobody has paid goes back to draft: its entry is voided and it needs approving again. */
export async function reopenBill(db: PrismaClient, bill: BillWithLines, reason: string, actorUserId: string): Promise<void> {
  if (bill.status !== 'APPROVED') throw new HttpError(409, 'bill_not_approved', 'Only an approved, unpaid bill can be reopened.');
  if (await livePayments(db, bill.id)) throw new HttpError(409, 'bill_has_payments', 'Payments were made against this bill. Void them first.');
  if (bill.journalEntryId) await voidEntry(db, bill.journalEntryId, { reason: `Bill reopened: ${reason}`, userId: actorUserId });
  await db.bill.update({ where: { id: bill.id }, data: { status: 'DRAFT', approvalRequestId: null, approvedAt: null, approvedById: null, journalEntryId: null } });
  enqueueAudit({ actorUserId, clientId: null, action: 'books.bill_reopened', entityType: 'Bill', entityId: bill.id, metadata: { reason } }, 'books.payables');
  emitBooksChange({ localType: 'Bill', localId: bill.id, op: 'UPSERT' });
}

export async function voidBill(db: PrismaClient, bill: BillWithLines, reason: string, actorUserId: string): Promise<void> {
  if (bill.status === 'VOID') throw new HttpError(409, 'bill_void', 'This bill is already void.');
  if (await livePayments(db, bill.id)) throw new HttpError(409, 'bill_has_payments', 'Payments were made against this bill. Void them first.');
  if (bill.journalEntryId) await voidEntry(db, bill.journalEntryId, { reason: `Bill voided: ${reason}`, userId: actorUserId });
  await db.$transaction(async (tx) => {
    if (bill.approvalRequestId && bill.status === 'PENDING_APPROVAL') {
      await tx.approvalRequest.updateMany({ where: { id: bill.approvalRequestId, status: 'PENDING' }, data: { status: 'CANCELLED', decidedById: actorUserId, decidedAt: new Date() } });
    }
    await tx.bill.update({ where: { id: bill.id }, data: { status: 'VOID', balance: new Prisma.Decimal(0), voidedAt: new Date() } });
  });
  enqueueAudit({ actorUserId, clientId: null, action: 'books.bill_voided', entityType: 'Bill', entityId: bill.id, metadata: { reason } }, 'books.payables');
  if (bill.journalEntryId) emitBooksChange({ localType: 'Bill', localId: bill.id, op: 'DELETE' });
}

/* ---- Shaping ------------------------------------------------------------- */

export async function shapeBills(db: Db, bills: BillWithLines[], viewer: Decider | null, now: Date = new Date()): Promise<BooksBill[]> {
  if (bills.length === 0) return [];
  const tenantId = tenantIdForWrite();
  const ids = bills.map((b) => b.id);
  const [vendors, accounts, approvals, apps, recurring, entries] = await Promise.all([
    db.vendor.findMany({ where: { id: { in: [...new Set(bills.map((b) => b.vendorId))] } }, select: { id: true, name: true } }),
    db.ledgerAccount.findMany({ where: { tenantId, id: { in: [...new Set(bills.flatMap((b) => b.lines.map((l) => l.accountId)))] } }, select: { id: true, code: true, name: true } }),
    db.approvalRequest.findMany({ where: { tenantId, kind: 'BILL_APPROVAL', subjectId: { in: ids } }, orderBy: { createdAt: 'desc' } }),
    db.billPaymentApplication.findMany({ where: { billId: { in: ids } }, include: { payment: true } }),
    db.recurringBill.findMany({ where: { id: { in: bills.map((b) => b.recurringId).filter((x): x is string => !!x) } }, select: { id: true, name: true } }),
    db.journalEntry.findMany({ where: { id: { in: bills.map((b) => b.journalEntryId).filter((x): x is string => !!x) } }, select: { id: true, number: true } }),
  ]);
  const clientIds = [...new Set(bills.flatMap((b) => b.lines.map((l) => l.clientId)).filter((x): x is string => !!x))];
  const clients = clientIds.length ? await db.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, name: true } }) : [];
  const names = await userNames(db, [...approvals.flatMap((a) => [a.requesterUserId, a.decidedById]), ...bills.flatMap((b) => [b.approvedById, b.createdById])]);
  const vendorName = new Map(vendors.map((v) => [v.id, v.name]));
  const acct = new Map(accounts.map((a) => [a.id, a]));
  const clientName = new Map(clients.map((c) => [c.id, c.name]));
  const recName = new Map(recurring.map((r) => [r.id, r.name]));
  const entryNo = new Map(entries.map((e) => [e.id, e.number]));
  const today = todayYmd(now);
  const out: BooksBill[] = [];
  for (const b of bills) {
    // The live request when there is one, else the most recent decision.
    const a = approvals.find((x) => x.id === b.approvalRequestId) ?? approvals.find((x) => x.subjectId === b.id) ?? null;
    out.push({
      id: b.id,
      vendorId: b.vendorId,
      vendorName: vendorName.get(b.vendorId) ?? 'A vendor',
      billNumber: b.billNumber,
      billDate: ymd(b.billDate),
      dueDate: ymd(b.dueDate),
      status: b.status as BooksBill['status'],
      total: dollars(cents(b.total)),
      balance: dollars(cents(b.balance)),
      memo: b.memo,
      hasAttachment: !!b.attachmentKey,
      attachmentName: b.attachmentName,
      daysPastDue: daysBetween(ymd(b.dueDate), today),
      approval: a
        ? {
            id: a.id,
            status: a.status,
            requesterName: a.requesterUserId ? (names.get(a.requesterUserId) ?? null) : null,
            decidedByName: a.decidedById ? (names.get(a.decidedById) ?? null) : null,
            reason: a.reason,
            mayDecide: viewer ? await mayDecide(db, a, viewer) : false,
            createdAt: a.createdAt.toISOString(),
          }
        : null,
      approvedAt: b.approvedAt?.toISOString() ?? null,
      approvedByName: b.approvedById ? (names.get(b.approvedById) ?? null) : null,
      journalEntryId: b.journalEntryId,
      journalEntryNumber: b.journalEntryId ? (entryNo.get(b.journalEntryId) ?? null) : null,
      recurringName: b.recurringId ? (recName.get(b.recurringId) ?? null) : null,
      lines: b.lines.map((l) => {
        const ac = acct.get(l.accountId);
        return {
          id: l.id,
          lineNo: l.lineNo,
          accountId: l.accountId,
          accountCode: ac?.code ?? '',
          accountName: ac?.name ?? 'An account',
          description: l.description,
          amount: dollars(cents(l.amount)),
          clientId: l.clientId,
          clientName: l.clientId ? (clientName.get(l.clientId) ?? null) : null,
          siteId: l.siteId,
          departmentId: l.departmentId,
          costCenterId: l.costCenterId,
        };
      }),
      payments: apps
        .filter((x) => x.billId === b.id)
        .sort((x, y) => x.payment.paidOn.getTime() - y.payment.paidOn.getTime())
        .map((x) => ({ paymentId: x.paymentId, paidOn: ymd(x.payment.paidOn), method: x.payment.method, amount: dollars(cents(x.amount)), reference: x.payment.reference, status: x.payment.status })),
      createdByName: b.createdById ? (names.get(b.createdById) ?? null) : null,
      createdAt: b.createdAt.toISOString(),
    });
  }
  return out;
}

/** The bill lists' filters ("tab"). */
export function billTabWhere(tab: string | undefined, now: Date = new Date()): Prisma.BillWhereInput {
  const today = dateOnly(todayYmd(now));
  switch (tab) {
    case 'approve':
      return { status: 'PENDING_APPROVAL' };
    case 'unpaid':
      return { status: { in: ['APPROVED', 'PARTIALLY_PAID'] } };
    // Due in the next 7 days, today included — a bill already late is in
    // 'late', never in both (the page's "Due in the next 7 days" tile and
    // its "Late" tile used to count the same late bill twice).
    case 'due':
      return { status: { in: ['APPROVED', 'PARTIALLY_PAID'] }, dueDate: { gte: today, lte: new Date(today.getTime() + 7 * 86_400_000) } };
    case 'late':
      return { status: { in: ['APPROVED', 'PARTIALLY_PAID'] }, dueDate: { lt: today } };
    case 'paid':
      return { status: 'PAID' };
    case 'draft':
      return { status: 'DRAFT' };
    default:
      return {};
  }
}
