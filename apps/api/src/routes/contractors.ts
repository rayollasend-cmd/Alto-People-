import { Router, type Request } from 'express';
import { createHash } from 'node:crypto';
import type { ContractorProfile, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { enqueueAudit, recordCriticalAudit } from '../lib/audit.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { assertAssociateInScope, isInternallyScoped, scopeActiveAssociates, scopeWhere } from '../lib/scope.js';
import { decryptString, encryptString, tryDecryptString } from '../lib/crypto.js';
import { assertBulkPiiExporter } from '../lib/bulkPiiExport.js';
import { dispatchFinancialChange, recordFinancialChange, ssnSummary } from '../lib/financialChanges.js';
import { notifyAssociate } from '../lib/notify.js';
import { renderLetterPdf } from '../lib/letterPdf.js';
import { defaultEmployerOrg } from '../lib/employment.js';
import {
  ALL_STATES,
  CFSF_STATES,
  NO_INCOME_TAX_STATES,
  TIN_MATCH_CODES,
  backupAmount,
  backupRequirement,
  bNoticeDeadlines,
  bNoticeKind,
  buildTinMatchRequestFile,
  defaultStateFiling,
  parseTinMatchResultsFile,
  tinMatchProvider,
  tinTypeCode,
  type StateFilingRow,
} from '../lib/contractors.js';
import { aggregateF1099NecPayments, f1099NecThreshold, listF1099NecEligibleAssociates } from '../lib/f1099NecAggregator.js';
import { aggregateF1099MiscPayments, listF1099MiscEligibleAssociates, meetsF1099MiscThreshold } from '../lib/f1099MiscAggregator.js';
import type { SessionUser } from '../types/express.js';

/**
 * Contractors (1099) desk: W-9s, IRS TIN matching, B-notices and backup
 * withholding, contractor payment runs, how each state gets its 1099s,
 * and the year-end summary. Mounted at /contractors behind process:payroll.
 *
 * The associate's own W-9 lives on `contractorSelfRouter`, mounted at /me/w9.
 *
 * TINs never leave this file in full except in the two bulk files the IRS
 * and a state need (TIN-match request, state export), which are gated to
 * the named bulk-PII exporters like every other SSN file.
 */
export const contractorsRouter = Router();
export const contractorSelfRouter = Router();

const CONTRACTOR_TYPES = ['CONTRACTOR_1099_INDIVIDUAL', 'CONTRACTOR_1099_BUSINESS'] as const;
const round2 = (n: number) => Math.round(n * 100) / 100;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');
const taxYearParam = z.preprocess((v) => Number(v ?? new Date().getUTCFullYear()), z.number().int().min(2000).max(2100));
const EXPORT_PII = requireCapability('export:payroll-pii');
const LIST_LIMIT = 1000;

/** Contractor payment runs and the state/IRS files are company-wide money: a store-bound account doesn't get them. */
function refuseNarrowed(user: SessionUser) {
  if (isInternallyScoped(user)) throw new HttpError(403, 'company_wide', 'Contractor payments and 1099 filing are company-wide. Ask a payroll administrator without a site limit.');
}

function tinDigits(enc: Uint8Array | null): string | null {
  if (!enc) return null;
  const v = tryDecryptString(enc);
  return v ? v.replace(/[^0-9]/g, '') : null;
}

async function ensureProfile(associateId: string): Promise<ContractorProfile> {
  const found = await prisma.contractorProfile.findFirst({ where: { tenantId: tenantIdForWrite(), associateId } });
  if (found) return found;
  return prisma.contractorProfile.create({ data: { tenantId: tenantIdForWrite(), associateId } });
}

async function loadContractor(req: Request, associateId: string) {
  const id = z.string().uuid().safeParse(associateId);
  if (!id.success) throw new HttpError(404, 'not_found', 'Contractor not found.');
  await assertAssociateInScope(prisma, req.user!, id.data);
  const a = await prisma.associate.findFirst({
    where: { id: id.data, tenantId: tenantIdForWrite(), employmentType: { in: [...CONTRACTOR_TYPES] } },
    select: { id: true, firstName: true, lastName: true, email: true, employmentType: true, tinEncrypted: true, addressLine1: true, city: true, state: true, zip: true },
  });
  if (!a) throw new HttpError(404, 'not_found', 'Contractor not found.');
  return a;
}

function profileView(p: ContractorProfile | null, hasTin: boolean) {
  const backup = backupRequirement(p, hasTin);
  return {
    w9Status: p?.w9Status ?? 'NONE',
    w9SignedAt: p?.w9SignedAt ?? null,
    w9RequestedAt: p?.w9RequestedAt ?? null,
    legalName: p?.legalName ?? null,
    businessName: p?.businessName ?? null,
    taxClassification: p?.taxClassification ?? null,
    tinType: p?.tinType ?? null,
    tinLast4: p?.tinLast4 ?? null,
    hasTin,
    tinMatchStatus: p?.tinMatchStatus ?? 'NOT_CHECKED',
    tinMatchCode: p?.tinMatchCode ?? null,
    tinMatchLabel: p?.tinMatchCode != null ? (TIN_MATCH_CODES[p.tinMatchCode]?.label ?? null) : null,
    tinMatchCheckedAt: p?.tinMatchCheckedAt ?? null,
    backupWithholding: backup.required,
    backupReason: backup.reason,
    backupStartedAt: p?.backupStartedAt ?? null,
    backupStoppedAt: p?.backupStoppedAt ?? null,
  };
}

/* ----- Contractors ------------------------------------------------------------- */

contractorsRouter.get('/profiles', async (req, res, next) => {
  try {
    const q = z.string().trim().max(100).optional().parse(req.query.q);
    const where = scopeWhere<Prisma.AssociateWhereInput>(
      scopeActiveAssociates(req.user!),
      { employmentType: { in: [...CONTRACTOR_TYPES] } },
      q ? { OR: [{ firstName: { contains: q, mode: 'insensitive' } }, { lastName: { contains: q, mode: 'insensitive' } }, { email: { contains: q, mode: 'insensitive' } }] } : null,
    );
    const rows = await prisma.associate.findMany({
      where,
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      take: LIST_LIMIT + 1,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        employmentType: true,
        tinEncrypted: true,
        contractorProfile: { include: { bNotices: { where: { resolution: null }, select: { id: true, kind: true, sendBy: true, sentAt: true, backupBy: true } } } },
      },
    });
    const truncated = rows.length > LIST_LIMIT;
    res.json({
      truncated,
      contractors: rows.slice(0, LIST_LIMIT).map((a) => ({
        associateId: a.id,
        name: `${a.firstName} ${a.lastName}`.trim(),
        email: a.email,
        employmentType: a.employmentType,
        ...profileView(a.contractorProfile, !!a.tinEncrypted),
        tinLast4: a.contractorProfile?.tinLast4 ?? (a.tinEncrypted ? (tinDigits(a.tinEncrypted)?.slice(-4) ?? null) : null),
        openBNotices: a.contractorProfile?.bNotices ?? [],
      })),
    });
  } catch (err) {
    next(err);
  }
});

contractorsRouter.get('/profiles/:associateId', async (req, res, next) => {
  try {
    const a = await loadContractor(req, req.params.associateId!);
    const profile = await prisma.contractorProfile.findFirst({
      where: { tenantId: tenantIdForWrite(), associateId: a.id },
      include: {
        bNotices: { orderBy: { irsNoticeReceivedOn: 'desc' } },
        tinResults: { orderBy: { createdAt: 'desc' }, take: 20, include: { batch: { select: { kind: true, createdAt: true } } } },
      },
    });
    const year = new Date().getUTCFullYear();
    const payments = await prisma.contractorPayment.findMany({
      where: { tenantId: tenantIdForWrite(), associateId: a.id, run: { status: { not: 'CANCELLED' }, payDate: { gte: new Date(Date.UTC(year, 0, 1)) } } },
      orderBy: { createdAt: 'desc' },
      include: { run: { select: { id: true, name: true, payDate: true, status: true } } },
    });
    res.json({
      associateId: a.id,
      name: `${a.firstName} ${a.lastName}`.trim(),
      email: a.email,
      employmentType: a.employmentType,
      address: { addressLine1: profile?.addressLine1 ?? a.addressLine1, city: profile?.city ?? a.city, state: profile?.state ?? a.state, zip: profile?.zip ?? a.zip },
      profile: profileView(profile, !!a.tinEncrypted),
      bNotices: (profile?.bNotices ?? []).map((n) => ({ ...n, irsNoticeReceivedOn: ymd(n.irsNoticeReceivedOn), sendBy: ymd(n.sendBy), backupBy: ymd(n.backupBy) })),
      tinChecks: (profile?.tinResults ?? []).map((r) => ({ id: r.id, kind: r.batch.kind, at: r.batch.createdAt, resultCode: r.resultCode, label: r.resultCode != null ? (TIN_MATCH_CODES[r.resultCode]?.label ?? null) : 'Waiting for IRS results' })),
      paymentsThisYear: payments.map((p) => ({ id: p.id, run: { ...p.run, payDate: ymd(p.run.payDate) }, description: p.description, form: p.form, amount: Number(p.amount), backupWithheld: Number(p.backupWithheld), netAmount: Number(p.netAmount) })),
    });
  } catch (err) {
    next(err);
  }
});

contractorsRouter.post('/profiles/:associateId/w9-request', async (req, res, next) => {
  try {
    const a = await loadContractor(req, req.params.associateId!);
    const profile = await ensureProfile(a.id);
    if (profile.w9Status !== 'SIGNED' || req.body?.again === true) {
      await prisma.contractorProfile.update({ where: { id: profile.id }, data: { w9Status: profile.w9Status === 'SIGNED' ? 'SIGNED' : 'REQUESTED', w9RequestedAt: new Date() } });
    }
    void notifyAssociate(a.id, {
      subject: 'Please complete your W-9',
      body: 'We need your W-9 (your taxpayer ID and tax classification) before we can pay you without withholding. It takes about two minutes.',
      category: 'payroll',
      linkUrl: '/me/w9',
      emailFallback: true,
    });
    enqueueAudit({ actorUserId: req.user!.id, action: 'contractor.w9_requested', entityType: 'Associate', entityId: a.id }, 'contractor.w9_requested');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** Start or stop backup withholding by hand (an IRS notice by letter, or a resolved mismatch). */
contractorsRouter.post('/profiles/:associateId/backup', async (req, res, next) => {
  try {
    const input = z.object({ action: z.enum(['start', 'stop']), reason: z.enum(['B_NOTICE', 'IRS_NOTIFIED', 'NOT_CERTIFIED']).optional(), note: z.string().trim().min(3).max(500) }).parse(req.body);
    const a = await loadContractor(req, req.params.associateId!);
    const profile = await ensureProfile(a.id);
    if (input.action === 'stop') {
      if (!a.tinEncrypted) throw new HttpError(409, 'no_tin', "Backup withholding can't stop until the contractor gives a TIN on a signed W-9.");
      if (profile.subjectToBackupCertified) throw new HttpError(409, 'certified_subject', 'Their W-9 says the IRS told them they are subject to backup withholding. Stop only after a new W-9 without that.');
      const open = await prisma.bNotice.count({ where: { profileId: profile.id, resolution: null } });
      if (open > 0) throw new HttpError(409, 'open_b_notice', 'Resolve the open B-notice first. That stops backup withholding too.');
    }
    await prisma.contractorProfile.update({
      where: { id: profile.id },
      data: input.action === 'start'
        ? { backupWithholding: true, backupReason: input.reason ?? 'IRS_NOTIFIED', backupStartedAt: new Date(), backupStoppedAt: null }
        : { backupWithholding: false, backupStoppedAt: new Date() },
    });
    await recordCriticalAudit({ actorUserId: req.user!.id, action: `contractor.backup_${input.action}`, entityType: 'Associate', entityId: a.id, metadata: { reason: input.reason ?? null, note: input.note } }, 'contractor.backup');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ----- TIN matching (IRS Pub 2108A) --------------------------------------------- */

contractorsRouter.get('/tin-match/batches', async (req, res, next) => {
  try {
    refuseNarrowed(req.user!);
    const batches = await prisma.tinMatchBatch.findMany({ where: { tenantId: tenantIdForWrite() }, orderBy: { createdAt: 'desc' }, take: 100 });
    res.json({ batches });
  } catch (err) {
    next(err);
  }
});

/** A bulk request: every contractor with a TIN that isn't matched yet (or the ones named). */
contractorsRouter.post('/tin-match/batches', async (req, res, next) => {
  try {
    refuseNarrowed(req.user!);
    const input = z.object({ associateIds: z.array(z.string().uuid()).max(100_000).optional() }).parse(req.body ?? {});
    const people = await prisma.associate.findMany({
      where: scopeWhere<Prisma.AssociateWhereInput>(
        scopeActiveAssociates(req.user!),
        { employmentType: { in: [...CONTRACTOR_TYPES] }, tinEncrypted: { not: null } },
        input.associateIds ? { id: { in: input.associateIds } } : { OR: [{ contractorProfile: null }, { contractorProfile: { tinMatchStatus: { not: 'MATCHED' } } }] },
      ),
      select: { id: true, employmentType: true },
    });
    if (people.length === 0) throw new HttpError(409, 'nothing_to_match', 'Every contractor with a TIN is already matched.');
    const batch = await prisma.$transaction(async (tx) => {
      const b = await tx.tinMatchBatch.create({ data: { tenantId: tenantIdForWrite(), kind: 'BULK', requestedCount: people.length, createdById: req.user!.id } });
      let n = 0;
      for (const p of people) {
        n += 1;
        const existing = await tx.contractorProfile.findFirst({ where: { associateId: p.id } });
        const profile = existing ?? (await tx.contractorProfile.create({ data: { tenantId: tenantIdForWrite(), associateId: p.id } }));
        await tx.tinMatchResult.create({ data: { tenantId: tenantIdForWrite(), batchId: b.id, profileId: profile.id, accountNumber: `R${String(n).padStart(6, '0')}`, tinType: tinTypeCode(profile.tinType ?? (p.employmentType === 'CONTRACTOR_1099_BUSINESS' ? 'EIN' : 'SSN')) } });
        await tx.contractorProfile.update({ where: { id: profile.id }, data: { tinMatchStatus: 'PENDING' } });
      }
      return b;
    });
    enqueueAudit({ actorUserId: req.user!.id, action: 'contractor.tin_match_batch_created', entityType: 'TinMatchBatch', entityId: batch.id, metadata: { count: people.length } }, 'contractor.tin_match_batch');
    res.status(201).json({ id: batch.id, requestedCount: people.length });
  } catch (err) {
    next(err);
  }
});

/** The request file to upload to IRS e-Services TIN Matching. Full TINs: named bulk-PII exporters only. */
contractorsRouter.get('/tin-match/batches/:id/request.txt', EXPORT_PII, async (req, res, next) => {
  try {
    refuseNarrowed(req.user!);
    assertBulkPiiExporter(req);
    const batch = await prisma.tinMatchBatch.findFirst({
      where: { id: z.string().uuid().parse(req.params.id), tenantId: tenantIdForWrite() },
      include: { results: { orderBy: { accountNumber: 'asc' }, include: { profile: { select: { legalName: true, businessName: true, associate: { select: { firstName: true, lastName: true, tinEncrypted: true } } } } } } },
    });
    if (!batch) throw new HttpError(404, 'not_found', 'Batch not found.');
    const rows = batch.results.flatMap((r) => {
      const tin = tinDigits(r.profile.associate.tinEncrypted);
      if (!tin) return [];
      // The IRS matches the name the payee gave on the W-9 (the business name for an EIN).
      const name = (r.tinType === 1 ? r.profile.businessName || r.profile.legalName : r.profile.legalName) || `${r.profile.associate.firstName} ${r.profile.associate.lastName}`;
      return [{ accountNumber: r.accountNumber, tinType: r.tinType as 1 | 2 | 3, tin, name }];
    });
    await recordCriticalAudit({ actorUserId: req.user!.id, action: 'contractor.tin_match_file_downloaded', entityType: 'TinMatchBatch', entityId: batch.id, metadata: { rows: rows.length } }, 'contractor.tin_match_file');
    res.setHeader('Content-Type', 'text/plain; charset=us-ascii');
    res.setHeader('Content-Disposition', `attachment; filename="tin-match-${ymd(batch.createdAt)}.txt"`);
    res.send(buildTinMatchRequestFile(rows));
  } catch (err) {
    next(err);
  }
});

/** The IRS results file pasted or uploaded back: each line's indicator updates its payee. */
contractorsRouter.post('/tin-match/batches/:id/results', async (req, res, next) => {
  try {
    refuseNarrowed(req.user!);
    const input = z.object({ text: z.string().min(1).max(20_000_000) }).parse(req.body);
    const batch = await prisma.tinMatchBatch.findFirst({ where: { id: z.string().uuid().parse(req.params.id), tenantId: tenantIdForWrite() }, include: { results: true } });
    if (!batch) throw new HttpError(404, 'not_found', 'Batch not found.');
    const codes = parseTinMatchResultsFile(input.text);
    if (codes.size === 0) throw new HttpError(400, 'unreadable_results', "No result lines were found. Upload the IRS results file as it came back (each line ends with ;0 to ;8).");
    const summary: Record<string, number> = { MATCHED: 0, MISMATCH: 0, INVALID: 0, missing: 0 };
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      for (const r of batch.results) {
        const code = codes.get(r.accountNumber);
        if (code === undefined) {
          summary.missing! += 1;
          continue;
        }
        const status = TIN_MATCH_CODES[code]!.status;
        summary[status]! += 1;
        await tx.tinMatchResult.update({ where: { id: r.id }, data: { resultCode: code } });
        await tx.contractorProfile.update({ where: { id: r.profileId }, data: { tinMatchStatus: status, tinMatchCode: code, tinMatchCheckedAt: now } });
      }
      await tx.tinMatchBatch.update({ where: { id: batch.id }, data: { status: 'RESULTS_LOADED', resultsLoadedAt: now, summary } });
    });
    enqueueAudit({ actorUserId: req.user!.id, action: 'contractor.tin_match_results_loaded', entityType: 'TinMatchBatch', entityId: batch.id, metadata: summary }, 'contractor.tin_match_results');
    res.json({ summary });
  } catch (err) {
    next(err);
  }
});

/** One payee checked now through the connected tax-filing provider. */
contractorsRouter.post('/profiles/:associateId/tin-check', async (req, res, next) => {
  try {
    const a = await loadContractor(req, req.params.associateId!);
    const tin = tinDigits(a.tinEncrypted);
    if (!tin) throw new HttpError(409, 'no_tin', 'There is no TIN on file to check. Request a W-9 first.');
    const provider = await tinMatchProvider();
    if (!provider) throw new HttpError(409, 'no_provider', 'Connect a tax-filing provider that offers TIN matching, or use a bulk IRS file.');
    const profile = await ensureProfile(a.id);
    const tinType = tinTypeCode(profile.tinType ?? (a.employmentType === 'CONTRACTOR_1099_BUSINESS' ? 'EIN' : 'SSN'));
    const name = (tinType === 1 ? profile.businessName || profile.legalName : profile.legalName) || `${a.firstName} ${a.lastName}`;
    const code = await provider.check({ tinType, tin, name });
    const status = TIN_MATCH_CODES[code]?.status ?? 'INVALID';
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      const b = await tx.tinMatchBatch.create({ data: { tenantId: tenantIdForWrite(), kind: 'INTERACTIVE', status: 'RESULTS_LOADED', requestedCount: 1, createdById: req.user!.id, resultsLoadedAt: now, summary: { [status]: 1, provider: provider.name } } });
      await tx.tinMatchResult.create({ data: { tenantId: tenantIdForWrite(), batchId: b.id, profileId: profile.id, accountNumber: 'R000001', tinType, resultCode: code } });
      await tx.contractorProfile.update({ where: { id: profile.id }, data: { tinMatchStatus: status, tinMatchCode: code, tinMatchCheckedAt: now } });
    });
    enqueueAudit({ actorUserId: req.user!.id, action: 'contractor.tin_checked', entityType: 'Associate', entityId: a.id, metadata: { code, status, provider: provider.name } }, 'contractor.tin_checked');
    res.json({ status, code, label: TIN_MATCH_CODES[code]?.label ?? null });
  } catch (err) {
    next(err);
  }
});

/* ----- B-notices (IRS Pub 1281) --------------------------------------------------- */

contractorsRouter.get('/b-notices', async (req, res, next) => {
  try {
    const open = z.enum(['open', 'all']).default('open').parse(req.query.status ?? 'open');
    const rows = await prisma.bNotice.findMany({
      where: scopeWhere<Prisma.BNoticeWhereInput>(
        { tenantId: tenantIdForWrite() },
        { profile: { is: { associate: { is: scopeActiveAssociates(req.user!, { former: true }) } } } },
        open === 'open' ? { resolution: null } : null,
      ),
      orderBy: { sendBy: 'asc' },
      take: LIST_LIMIT + 1,
      include: { profile: { select: { associateId: true, associate: { select: { firstName: true, lastName: true } } } } },
    });
    res.json({
      truncated: rows.length > LIST_LIMIT,
      notices: rows.slice(0, LIST_LIMIT).map((n) => ({
        id: n.id,
        associateId: n.profile.associateId,
        name: `${n.profile.associate.firstName} ${n.profile.associate.lastName}`.trim(),
        kind: n.kind,
        irsNoticeKind: n.irsNoticeKind,
        irsNoticeReceivedOn: ymd(n.irsNoticeReceivedOn),
        sendBy: ymd(n.sendBy),
        sentAt: n.sentAt,
        backupBy: ymd(n.backupBy),
        respondedAt: n.respondedAt,
        resolution: n.resolution,
      })),
    });
  } catch (err) {
    next(err);
  }
});

contractorsRouter.post('/profiles/:associateId/b-notices', async (req, res, next) => {
  try {
    const input = z.object({
      irsNoticeKind: z.enum(['CP2100', 'CP2100A', '972CG']).default('CP2100'),
      irsNoticeReceivedOn: dateOnly,
      nameOnNotice: z.string().trim().max(200).nullish(),
      tinLast4OnNotice: z.string().regex(/^\d{4}$/).nullish(),
    }).parse(req.body);
    const a = await loadContractor(req, req.params.associateId!);
    const profile = await ensureProfile(a.id);
    const received = new Date(`${input.irsNoticeReceivedOn}T00:00:00Z`);
    const earlier = await prisma.bNotice.findMany({ where: { profileId: profile.id }, select: { irsNoticeReceivedOn: true } });
    const kind = bNoticeKind(received, earlier);
    const { sendBy, backupBy } = bNoticeDeadlines(received);
    const notice = await prisma.bNotice.create({
      data: { tenantId: tenantIdForWrite(), profileId: profile.id, kind, irsNoticeKind: input.irsNoticeKind, irsNoticeReceivedOn: received, nameOnNotice: input.nameOnNotice ?? null, tinLast4OnNotice: input.tinLast4OnNotice ?? null, sendBy, backupBy, createdById: req.user!.id },
    });
    await prisma.contractorProfile.update({ where: { id: profile.id }, data: { tinMatchStatus: 'MISMATCH' } });
    enqueueAudit({ actorUserId: req.user!.id, action: 'contractor.b_notice_logged', entityType: 'BNotice', entityId: notice.id, metadata: { associateId: a.id, kind, irsNoticeKind: input.irsNoticeKind, sendBy: ymd(sendBy), backupBy: ymd(backupBy) } }, 'contractor.b_notice');
    res.status(201).json({ id: notice.id, kind, sendBy: ymd(sendBy), backupBy: ymd(backupBy) });
  } catch (err) {
    next(err);
  }
});

async function loadNotice(req: Request) {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) throw new HttpError(404, 'not_found', 'Notice not found.');
  const n = await prisma.bNotice.findFirst({
    where: { id: id.data, tenantId: tenantIdForWrite() },
    include: { profile: { include: { associate: { select: { id: true, firstName: true, lastName: true, addressLine1: true, city: true, state: true, zip: true } } } } },
  });
  if (!n) throw new HttpError(404, 'not_found', 'Notice not found.');
  await assertAssociateInScope(prisma, req.user!, n.profile.associateId);
  return n;
}

/**
 * The B-notice letter text. The IRS prescribes the wording in Pub 1281
 * (Exhibits: First and Second B Notice) — this is a plain-language
 * rendering of the same instructions. CONFIRM WITH IRS Pub 1281 (current
 * revision) and attach the IRS text before mailing if counsel prefers it verbatim.
 */
function bNoticeLetter(n: Awaited<ReturnType<typeof loadNotice>>, payer: string): { title: string; body: string } {
  const who = n.nameOnNotice || n.profile.legalName || `${n.profile.associate.firstName} ${n.profile.associate.lastName}`;
  const tail = n.tinLast4OnNotice || n.profile.tinLast4 || '••••';
  const by = ymd(n.backupBy);
  if (n.kind === 'FIRST') {
    return {
      title: 'Important tax notice: backup withholding warning (First B Notice)',
      body: [
        `To: ${who}`,
        `From: ${payer}`,
        '',
        `The IRS told us that the name and taxpayer identification number (TIN) you gave us (ending ${tail}) do not match its records.`,
        '',
        `If you do not give us a correct name and TIN, we must withhold 24% of payments we make to you (backup withholding), starting ${by} at the latest.`,
        '',
        'What to do:',
        '1. Check your name and number against your Social Security card or IRS EIN letter.',
        '2. Sign a new Form W-9 with the correct name and number and return it to us before the date above. You can do this in Alto under Me → W-9.',
        '3. If your name changed, you may also need to update it with the Social Security Administration.',
        '',
        'If the name and number you gave us are correct, sign a new W-9 anyway so we can stop the mismatch.',
      ].join('\n'),
    };
  }
  return {
    title: 'Important tax notice: second backup withholding warning (Second B Notice)',
    body: [
      `To: ${who}`,
      `From: ${payer}`,
      '',
      `This is the second time in three calendar years the IRS has told us that your name and TIN (ending ${tail}) do not match its records.`,
      '',
      `A new W-9 is not enough this time. We must withhold 24% of payments to you starting ${by} at the latest, until you send us one of these:`,
      '• If you are an individual: a validation from the Social Security Administration of your name and Social Security number (for example, a copy of your Social Security card issued by SSA).',
      '• If you have an EIN: IRS Letter 147C confirming your business name and EIN.',
      '',
      'Send it to us as soon as you have it; we stop backup withholding once it arrives.',
    ].join('\n'),
  };
}

contractorsRouter.get('/b-notices/:id/letter.pdf', async (req, res, next) => {
  try {
    const n = await loadNotice(req);
    const employer = await defaultEmployerOrg(prisma);
    const { title, body } = bNoticeLetter(n, employer.legalName);
    const pdf = await renderLetterPdf({ title, body, issuedAt: n.sentAt ?? new Date(), issuedTo: `${n.profile.associate.firstName} ${n.profile.associate.lastName}`.trim() });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="b-notice-${n.kind.toLowerCase()}-${ymd(n.irsNoticeReceivedOn)}.pdf"`);
    res.send(pdf);
  } catch (err) {
    next(err);
  }
});

contractorsRouter.post('/b-notices/:id/sent', async (req, res, next) => {
  try {
    const n = await loadNotice(req);
    if (n.sentAt) throw new HttpError(409, 'already_sent', 'This notice is already marked sent.');
    const employer = await defaultEmployerOrg(prisma);
    const { title, body } = bNoticeLetter(n, employer.legalName);
    const now = new Date();
    const letterHash = createHash('sha256').update(`${title}\n${body}`).digest('hex');
    await prisma.bNotice.update({ where: { id: n.id }, data: { sentAt: now, letterHash } });
    void notifyAssociate(n.profile.associateId, { subject: title, body: n.kind === 'FIRST' ? 'The IRS says your name and TIN do not match. Sign a new W-9 to avoid 24% backup withholding.' : 'The IRS reported a second mismatch. Send us an SSA validation or IRS Letter 147C to avoid 24% backup withholding.', category: 'payroll', linkUrl: '/me/w9', emailFallback: true });
    enqueueAudit({ actorUserId: req.user!.id, action: 'contractor.b_notice_sent', entityType: 'BNotice', entityId: n.id, metadata: { kind: n.kind, letterHash } }, 'contractor.b_notice_sent');
    res.json({ sentAt: now });
  } catch (err) {
    next(err);
  }
});

contractorsRouter.post('/b-notices/:id/resolve', async (req, res, next) => {
  try {
    const input = z.object({ resolution: z.enum(['W9_RECEIVED', 'SSA_VALIDATION', 'IRS_147C']) }).parse(req.body);
    const n = await loadNotice(req);
    if (n.resolution && n.resolution !== 'BACKUP_STARTED') throw new HttpError(409, 'already_resolved', 'This notice is already resolved.');
    if (n.kind === 'SECOND' && input.resolution === 'W9_RECEIVED') {
      throw new HttpError(409, 'second_needs_validation', 'A second B-notice needs an SSA validation or IRS Letter 147C. A new W-9 is not enough.');
    }
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.bNotice.update({ where: { id: n.id }, data: { resolution: input.resolution, respondedAt: now } });
      // Backup withholding this notice started stops once it's answered (Pub 1281: within 30 days; we stop at once).
      if (n.profile.backupWithholding && n.profile.backupReason === 'B_NOTICE') {
        const stillOpen = await tx.bNotice.count({ where: { profileId: n.profileId, resolution: null, id: { not: n.id } } });
        if (stillOpen === 0) await tx.contractorProfile.update({ where: { id: n.profileId }, data: { backupWithholding: false, backupStoppedAt: now } });
      }
    });
    await recordCriticalAudit({ actorUserId: req.user!.id, action: 'contractor.b_notice_resolved', entityType: 'BNotice', entityId: n.id, metadata: { resolution: input.resolution, kind: n.kind } }, 'contractor.b_notice_resolved');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ----- Contractor payment runs ------------------------------------------------------ */

function runView(run: Prisma.ContractorPaymentRunGetPayload<{ include: { payments: true } }>) {
  const sum = (f: (p: (typeof run.payments)[number]) => number) => round2(run.payments.reduce((a, p) => a + f(p), 0));
  return {
    id: run.id,
    name: run.name,
    payDate: ymd(run.payDate),
    status: run.status,
    createdById: run.createdById,
    approvedById: run.approvedById,
    approvedAt: run.approvedAt,
    paidAt: run.paidAt,
    count: run.payments.length,
    totals: { amount: sum((p) => Number(p.amount)), backupWithheld: sum((p) => Number(p.backupWithheld)), stateWithheld: sum((p) => Number(p.stateWithheld)), net: sum((p) => Number(p.netAmount)) },
  };
}

async function loadRun(req: Request) {
  refuseNarrowed(req.user!);
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) throw new HttpError(404, 'not_found', 'Payment run not found.');
  const run = await prisma.contractorPaymentRun.findFirst({ where: { id: id.data, tenantId: tenantIdForWrite() }, include: { payments: { orderBy: { createdAt: 'asc' } } } });
  if (!run) throw new HttpError(404, 'not_found', 'Payment run not found.');
  return run;
}

contractorsRouter.get('/payment-runs', async (req, res, next) => {
  try {
    refuseNarrowed(req.user!);
    const runs = await prisma.contractorPaymentRun.findMany({ where: { tenantId: tenantIdForWrite() }, orderBy: { payDate: 'desc' }, take: 200, include: { payments: true } });
    res.json({ runs: runs.map(runView), me: req.user!.id });
  } catch (err) {
    next(err);
  }
});

contractorsRouter.post('/payment-runs', async (req, res, next) => {
  try {
    refuseNarrowed(req.user!);
    const input = z.object({ name: z.string().trim().min(1).max(120), payDate: dateOnly }).parse(req.body);
    const run = await prisma.contractorPaymentRun.create({ data: { tenantId: tenantIdForWrite(), name: input.name, payDate: new Date(`${input.payDate}T00:00:00Z`), createdById: req.user!.id } });
    enqueueAudit({ actorUserId: req.user!.id, action: 'contractor.payment_run_created', entityType: 'ContractorPaymentRun', entityId: run.id, metadata: input }, 'contractor.payment_run_created');
    res.status(201).json({ id: run.id });
  } catch (err) {
    next(err);
  }
});

contractorsRouter.get('/payment-runs/:id', async (req, res, next) => {
  try {
    const run = await loadRun(req);
    const people = await prisma.associate.findMany({ where: { id: { in: run.payments.map((p) => p.associateId) } }, select: { id: true, firstName: true, lastName: true } });
    const nameOf = new Map(people.map((p) => [p.id, `${p.firstName} ${p.lastName}`.trim()]));
    res.json({
      run: runView(run),
      me: req.user!.id,
      payments: run.payments.map((p) => ({
        id: p.id,
        associateId: p.associateId,
        name: nameOf.get(p.associateId) ?? 'Unknown',
        description: p.description,
        invoiceNumber: p.invoiceNumber,
        form: p.form,
        miscBox: p.miscBox,
        amount: Number(p.amount),
        backupWithheld: Number(p.backupWithheld),
        workState: p.workState,
        stateWithheld: Number(p.stateWithheld),
        netAmount: Number(p.netAmount),
      })),
    });
  } catch (err) {
    next(err);
  }
});

/** Backup withholding for a payee today, from their TIN and profile. */
async function backupFor(associateId: string): Promise<{ required: boolean; reason: string | null }> {
  const a = await prisma.associate.findFirst({ where: { id: associateId }, select: { tinEncrypted: true, contractorProfile: true } });
  return backupRequirement(a?.contractorProfile ?? null, !!a?.tinEncrypted);
}

function computeNet(amount: number, backup: number, stateWithheld: number): number {
  return round2(amount - backup - stateWithheld);
}

contractorsRouter.post('/payment-runs/:id/payments', async (req, res, next) => {
  try {
    const run = await loadRun(req);
    if (run.status !== 'DRAFT') throw new HttpError(409, 'run_locked', 'Only a draft run can change.');
    const input = z.object({
      associateId: z.string().uuid(),
      description: z.string().trim().min(1).max(300),
      invoiceNumber: z.string().trim().max(60).nullish(),
      form: z.enum(['NEC', 'MISC']).default('NEC'),
      miscBox: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(6), z.literal(10)]).nullish(),
      amount: z.coerce.number().positive().max(10_000_000),
      workState: z.string().trim().length(2).toUpperCase().nullish(),
      stateWithheld: z.coerce.number().min(0).max(10_000_000).default(0),
    }).parse(req.body);
    await loadContractor(req, input.associateId);
    if (input.form === 'MISC' && !input.miscBox) throw new HttpError(400, 'misc_box', 'Choose the 1099-MISC box: rents, royalties, other income, medical payments or attorney proceeds.');
    const backup = await backupFor(input.associateId);
    const backupWithheld = backupAmount(input.amount, backup.required);
    const net = computeNet(input.amount, backupWithheld, input.stateWithheld);
    if (net < 0) throw new HttpError(400, 'negative_net', 'Withholding is more than the payment.');
    const p = await prisma.contractorPayment.create({
      data: {
        tenantId: tenantIdForWrite(),
        runId: run.id,
        associateId: input.associateId,
        description: input.description,
        invoiceNumber: input.invoiceNumber ?? null,
        form: input.form,
        miscBox: input.form === 'MISC' ? (input.miscBox ?? 3) : null,
        amount: input.amount,
        backupWithheld,
        netAmount: net,
        workState: input.workState ?? null,
        stateWithheld: input.stateWithheld,
      },
    });
    enqueueAudit({ actorUserId: req.user!.id, action: 'contractor.payment_added', entityType: 'ContractorPaymentRun', entityId: run.id, metadata: { paymentId: p.id, associateId: input.associateId, amount: input.amount, backupWithheld } }, 'contractor.payment_added');
    res.status(201).json({ id: p.id, backupWithheld, netAmount: net, backupReason: backup.reason });
  } catch (err) {
    next(err);
  }
});

contractorsRouter.delete('/payment-runs/:id/payments/:paymentId', async (req, res, next) => {
  try {
    const run = await loadRun(req);
    if (run.status !== 'DRAFT') throw new HttpError(409, 'run_locked', 'Only a draft run can change.');
    const p = run.payments.find((x) => x.id === req.params.paymentId);
    if (!p) throw new HttpError(404, 'not_found', 'Payment not found.');
    await prisma.contractorPayment.delete({ where: { id: p.id } });
    enqueueAudit({ actorUserId: req.user!.id, action: 'contractor.payment_removed', entityType: 'ContractorPaymentRun', entityId: run.id, metadata: { paymentId: p.id, amount: Number(p.amount) } }, 'contractor.payment_removed');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** A second person approves; backup withholding is re-checked as of approval. */
contractorsRouter.post('/payment-runs/:id/approve', async (req, res, next) => {
  try {
    const run = await loadRun(req);
    if (run.status !== 'DRAFT') throw new HttpError(409, 'not_draft', 'Only a draft run can be approved.');
    if (run.payments.length === 0) throw new HttpError(409, 'empty_run', 'Add at least one payment first.');
    if (run.createdById === req.user!.id) throw new HttpError(403, 'second_person', 'Someone other than the person who built this run has to approve it.');
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      for (const p of run.payments) {
        const backup = await backupFor(p.associateId);
        const backupWithheld = backupAmount(Number(p.amount), backup.required);
        if (backupWithheld !== Number(p.backupWithheld)) {
          await tx.contractorPayment.update({ where: { id: p.id }, data: { backupWithheld, netAmount: computeNet(Number(p.amount), backupWithheld, Number(p.stateWithheld)) } });
        }
      }
      await tx.contractorPaymentRun.update({ where: { id: run.id }, data: { status: 'APPROVED', approvedById: req.user!.id, approvedAt: now } });
    });
    await recordCriticalAudit({ actorUserId: req.user!.id, action: 'contractor.payment_run_approved', entityType: 'ContractorPaymentRun', entityId: run.id, metadata: { count: run.payments.length, requestedBy: run.createdById } }, 'contractor.payment_run_approved');
    res.json({ status: 'APPROVED' });
  } catch (err) {
    next(err);
  }
});

contractorsRouter.post('/payment-runs/:id/paid', async (req, res, next) => {
  try {
    const input = z.object({ paymentMethod: z.enum(['ACH', 'CHECK', 'WIRE', 'CARD', 'OTHER']).default('ACH'), reference: z.string().trim().max(120).nullish() }).parse(req.body ?? {});
    const run = await loadRun(req);
    if (run.status !== 'APPROVED') throw new HttpError(409, 'not_approved', 'Approve the run before marking it paid.');
    const now = new Date();
    await prisma.$transaction([
      prisma.contractorPayment.updateMany({ where: { runId: run.id }, data: { paymentMethod: input.paymentMethod, reference: input.reference ?? null } }),
      prisma.contractorPaymentRun.update({ where: { id: run.id }, data: { status: 'PAID', paidAt: now } }),
    ]);
    const view = runView(run);
    await recordCriticalAudit({ actorUserId: req.user!.id, action: 'contractor.payment_run_paid', entityType: 'ContractorPaymentRun', entityId: run.id, metadata: { ...view.totals, paymentMethod: input.paymentMethod } }, 'contractor.payment_run_paid');
    res.json({ status: 'PAID' });
  } catch (err) {
    next(err);
  }
});

contractorsRouter.post('/payment-runs/:id/cancel', async (req, res, next) => {
  try {
    const run = await loadRun(req);
    if (run.status === 'PAID' || run.status === 'CANCELLED') throw new HttpError(409, 'not_cancellable', 'A paid or cancelled run cannot be cancelled.');
    await prisma.contractorPaymentRun.update({ where: { id: run.id }, data: { status: 'CANCELLED' } });
    enqueueAudit({ actorUserId: req.user!.id, action: 'contractor.payment_run_cancelled', entityType: 'ContractorPaymentRun', entityId: run.id }, 'contractor.payment_run_cancelled');
    res.json({ status: 'CANCELLED' });
  } catch (err) {
    next(err);
  }
});

/* ----- State 1099 filing ------------------------------------------------------------- */

async function stateFilingRows(): Promise<StateFilingRow[]> {
  const saved = await prisma.state1099Filing.findMany({ where: { tenantId: tenantIdForWrite() } });
  const byState = new Map(saved.map((s) => [s.state, s]));
  return ALL_STATES.map((st) => {
    const s = byState.get(st);
    if (!s) return { ...defaultStateFiling(st), payerStateId: null, notes: null };
    return { state: st, cfsf: s.cfsf, directFiling: s.directFiling, payerStateId: s.payerStateId, notes: s.notes, isDefault: false, noIncomeTax: NO_INCOME_TAX_STATES.has(st) };
  });
}

contractorsRouter.get('/state-filing', async (req, res, next) => {
  try {
    refuseNarrowed(req.user!);
    const states = await stateFilingRows();
    const cfsf = states.filter((s) => s.cfsf).map((s) => s.state);
    res.json({ states, cfsfStates: cfsf, cfsfParticipants: [...CFSF_STATES] });
  } catch (err) {
    next(err);
  }
});

contractorsRouter.put('/state-filing/:state', async (req, res, next) => {
  try {
    refuseNarrowed(req.user!);
    const state = z.enum(ALL_STATES).parse(String(req.params.state).toUpperCase());
    const input = z.object({ cfsf: z.boolean(), directFiling: z.boolean(), payerStateId: z.string().trim().max(40).nullish(), notes: z.string().trim().max(500).nullish() }).parse(req.body);
    if (input.cfsf && !CFSF_STATES.has(state)) throw new HttpError(400, 'not_cfsf_state', `${state} doesn't take 1099s through the IRS Combined Federal/State program. File directly.`);
    const tenantId = tenantIdForWrite();
    await prisma.state1099Filing.upsert({
      where: { tenantId_state: { tenantId, state } },
      create: { tenantId, state, cfsf: input.cfsf, directFiling: input.directFiling, payerStateId: input.payerStateId ?? null, notes: input.notes ?? null, updatedById: req.user!.id },
      update: { cfsf: input.cfsf, directFiling: input.directFiling, payerStateId: input.payerStateId ?? null, notes: input.notes ?? null, updatedById: req.user!.id },
    });
    enqueueAudit({ actorUserId: req.user!.id, action: 'contractor.state_filing_updated', entityType: 'State1099Filing', entityId: state, metadata: { cfsf: input.cfsf, directFiling: input.directFiling } }, 'contractor.state_filing_updated');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

interface PayeeYear {
  associateId: string;
  nec: Awaited<ReturnType<typeof aggregateF1099NecPayments>>;
  misc: Awaited<ReturnType<typeof aggregateF1099MiscPayments>>;
}

async function payeeYears(user: SessionUser, taxYear: number): Promise<PayeeYear[]> {
  const [necIds, miscIds] = await Promise.all([listF1099NecEligibleAssociates(prisma, taxYear, null), listF1099MiscEligibleAssociates(prisma, taxYear, null)]);
  const contractors = await prisma.associate.findMany({
    where: scopeWhere<Prisma.AssociateWhereInput>(scopeActiveAssociates(user, { former: true }), { OR: [{ employmentType: { in: [...CONTRACTOR_TYPES] } }, { id: { in: [...new Set([...necIds, ...miscIds])] } }] }),
    select: { id: true },
  });
  const out: PayeeYear[] = [];
  for (const c of contractors) {
    const [nec, misc] = await Promise.all([aggregateF1099NecPayments(prisma, c.id, taxYear), aggregateF1099MiscPayments(prisma, c.id, taxYear)]);
    out.push({ associateId: c.id, nec, misc });
  }
  return out;
}

const csvCell = (v: unknown) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * One state's 1099 recipients for direct filing, as CSV: payer state id,
 * recipient, TIN, address, the form, federal box 1/4 and the state's income
 * and withholding. States publish their own layouts; this is the data they
 * all ask for. CONFIRM WITH <state revenue department>'s 1099 e-file spec
 * before uploading — several want a fixed-width or Pub 1220-style file.
 */
contractorsRouter.get('/state-filing/:state/export.csv', EXPORT_PII, async (req, res, next) => {
  try {
    refuseNarrowed(req.user!);
    assertBulkPiiExporter(req);
    const state = z.enum(ALL_STATES).parse(String(req.params.state).toUpperCase());
    const taxYear = taxYearParam.parse(req.query.taxYear);
    const filing = (await stateFilingRows()).find((s) => s.state === state)!;
    const years = await payeeYears(req.user!, taxYear);
    const people = await prisma.associate.findMany({
      where: { id: { in: years.map((y) => y.associateId) } },
      select: { id: true, firstName: true, lastName: true, tinEncrypted: true, addressLine1: true, city: true, state: true, zip: true, contractorProfile: { select: { legalName: true, businessName: true, addressLine1: true, city: true, state: true, zip: true } } },
    });
    const byId = new Map(people.map((p) => [p.id, p]));
    const lines = [['Tax year', 'Form', 'Payer state ID', 'Recipient name', 'Recipient TIN', 'Address', 'City', 'State', 'ZIP', 'Federal amount', 'Federal tax withheld (box 4)', 'State income', 'State tax withheld'].join(',')];
    let count = 0;
    for (const y of years) {
      const p = byId.get(y.associateId);
      if (!p) continue;
      const forms: Array<{ form: string; federal: number; box4: number; line?: { stateIncome: number; stateTaxWithheld: number } }> = [
        { form: '1099-NEC', federal: y.nec.box1NonemployeeCompensation, box4: y.nec.box4FitWithheld, line: y.nec.stateLines.find((l) => l.state === state) },
        { form: '1099-MISC', federal: round2(y.misc.box1Rents + y.misc.box2Royalties + y.misc.box3OtherIncome + y.misc.box6MedicalHealthcarePayments + y.misc.box10GrossProceedsAttorney), box4: y.misc.box4FitWithheld, line: y.misc.stateLines.find((l) => l.state === state) },
      ];
      for (const f of forms) {
        if (!f.line || (f.line.stateIncome <= 0 && f.line.stateTaxWithheld <= 0)) continue;
        const prof = p.contractorProfile;
        lines.push([
          taxYear, f.form, filing.payerStateId ?? '',
          prof?.businessName || prof?.legalName || `${p.firstName} ${p.lastName}`,
          tinDigits(p.tinEncrypted) ?? '',
          prof?.addressLine1 ?? p.addressLine1 ?? '', prof?.city ?? p.city ?? '', prof?.state ?? p.state ?? '', prof?.zip ?? p.zip ?? '',
          f.federal.toFixed(2), f.box4.toFixed(2), f.line.stateIncome.toFixed(2), f.line.stateTaxWithheld.toFixed(2),
        ].map(csvCell).join(','));
        count += 1;
      }
    }
    await recordCriticalAudit({ actorUserId: req.user!.id, action: 'contractor.state_1099_exported', entityType: 'State1099Filing', entityId: state, metadata: { taxYear, rows: count } }, 'contractor.state_1099_exported');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="1099-${state}-${taxYear}.csv"`);
    res.send(lines.join('\r\n') + '\r\n');
  } catch (err) {
    next(err);
  }
});

/* ----- Year-end summary --------------------------------------------------------------- */

contractorsRouter.get('/year-end', async (req, res, next) => {
  try {
    refuseNarrowed(req.user!);
    const taxYear = taxYearParam.parse(req.query.taxYear);
    const years = await payeeYears(req.user!, taxYear);
    const people = await prisma.associate.findMany({
      where: { id: { in: years.map((y) => y.associateId) } },
      select: { id: true, firstName: true, lastName: true, tinEncrypted: true, zip: true, contractorProfile: true },
    });
    const byId = new Map(people.map((p) => [p.id, p]));
    const rows = years
      .map((y) => {
        const p = byId.get(y.associateId)!;
        const needsNec = y.nec.box1NonemployeeCompensation >= f1099NecThreshold(taxYear) || y.nec.box4FitWithheld > 0;
        const needsMisc = meetsF1099MiscThreshold(y.misc, taxYear);
        const issues: string[] = [];
        if ((needsNec || needsMisc) && !p.tinEncrypted) issues.push('No TIN');
        if ((needsNec || needsMisc) && p.contractorProfile?.w9Status !== 'SIGNED') issues.push('No signed W-9');
        if ((needsNec || needsMisc) && p.contractorProfile?.tinMatchStatus && ['MISMATCH', 'INVALID'].includes(p.contractorProfile.tinMatchStatus)) issues.push('TIN mismatch');
        if ((needsNec || needsMisc) && !(p.contractorProfile?.zip ?? p.zip)) issues.push('No address');
        return {
          associateId: y.associateId,
          name: `${p.firstName} ${p.lastName}`.trim(),
          necBox1: y.nec.box1NonemployeeCompensation,
          necBox4: y.nec.box4FitWithheld,
          miscTotal: round2(y.misc.box1Rents + y.misc.box2Royalties + y.misc.box3OtherIncome + y.misc.box6MedicalHealthcarePayments + y.misc.box10GrossProceedsAttorney),
          miscBox4: y.misc.box4FitWithheld,
          states: [...new Set([...y.nec.stateLines, ...y.misc.stateLines].map((l) => l.state))],
          needsNec,
          needsMisc,
          issues,
        };
      })
      .filter((r) => r.necBox1 > 0 || r.miscTotal > 0 || r.necBox4 > 0 || r.miscBox4 > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
    const sum = (f: (r: (typeof rows)[number]) => number) => round2(rows.reduce((a, r) => a + f(r), 0));
    res.json({
      taxYear,
      threshold: f1099NecThreshold(taxYear),
      rows,
      totals: { payees: rows.length, necForms: rows.filter((r) => r.needsNec).length, miscForms: rows.filter((r) => r.needsMisc).length, necBox1: sum((r) => r.necBox1), backupWithheld: sum((r) => r.necBox4 + r.miscBox4), withIssues: rows.filter((r) => r.issues.length > 0).length },
    });
  } catch (err) {
    next(err);
  }
});

/* ----- The contractor's own W-9 (/me/w9) ------------------------------------------------ */

const W9Input = z.object({
  legalName: z.string().trim().min(2).max(200),
  businessName: z.string().trim().max(200).nullish(),
  taxClassification: z.enum(['INDIVIDUAL', 'C_CORP', 'S_CORP', 'PARTNERSHIP', 'TRUST', 'LLC', 'OTHER']),
  llcTaxClass: z.enum(['C', 'S', 'P']).nullish(),
  exemptPayeeCode: z.string().trim().max(4).nullish(),
  fatcaCode: z.string().trim().max(4).nullish(),
  addressLine1: z.string().trim().min(3).max(200),
  city: z.string().trim().min(1).max(80),
  state: z.string().trim().length(2).toUpperCase(),
  zip: z.string().trim().regex(/^\d{5}(-?\d{4})?$/),
  tinType: z.enum(['SSN', 'EIN']),
  tin: z.string().trim().min(9).max(11),
  /** W-9 Part II item 2 crossed out: the IRS told them they're subject to backup withholding. */
  subjectToBackup: z.boolean().default(false),
  signatureName: z.string().trim().min(2).max(120),
  certify: z.literal(true),
});

async function selfContractor(req: Request) {
  const associateId = req.user?.associateId;
  if (!associateId) throw new HttpError(404, 'not_found', 'No W-9 for this account.');
  const a = await prisma.associate.findFirst({ where: { id: associateId }, select: { id: true, firstName: true, lastName: true, employmentType: true, tinEncrypted: true, addressLine1: true, city: true, state: true, zip: true } });
  if (!a) throw new HttpError(404, 'not_found', 'No W-9 for this account.');
  return a;
}

contractorSelfRouter.get('/', async (req, res, next) => {
  try {
    const a = await selfContractor(req);
    const isContractor = (CONTRACTOR_TYPES as readonly string[]).includes(a.employmentType);
    const p = await prisma.contractorProfile.findFirst({ where: { associateId: a.id } });
    const backup = backupRequirement(p, !!a.tinEncrypted);
    res.json({
      required: isContractor,
      status: p?.w9Status ?? 'NONE',
      signedAt: p?.w9SignedAt ?? null,
      backupWithholding: isContractor && backup.required,
      form: {
        legalName: p?.legalName ?? `${a.firstName} ${a.lastName}`.trim(),
        businessName: p?.businessName ?? null,
        taxClassification: p?.taxClassification ?? null,
        llcTaxClass: p?.llcTaxClass ?? null,
        exemptPayeeCode: p?.exemptPayeeCode ?? null,
        fatcaCode: p?.fatcaCode ?? null,
        addressLine1: p?.addressLine1 ?? a.addressLine1,
        city: p?.city ?? a.city,
        state: p?.state ?? a.state,
        zip: p?.zip ?? a.zip,
        tinType: p?.tinType ?? null,
        tinLast4: p?.tinLast4 ?? (a.tinEncrypted ? (tinDigits(a.tinEncrypted)?.slice(-4) ?? null) : null),
        subjectToBackup: p?.subjectToBackupCertified ?? false,
      },
    });
  } catch (err) {
    next(err);
  }
});

function w9Summary(p: { legalName: string; businessName?: string | null; taxClassification: string; llcTaxClass?: string | null; exemptPayeeCode?: string | null; fatcaCode?: string | null; addressLine1: string; city: string; state: string; zip: string; tinType: string; tinLast4: string; subjectToBackup: boolean; signatureName: string; signedAt: Date; ip: string | null }): string {
  return [
    'Form W-9, Request for Taxpayer Identification Number and Certification (signed electronically)',
    '',
    `1. Name: ${p.legalName}`,
    `2. Business name: ${p.businessName || '—'}`,
    `3a. Federal tax classification: ${p.taxClassification}${p.llcTaxClass ? ` (LLC taxed as ${p.llcTaxClass})` : ''}`,
    `4. Exemptions: payee code ${p.exemptPayeeCode || '—'}, FATCA code ${p.fatcaCode || '—'}`,
    `5–6. Address: ${p.addressLine1}, ${p.city}, ${p.state} ${p.zip}`,
    `Part I. ${p.tinType}: •••-••-${p.tinLast4}`,
    '',
    'Part II. Certification. Under penalties of perjury, I certify that:',
    '1. The number shown on this form is my correct taxpayer identification number; and',
    p.subjectToBackup
      ? '2. [Crossed out] I have been notified by the IRS that I am currently subject to backup withholding; and'
      : '2. I am not subject to backup withholding because (a) I am exempt, or (b) I have not been notified by the IRS that I am subject to backup withholding, or (c) the IRS has notified me that I am no longer subject to backup withholding; and',
    '3. I am a U.S. citizen or other U.S. person; and',
    '4. The FATCA code(s) entered on this form (if any) indicating that I am exempt from FATCA reporting is correct.',
    '',
    `Signed: ${p.signatureName}   Date: ${p.signedAt.toISOString().slice(0, 10)}   (typed signature, ${p.signedAt.toISOString()}${p.ip ? `, from ${p.ip}` : ''})`,
    '',
    'Certification wording from IRS Form W-9 (Rev. March 2024). The full TIN is kept encrypted and is not printed on this copy.',
  ].join('\n');
}

contractorSelfRouter.post('/', async (req, res, next) => {
  try {
    const input = W9Input.parse(req.body);
    const a = await selfContractor(req);
    if (!(CONTRACTOR_TYPES as readonly string[]).includes(a.employmentType)) throw new HttpError(409, 'not_a_contractor', 'A W-9 is for independent contractors. Employees use the W-4.');
    const tin = input.tin.replace(/[^0-9]/g, '');
    if (tin.length !== 9) throw new HttpError(400, 'invalid_tin', 'Enter all nine digits of your SSN or EIN.');
    if (input.taxClassification === 'LLC' && !input.llcTaxClass) throw new HttpError(400, 'llc_class', 'Choose how your LLC is taxed: C corporation, S corporation or partnership.');
    const prior = a.tinEncrypted ? decryptString(a.tinEncrypted).replace(/[^0-9]/g, '') : null;
    const tinChanged = prior !== tin;
    const signedAt = new Date();
    const ip = (req.ip ?? '').slice(0, 64) || null;
    const body = w9Summary({ ...input, tinLast4: tin.slice(-4), signedAt, ip });
    const w9Hash = createHash('sha256').update(body).digest('hex');
    const existing = await prisma.contractorProfile.findFirst({ where: { associateId: a.id } });
    const change = await prisma.$transaction(async (tx) => {
      if (tinChanged) await tx.associate.update({ where: { id: a.id }, data: { tinEncrypted: encryptString(tin) } });
      const data = {
        legalName: input.legalName,
        businessName: input.businessName ?? null,
        taxClassification: input.taxClassification,
        llcTaxClass: input.taxClassification === 'LLC' ? (input.llcTaxClass ?? null) : null,
        exemptPayeeCode: input.exemptPayeeCode ?? null,
        fatcaCode: input.fatcaCode ?? null,
        addressLine1: input.addressLine1,
        city: input.city,
        state: input.state,
        zip: input.zip,
        tinType: input.tinType,
        tinLast4: tin.slice(-4),
        w9Status: 'SIGNED',
        w9SignedAt: signedAt,
        w9SignatureName: input.signatureName,
        w9SignedIp: ip,
        w9Hash,
        subjectToBackupCertified: input.subjectToBackup,
        ...(tinChanged || !existing ? { tinMatchStatus: 'NOT_CHECKED', tinMatchCode: null, tinMatchCheckedAt: null } : {}),
      };
      const profile = existing
        ? await tx.contractorProfile.update({ where: { id: existing.id }, data })
        : await tx.contractorProfile.create({ data: { ...data, tenantId: tenantIdForWrite(), associateId: a.id } });
      // A corrected W-9 answers an open FIRST B-notice (Pub 1281); a second one needs SSA/IRS validation.
      const firsts = await tx.bNotice.findMany({ where: { profileId: profile.id, kind: 'FIRST', OR: [{ resolution: null }, { resolution: 'BACKUP_STARTED' }] }, select: { id: true } });
      if (firsts.length) await tx.bNotice.updateMany({ where: { id: { in: firsts.map((f) => f.id) } }, data: { resolution: 'W9_RECEIVED', respondedAt: signedAt } });
      const stillOpen = await tx.bNotice.count({ where: { profileId: profile.id, OR: [{ resolution: null }, { resolution: 'BACKUP_STARTED', kind: 'SECOND' }] } });
      if (profile.backupWithholding && profile.backupReason === 'B_NOTICE' && stillOpen === 0) {
        await tx.contractorProfile.update({ where: { id: profile.id }, data: { backupWithholding: false, backupStoppedAt: signedAt } });
      }
      return prior && tinChanged
        ? recordFinancialChange(tx, { associateId: a.id, kind: 'SSN', source: 'SELF', actor: { id: req.user!.id, role: req.user!.role, associateId: a.id }, req, oldSummary: ssnSummary(prior, 'TIN'), newSummary: ssnSummary(tin, 'TIN') })
        : null;
    });
    if (change) void dispatchFinancialChange(change.id);
    await recordCriticalAudit({ actorUserId: req.user!.id, action: 'contractor.w9_signed', entityType: 'Associate', entityId: a.id, metadata: { w9Hash, tinType: input.tinType, tinChanged, subjectToBackup: input.subjectToBackup } }, 'contractor.w9_signed');
    res.json({ status: 'SIGNED', signedAt, tinLast4: tin.slice(-4) });
  } catch (err) {
    next(err);
  }
});

async function signedW9Pdf(associateId: string): Promise<Buffer> {
  const p = await prisma.contractorProfile.findFirst({ where: { associateId } });
  if (!p || p.w9Status !== 'SIGNED' || !p.w9SignedAt) throw new HttpError(404, 'not_found', 'No signed W-9 yet.');
  const body = w9Summary({
    legalName: p.legalName ?? '', businessName: p.businessName, taxClassification: p.taxClassification ?? '', llcTaxClass: p.llcTaxClass, exemptPayeeCode: p.exemptPayeeCode, fatcaCode: p.fatcaCode,
    addressLine1: p.addressLine1 ?? '', city: p.city ?? '', state: p.state ?? '', zip: p.zip ?? '', tinType: p.tinType ?? 'SSN', tinLast4: p.tinLast4 ?? '', subjectToBackup: p.subjectToBackupCertified,
    signatureName: p.w9SignatureName ?? '', signedAt: p.w9SignedAt, ip: p.w9SignedIp,
  });
  return renderLetterPdf({ title: 'Form W-9 (signed copy)', body: `${body}\n\nDocument hash: ${p.w9Hash ?? ''}`, issuedAt: p.w9SignedAt, issuedTo: p.legalName });
}

contractorsRouter.get('/profiles/:associateId/w9.pdf', async (req, res, next) => {
  try {
    const a = await loadContractor(req, req.params.associateId!);
    const pdf = await signedW9Pdf(a.id);
    enqueueAudit({ actorUserId: req.user!.id, action: 'contractor.w9_viewed', entityType: 'Associate', entityId: a.id }, 'contractor.w9_viewed');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="W-9-signed.pdf"');
    res.send(pdf);
  } catch (err) {
    next(err);
  }
});

contractorSelfRouter.get('/signed.pdf', async (req, res, next) => {
  try {
    const a = await selfContractor(req);
    const pdf = await signedW9Pdf(a.id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="W-9-signed.pdf"');
    res.send(pdf);
  } catch (err) {
    next(err);
  }
});
