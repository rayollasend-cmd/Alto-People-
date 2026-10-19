import { Router, type Request } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireAuth, requireCapability } from '../middleware/auth.js';
import { scopePayrollRuns } from '../lib/scope.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { loadBrand } from '../lib/docKit/index.js';
import { buildPaystubDataById } from '../lib/paystubData.js';
import { micrFontPath, renderAlignmentPdf, renderChecksPdf, type CheckPrintInput, type CheckPrintItem } from '../lib/checkPrintPdf.js';
import {
  checkSettingsRow,
  checkSettingsView,
  clearPayByCheck,
  drawerAccount,
  markPrinted,
  myPayByCheck,
  overridesForRun,
  positivePayFile,
  reissueCheck,
  requestPayByCheck,
  setCheckSignature,
  setPayByCheck,
  stopPayment,
  updateCheckSettings,
  voidCheck,
} from '../lib/paperChecks.js';

/**
 * Paper checks: "pay by check this time" on a paycheck, the associate's
 * own request, printing (the run's checks, one reprint, the alignment
 * test), a check's life (void, reissue, stop payment), the tenant's check
 * settings and the bank's positive-pay file. Payroll routes self-gate on
 * process:payroll and the caller's reach over runs; /me routes are the
 * associate's own.
 */

export const paperChecksRouter = Router();
const PROCESS = requireCapability('process:payroll');
const ymd = (d: Date) => d.toISOString().slice(0, 10);

async function scopedItem(req: Request) {
  const id = z.string().uuid().parse(req.params.id);
  const item = await prisma.payrollItem.findFirst({ where: { id, payrollRun: scopePayrollRuns(req.user!) }, select: { id: true } });
  if (!item) throw new HttpError(404, 'item_not_found', 'Paycheck not found.');
  return item;
}

async function scopedRun(req: Request) {
  const id = z.string().uuid().parse(req.params.id);
  const run = await prisma.payrollRun.findFirst({ where: { id, ...scopePayrollRuns(req.user!) } });
  if (!run) throw new HttpError(404, 'run_not_found', 'Payroll run not found.');
  return run;
}

async function scopedCheck(req: Request) {
  const id = z.string().uuid().parse(req.params.checkId);
  const c = await prisma.payCheck.findFirst({ where: { id, tenantId: tenantIdForWrite(), payrollItem: { payrollRun: scopePayrollRuns(req.user!) } }, select: { id: true } });
  if (!c) throw new HttpError(404, 'check_not_found', 'Check not found.');
  return c;
}

/* ---- Pay by check this time --------------------------------------------- */

paperChecksRouter.put('/payroll/items/:id/pay-by-check', PROCESS, async (req, res) => {
  const item = await scopedItem(req);
  const body = z.object({ reason: z.string().trim().min(3).max(500) }).parse(req.body ?? {});
  res.json({ override: await setPayByCheck(prisma, { itemId: item.id, reason: body.reason, actorUserId: req.user!.id }) });
});

paperChecksRouter.delete('/payroll/items/:id/pay-by-check', PROCESS, async (req, res) => {
  const item = await scopedItem(req);
  const body = z.object({ reason: z.string().trim().max(500).optional().nullable() }).parse(req.body ?? {});
  await clearPayByCheck(prisma, { itemId: item.id, actorUserId: req.user!.id, reason: body.reason ?? null });
  res.status(204).end();
});

/* ---- The associate's own request ---------------------------------------- */

paperChecksRouter.get('/me/pay-by-check', requireAuth, async (req, res) => {
  const associateId = req.user!.associateId;
  if (!associateId) throw new HttpError(403, 'no_associate_record', 'Only a worker has their own pay.');
  res.json(await myPayByCheck(prisma, associateId));
});

paperChecksRouter.post('/me/pay-by-check', requireAuth, async (req, res) => {
  const associateId = req.user!.associateId;
  if (!associateId) throw new HttpError(403, 'no_associate_record', 'Only a worker has their own pay.');
  const body = z.object({ reason: z.string().trim().min(3).max(500) }).parse(req.body ?? {});
  res.status(201).json(await requestPayByCheck(prisma, { associateId, userId: req.user!.id, reason: body.reason }));
});

/* ---- A run's checks -------------------------------------------------------- */

paperChecksRouter.get('/payroll/runs/:id/checks', PROCESS, async (req, res) => {
  const run = await scopedRun(req);
  const [checks, overrides, requests, settings] = await Promise.all([
    prisma.payCheck.findMany({
      where: { payrollItem: { payrollRunId: run.id } },
      orderBy: { checkNumber: 'asc' },
      include: { payrollItem: { select: { id: true, associateId: true } } },
    }),
    overridesForRun(prisma, run.id),
    prisma.approvalRequest.findMany({
      where: { kind: 'PAY_BY_CHECK', status: 'PENDING', subjectType: 'PayrollItem', subjectId: { in: (await prisma.payrollItem.findMany({ where: { payrollRunId: run.id }, select: { id: true } })).map((i) => i.id) } },
      select: { id: true, title: true, summary: true, subjectId: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    checkSettingsView(prisma, !!micrFontPath()),
  ]);
  const numberById = new Map(checks.map((c) => [c.id, c.checkNumber]));
  res.json({
    run: { id: run.id, status: run.status, kind: run.kind, periodStart: ymd(run.periodStart), periodEnd: ymd(run.periodEnd) },
    checks: checks.map((c) => ({
      id: c.id,
      checkNumber: c.checkNumber,
      itemId: c.payrollItemId,
      associateId: c.payrollItem.associateId,
      payeeName: c.payeeName,
      amount: Number(c.amount),
      issuedAt: c.issuedAt.toISOString(),
      status: c.stopPaymentAt ? 'STOPPED' : c.voidedAt ? 'VOID' : c.printedAt ? 'PRINTED' : 'ISSUED',
      printedAt: c.printedAt?.toISOString() ?? null,
      printCount: c.printCount,
      voidedAt: c.voidedAt?.toISOString() ?? null,
      voidReason: c.voidReason,
      stopPaymentAt: c.stopPaymentAt?.toISOString() ?? null,
      stopPaymentRef: c.stopPaymentRef,
      replacesCheckNumber: c.reissuedFromId ? numberById.get(c.reissuedFromId) ?? null : null,
      positivePayAt: c.positivePayAt?.toISOString() ?? null,
    })),
    overrides,
    requests: requests.map((r) => ({ id: r.id, title: r.title, reason: r.summary, itemId: r.subjectId, createdAt: r.createdAt.toISOString() })),
    settings,
  });
});

async function printInput(checkIds: string[] | null, runId: string | null): Promise<CheckPrintInput & { ids: string[] }> {
  const settings = await checkSettingsRow(prisma);
  const acct = await drawerAccount(prisma);
  if (!acct) throw new HttpError(409, 'check_bank_missing', 'Choose the bank account checks are drawn on in Check settings first.');
  const checks = await prisma.payCheck.findMany({
    where: { tenantId: tenantIdForWrite(), voidedAt: null, ...(checkIds ? { id: { in: checkIds } } : {}), ...(runId ? { payrollItem: { payrollRunId: runId } } : {}) },
    orderBy: { checkNumber: 'asc' },
    include: { payrollItem: { select: { id: true, associate: { select: { addressLine1: true, city: true, state: true, zip: true } }, payrollRun: { select: { periodStart: true, periodEnd: true } } } } },
  });
  if (checks.length === 0) throw new HttpError(404, 'no_checks', 'No live checks to print.');
  const replaced = await prisma.payCheck.findMany({ where: { id: { in: checks.map((c) => c.reissuedFromId).filter((x): x is string => !!x) } }, select: { id: true, checkNumber: true } });
  const replacedNo = new Map(replaced.map((r) => [r.id, r.checkNumber]));
  const items: CheckPrintItem[] = [];
  let company: CheckPrintInput['company'] | null = null;
  for (const c of checks) {
    const built = await buildPaystubDataById(prisma, c.payrollItemId, c.issuedAt);
    if (!built) continue;
    const addr = (c.payeeAddress ?? null) as { line1: string | null; city: string | null; state: string | null; zip: string | null } | null;
    const a = c.payrollItem.associate;
    const run = c.payrollItem.payrollRun;
    items.push({
      checkNumber: c.checkNumber,
      issuedAt: c.issuedAt.toISOString(),
      amount: Number(c.amount),
      payee: { name: c.payeeName, line1: addr?.line1 ?? a.addressLine1, city: addr?.city ?? a.city, state: addr?.state ?? a.state, zip: addr?.zip ?? a.zip },
      memo: `Payroll ${run.periodStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} – ${run.periodEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`,
      stub: built.data,
      replacesCheckNumber: c.reissuedFromId ? replacedNo.get(c.reissuedFromId) ?? null : null,
    });
    if (!company) {
      const co = built.data.company;
      const cityLine = [co.city, [co.state, co.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
      company = { name: co.name, lines: [co.addressLine1, cityLine].filter((x): x is string => !!x), logo: (await loadBrand(prisma as never, tenantIdForWrite())).logo ?? null };
    }
  }
  return {
    ids: checks.map((c) => c.id),
    company: company ?? { name: (await loadBrand(prisma as never, tenantIdForWrite())).name, lines: [] },
    bank: { name: acct.bankName, address: settings?.bankAddress ?? null, fractional: settings?.fractionalRouting ?? null, routing: acct.routing, account: acct.account },
    signature: settings?.signatureImage ? { image: Buffer.from(settings.signatureImage), signerName: settings.signatureSignerName } : settings?.signatureSignerName ? { image: null, signerName: settings.signatureSignerName } : null,
    twoSignatureOver: settings?.twoSignatureOverCents != null ? Number(settings.twoSignatureOverCents) / 100 : null,
    voidAfterDays: settings?.voidAfterDays ?? 90,
    offset: { x: settings?.offsetXPt ?? 0, y: settings?.offsetYPt ?? 0 },
    checks: items,
  };
}

function sendPdf(res: import('express').Response, pdf: Buffer, name: string) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send(pdf);
}

/** GET /payroll/runs/:id/checks.pdf — every live check in the run, one page each, in number order. */
paperChecksRouter.get('/payroll/runs/:id/checks.pdf', PROCESS, async (req, res) => {
  const run = await scopedRun(req);
  const input = await printInput(null, run.id);
  const pdf = await renderChecksPdf(input);
  await markPrinted(prisma, input.ids, req.user!.id);
  sendPdf(res, pdf, `checks-${ymd(run.periodStart)}-to-${ymd(run.periodEnd)}.pdf`);
});

/** GET /payroll/checks/:checkId/print.pdf — reprint one check (live only). */
paperChecksRouter.get('/payroll/checks/:checkId/print.pdf', PROCESS, async (req, res) => {
  const c = await scopedCheck(req);
  const input = await printInput([c.id], null);
  const pdf = await renderChecksPdf(input);
  await markPrinted(prisma, input.ids, req.user!.id);
  sendPdf(res, pdf, `check-${input.checks[0]!.checkNumber}.pdf`);
});

paperChecksRouter.get('/payroll/checks/alignment.pdf', PROCESS, async (_req, res) => {
  const s = await checkSettingsRow(prisma);
  const brand = await loadBrand(prisma as never, tenantIdForWrite());
  sendPdf(res, await renderAlignmentPdf({ company: { name: brand.name, lines: [] }, offset: { x: s?.offsetXPt ?? 0, y: s?.offsetYPt ?? 0 }, micrFontInstalled: !!micrFontPath() }), 'check-alignment-test.pdf');
});

const Reason = z.object({ reason: z.string().trim().min(3).max(500) });

paperChecksRouter.post('/payroll/checks/:checkId/void', PROCESS, async (req, res) => {
  const c = await scopedCheck(req);
  const body = Reason.parse(req.body ?? {});
  const row = await voidCheck(prisma, { checkId: c.id, reason: body.reason, actorUserId: req.user!.id });
  res.json({ id: row.id, checkNumber: row.checkNumber, voidedAt: row.voidedAt });
});

paperChecksRouter.post('/payroll/checks/:checkId/reissue', PROCESS, async (req, res) => {
  const c = await scopedCheck(req);
  const body = Reason.parse(req.body ?? {});
  const row = await reissueCheck(prisma, { checkId: c.id, reason: body.reason, actorUserId: req.user!.id });
  res.status(201).json({ id: row.id, checkNumber: row.checkNumber });
});

paperChecksRouter.post('/payroll/checks/:checkId/stop-payment', PROCESS, async (req, res) => {
  const c = await scopedCheck(req);
  const body = Reason.extend({ bankRef: z.string().trim().max(80).optional().nullable() }).parse(req.body ?? {});
  const row = await stopPayment(prisma, { checkId: c.id, reason: body.reason, bankRef: body.bankRef ?? null, actorUserId: req.user!.id });
  res.json({ id: row.id, checkNumber: row.checkNumber, stopPaymentAt: row.stopPaymentAt });
});

/** GET /payroll/positive-pay.csv?runId=&onlyNew=1 — the bank's positive-pay file. */
paperChecksRouter.get('/payroll/positive-pay.csv', PROCESS, async (req, res) => {
  const q = z.object({ runId: z.string().uuid().optional(), onlyNew: z.enum(['0', '1']).optional() }).parse(req.query);
  if (q.runId) {
    const run = await prisma.payrollRun.findFirst({ where: { id: q.runId, ...scopePayrollRuns(req.user!) }, select: { id: true } });
    if (!run) throw new HttpError(404, 'run_not_found', 'Payroll run not found.');
  }
  const out = await positivePayFile(prisma, { runId: q.runId ?? null, onlyNew: q.onlyNew === '1', actorUserId: req.user!.id });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="positive-pay-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.setHeader('X-Checks-Issued', String(out.issued));
  res.setHeader('X-Checks-Voided', String(out.voids));
  res.send(out.csv);
});

/* ---- Settings ---------------------------------------------------------------- */

paperChecksRouter.get('/payroll/check-settings', PROCESS, async (_req, res) => {
  const accounts = await prisma.employerBankAccount.findMany({ where: { tenantId: tenantIdForWrite(), status: { not: 'DISABLED' } }, select: { id: true, label: true, bankName: true, accountLast4: true, status: true }, orderBy: { createdAt: 'asc' } });
  res.json({ settings: await checkSettingsView(prisma, !!micrFontPath()), accounts });
});

paperChecksRouter.put('/payroll/check-settings', PROCESS, async (req, res) => {
  const body = z
    .object({
      bankAccountId: z.string().uuid().nullable().optional(),
      bankName: z.string().trim().max(120).nullable().optional(),
      bankAddress: z.string().trim().max(200).nullable().optional(),
      fractionalRouting: z.string().trim().max(20).regex(/^[0-9/-]*$/, 'Digits, dashes and a slash').nullable().optional(),
      offsetXPt: z.number().min(-36).max(36).optional(),
      offsetYPt: z.number().min(-36).max(36).optional(),
      signatureSignerName: z.string().trim().max(120).nullable().optional(),
      twoSignatureOver: z.number().positive().max(10_000_000).nullable().optional(),
      voidAfterDays: z.number().int().min(30).max(365).optional(),
    })
    .strict()
    .parse(req.body ?? {});
  await updateCheckSettings(prisma, body, req.user!.id);
  res.json({ settings: await checkSettingsView(prisma, !!micrFontPath()) });
});

paperChecksRouter.put('/payroll/check-settings/signature', PROCESS, async (req, res) => {
  const body = z.object({ imageBase64: z.string().max(700_000), contentType: z.enum(['image/png', 'image/jpeg']), signerName: z.string().trim().max(120).nullable().optional() }).parse(req.body ?? {});
  const image = Buffer.from(body.imageBase64, 'base64');
  if (image.length === 0 || image.length > 500_000) throw new HttpError(400, 'bad_image', 'Upload a signature image under 500 KB.');
  await setCheckSignature(prisma, { image, contentType: body.contentType, signerName: body.signerName, actorUserId: req.user!.id });
  res.json({ settings: await checkSettingsView(prisma, !!micrFontPath()) });
});

paperChecksRouter.delete('/payroll/check-settings/signature', PROCESS, async (req, res) => {
  await setCheckSignature(prisma, { image: null, contentType: null, actorUserId: req.user!.id });
  res.json({ settings: await checkSettingsView(prisma, !!micrFontPath()) });
});
