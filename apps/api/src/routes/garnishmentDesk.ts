import { Router, type Request } from 'express';
import { Prisma, type Garnishment } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { enqueueAudit } from '../lib/audit.js';
import { decryptString, encryptString } from '../lib/crypto.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { orgDateKey } from '../lib/timeAnomalies.js';
import { dateColumnKey } from '../lib/timezone.js';
import { isInternallyScoped, scopeAssociatesIncludingFormer, scopeWhere } from '../lib/scope.js';
import { createApprovalRequest, pendingResponse, registerApplyHandler } from '../lib/approvalRequests.js';
import {
  buildAcknowledgment,
  buildLumpSumNotice,
  buildTerminationNotice,
  eiwoProblems,
  EiwoParseError,
  orderFieldsFrom,
  parseEiwoFile,
  redactParsed,
  REJECT_REASONS,
  type EmployerFacts,
  type OrderRef,
  type ParsedEiwo,
  type RejectReasonCode,
} from '../lib/eiwo.js';
import { remitDueBy, remitElectronically, sealPayeeBank } from '../lib/garnishmentRemit.js';
import { payDateFor, loadTenantHolidays } from '../lib/banking/funding.js';
import type { SessionUser } from '../types/express.js';

/**
 * The garnishment desk: e-IWO intake and answers, the state rules and
 * levy tables the withholding engine reads, electronic remittance, and a
 * per-order view of balance, next remittance and status.
 *
 * Gate: process:payroll (garnishment orders are company-wide PII). Site-
 * or region-bound payroll users see the orders of people in their reach
 * and cannot change the tenant-wide tables.
 */
export const garnishmentDeskRouter = Router();
const PROCESS = requireCapability('process:payroll');

function audit(req: Request, action: string, entityType: string, entityId: string, metadata: Record<string, unknown> = {}): void {
  enqueueAudit(
    { actorUserId: req.user!.id, action, entityType, entityId, metadata: metadata as Prisma.InputJsonObject },
    'garnishmentDesk',
  );
}

function refuseNarrowed(user: SessionUser): void {
  if (isInternallyScoped(user)) {
    throw new HttpError(403, 'company_wide', 'The withholding tables apply to the whole company; ask a payroll lead without a site limit.');
  }
}

const num = (d: Prisma.Decimal | null | undefined): number | null => (d == null ? null : Number(d));
/** A date column's YYYY-MM-DD. */
const ymd = (d: Date | null | undefined): string | null => (d ? dateColumnKey(d) : null);

async function employerFor(associateId: string | null): Promise<EmployerFacts> {
  const tenantId = tenantIdForWrite();
  const employment = associateId
    ? await prisma.employment.findFirst({ where: { associateId, endDate: null }, include: { employer: true }, orderBy: { hireDate: 'desc' } })
    : null;
  const org = employment?.employer ?? (await prisma.employerOrganization.findFirst({ where: { tenantId, isDefault: true } }));
  return {
    ein: org?.ein ?? '',
    name: org?.legalName ?? 'Employer',
    address: org ? [org.addressLine1, org.addressLine2, [org.city, org.state, org.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ') : null,
  };
}

async function fullSsn(associateId: string): Promise<string | null> {
  const w4 = await prisma.w4Submission.findFirst({ where: { associateId }, select: { ssnEncrypted: true } });
  return w4?.ssnEncrypted ? decryptString(w4.ssnEncrypted) : null;
}

/** The documents we keep: raw file encrypted (it carries full SSNs). */
const sealRaw = (xml: string) => encryptString(xml).toString('base64');

/** Find the employee an e-IWO names: SSN last four and last name, then the full SSN when we hold it. */
async function matchEmployee(d: ParsedEiwo): Promise<{ associateId: string | null; why: string }> {
  if (!d.employeeSsn) return { associateId: null, why: 'The document has no full SSN.' };
  const last4 = d.employeeSsn.slice(-4);
  const candidates = await prisma.associate.findMany({
    where: { tenantId: tenantIdForWrite(), ssnLast4: last4, deletedAt: null },
    select: { id: true, lastName: true, w4Submission: { select: { ssnEncrypted: true } } },
  });
  const exact = candidates.filter((c) => c.w4Submission?.ssnEncrypted && decryptString(c.w4Submission.ssnEncrypted) === d.employeeSsn);
  if (exact.length === 1) return { associateId: exact[0]!.id, why: 'Matched on the full SSN.' };
  const byName = candidates.filter((c) => !c.w4Submission?.ssnEncrypted && d.employeeLastName && c.lastName.toLowerCase() === d.employeeLastName.toLowerCase());
  if (byName.length === 1) return { associateId: byName[0]!.id, why: 'Matched on the SSN’s last four and last name; confirm before accepting.' };
  return { associateId: null, why: candidates.length ? 'More than one person could match; choose who this is.' : 'No one on file has this SSN.' };
}

/* ----- the desk -------------------------------------------------------- */

garnishmentDeskRouter.get('/garnishment-desk', PROCESS, async (req, res) => {
  const tenantId = tenantIdForWrite();
  await loadTenantHolidays(prisma);
  const where = scopeWhere<Prisma.GarnishmentWhereInput>({ tenantId, deletedAt: null }, { associate: scopeAssociatesIncludingFormer(req.user!) });
  const [orders, eiwoPending, stateRules, levyRows] = await Promise.all([
    prisma.garnishment.findMany({
      where,
      include: {
        associate: { select: { firstName: true, lastName: true } },
        deductions: {
          orderBy: { deductedOn: 'desc' },
          take: 1,
          select: { amount: true, deductedOn: true },
        },
      },
      orderBy: [{ status: 'asc' }, { priority: 'asc' }, { createdAt: 'desc' }],
    }),
    prisma.eiwoDocument.count({ where: { tenantId, status: 'RECEIVED' } }),
    prisma.garnishmentStateRule.findMany({ where: { tenantId }, orderBy: { state: 'asc' } }),
    prisma.levyExemptParameter.findMany({ where: { tenantId }, select: { taxYear: true }, distinct: ['taxYear'], orderBy: { taxYear: 'desc' } }),
  ]);
  // Pending remittances that include each order's money.
  const pendingDeductions = await prisma.garnishmentDeduction.findMany({
    where: { garnishmentId: { in: orders.map((o) => o.id) }, remittance: { status: 'PENDING' } },
    select: { garnishmentId: true, amount: true, remittanceId: true, remittance: { select: { payrollRunId: true, payeeName: true } } },
  });
  const payDates = new Map<string, string>();
  for (const d of pendingDeductions) {
    const runId = d.remittance!.payrollRunId;
    if (!payDates.has(runId)) payDates.set(runId, await payDateFor(prisma, runId));
  }
  const nextByOrder = new Map<string, { remittanceId: string; amount: number; payee: string; dueBy: string }>();
  for (const d of pendingDeductions) {
    const dueBy = remitDueBy(payDates.get(d.remittance!.payrollRunId)!);
    const prev = nextByOrder.get(d.garnishmentId);
    if (!prev || dueBy < prev.dueBy) nextByOrder.set(d.garnishmentId, { remittanceId: d.remittanceId!, amount: Number(d.amount), payee: d.remittance!.payeeName, dueBy });
  }
  const today = orgDateKey(new Date());
  const shaped = orders.map((g) => {
    const cap = num(g.totalCap);
    const withheld = Number(g.amountWithheld);
    const next = nextByOrder.get(g.id) ?? null;
    return {
      id: g.id,
      associateId: g.associateId,
      associateName: `${g.associate.firstName} ${g.associate.lastName}`,
      kind: g.kind,
      status: g.status,
      source: g.source,
      caseNumber: g.caseNumber,
      orderIdentifier: g.orderIdentifier,
      remittanceIdentifier: g.remittanceIdentifier,
      state: g.state,
      fipsCode: g.fipsCode,
      agencyName: g.agencyName,
      payee: g.remitTo ?? g.agencyName,
      payeeKind: g.payeeKind,
      remitMethod: g.remitMethod,
      payeeAccountLast4: g.payeeAccountLast4,
      orderFrequency: g.orderFrequency,
      currentSupport: num(g.currentSupport),
      pastDueSupport: num(g.pastDueSupport),
      medicalSupport: num(g.medicalSupport),
      arrearsOver12Weeks: g.arrearsOver12Weeks,
      supportsSecondFamily: g.supportsSecondFamily,
      amountPerRun: num(g.amountPerRun),
      percentOfDisp: num(g.percentOfDisp),
      adminFee: num(g.adminFee),
      levyFilingStatus: g.levyFilingStatus,
      levyExemptions: g.levyExemptions,
      levyAdditionalStandard: g.levyAdditionalStandard,
      levyTaxYear: g.levyTaxYear,
      lumpSumReporting: g.lumpSumReporting,
      totalCap: cap,
      amountWithheld: withheld,
      remainingBalance: cap == null ? null : Math.max(0, Math.round((cap - withheld) * 100) / 100),
      lastDeduction: g.deductions[0] ? { amount: Number(g.deductions[0].amount), on: orgDateKey(g.deductions[0].deductedOn) } : null,
      nextRemittance: next ? { ...next, overdue: next.dueBy < today } : null,
      startDate: ymd(g.startDate),
      endDate: ymd(g.endDate),
      receivedAt: g.receivedAt?.toISOString() ?? null,
      priority: g.priority,
    };
  });
  const remitPending = await prisma.garnishmentRemittance.aggregate({
    where: { tenantId, status: 'PENDING' },
    _sum: { amount: true },
    _count: true,
  });
  res.json({
    orders: shaped,
    totals: {
      active: shaped.filter((o) => o.status === 'ACTIVE').length,
      eiwoToReview: eiwoPending,
      remittancesPending: remitPending._count,
      remittancesPendingAmount: Number(remitPending._sum.amount ?? 0),
      overdue: shaped.filter((o) => o.nextRemittance?.overdue).length,
    },
    stateRules: stateRules.map(shapeRule),
    levyYears: levyRows.map((r) => r.taxYear),
    rejectReasons: Object.entries(REJECT_REASONS).map(([code, label]) => ({ code, label })),
  });
});

/* ----- e-IWO intake ---------------------------------------------------- */

function shapeDoc(d: Prisma.EiwoDocumentGetPayload<object>) {
  return {
    id: d.id,
    receivedAt: d.receivedAt.toISOString(),
    documentActionCode: d.documentActionCode,
    caseIdentifier: d.caseIdentifier,
    orderIdentifier: d.orderIdentifier,
    remittanceIdentifier: d.remittanceIdentifier,
    issuingState: d.issuingState,
    employeeName: d.employeeName,
    employeeSsnLast4: d.employeeSsnLast4,
    parsed: d.parsed,
    status: d.status,
    rejectReasonCode: d.rejectReasonCode,
    rejectReason: d.rejectReason,
    associateId: d.associateId,
    garnishmentId: d.garnishmentId,
    hasAck: !!d.ackContent,
    ackGeneratedAt: d.ackGeneratedAt?.toISOString() ?? null,
  };
}

garnishmentDeskRouter.get('/garnishment-desk/eiwo', PROCESS, async (req, res) => {
  const status = z.enum(['RECEIVED', 'ACCEPTED', 'REJECTED']).optional().parse(req.query.status || undefined);
  const rows = await prisma.eiwoDocument.findMany({
    where: { tenantId: tenantIdForWrite(), ...(status ? { status } : {}) },
    orderBy: { receivedAt: 'desc' },
    take: 500,
  });
  // Narrowed callers see documents for people in their reach, and unmatched ones not at all.
  let visible = rows;
  if (isInternallyScoped(req.user!)) {
    const reach = new Set(
      (await prisma.associate.findMany({ where: scopeWhere<Prisma.AssociateWhereInput>({ id: { in: rows.map((r) => r.associateId).filter((x): x is string => !!x) } }, scopeAssociatesIncludingFormer(req.user!)), select: { id: true } })).map((a) => a.id),
    );
    visible = rows.filter((r) => r.associateId && reach.has(r.associateId));
  }
  res.json({ documents: visible.map(shapeDoc), truncated: rows.length === 500 });
});

garnishmentDeskRouter.post('/garnishment-desk/eiwo', PROCESS, async (req, res) => {
  const { xml } = z.object({ xml: z.string().min(10).max(5_000_000) }).parse(req.body);
  let docs: ParsedEiwo[];
  try {
    docs = parseEiwoFile(xml);
  } catch (err) {
    if (err instanceof EiwoParseError) throw new HttpError(400, 'eiwo_unreadable', `This file is not a readable e-IWO: ${err.message}`);
    throw err;
  }
  const tenantId = tenantIdForWrite();
  const sealed = sealRaw(xml);
  const created = [];
  for (const d of docs) {
    const match = await matchEmployee(d);
    const problems = eiwoProblems(d);
    const row = await prisma.eiwoDocument.create({
      data: {
        tenantId,
        documentActionCode: d.documentActionCode,
        caseIdentifier: d.caseIdentifier,
        orderIdentifier: d.orderIdentifier,
        remittanceIdentifier: d.remittanceIdentifier,
        issuingState: d.issuingState,
        employeeName: [d.employeeFirstName, d.employeeLastName].filter(Boolean).join(' ') || null,
        employeeSsnLast4: d.employeeSsn?.slice(-4) ?? null,
        rawContent: sealed,
        parsed: { ...redactParsed(d), problems, match: match.why, ssnSealed: d.employeeSsn ? encryptString(d.employeeSsn).toString('base64') : null } as unknown as Prisma.InputJsonObject,
        associateId: match.associateId,
      },
    });
    created.push(row);
    audit(req, 'garnishment.eiwo_received', 'EiwoDocument', row.id, { action: d.documentActionCode, caseIdentifier: d.caseIdentifier, matched: !!match.associateId });
  }
  res.status(201).json({ documents: created.map(shapeDoc) });
});

type StoredParsed = Omit<ParsedEiwo, 'employeeSsn'> & { employeeSsnLast4: string | null; problems: string[]; ssnSealed: string | null };

async function loadDoc(id: string) {
  const doc = await prisma.eiwoDocument.findFirst({ where: { id, tenantId: tenantIdForWrite() } });
  if (!doc) throw new HttpError(404, 'not_found', 'That e-IWO document was not found.');
  if (doc.status !== 'RECEIVED') throw new HttpError(409, 'already_answered', 'This document has already been answered.');
  const parsed = doc.parsed as unknown as StoredParsed;
  const ssn = parsed.ssnSealed ? decryptString(Buffer.from(parsed.ssnSealed, 'base64')) : null;
  return { doc, parsed, ssn };
}

garnishmentDeskRouter.post('/garnishment-desk/eiwo/:id/accept', PROCESS, async (req, res) => {
  const body = z
    .object({
      associateId: z.string().uuid().optional(),
      remitMethod: z.enum(['CHECK', 'ACH', 'EFT_SDU', 'PORTAL']).optional(),
    })
    .parse(req.body ?? {});
  const { doc, parsed, ssn } = await loadDoc(String(req.params.id));
  const associateId = body.associateId ?? doc.associateId;
  if (!associateId) throw new HttpError(400, 'choose_employee', 'Choose who this order is for, or reject it as not an employee.');
  const person = await prisma.associate.findFirst({ where: scopeWhere<Prisma.AssociateWhereInput>({ id: associateId, tenantId: tenantIdForWrite() }, scopeAssociatesIncludingFormer(req.user!)) });
  if (!person) throw new HttpError(404, 'not_found', 'That person was not found.');
  if (parsed.problems.length && (parsed.documentActionCode === 'ORG' || parsed.documentActionCode === 'AMD')) {
    throw new HttpError(409, 'eiwo_incomplete', `This document cannot become an order: ${parsed.problems.join(' ')} Reject it with reason U.`);
  }
  const fields = orderFieldsFrom({ ...parsed, employeeSsn: ssn });
  const existing = parsed.caseIdentifier
    ? await prisma.garnishment.findFirst({
        where: { associateId, deletedAt: null, caseNumber: parsed.caseIdentifier, ...(parsed.orderIdentifier ? { orderIdentifier: parsed.orderIdentifier } : {}) },
        orderBy: { createdAt: 'desc' },
      })
    : null;
  let garnishment: Garnishment;
  const common = {
    state: parsed.issuingState,
    fipsCode: parsed.fipsCode,
    orderIdentifier: parsed.orderIdentifier,
    remittanceIdentifier: parsed.remittanceIdentifier,
    agencyName: parsed.issuingAgency,
    remitTo: parsed.payeeName,
    remitAddress: parsed.payeeAddress,
    payeeKind: 'SDU',
    source: 'EIWO',
    receivedAt: doc.receivedAt,
  };
  switch (parsed.documentActionCode) {
    case 'ORG':
    case 'AMD': {
      const data = {
        ...common,
        currentSupport: fields.currentSupport,
        pastDueSupport: fields.pastDueSupport,
        medicalSupport: fields.medicalSupport,
        orderFrequency: fields.orderFrequency,
        arrearsOver12Weeks: fields.arrearsOver12Weeks,
        ...(body.remitMethod ? { remitMethod: body.remitMethod } : {}),
      };
      if (existing && parsed.documentActionCode === 'AMD') {
        garnishment = await prisma.garnishment.update({ where: { id: existing.id }, data: { ...data, status: 'ACTIVE' } });
      } else if (existing) {
        throw new HttpError(409, 'duplicate_order', 'An order with this case and order number is already on file. Reject it as a duplicate (reason D), or accept the amendment instead.');
      } else {
        garnishment = await prisma.garnishment.create({
          data: {
            ...data,
            tenantId: tenantIdForWrite(),
            associateId,
            kind: 'CHILD_SUPPORT',
            caseNumber: parsed.caseIdentifier,
            startDate: new Date(`${parsed.beginWithholdingBy ?? orgDateKey(new Date())}T00:00:00Z`),
            priority: 10,
            createdById: req.user!.id,
          },
        });
      }
      break;
    }
    case 'TRM': {
      if (!existing) throw new HttpError(409, 'no_order', 'There is no order on file with this case number to end. Reject it with reason U if it is not ours.');
      garnishment = await prisma.garnishment.update({ where: { id: existing.id }, data: { status: 'TERMINATED', endDate: new Date() } });
      break;
    }
    case 'LUM': {
      // A one-time withholding from a lump sum: capped at the amount the agency claims.
      garnishment = await prisma.garnishment.create({
        data: {
          ...common,
          tenantId: tenantIdForWrite(),
          associateId,
          kind: 'CHILD_SUPPORT',
          caseNumber: parsed.caseIdentifier,
          amountPerRun: parsed.lumpSumAmount,
          totalCap: parsed.lumpSumAmount,
          startDate: new Date(),
          priority: 5,
          notes: 'Lump-sum withholding from an e-IWO LUM instruction.',
          createdById: req.user!.id,
          ...(body.remitMethod ? { remitMethod: body.remitMethod } : {}),
        },
      });
      break;
    }
  }
  const employer = await employerFor(associateId);
  const ack = buildAcknowledgment(employer, [{ doc: parsed, ssn: ssn ?? (await fullSsn(associateId)), accepted: true }]);
  const updated = await prisma.eiwoDocument.update({
    where: { id: doc.id },
    data: { status: 'ACCEPTED', associateId, garnishmentId: garnishment.id, ackContent: encryptString(ack).toString('base64'), ackGeneratedAt: new Date(), decidedById: req.user!.id },
  });
  audit(req, 'garnishment.eiwo_accepted', 'EiwoDocument', doc.id, { garnishmentId: garnishment.id, action: parsed.documentActionCode });
  res.json({ document: shapeDoc(updated), garnishmentId: garnishment.id });
});

garnishmentDeskRouter.post('/garnishment-desk/eiwo/:id/reject', PROCESS, async (req, res) => {
  const body = z
    .object({
      reasonCode: z.enum(Object.keys(REJECT_REASONS) as [RejectReasonCode, ...RejectReasonCode[]]),
      reasonText: z.string().max(500).optional(),
      terminationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      newEmployerName: z.string().max(120).optional(),
      newEmployerAddress: z.string().max(300).optional(),
    })
    .parse(req.body ?? {});
  if (body.reasonCode === 'O' && !body.reasonText?.trim()) throw new HttpError(400, 'reason_required', 'Say why when the reason is “another reason”.');
  const { doc, parsed, ssn } = await loadDoc(String(req.params.id));
  const employer = await employerFor(doc.associateId);
  const ack = buildAcknowledgment(employer, [
    {
      doc: parsed,
      ssn,
      accepted: false,
      reasonCode: body.reasonCode,
      reasonText: body.reasonText ?? null,
      terminationDate: body.terminationDate ?? null,
      newEmployerName: body.newEmployerName ?? null,
      newEmployerAddress: body.newEmployerAddress ?? null,
    },
  ]);
  const updated = await prisma.eiwoDocument.update({
    where: { id: doc.id },
    data: {
      status: 'REJECTED',
      rejectReasonCode: body.reasonCode,
      rejectReason: body.reasonText ?? REJECT_REASONS[body.reasonCode],
      ackContent: encryptString(ack).toString('base64'),
      ackGeneratedAt: new Date(),
      decidedById: req.user!.id,
    },
  });
  audit(req, 'garnishment.eiwo_rejected', 'EiwoDocument', doc.id, { reasonCode: body.reasonCode });
  res.json({ document: shapeDoc(updated) });
});

garnishmentDeskRouter.get('/garnishment-desk/eiwo/:id/ack.xml', PROCESS, async (req, res) => {
  const doc = await prisma.eiwoDocument.findFirst({ where: { id: String(req.params.id), tenantId: tenantIdForWrite() } });
  if (!doc?.ackContent) throw new HttpError(404, 'not_found', 'This document has no acknowledgment yet.');
  audit(req, 'garnishment.eiwo_ack_downloaded', 'EiwoDocument', doc.id);
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="eiwo-ack-${doc.caseIdentifier ?? doc.id.slice(0, 8)}.xml"`);
  res.send(decryptString(Buffer.from(doc.ackContent, 'base64')));
});

/* ----- an order's e-IWO / state detail --------------------------------- */

const money = z.number().nonnegative().max(1_000_000).nullable().optional();
const DetailSchema = z.object({
  state: z.string().length(2).toUpperCase().nullable().optional(),
  fipsCode: z.string().regex(/^\d{5,7}$/).nullable().optional(),
  orderIdentifier: z.string().max(40).nullable().optional(),
  remittanceIdentifier: z.string().max(40).nullable().optional(),
  orderFrequency: z.enum(['WEEKLY', 'BIWEEKLY', 'SEMIMONTHLY', 'MONTHLY']).nullable().optional(),
  currentSupport: money,
  pastDueSupport: money,
  medicalSupport: money,
  arrearsOver12Weeks: z.boolean().optional(),
  supportsSecondFamily: z.boolean().optional(),
  adminFee: money,
  totalCap: money,
  levyFilingStatus: z.enum(['SINGLE', 'MARRIED_FILING_JOINTLY', 'MARRIED_FILING_SEPARATELY', 'HEAD_OF_HOUSEHOLD', 'QUALIFYING_SURVIVING_SPOUSE']).nullable().optional(),
  levyExemptions: z.number().int().min(0).max(30).nullable().optional(),
  levyAdditionalStandard: z.number().int().min(0).max(4).optional(),
  levyTaxYear: z.number().int().min(2018).max(2100).nullable().optional(),
  payeeKind: z.enum(['SDU', 'IRS', 'CREDITOR', 'COURT', 'TRUSTEE', 'OTHER']).nullable().optional(),
  remitMethod: z.enum(['CHECK', 'ACH', 'EFT_SDU', 'PORTAL']).optional(),
  lumpSumReporting: z.boolean().optional(),
});

async function orderInReach(req: Request, id: string) {
  const g = await prisma.garnishment.findFirst({
    where: scopeWhere<Prisma.GarnishmentWhereInput>({ id, tenantId: tenantIdForWrite(), deletedAt: null }, { associate: scopeAssociatesIncludingFormer(req.user!) }),
    include: { associate: { select: { id: true, firstName: true, lastName: true, addressLine1: true, city: true, state: true, zip: true, phone: true } } },
  });
  if (!g) throw new HttpError(404, 'not_found', 'That order was not found.');
  return g;
}

garnishmentDeskRouter.post('/garnishment-desk/orders/:id/details', PROCESS, async (req, res) => {
  const input = DetailSchema.parse(req.body ?? {});
  const g = await orderInReach(req, String(req.params.id));
  if (input.remitMethod === 'EFT_SDU' && g.kind !== 'CHILD_SUPPORT') throw new HttpError(400, 'sdu_support_only', 'Only support orders are paid to a State Disbursement Unit.');
  if (input.remitMethod === 'ACH' && g.kind === 'TAX_LEVY') throw new HttpError(400, 'levy_by_check', 'The IRS takes levy payments by check with Part 3 of the levy, not by ACH.');
  const data: Prisma.GarnishmentUpdateInput = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    (data as Record<string, unknown>)[k] = v;
  }
  const updated = await prisma.garnishment.update({ where: { id: g.id }, data });
  audit(req, 'garnishment.details_updated', 'Garnishment', g.id, { fields: Object.keys(data) });
  res.json({ id: updated.id });
});

/* ----- payee bank details: a second person approves -------------------- */

garnishmentDeskRouter.post('/garnishment-desk/orders/:id/payee-bank', PROCESS, async (req, res) => {
  const { routingNumber, accountNumber } = z.object({ routingNumber: z.string().regex(/^\d{9}$/), accountNumber: z.string().min(4).max(17) }).parse(req.body ?? {});
  const g = await orderInReach(req, String(req.params.id));
  const sealed = sealPayeeBank(routingNumber, accountNumber);
  const approval = await createApprovalRequest(prisma, {
    kind: 'GARNISHMENT_PAYEE_BANK',
    subjectType: 'Garnishment',
    subjectId: g.id,
    title: `New bank account for ${g.remitTo ?? g.agencyName ?? 'a garnishment payee'}`,
    summary: `${g.associate.firstName} ${g.associate.lastName}, case ${g.caseNumber ?? '—'}: remittances would go to the account ending ${sealed.payeeAccountLast4} (routing ${routingNumber}).`,
    proposed: { garnishmentId: g.id, ...sealed, routingNumber },
    before: { payeeAccountLast4: g.payeeAccountLast4 },
    requesterUserId: req.user!.id,
    approver: { capability: 'process:payroll' },
    associateId: g.associateId,
  });
  audit(req, 'garnishment.payee_bank_requested', 'Garnishment', g.id, { approvalId: approval.id, last4: sealed.payeeAccountLast4 });
  res.status(202).json(pendingResponse(approval));
});

registerApplyHandler('GARNISHMENT_PAYEE_BANK', async (db, row, decider) => {
  const p = row.proposed as { garnishmentId: string; payeeRoutingEnc: string; payeeAccountEnc: string; payeeAccountLast4: string };
  const g = await db.garnishment.findFirst({ where: { id: p.garnishmentId, deletedAt: null } });
  if (!g) return;
  await db.garnishment.update({
    where: { id: g.id },
    data: { payeeRoutingEnc: p.payeeRoutingEnc, payeeAccountEnc: p.payeeAccountEnc, payeeAccountLast4: p.payeeAccountLast4 },
  });
  enqueueAudit(
    { actorUserId: decider.id, action: 'garnishment.payee_bank_changed', entityType: 'Garnishment', entityId: g.id, metadata: { approvalId: row.id, last4: p.payeeAccountLast4 } },
    'garnishmentDesk',
  );
});

/* ----- termination and lump-sum notices -------------------------------- */

const NoticeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('TERMINATION'),
    terminationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    lastPayDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    finalPaymentAmount: z.number().nonnegative().nullable().optional(),
    newEmployerName: z.string().max(120).nullable().optional(),
    newEmployerAddress: z.string().max(300).nullable().optional(),
  }),
  z.object({
    kind: z.literal('LUMP_SUM'),
    paymentType: z.enum(['BONUS', 'COMMISSION', 'SEVERANCE', 'INSURANCE', 'OTHER']),
    amount: z.number().positive(),
    expectedPaymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
]);

function shapeNotice(n: Prisma.EiwoNoticeGetPayload<object>) {
  return { id: n.id, garnishmentId: n.garnishmentId, kind: n.kind, payload: n.payload, createdAt: n.createdAt.toISOString(), sentAt: n.sentAt?.toISOString() ?? null, reference: n.reference };
}

garnishmentDeskRouter.get('/garnishment-desk/orders/:id/notices', PROCESS, async (req, res) => {
  const g = await orderInReach(req, String(req.params.id));
  const rows = await prisma.eiwoNotice.findMany({ where: { garnishmentId: g.id, tenantId: tenantIdForWrite() }, orderBy: { createdAt: 'desc' } });
  res.json({ notices: rows.map(shapeNotice) });
});

garnishmentDeskRouter.post('/garnishment-desk/orders/:id/notices', PROCESS, async (req, res) => {
  const input = NoticeSchema.parse(req.body ?? {});
  const g = await orderInReach(req, String(req.params.id));
  if (g.kind !== 'CHILD_SUPPORT') throw new HttpError(400, 'support_only', 'Termination and lump-sum notices answer income withholding orders for support.');
  const ref: OrderRef = {
    caseIdentifier: g.caseNumber,
    orderIdentifier: g.orderIdentifier,
    remittanceIdentifier: g.remittanceIdentifier,
    fipsCode: g.fipsCode,
    employeeFirstName: g.associate.firstName,
    employeeLastName: g.associate.lastName,
    ssn: await fullSsn(g.associateId),
  };
  const employer = await employerFor(g.associateId);
  const address = [g.associate.addressLine1, [g.associate.city, g.associate.state, g.associate.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ') || null;
  const content =
    input.kind === 'TERMINATION'
      ? buildTerminationNotice(employer, {
          order: ref,
          terminationDate: input.terminationDate,
          lastPayDate: input.lastPayDate ?? null,
          finalPaymentAmount: input.finalPaymentAmount ?? null,
          employeeLastKnownAddress: address,
          employeePhone: g.associate.phone,
          newEmployerName: input.newEmployerName ?? null,
          newEmployerAddress: input.newEmployerAddress ?? null,
        })
      : buildLumpSumNotice(employer, { order: ref, paymentType: input.paymentType, amount: input.amount, expectedPaymentDate: input.expectedPaymentDate });
  const notice = await prisma.$transaction(async (tx) => {
    const n = await tx.eiwoNotice.create({
      data: {
        tenantId: tenantIdForWrite(),
        garnishmentId: g.id,
        kind: input.kind,
        content: encryptString(content).toString('base64'),
        payload: input as unknown as Prisma.InputJsonObject,
        createdById: req.user!.id,
      },
    });
    if (input.kind === 'TERMINATION') {
      await tx.garnishment.update({ where: { id: g.id }, data: { status: 'TERMINATED', endDate: new Date(`${input.terminationDate}T00:00:00Z`) } });
    }
    return n;
  });
  audit(req, `garnishment.notice_${input.kind.toLowerCase()}`, 'Garnishment', g.id, { noticeId: notice.id });
  res.status(201).json({ notice: shapeNotice(notice) });
});

garnishmentDeskRouter.get('/garnishment-desk/notices/:id/file.xml', PROCESS, async (req, res) => {
  const n = await prisma.eiwoNotice.findFirst({ where: { id: String(req.params.id), tenantId: tenantIdForWrite() } });
  if (!n) throw new HttpError(404, 'not_found', 'That notice was not found.');
  await orderInReach(req, n.garnishmentId);
  audit(req, 'garnishment.notice_downloaded', 'EiwoNotice', n.id);
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="eiwo-${n.kind.toLowerCase()}-${n.id.slice(0, 8)}.xml"`);
  res.send(decryptString(Buffer.from(n.content, 'base64')));
});

garnishmentDeskRouter.post('/garnishment-desk/notices/:id/sent', PROCESS, async (req, res) => {
  const { reference } = z.object({ reference: z.string().max(80).optional() }).parse(req.body ?? {});
  const n = await prisma.eiwoNotice.findFirst({ where: { id: String(req.params.id), tenantId: tenantIdForWrite() } });
  if (!n) throw new HttpError(404, 'not_found', 'That notice was not found.');
  await orderInReach(req, n.garnishmentId);
  const updated = await prisma.eiwoNotice.update({ where: { id: n.id }, data: { sentAt: new Date(), reference: reference ?? null } });
  audit(req, 'garnishment.notice_sent', 'EiwoNotice', n.id, { reference });
  res.json({ notice: shapeNotice(updated) });
});

/* ----- state rules ----------------------------------------------------- */

function shapeRule(r: Prisma.GarnishmentStateRuleGetPayload<object>) {
  return {
    state: r.state,
    allocationMethod: r.allocationMethod,
    supportMaxPercent: num(r.supportMaxPercent),
    creditorMaxPercent: num(r.creditorMaxPercent),
    adminFeeMax: num(r.adminFeeMax),
    adminFeeFrequency: r.adminFeeFrequency,
    notes: r.notes,
    updatedAt: r.updatedAt.toISOString(),
  };
}

garnishmentDeskRouter.get('/garnishment-desk/state-rules', PROCESS, async (_req, res) => {
  const rows = await prisma.garnishmentStateRule.findMany({ where: { tenantId: tenantIdForWrite() }, orderBy: { state: 'asc' } });
  res.json({ rules: rows.map(shapeRule) });
});

const RuleSchema = z.object({
  allocationMethod: z.enum(['PRO_RATA', 'FIRST_IN_TIME']),
  supportMaxPercent: z.number().min(0).max(0.65).nullable().optional(),
  creditorMaxPercent: z.number().min(0).max(0.25).nullable().optional(),
  adminFeeMax: z.number().min(0).max(100).nullable().optional(),
  adminFeeFrequency: z.enum(['PER_PAYMENT', 'MONTHLY', 'ONE_TIME']).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
});

garnishmentDeskRouter.put('/garnishment-desk/state-rules/:state', PROCESS, async (req, res) => {
  refuseNarrowed(req.user!);
  const state = z.string().regex(/^[A-Za-z]{2}$/).parse(req.params.state).toUpperCase();
  const input = RuleSchema.parse(req.body ?? {});
  const tenantId = tenantIdForWrite();
  const data = {
    allocationMethod: input.allocationMethod,
    supportMaxPercent: input.supportMaxPercent ?? null,
    creditorMaxPercent: input.creditorMaxPercent ?? null,
    adminFeeMax: input.adminFeeMax ?? null,
    adminFeeFrequency: input.adminFeeFrequency ?? null,
    notes: input.notes ?? null,
    updatedById: req.user!.id,
  };
  const existing = await prisma.garnishmentStateRule.findFirst({ where: { tenantId, state } });
  const row = existing
    ? await prisma.garnishmentStateRule.update({ where: { id: existing.id }, data })
    : await prisma.garnishmentStateRule.create({ data: { ...data, tenantId, state } });
  audit(req, 'garnishment.state_rule_saved', 'GarnishmentStateRule', row.id, { state, ...input });
  res.json({ rule: shapeRule(row) });
});

garnishmentDeskRouter.delete('/garnishment-desk/state-rules/:state', PROCESS, async (req, res) => {
  refuseNarrowed(req.user!);
  const state = z.string().regex(/^[A-Za-z]{2}$/).parse(req.params.state).toUpperCase();
  const { count } = await prisma.garnishmentStateRule.deleteMany({ where: { tenantId: tenantIdForWrite(), state } });
  if (!count) throw new HttpError(404, 'not_found', 'There is no rule for that state.');
  audit(req, 'garnishment.state_rule_removed', 'GarnishmentStateRule', state);
  res.status(204).end();
});

/* ----- IRS Publication 1494 figures ------------------------------------ */

function shapeLevy(r: Prisma.LevyExemptParameterGetPayload<object>) {
  return {
    id: r.id,
    taxYear: r.taxYear,
    filingStatus: r.filingStatus,
    standardDeduction: Number(r.standardDeduction),
    additionalStandardDeduction: Number(r.additionalStandardDeduction),
    exemptionAmount: Number(r.exemptionAmount),
    source: r.source,
    updatedAt: r.updatedAt.toISOString(),
  };
}

garnishmentDeskRouter.get('/garnishment-desk/levy-parameters', PROCESS, async (_req, res) => {
  const rows = await prisma.levyExemptParameter.findMany({ where: { tenantId: tenantIdForWrite() }, orderBy: [{ taxYear: 'desc' }, { filingStatus: 'asc' }] });
  res.json({ parameters: rows.map(shapeLevy) });
});

const LevySchema = z.object({
  taxYear: z.number().int().min(2018).max(2100),
  filingStatus: z.enum(['SINGLE', 'MARRIED_FILING_JOINTLY', 'MARRIED_FILING_SEPARATELY', 'HEAD_OF_HOUSEHOLD', 'QUALIFYING_SURVIVING_SPOUSE']),
  standardDeduction: z.number().positive().max(100_000),
  additionalStandardDeduction: z.number().min(0).max(10_000),
  exemptionAmount: z.number().min(0).max(20_000),
  source: z.string().max(200).nullable().optional(),
});

garnishmentDeskRouter.put('/garnishment-desk/levy-parameters', PROCESS, async (req, res) => {
  refuseNarrowed(req.user!);
  const input = LevySchema.parse(req.body ?? {});
  const tenantId = tenantIdForWrite();
  const data = {
    standardDeduction: input.standardDeduction,
    additionalStandardDeduction: input.additionalStandardDeduction,
    exemptionAmount: input.exemptionAmount,
    source: input.source ?? null,
    updatedById: req.user!.id,
  };
  const existing = await prisma.levyExemptParameter.findFirst({ where: { tenantId, taxYear: input.taxYear, filingStatus: input.filingStatus } });
  const row = existing
    ? await prisma.levyExemptParameter.update({ where: { id: existing.id }, data })
    : await prisma.levyExemptParameter.create({ data: { ...data, tenantId, taxYear: input.taxYear, filingStatus: input.filingStatus } });
  audit(req, 'garnishment.levy_parameter_saved', 'LevyExemptParameter', row.id, input);
  res.json({ parameter: shapeLevy(row) });
});

garnishmentDeskRouter.delete('/garnishment-desk/levy-parameters/:id', PROCESS, async (req, res) => {
  refuseNarrowed(req.user!);
  const { count } = await prisma.levyExemptParameter.deleteMany({ where: { id: String(req.params.id), tenantId: tenantIdForWrite() } });
  if (!count) throw new HttpError(404, 'not_found', 'That figure was not found.');
  audit(req, 'garnishment.levy_parameter_removed', 'LevyExemptParameter', String(req.params.id));
  res.status(204).end();
});

/* ----- electronic remittance ------------------------------------------- */

garnishmentDeskRouter.post('/garnishment-desk/remittances/send', PROCESS, async (req, res) => {
  refuseNarrowed(req.user!);
  const { remittanceIds, effectiveDate } = z
    .object({ remittanceIds: z.array(z.string().uuid()).min(1).max(200), effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
    .parse(req.body ?? {});
  await loadTenantHolidays(prisma);
  const outcome = await remitElectronically(prisma, remittanceIds, {
    effectiveDate,
    actorUserId: req.user!.id,
    payDateOf: (runId) => payDateFor(prisma, runId),
  });
  audit(req, 'garnishment.remitted_electronically', 'AchFile', outcome.achFileId, { remittances: outcome.sent });
  res.json(outcome);
});

garnishmentDeskRouter.get('/garnishment-desk/remittances/:id/advice.txt', PROCESS, async (req, res) => {
  const r = await prisma.garnishmentRemittance.findFirst({ where: { id: String(req.params.id), tenantId: tenantIdForWrite() } });
  if (!r?.advice) throw new HttpError(404, 'not_found', 'This remittance has no electronic advice; use the printable advice.');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="remittance-advice-${r.id.slice(0, 8)}.txt"`);
  res.send(r.advice);
});
