import { Router, type Request } from 'express';
import multer from 'multer';
import { z } from 'zod';
import {
  BooksBillInputSchema,
  BooksBillPaymentInputSchema,
  BooksBillsApproveInputSchema,
  type BooksBillsApproveResult,
  BooksRecurringBillInputSchema,
  BooksVendorInputSchema,
  BooksVendorUpdateSchema,
  csvCell,
} from '@alto-people/shared';
import type { Prisma as P } from '@prisma/client';
import { prisma } from '../../db.js';
import { HttpError } from '../../middleware/error.js';
import { requireCapability } from '../../middleware/auth.js';
import { decideApprovalRequest, pendingResponse } from '../../lib/approvalRequests.js';
import { bankingProfile, usesOurAch } from '../../lib/banking/ach.js';
import { getBlobStore } from '../../lib/blobStore.js';
import { safeContentDisposition, sanitizeUploadFilename, verifyFileMagic } from '../../lib/uploads.js';
import { tenantIdForWrite } from '../../lib/tenant.js';
import { enqueueAudit } from '../../lib/audit.js';
import { createVendor, shapeVendors, updateVendor, vendorInReach } from '../../lib/books/payables/vendors.js';
import { billInReach, billTabWhere, createBill, reopenBill, shapeBills, submitBill, updateBill, voidBill, withdrawBill } from '../../lib/books/payables/bills.js';
import { payBills, payFromAccounts, paymentInReach, shapePayments, voidPayment } from '../../lib/books/payables/payments.js';
import { createRecurring, shapeRecurring, updateRecurring } from '../../lib/books/payables/recurring.js';
import { apAging, vendor1099 } from '../../lib/books/payables/reports.js';
import { deciderFrom } from '../approvalRequests.js';

/**
 * Payables — vendors, bills, payments, recurring bills, AP aging and the
 * vendor 1099 list. Mounted at /books (routes/books/index.ts, which already
 * required view:books); writes need manage:books. The contract is
 * packages/shared/src/books/payables.ts.
 */

export const booksPayablesRouter = Router();
const MANAGE = requireCapability('manage:books');

const ReasonSchema = z.object({ reason: z.string().trim().min(3).max(300) });
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const UPLOAD_MIMES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (_req, file, cb) => {
    if (!UPLOAD_MIMES.has(file.mimetype)) {
      cb(new HttpError(400, 'invalid_mime', 'Attach the invoice as a PDF or a photo (JPEG, PNG or WebP).'));
      return;
    }
    cb(null, true);
  },
});

const viewer = (req: Request) => deciderFrom(req.user!);

/* ---- Vendors -------------------------------------------------------------- */

booksPayablesRouter.get('/vendors', async (req, res) => {
  const q = z.object({ q: z.string().trim().max(100).optional(), active: z.enum(['true', 'false', 'all']).default('true') }).parse(req.query);
  const where: P.VendorWhereInput = {
    tenantId: tenantIdForWrite(),
    deletedAt: null,
    ...(q.active === 'all' ? {} : { isActive: q.active === 'true' }),
    ...(q.q ? { name: { contains: q.q, mode: 'insensitive' } } : {}),
  };
  const rows = await prisma.vendor.findMany({ where, orderBy: { name: 'asc' }, take: 1000 });
  res.json({ vendors: await shapeVendors(prisma, rows) });
});

booksPayablesRouter.post('/vendors', MANAGE, async (req, res) => {
  const input = BooksVendorInputSchema.parse(req.body);
  const v = await createVendor(prisma, input, req.user!.id);
  res.status(201).json({ vendor: (await shapeVendors(prisma, [v]))[0] });
});

booksPayablesRouter.get('/vendors/:id', async (req, res) => {
  const v = await vendorInReach(prisma, String(req.params.id));
  const [bills, payments] = await Promise.all([
    prisma.bill.findMany({ where: { tenantId: tenantIdForWrite(), vendorId: v.id }, include: { lines: { orderBy: { lineNo: 'asc' } } }, orderBy: { billDate: 'desc' }, take: 200 }),
    prisma.billPayment.findMany({ where: { tenantId: tenantIdForWrite(), vendorId: v.id }, include: { applications: true }, orderBy: { paidOn: 'desc' }, take: 200 }),
  ]);
  res.json({ vendor: (await shapeVendors(prisma, [v]))[0], bills: await shapeBills(prisma, bills, viewer(req)), payments: await shapePayments(prisma, payments) });
});

booksPayablesRouter.patch('/vendors/:id', MANAGE, async (req, res) => {
  const input = BooksVendorUpdateSchema.parse(req.body);
  const v = await vendorInReach(prisma, String(req.params.id));
  const { vendor, pendingApprovalId } = await updateVendor(prisma, v, input, req.user!.id);
  if (pendingApprovalId) {
    const row = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: pendingApprovalId } });
    res.status(202).json({ ...pendingResponse(row), vendor: (await shapeVendors(prisma, [vendor]))[0] });
    return;
  }
  res.json({ vendor: (await shapeVendors(prisma, [vendor]))[0] });
});

/* ---- Bills ---------------------------------------------------------------- */

booksPayablesRouter.get('/bills', async (req, res) => {
  const q = z
    .object({
      tab: z.enum(['approve', 'unpaid', 'due', 'paid', 'draft', 'all']).optional(),
      status: z.enum(['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PARTIALLY_PAID', 'PAID', 'VOID']).optional(),
      vendorId: z.string().uuid().optional(),
    })
    .parse(req.query);
  const rows = await prisma.bill.findMany({
    where: { tenantId: tenantIdForWrite(), ...billTabWhere(q.tab), ...(q.status ? { status: q.status } : {}), ...(q.vendorId ? { vendorId: q.vendorId } : {}) },
    include: { lines: { orderBy: { lineNo: 'asc' } } },
    orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }],
    take: 1000,
  });
  res.json({ bills: await shapeBills(prisma, rows, viewer(req)) });
});

booksPayablesRouter.post('/bills', MANAGE, async (req, res) => {
  const input = BooksBillInputSchema.parse(req.body);
  const bill = await createBill(prisma, input, req.user!.id);
  res.status(201).json({ bill: (await shapeBills(prisma, [bill], viewer(req)))[0] });
});

booksPayablesRouter.get('/bills/:id', async (req, res) => {
  const bill = await billInReach(prisma, String(req.params.id));
  res.json({ bill: (await shapeBills(prisma, [bill], viewer(req)))[0] });
});

booksPayablesRouter.patch('/bills/:id', MANAGE, async (req, res) => {
  const input = BooksBillInputSchema.parse(req.body);
  const bill = await billInReach(prisma, String(req.params.id));
  const updated = await updateBill(prisma, bill, input, req.user!.id);
  res.json({ bill: (await shapeBills(prisma, [updated], viewer(req)))[0] });
});

booksPayablesRouter.post('/bills/:id/submit', MANAGE, async (req, res) => {
  const bill = await billInReach(prisma, String(req.params.id));
  const approval = await submitBill(prisma, bill, req.user!.id);
  res.status(202).json(pendingResponse(approval));
});

/** Approve several at once — each its own decision, the second-person rule intact. */
booksPayablesRouter.post('/bills/approve', MANAGE, async (req, res) => {
  const { ids } = BooksBillsApproveInputSchema.parse(req.body ?? {});
  const me = viewer(req);
  const bills = await prisma.bill.findMany({ where: { tenantId: tenantIdForWrite(), id: { in: [...new Set(ids)] } }, include: { vendor: { select: { name: true } } } });
  const byId = new Map(bills.map((b) => [b.id, b]));
  const out: BooksBillsApproveResult = { approved: [], skipped: [] };
  for (const id of ids) {
    const b = byId.get(id);
    if (!b) {
      out.skipped.push({ id, reason: 'Not found.' });
      continue;
    }
    if (b.status !== 'PENDING_APPROVAL' || !b.approvalRequestId) {
      out.skipped.push({ id, reason: b.status === 'DRAFT' ? 'It’s a draft — not sent for approval.' : 'Already decided.' });
      continue;
    }
    try {
      const d = await decideApprovalRequest(prisma, b.approvalRequestId, me, { decision: 'APPROVE' });
      if (d.applyError) out.skipped.push({ id, reason: `Approved, but it didn’t post: ${d.applyError}` });
      else out.approved.push({ id, total: Number(b.total), vendorName: b.vendor.name });
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      out.skipped.push({ id, reason: err.code === 'maker_checker' ? 'You entered it — a second person approves it.' : err.message });
    }
  }
  res.json(out);
});

booksPayablesRouter.post('/bills/:id/withdraw', MANAGE, async (req, res) => {
  const bill = await billInReach(prisma, String(req.params.id));
  await withdrawBill(prisma, bill, req.user!.id);
  res.json({ bill: (await shapeBills(prisma, [await billInReach(prisma, bill.id)], viewer(req)))[0] });
});

booksPayablesRouter.post('/bills/:id/reopen', MANAGE, async (req, res) => {
  const { reason } = ReasonSchema.parse(req.body ?? {});
  const bill = await billInReach(prisma, String(req.params.id));
  await reopenBill(prisma, bill, reason, req.user!.id);
  res.json({ bill: (await shapeBills(prisma, [await billInReach(prisma, bill.id)], viewer(req)))[0] });
});

booksPayablesRouter.post('/bills/:id/void', MANAGE, async (req, res) => {
  const { reason } = ReasonSchema.parse(req.body ?? {});
  const bill = await billInReach(prisma, String(req.params.id));
  await voidBill(prisma, bill, reason, req.user!.id);
  res.json({ bill: (await shapeBills(prisma, [await billInReach(prisma, bill.id)], viewer(req)))[0] });
});

booksPayablesRouter.post('/bills/:id/attachment', MANAGE, upload.single('file'), async (req, res) => {
  const bill = await billInReach(prisma, String(req.params.id));
  const file = req.file;
  if (!file) throw new HttpError(400, 'no_file', 'Attach the invoice.');
  const magic = verifyFileMagic(file.buffer, file.mimetype);
  if (magic) throw new HttpError(400, 'invalid_file', magic);
  const name = sanitizeUploadFilename(file.originalname);
  const key = `books/bills/${tenantIdForWrite()}/${bill.id}-${Date.now()}-${name}`;
  await getBlobStore().put(key, file.buffer, file.mimetype);
  await prisma.bill.update({ where: { id: bill.id }, data: { attachmentKey: key, attachmentName: name } });
  enqueueAudit({ actorUserId: req.user!.id, clientId: null, action: 'books.bill_attachment', entityType: 'Bill', entityId: bill.id, metadata: { name, bytes: file.size } }, 'books.payables');
  res.json({ bill: (await shapeBills(prisma, [await billInReach(prisma, bill.id)], viewer(req)))[0] });
});

booksPayablesRouter.get('/bills/:id/attachment', async (req, res) => {
  const bill = await billInReach(prisma, String(req.params.id));
  if (!bill.attachmentKey) throw new HttpError(404, 'no_attachment', 'No invoice is attached to this bill.');
  const buf = await getBlobStore().get(bill.attachmentKey);
  if (!buf) throw new HttpError(404, 'no_attachment', 'The attached invoice could not be found.');
  const name = bill.attachmentName ?? 'invoice';
  const type = name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : /\.png$/i.test(name) ? 'image/png' : /\.webp$/i.test(name) ? 'image/webp' : 'image/jpeg';
  res.setHeader('Content-Type', type);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', safeContentDisposition(name, req.query.download !== '1'));
  res.send(buf);
});

/* ---- Payments --------------------------------------------------------------- */

booksPayablesRouter.get('/bank-sources', async (_req, res) => {
  const profile = await bankingProfile(prisma);
  res.json({ accounts: await payFromAccounts(prisma), ownAch: usesOurAch(profile) });
});

/** Everything the bill and payment forms pick from, in one call. */
booksPayablesRouter.get('/payables/options', async (_req, res) => {
  const tenantId = tenantIdForWrite();
  const [accounts, payFrom, clients, sites, profile] = await Promise.all([
    prisma.ledgerAccount.findMany({
      where: { tenantId, isActive: true, subtype: { notIn: ['AP', 'BANK', 'CREDIT_CARD', 'AR', 'RETAINED_EARNINGS'] } },
      orderBy: { code: 'asc' },
      select: { id: true, code: true, name: true, type: true, subtype: true },
    }),
    payFromAccounts(prisma),
    prisma.client.findMany({ where: { tenantId, deletedAt: null }, orderBy: { name: 'asc' }, select: { id: true, name: true }, take: 2000 }),
    prisma.site.findMany({ where: { tenantId, deletedAt: null }, orderBy: { name: 'asc' }, select: { id: true, name: true, clientId: true }, take: 5000 }),
    bankingProfile(prisma),
  ]);
  res.json({ accounts, payFrom, clients, sites, ownAch: usesOurAch(profile) });
});

booksPayablesRouter.get('/bill-payments', async (req, res) => {
  const q = z.object({ vendorId: z.string().uuid().optional() }).parse(req.query);
  const rows = await prisma.billPayment.findMany({
    where: { tenantId: tenantIdForWrite(), ...(q.vendorId ? { vendorId: q.vendorId } : {}) },
    include: { applications: true },
    orderBy: [{ paidOn: 'desc' }, { createdAt: 'desc' }],
    take: 1000,
  });
  res.json({ payments: await shapePayments(prisma, rows) });
});

booksPayablesRouter.post('/bill-payments', MANAGE, async (req, res) => {
  const input = BooksBillPaymentInputSchema.parse(req.body);
  const payment = await payBills(prisma, input, req.user!.id);
  res.status(201).json({ payment: (await shapePayments(prisma, [payment]))[0] });
});

booksPayablesRouter.post('/bill-payments/:id/void', MANAGE, async (req, res) => {
  const { reason } = ReasonSchema.parse(req.body ?? {});
  const p = await paymentInReach(prisma, String(req.params.id));
  const updated = await voidPayment(prisma, p, reason, req.user!.id);
  res.json({ payment: (await shapePayments(prisma, [updated]))[0] });
});

/* ---- Recurring bills ------------------------------------------------------ */

booksPayablesRouter.get('/recurring-bills', async (_req, res) => {
  const rows = await prisma.recurringBill.findMany({ where: { tenantId: tenantIdForWrite() }, orderBy: [{ isActive: 'desc' }, { nextDate: 'asc' }] });
  res.json({ recurring: await shapeRecurring(prisma, rows) });
});

booksPayablesRouter.post('/recurring-bills', MANAGE, async (req, res) => {
  const input = BooksRecurringBillInputSchema.parse(req.body);
  const row = await createRecurring(prisma, input, req.user!.id);
  res.status(201).json({ recurring: (await shapeRecurring(prisma, [row]))[0] });
});

booksPayablesRouter.patch('/recurring-bills/:id', MANAGE, async (req, res) => {
  const input = BooksRecurringBillInputSchema.partial().extend({ isActive: z.boolean().optional() }).parse(req.body);
  const id = String(req.params.id);
  const row = /^[0-9a-f-]{36}$/i.test(id) ? await prisma.recurringBill.findFirst({ where: { id, tenantId: tenantIdForWrite() } }) : null;
  if (!row) throw new HttpError(404, 'recurring_not_found', 'Recurring bill not found.');
  const updated = await updateRecurring(prisma, row, input, req.user!.id);
  res.json({ recurring: (await shapeRecurring(prisma, [updated]))[0] });
});

/* ---- Reports -------------------------------------------------------------- */

booksPayablesRouter.get('/payables/aging', async (req, res) => {
  const q = z.object({ asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(req.query);
  res.json(await apAging(prisma, q.asOf));
});

booksPayablesRouter.get('/payables/1099', async (req, res) => {
  const q = z.object({ year: z.coerce.number().int().min(2000).max(2100).default(new Date().getUTCFullYear() - 1), format: z.enum(['json', 'csv']).default('json') }).parse(req.query);
  const report = await vendor1099(prisma, q.year);
  if (q.format === 'csv') {
    const lines = [
      ['Vendor', 'Tax ID (last 4)', 'Address', 'Paid (cash, check, ACH)', 'Paid by card (1099-K)', 'Payments', `Needs 1099-NEC (≥ $${report.threshold.toLocaleString('en-US')})`, 'Missing'].map(csvCell).join(','),
      ...report.rows.map((r) => [r.name, r.taxIdLast4 ?? '', r.address ?? '', r.total.toFixed(2), r.cardTotal.toFixed(2), r.payments, r.needs1099 ? 'Yes' : 'No', r.missing.join('; ')].map(csvCell).join(',')),
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="vendor-1099-${q.year}.csv"`);
    res.send(`${lines.join('\r\n')}\r\n`);
    return;
  }
  res.json(report);
});
