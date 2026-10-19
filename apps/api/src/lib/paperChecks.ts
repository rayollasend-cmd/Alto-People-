import type { PayCheck, Prisma, PrismaClient } from '@prisma/client';
import { HttpError } from '../middleware/error.js';
import { createApprovalRequest, registerApplyHandler } from './approvalRequests.js';
import { enqueueAudit } from './audit.js';
import { tryDecryptString } from './crypto.js';
import { notifyUser } from './notify.js';
import { tenantIdForWrite } from './tenant.js';

/**
 * Paper checks: the one-time "pay this paycheck by check" decision, the
 * check's life after it is issued (printed, voided, reissued, stopped),
 * the tenant's check settings, and the bank's positive-pay file.
 *
 * The override changes HOW a paycheck is paid, never how much: it leaves
 * the pre-payroll review's fingerprint alone (lib/payrollReview.ts reads
 * amounts only). The disburse route sends an overridden paycheck to the
 * check register whatever the company's rail is, and our own ACH never
 * puts it in a NACHA file (lib/banking/directDeposit.ts refuses it too).
 */

type Db = PrismaClient | Prisma.TransactionClient;

/** Runs a paycheck in can be switched to a paper check. Daily settlements and manual checks are already settled their own way. */
export const OVERRIDABLE_KINDS = ['REGULAR', 'OFF_CYCLE', 'AMENDMENT'] as const;

export interface OverrideView {
  itemId: string;
  associateId: string;
  name: string;
  reason: string;
  source: 'PAYROLL' | 'ASSOCIATE';
  setAt: string;
  setByUserId: string | null;
}

/** Paychecks in these ids that are set to pay by check now. */
export async function activeOverrides(db: Db, itemIds: string[]): Promise<Set<string>> {
  if (itemIds.length === 0) return new Set();
  const rows = await db.payrollItemPayoutOverride.findMany({ where: { payrollItemId: { in: itemIds }, clearedAt: null, method: 'CHECK' }, select: { payrollItemId: true } });
  return new Set(rows.map((r) => r.payrollItemId));
}

/** Everyone in a run who is paid by check this time, by payroll's choice or their own request. */
export async function overridesForRun(db: Db, runId: string): Promise<OverrideView[]> {
  const rows = await db.payrollItemPayoutOverride.findMany({
    where: { clearedAt: null, payrollItem: { payrollRunId: runId } },
    select: { payrollItemId: true, reason: true, source: true, createdAt: true, updatedAt: true, requestedById: true, payrollItem: { select: { associateId: true, associate: { select: { firstName: true, lastName: true } } } } },
    orderBy: { updatedAt: 'asc' },
  });
  return rows.map((r) => ({
    itemId: r.payrollItemId,
    associateId: r.payrollItem.associateId,
    name: `${r.payrollItem.associate.firstName} ${r.payrollItem.associate.lastName}`,
    reason: r.reason,
    source: r.source as OverrideView['source'],
    setAt: r.updatedAt.toISOString(),
    setByUserId: r.requestedById,
  }));
}

async function overridableItem(db: Db, itemId: string) {
  const item = await db.payrollItem.findFirst({
    where: { id: itemId },
    select: { id: true, status: true, associateId: true, netPay: true, payrollRun: { select: { id: true, status: true, kind: true, clientId: true, periodStart: true, periodEnd: true } }, associate: { select: { firstName: true, lastName: true } } },
  });
  if (!item) throw new HttpError(404, 'item_not_found', 'Paycheck not found.');
  const run = item.payrollRun;
  if (!(OVERRIDABLE_KINDS as readonly string[]).includes(run.kind)) {
    throw new HttpError(409, 'not_overridable', 'Daily pay and manual checks are paid their own way.');
  }
  if (run.status !== 'DRAFT' && run.status !== 'FINALIZED') {
    throw new HttpError(409, 'run_closed', run.status === 'DISBURSED' ? 'This payroll was already paid.' : 'This payroll was voided.');
  }
  if (item.status !== 'PENDING') throw new HttpError(409, 'item_paid', 'This paycheck was already sent.');
  return item;
}

export async function setPayByCheck(
  db: Db,
  input: { itemId: string; reason: string; actorUserId: string | null; source?: 'PAYROLL' | 'ASSOCIATE'; approvalRequestId?: string | null; requestedById?: string | null },
): Promise<OverrideView> {
  const reason = input.reason.trim();
  if (reason.length < 3) throw new HttpError(400, 'reason_required', 'Say why this paycheck goes by check.');
  const item = await overridableItem(db, input.itemId);
  const source = input.source ?? 'PAYROLL';
  const requestedById = input.requestedById ?? input.actorUserId;
  const row = await db.payrollItemPayoutOverride.upsert({
    where: { payrollItemId: item.id },
    create: { tenantId: tenantIdForWrite(), payrollItemId: item.id, method: 'CHECK', reason: reason.slice(0, 500), source, requestedById, approvalRequestId: input.approvalRequestId ?? null },
    update: { method: 'CHECK', reason: reason.slice(0, 500), source, requestedById, approvalRequestId: input.approvalRequestId ?? null, clearedAt: null, clearedById: null, clearReason: null },
  });
  enqueueAudit(
    { actorUserId: input.actorUserId, clientId: item.payrollRun.clientId, action: 'payroll.pay_by_check_set', entityType: 'PayrollItem', entityId: item.id, metadata: { runId: item.payrollRun.id, reason: row.reason, source, approvalRequestId: input.approvalRequestId ?? null } },
    'paperChecks.set',
  );
  return {
    itemId: item.id,
    associateId: item.associateId,
    name: `${item.associate.firstName} ${item.associate.lastName}`,
    reason: row.reason,
    source,
    setAt: row.updatedAt.toISOString(),
    setByUserId: requestedById,
  };
}

export async function clearPayByCheck(db: Db, input: { itemId: string; actorUserId: string; reason?: string | null }): Promise<void> {
  const item = await overridableItem(db, input.itemId);
  const row = await db.payrollItemPayoutOverride.findUnique({ where: { payrollItemId: item.id } });
  if (!row || row.clearedAt) throw new HttpError(409, 'not_set', 'This paycheck isn’t set to pay by check.');
  await db.payrollItemPayoutOverride.update({ where: { id: row.id }, data: { clearedAt: new Date(), clearedById: input.actorUserId, clearReason: input.reason?.trim().slice(0, 500) || null } });
  enqueueAudit(
    { actorUserId: input.actorUserId, clientId: item.payrollRun.clientId, action: 'payroll.pay_by_check_cleared', entityType: 'PayrollItem', entityId: item.id, metadata: { runId: item.payrollRun.id, reason: input.reason ?? null } },
    'paperChecks.clear',
  );
}

/* ---- The associate's request ----------------------------------------- */

const fmtDay = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** The associate's paycheck still open to a change of method: the latest unpaid one in a drafted or finalized run. */
async function openPaycheckFor(db: Db, associateId: string) {
  return db.payrollItem.findFirst({
    where: { associateId, status: 'PENDING', payrollRun: { status: { in: ['DRAFT', 'FINALIZED'] }, kind: { in: [...OVERRIDABLE_KINDS] } } },
    orderBy: { payrollRun: { periodEnd: 'desc' } },
    select: { id: true, payrollRun: { select: { id: true, status: true, periodStart: true, periodEnd: true, clientId: true } }, associate: { select: { firstName: true, lastName: true } } },
  });
}

export interface MyPayByCheck {
  openPaycheck: { itemId: string; periodStart: string; periodEnd: string } | null;
  override: { reason: string; source: 'PAYROLL' | 'ASSOCIATE' } | null;
  request: { id: string; status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED'; reason: string | null; decidedReason: string | null; createdAt: string } | null;
}

export async function myPayByCheck(db: Db, associateId: string): Promise<MyPayByCheck> {
  const open = await openPaycheckFor(db, associateId);
  if (!open) return { openPaycheck: null, override: null, request: null };
  const [ov, req] = await Promise.all([
    db.payrollItemPayoutOverride.findUnique({ where: { payrollItemId: open.id } }),
    db.approvalRequest.findFirst({ where: { kind: 'PAY_BY_CHECK', subjectType: 'PayrollItem', subjectId: open.id }, orderBy: { createdAt: 'desc' } }),
  ]);
  return {
    openPaycheck: { itemId: open.id, periodStart: open.payrollRun.periodStart.toISOString().slice(0, 10), periodEnd: open.payrollRun.periodEnd.toISOString().slice(0, 10) },
    override: ov && !ov.clearedAt ? { reason: ov.reason, source: ov.source as 'PAYROLL' | 'ASSOCIATE' } : null,
    request: req ? { id: req.id, status: req.status, reason: req.summary, decidedReason: req.reason, createdAt: req.createdAt.toISOString() } : null,
  };
}

export async function requestPayByCheck(db: PrismaClient, input: { associateId: string; userId: string; reason: string }): Promise<MyPayByCheck> {
  const reason = input.reason.trim();
  if (reason.length < 3) throw new HttpError(400, 'reason_required', 'Tell payroll why you’d like a check.');
  const open = await openPaycheckFor(db, input.associateId);
  if (!open) throw new HttpError(409, 'no_open_paycheck', 'Your next paycheck isn’t ready yet. You can ask once payroll has prepared it.');
  const ov = await db.payrollItemPayoutOverride.findUnique({ where: { payrollItemId: open.id } });
  if (ov && !ov.clearedAt) throw new HttpError(409, 'already_check', 'This paycheck is already set to come as a paper check.');
  const pending = await db.approvalRequest.findFirst({ where: { kind: 'PAY_BY_CHECK', subjectType: 'PayrollItem', subjectId: open.id, status: 'PENDING' } });
  if (pending) throw new HttpError(409, 'already_requested', 'You already asked. Payroll will answer before payday.');
  const name = `${open.associate.firstName} ${open.associate.lastName}`;
  const period = `${fmtDay(open.payrollRun.periodStart)} – ${fmtDay(open.payrollRun.periodEnd)}`;
  await createApprovalRequest(db, {
    kind: 'PAY_BY_CHECK',
    subjectType: 'PayrollItem',
    subjectId: open.id,
    title: `Paper check for ${name} (${period})`,
    summary: reason.slice(0, 500),
    proposed: { itemId: open.id, runId: open.payrollRun.id, reason: reason.slice(0, 500) },
    requesterUserId: input.userId,
    approver: { capability: 'process:payroll' },
    clientId: open.payrollRun.clientId,
    associateId: input.associateId,
  });
  return myPayByCheck(db, input.associateId);
}

/** At payout the cut-off has passed: open requests for this run close, and the people who asked hear why. */
export async function closePendingCheckRequests(db: PrismaClient, runId: string): Promise<number> {
  const itemIds = (await db.payrollItem.findMany({ where: { payrollRunId: runId }, select: { id: true } })).map((i) => i.id);
  if (itemIds.length === 0) return 0;
  const open = await db.approvalRequest.findMany({ where: { kind: 'PAY_BY_CHECK', status: 'PENDING', subjectType: 'PayrollItem', subjectId: { in: itemIds } }, select: { id: true, requesterUserId: true } });
  for (const r of open) {
    await db.approvalRequest.update({ where: { id: r.id }, data: { status: 'CANCELLED', decidedAt: new Date(), reason: 'Payday cut-off passed before payroll answered.' } });
    if (r.requesterUserId) {
      void notifyUser(r.requesterUserId, {
        subject: 'Your paper check request closed',
        body: 'Payroll sent this payday before answering, so it was paid your usual way. You can ask again for the next payday.',
        category: 'payroll',
        linkUrl: '/payroll',
      });
    }
  }
  return open.length;
}

registerApplyHandler('PAY_BY_CHECK', async (db, row, decider) => {
  const p = row.proposed as { itemId: string; reason: string };
  await setPayByCheck(db, { itemId: p.itemId, reason: p.reason, actorUserId: decider.id, source: 'ASSOCIATE', approvalRequestId: row.id, requestedById: row.requesterUserId });
});

/* ---- Settings ----------------------------------------------------------- */

export interface CheckSettingsView {
  bankAccountId: string | null;
  bankAccountLabel: string | null;
  bankName: string | null;
  bankAddress: string | null;
  fractionalRouting: string | null;
  offsetXPt: number;
  offsetYPt: number;
  hasSignature: boolean;
  signatureSignerName: string | null;
  twoSignatureOver: number | null;
  voidAfterDays: number;
  /** Is a licensed E-13B MICR font installed (MICR_FONT_PATH)? Without one, checks print a placeholder MICR line. */
  micrFontInstalled: boolean;
  ready: boolean;
  gaps: string[];
}

export async function checkSettingsRow(db: Db) {
  return db.checkSettings.findUnique({ where: { tenantId: tenantIdForWrite() } });
}

export async function checkSettingsView(db: Db, micrFontInstalled: boolean): Promise<CheckSettingsView> {
  const s = await checkSettingsRow(db);
  const acct = s?.bankAccountId ? await db.employerBankAccount.findFirst({ where: { id: s.bankAccountId, tenantId: tenantIdForWrite() }, select: { label: true, accountLast4: true, bankName: true } }) : null;
  const gaps: string[] = [];
  if (!acct) gaps.push('Choose the bank account checks are drawn on.');
  if (!s?.bankName && !acct?.bankName) gaps.push('Add the bank’s name as it prints on the check.');
  if (!micrFontInstalled) gaps.push('Install a licensed E-13B MICR font and print on MICR toner so banks can read the check.');
  return {
    bankAccountId: s?.bankAccountId ?? null,
    bankAccountLabel: acct ? `${acct.label} ••••${acct.accountLast4}` : null,
    bankName: s?.bankName ?? acct?.bankName ?? null,
    bankAddress: s?.bankAddress ?? null,
    fractionalRouting: s?.fractionalRouting ?? null,
    offsetXPt: s?.offsetXPt ?? 0,
    offsetYPt: s?.offsetYPt ?? 0,
    hasSignature: !!s?.signatureImage,
    signatureSignerName: s?.signatureSignerName ?? null,
    twoSignatureOver: s?.twoSignatureOverCents != null ? Number(s.twoSignatureOverCents) / 100 : null,
    voidAfterDays: s?.voidAfterDays ?? 90,
    micrFontInstalled,
    ready: !!acct,
    gaps,
  };
}

export async function updateCheckSettings(
  db: Db,
  input: Partial<{ bankAccountId: string | null; bankName: string | null; bankAddress: string | null; fractionalRouting: string | null; offsetXPt: number; offsetYPt: number; signatureSignerName: string | null; twoSignatureOver: number | null; voidAfterDays: number }>,
  actorUserId: string,
): Promise<void> {
  if (input.bankAccountId) {
    const acct = await db.employerBankAccount.findFirst({ where: { id: input.bankAccountId, tenantId: tenantIdForWrite() }, select: { id: true } });
    if (!acct) throw new HttpError(404, 'bank_account_not_found', 'That bank account isn’t set up for this company.');
  }
  const data = {
    ...(input.bankAccountId !== undefined ? { bankAccountId: input.bankAccountId } : {}),
    ...(input.bankName !== undefined ? { bankName: input.bankName } : {}),
    ...(input.bankAddress !== undefined ? { bankAddress: input.bankAddress } : {}),
    ...(input.fractionalRouting !== undefined ? { fractionalRouting: input.fractionalRouting } : {}),
    ...(input.offsetXPt !== undefined ? { offsetXPt: input.offsetXPt } : {}),
    ...(input.offsetYPt !== undefined ? { offsetYPt: input.offsetYPt } : {}),
    ...(input.signatureSignerName !== undefined ? { signatureSignerName: input.signatureSignerName } : {}),
    ...(input.twoSignatureOver !== undefined ? { twoSignatureOverCents: input.twoSignatureOver == null ? null : BigInt(Math.round(input.twoSignatureOver * 100)) } : {}),
    ...(input.voidAfterDays !== undefined ? { voidAfterDays: input.voidAfterDays } : {}),
    updatedById: actorUserId,
  };
  await db.checkSettings.upsert({ where: { tenantId: tenantIdForWrite() }, create: { tenantId: tenantIdForWrite(), ...data }, update: data });
  enqueueAudit({ actorUserId, clientId: null, action: 'payroll.check_settings_updated', entityType: 'CheckSettings', entityId: tenantIdForWrite(), metadata: { fields: Object.keys(input) } }, 'paperChecks.settings');
}

export async function setCheckSignature(db: Db, input: { image: Buffer | null; contentType: string | null; signerName?: string | null; actorUserId: string }): Promise<void> {
  if (input.image && !/^image\/(png|jpeg)$/.test(input.contentType ?? '')) throw new HttpError(400, 'bad_image', 'Upload the signature as a PNG or JPEG.');
  const data = { signatureImage: input.image ? new Uint8Array(input.image) : null, signatureContentType: input.image ? input.contentType : null, ...(input.signerName !== undefined ? { signatureSignerName: input.signerName } : {}), updatedById: input.actorUserId };
  await db.checkSettings.upsert({ where: { tenantId: tenantIdForWrite() }, create: { tenantId: tenantIdForWrite(), ...data }, update: data });
  enqueueAudit({ actorUserId: input.actorUserId, clientId: null, action: input.image ? 'payroll.check_signature_set' : 'payroll.check_signature_removed', entityType: 'CheckSettings', entityId: tenantIdForWrite(), metadata: {} }, 'paperChecks.signature');
}

/** The account checks are drawn on, with the full numbers for the MICR line. Never logged. */
export async function drawerAccount(db: Db): Promise<{ routing: string; account: string; last4: string; bankName: string | null } | null> {
  const s = await checkSettingsRow(db);
  if (!s?.bankAccountId) return null;
  const acct = await db.employerBankAccount.findFirst({ where: { id: s.bankAccountId, tenantId: tenantIdForWrite() } });
  if (!acct) return null;
  const account = tryDecryptString(Buffer.from(acct.accountNumberEnc));
  if (!account) return null;
  return { routing: acct.routingNumber, account, last4: acct.accountLast4, bankName: s.bankName ?? acct.bankName ?? null };
}

/* ---- A check's life ------------------------------------------------------ */

async function liveCheck(db: Db, checkId: string): Promise<PayCheck & { payrollItem: { id: string; payrollRunId: string; payrollRun: { clientId: string | null } } }> {
  const c = await db.payCheck.findFirst({ where: { id: checkId, tenantId: tenantIdForWrite() }, include: { payrollItem: { select: { id: true, payrollRunId: true, payrollRun: { select: { clientId: true } } } } } });
  if (!c) throw new HttpError(404, 'check_not_found', 'Check not found.');
  return c;
}

export async function voidCheck(db: Db, input: { checkId: string; reason: string; actorUserId: string }): Promise<PayCheck> {
  const reason = input.reason.trim();
  if (reason.length < 3) throw new HttpError(400, 'reason_required', 'Say why the check is void.');
  const c = await liveCheck(db, input.checkId);
  if (c.voidedAt) throw new HttpError(409, 'already_void', `Check #${c.checkNumber} is already void.`);
  const row = await db.payCheck.update({ where: { id: c.id }, data: { voidedAt: new Date(), voidReason: reason.slice(0, 500), voidedById: input.actorUserId } });
  enqueueAudit({ actorUserId: input.actorUserId, clientId: c.payrollItem.payrollRun.clientId, action: 'payroll.check_voided', entityType: 'PayCheck', entityId: c.id, metadata: { checkNumber: c.checkNumber, amount: Number(c.amount), reason } }, 'paperChecks.void');
  return row;
}

/** Void (if still live) and issue a new check for the same paycheck, with a new number. */
export async function reissueCheck(db: PrismaClient, input: { checkId: string; reason: string; actorUserId: string }): Promise<PayCheck> {
  const c = await liveCheck(db, input.checkId);
  if (c.stopPaymentAt === null && !c.voidedAt) await voidCheck(db, { checkId: c.id, reason: input.reason, actorUserId: input.actorUserId });
  const live = await db.payCheck.findFirst({ where: { payrollItemId: c.payrollItemId, voidedAt: null } });
  if (live) throw new HttpError(409, 'live_check_exists', `Check #${live.checkNumber} is already live for this paycheck.`);
  const fresh = await db.payCheck.create({
    data: { tenantId: c.tenantId, payrollItemId: c.payrollItemId, payeeName: c.payeeName, amount: c.amount, memo: c.memo, payeeAddress: c.payeeAddress ?? undefined, reissuedFromId: c.id },
  });
  await db.payrollItem.update({ where: { id: c.payrollItemId }, data: { disbursementRef: `CHECK-${fresh.checkNumber}` } });
  enqueueAudit({ actorUserId: input.actorUserId, clientId: c.payrollItem.payrollRun.clientId, action: 'payroll.check_reissued', entityType: 'PayCheck', entityId: fresh.id, metadata: { checkNumber: fresh.checkNumber, replaces: c.checkNumber, reason: input.reason } }, 'paperChecks.reissue');
  return fresh;
}

/** The bank was told not to honour this check. It is void too; reissue separately. */
export async function stopPayment(db: Db, input: { checkId: string; reason: string; bankRef?: string | null; actorUserId: string }): Promise<PayCheck> {
  const reason = input.reason.trim();
  if (reason.length < 3) throw new HttpError(400, 'reason_required', 'Say why payment is stopped.');
  const c = await liveCheck(db, input.checkId);
  if (c.stopPaymentAt) throw new HttpError(409, 'already_stopped', `Payment on check #${c.checkNumber} is already stopped.`);
  const now = new Date();
  const row = await db.payCheck.update({
    where: { id: c.id },
    data: { stopPaymentAt: now, stopPaymentById: input.actorUserId, stopPaymentReason: reason.slice(0, 500), stopPaymentRef: input.bankRef?.trim().slice(0, 80) || null, voidedAt: c.voidedAt ?? now, voidReason: c.voidReason ?? `Stop payment: ${reason}`.slice(0, 500), voidedById: c.voidedById ?? input.actorUserId },
  });
  enqueueAudit({ actorUserId: input.actorUserId, clientId: c.payrollItem.payrollRun.clientId, action: 'payroll.check_stop_payment', entityType: 'PayCheck', entityId: c.id, metadata: { checkNumber: c.checkNumber, reason, bankRef: input.bankRef ?? null } }, 'paperChecks.stop');
  return row;
}

export async function markPrinted(db: Db, checkIds: string[], actorUserId: string): Promise<void> {
  if (checkIds.length === 0) return;
  await db.payCheck.updateMany({ where: { id: { in: checkIds }, tenantId: tenantIdForWrite() }, data: { printedAt: new Date(), printedById: actorUserId, printCount: { increment: 1 } } });
  enqueueAudit({ actorUserId, clientId: null, action: 'payroll.checks_printed', entityType: 'PayCheck', entityId: checkIds[0]!, metadata: { count: checkIds.length, checkIds: checkIds.slice(0, 200) } }, 'paperChecks.print');
}

/* ---- Positive pay -------------------------------------------------------- */

const csvCell = (v: string | number) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const mmddyyyy = (d: Date) => `${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}${d.getUTCFullYear()}`;

/**
 * The positive-pay file: every check issued (and every void) the bank
 * hasn't been told about yet, or a run's checks. The column set is the
 * common one most banks accept; CONFIRM with the bank's positive-pay spec
 * (some want fixed-width, an issue/void code instead of a flag, or a
 * header/trailer record).
 */
export async function positivePayFile(db: Db, input: { runId?: string | null; onlyNew?: boolean; actorUserId: string }): Promise<{ csv: string; issued: number; voids: number; accountLast4: string | null }> {
  const acct = await drawerAccount(db);
  if (!acct) throw new HttpError(409, 'check_bank_missing', 'Choose the bank account checks are drawn on first.');
  const where: Prisma.PayCheckWhereInput = {
    tenantId: tenantIdForWrite(),
    ...(input.runId ? { payrollItem: { payrollRunId: input.runId } } : {}),
    ...(input.onlyNew ? { OR: [{ positivePayAt: null }, { voidedAt: { not: null }, positivePayVoidAt: null }] } : {}),
  };
  const checks = await db.payCheck.findMany({ where, orderBy: { checkNumber: 'asc' } });
  const lines = ['Account Number,Check Number,Issue Date,Amount,Payee Name,Void'];
  let issued = 0;
  let voids = 0;
  const now = new Date();
  for (const c of checks) {
    const isVoid = !!c.voidedAt;
    lines.push([acct.account, c.checkNumber, mmddyyyy(c.issuedAt), Number(c.amount).toFixed(2), c.payeeName, isVoid ? 'V' : ''].map(csvCell).join(','));
    if (isVoid) voids += 1;
    else issued += 1;
  }
  if (checks.length) {
    await db.payCheck.updateMany({ where: { id: { in: checks.filter((c) => !c.positivePayAt).map((c) => c.id) } }, data: { positivePayAt: now } });
    await db.payCheck.updateMany({ where: { id: { in: checks.filter((c) => c.voidedAt && !c.positivePayVoidAt).map((c) => c.id) } }, data: { positivePayVoidAt: now } });
  }
  enqueueAudit({ actorUserId: input.actorUserId, clientId: null, action: 'payroll.positive_pay_exported', entityType: 'PayCheck', entityId: checks[0]?.id ?? tenantIdForWrite(), metadata: { runId: input.runId ?? null, issued, voids } }, 'paperChecks.positivePay');
  return { csv: `${lines.join('\r\n')}\r\n`, issued, voids, accountLast4: acct.last4 };
}
