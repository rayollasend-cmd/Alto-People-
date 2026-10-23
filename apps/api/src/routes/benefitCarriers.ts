import { Router, type Request } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { enqueueAudit } from '../lib/audit.js';
import { decryptString, encryptString } from '../lib/crypto.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { assertBulkPiiExporter } from '../lib/bulkPiiExport.js';
import { isInternallyScoped } from '../lib/scope.js';
import {
  build834,
  coverageLevelFor,
  INSURANCE_LINE_BY_KIND,
  REASON_BY_QLE,
  RELATIONSHIP_CODES,
  type Edi834Coverage,
  type Edi834Member,
  type MaintenanceType,
} from '../lib/edi834.js';
import { deliverFile, DeliveryError, describeConnection, openConnection, sealConnection, type Transport } from '../lib/fileDelivery.js';
import type { SessionUser } from '../types/express.js';

/**
 * Benefit carrier feeds: a carrier connection per insurer, the plans it
 * covers, and EDI 834 enrollment files (full and change) built from
 * benefit enrollments, covered dependents and life events — with a send
 * log. Gate: process:payroll (the benefits admin capability); downloading
 * an 834 (every member's SSN) is a bulk PII export.
 */
export const benefitCarriersRouter = Router();
const PROCESS = requireCapability('process:payroll');
const EXPORT_PII = requireCapability('export:payroll-pii');

const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

function audit(req: Request, action: string, entityType: string, entityId: string, metadata: Record<string, unknown> = {}): void {
  enqueueAudit({ actorUserId: req.user!.id, action, entityType, entityId, metadata: metadata as Prisma.InputJsonObject }, 'benefitCarriers');
}

function refuseNarrowed(user: SessionUser): void {
  if (isInternallyScoped(user)) throw new HttpError(403, 'company_wide', 'Carrier feeds cover the whole company; ask a benefits lead without a site limit.');
}

async function carrierOr404(id: string) {
  const c = await prisma.benefitCarrier.findFirst({ where: { id, tenantId: tenantIdForWrite() } });
  if (!c) throw new HttpError(404, 'not_found', 'That carrier was not found.');
  return c;
}

function shapeCarrier(c: Prisma.BenefitCarrierGetPayload<object>, extra: { plans?: Array<{ id: string; name: string; kind: string; insuranceLineCode: string | null; carrierPlanCode: string | null }>; lastFile?: { createdAt: Date; mode: string; status: string } | null } = {}) {
  return {
    id: c.id,
    name: c.name,
    receiverId: c.receiverId,
    receiverQualifier: c.receiverQualifier,
    senderId: c.senderId,
    senderQualifier: c.senderQualifier,
    sponsorTaxId: c.sponsorTaxId,
    policyNumber: c.policyNumber,
    usageIndicator: c.usageIndicator,
    transport: c.transport,
    connection: describeConnection(c.connectionEnc),
    active: c.active,
    plans: extra.plans ?? [],
    lastFile: extra.lastFile ? { createdAt: extra.lastFile.createdAt.toISOString(), mode: extra.lastFile.mode, status: extra.lastFile.status } : null,
  };
}

/**
 * How each feed is doing, from the data the send log holds:
 *   people          — everyone the next full file would carry (enrolled in
 *                     one of the carrier's plans, effective within 90 days,
 *                     not ended before today: the full file's own rule);
 *   changesWaiting  — people whose enrollment in those plans changed since
 *                     the last file made (what the next change file
 *                     carries); null before the first file — that's a full;
 *   lastFile        — the newest file: made when, full or changes, its
 *                     control number, how many members, and whether it was
 *                     delivered. Carriers' 999/TA1 acknowledgments aren't
 *                     received here, so delivery is as far as it goes.
 */
export interface FeedHealth {
  people: number;
  changesWaiting: number | null;
  lastFile: { createdAt: string; mode: string; status: string; controlNumber: number; memberCount: number; sentAt: string | null; error: string | null } | null;
}

export async function feedHealthFor(carrierIds: string[], now: Date = new Date()): Promise<Map<string, FeedHealth>> {
  const tenantId = tenantIdForWrite();
  const out = new Map<string, FeedHealth>();
  if (carrierIds.length === 0) return out;
  const today = new Date(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  const [plans, newest, baselines] = await Promise.all([
    prisma.benefitsPlan.findMany({ where: { tenantId, carrierId: { in: carrierIds } }, select: { id: true, carrierId: true } }),
    prisma.edi834File.findMany({ where: { tenantId, carrierId: { in: carrierIds } }, orderBy: { createdAt: 'desc' }, distinct: ['carrierId'] }),
    // The change file's own baseline: the last file made (a failed send still counts as made).
    prisma.edi834File.findMany({ where: { tenantId, carrierId: { in: carrierIds }, status: { in: ['GENERATED', 'SENT'] } }, orderBy: { createdAt: 'desc' }, distinct: ['carrierId'], select: { carrierId: true, createdAt: true } }),
  ]);
  const enrolled = plans.length
    ? await prisma.benefitsEnrollment.findMany({
        where: { tenantId, planId: { in: plans.map((p) => p.id) }, effectiveDate: { lte: new Date(today.getTime() + 90 * 86_400_000) }, OR: [{ terminationDate: null }, { terminationDate: { gte: today } }] },
        select: { planId: true, associateId: true },
      })
    : [];
  for (const id of carrierIds) {
    const planIds = new Set(plans.filter((p) => p.carrierId === id).map((p) => p.id));
    const f = newest.find((x) => x.carrierId === id);
    const since = baselines.find((x) => x.carrierId === id)?.createdAt ?? null;
    let changesWaiting: number | null = null;
    if (since) {
      const changed = planIds.size
        ? await prisma.benefitsEnrollment.findMany({ where: { tenantId, planId: { in: [...planIds] }, updatedAt: { gt: since } }, select: { associateId: true }, distinct: ['associateId'] })
        : [];
      changesWaiting = changed.length;
    }
    out.set(id, {
      people: new Set(enrolled.filter((e) => planIds.has(e.planId)).map((e) => e.associateId)).size,
      changesWaiting,
      lastFile: f ? { createdAt: f.createdAt.toISOString(), mode: f.mode, status: f.status, controlNumber: f.controlNumber, memberCount: f.memberCount, sentAt: f.sentAt?.toISOString() ?? null, error: f.error } : null,
    });
  }
  return out;
}

benefitCarriersRouter.get('/benefit-carriers', PROCESS, async (_req, res) => {
  const tenantId = tenantIdForWrite();
  const [carriers, plans, lastFiles] = await Promise.all([
    prisma.benefitCarrier.findMany({ where: { tenantId }, orderBy: { name: 'asc' } }),
    prisma.benefitsPlan.findMany({ where: { tenantId, isActive: true }, select: { id: true, name: true, kind: true, carrierId: true, insuranceLineCode: true, carrierPlanCode: true }, orderBy: { name: 'asc' } }),
    prisma.edi834File.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, distinct: ['carrierId'], select: { carrierId: true, createdAt: true, mode: true, status: true } }),
  ]);
  const health = await feedHealthFor(carriers.map((c) => c.id));
  res.json({
    carriers: carriers.map((c) => ({
      ...shapeCarrier(c, {
        plans: plans.filter((p) => p.carrierId === c.id),
        lastFile: lastFiles.find((f) => f.carrierId === c.id) ?? null,
      }),
      health: health.get(c.id) ?? { people: 0, changesWaiting: null, lastFile: null },
    })),
    plans: plans.map((p) => ({ ...p, defaultLine: INSURANCE_LINE_BY_KIND[p.kind] ?? null })),
  });
});

const CarrierSchema = z.object({
  name: z.string().trim().min(2).max(120),
  receiverId: z.string().trim().min(2).max(15),
  receiverQualifier: z.string().trim().length(2).default('ZZ'),
  senderId: z.string().trim().min(2).max(15),
  senderQualifier: z.string().trim().length(2).default('ZZ'),
  sponsorTaxId: z.string().regex(/^\d{9}$/).nullable().optional(),
  policyNumber: z.string().max(50).nullable().optional(),
  usageIndicator: z.enum(['T', 'P']),
  transport: z.enum(['DOWNLOAD', 'SFTP', 'HTTPS']),
  active: z.boolean().optional(),
});

benefitCarriersRouter.post('/benefit-carriers', PROCESS, async (req, res) => {
  refuseNarrowed(req.user!);
  const input = CarrierSchema.parse(req.body ?? {});
  const c = await prisma.benefitCarrier.create({ data: { ...input, sponsorTaxId: input.sponsorTaxId ?? null, policyNumber: input.policyNumber ?? null, tenantId: tenantIdForWrite() } });
  audit(req, 'benefits.carrier_created', 'BenefitCarrier', c.id, { name: c.name });
  res.status(201).json({ carrier: shapeCarrier(c) });
});

benefitCarriersRouter.put('/benefit-carriers/:id', PROCESS, async (req, res) => {
  refuseNarrowed(req.user!);
  const c = await carrierOr404(String(req.params.id));
  const input = CarrierSchema.parse(req.body ?? {});
  if (input.usageIndicator === 'P' && c.usageIndicator === 'T') {
    const tested = await prisma.edi834File.count({ where: { carrierId: c.id } });
    if (!tested) throw new HttpError(409, 'test_first', 'Send the carrier a test file before switching to production.');
  }
  const updated = await prisma.benefitCarrier.update({ where: { id: c.id }, data: { ...input, sponsorTaxId: input.sponsorTaxId ?? null, policyNumber: input.policyNumber ?? null } });
  audit(req, 'benefits.carrier_updated', 'BenefitCarrier', c.id, { name: updated.name, usage: updated.usageIndicator });
  res.json({ carrier: shapeCarrier(updated) });
});

benefitCarriersRouter.put('/benefit-carriers/:id/connection', PROCESS, async (req, res) => {
  refuseNarrowed(req.user!);
  const c = await carrierOr404(String(req.params.id));
  const input = z
    .object({
      baseUrl: z.string().url().startsWith('https://').optional(),
      apiKey: z.string().max(500).optional(),
      host: z.string().max(200).optional(),
      port: z.number().int().min(1).max(65535).optional(),
      username: z.string().max(120).optional(),
      password: z.string().max(500).optional(),
      privateKey: z.string().max(10_000).optional(),
      remoteDir: z.string().max(300).optional(),
    })
    .parse(req.body ?? {});
  const next = { ...openConnection(c.connectionEnc), ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined && v !== '')) };
  const updated = await prisma.benefitCarrier.update({ where: { id: c.id }, data: { connectionEnc: sealConnection(next) } });
  audit(req, 'benefits.carrier_connection_saved', 'BenefitCarrier', c.id, { host: next.host ?? null });
  res.json({ connection: describeConnection(updated.connectionEnc) });
});

benefitCarriersRouter.put('/benefit-carriers/:id/plans', PROCESS, async (req, res) => {
  refuseNarrowed(req.user!);
  const c = await carrierOr404(String(req.params.id));
  const { plans } = z
    .object({
      plans: z.array(z.object({ planId: z.string().uuid(), insuranceLineCode: z.string().regex(/^[A-Z]{2,3}$/).nullable().optional(), carrierPlanCode: z.string().max(50).nullable().optional() })).max(100),
    })
    .parse(req.body ?? {});
  const tenantId = tenantIdForWrite();
  const found = await prisma.benefitsPlan.findMany({ where: { tenantId, id: { in: plans.map((p) => p.planId) } }, select: { id: true, kind: true } });
  if (found.length !== plans.length) throw new HttpError(404, 'not_found', 'One or more plans were not found.');
  const kindOf = new Map(found.map((p) => [p.id, p.kind]));
  for (const p of plans) {
    if (!p.insuranceLineCode && !INSURANCE_LINE_BY_KIND[kindOf.get(p.planId)!]) {
      throw new HttpError(400, 'line_required', 'Accounts like HSA and FSA have no insurance line of their own; give one or leave the plan off this carrier.');
    }
  }
  await prisma.$transaction([
    prisma.benefitsPlan.updateMany({ where: { tenantId, carrierId: c.id, id: { notIn: plans.map((p) => p.planId) } }, data: { carrierId: null } }),
    ...plans.map((p) => prisma.benefitsPlan.update({ where: { id: p.planId }, data: { carrierId: c.id, insuranceLineCode: p.insuranceLineCode ?? null, carrierPlanCode: p.carrierPlanCode ?? null } })),
  ]);
  audit(req, 'benefits.carrier_plans_linked', 'BenefitCarrier', c.id, { plans: plans.length });
  res.json({ ok: true });
});

/* ----- the 834 --------------------------------------------------------- */

interface BuildResult {
  members: Edi834Member[];
  excluded: string[];
}

/** Build the member loops for one carrier. */
export async function membersFor(carrierId: string, mode: 'FULL' | 'CHANGE', since: Date | null, today: Date): Promise<BuildResult> {
  const tenantId = tenantIdForWrite();
  const todayDate = new Date(`${today.toISOString().slice(0, 10)}T00:00:00Z`);
  const plans = await prisma.benefitsPlan.findMany({ where: { tenantId, carrierId }, select: { id: true, kind: true, insuranceLineCode: true, carrierPlanCode: true } });
  const planById = new Map(plans.map((p) => [p.id, p]));
  const enrollmentWhere: Prisma.BenefitsEnrollmentWhereInput =
    mode === 'FULL' || !since
      ? { planId: { in: plans.map((p) => p.id) }, effectiveDate: { lte: new Date(todayDate.getTime() + 90 * 86_400_000) }, OR: [{ terminationDate: null }, { terminationDate: { gte: todayDate } }] }
      : { planId: { in: plans.map((p) => p.id) }, updatedAt: { gt: since } };
  const enrollments = await prisma.benefitsEnrollment.findMany({
    where: { tenantId, ...enrollmentWhere },
    include: {
      associate: {
        select: { id: true, firstName: true, lastName: true, dob: true, hireDate: true, separatedAt: true, phone: true, addressLine1: true, addressLine2: true, city: true, state: true, zip: true, w4Submission: { select: { ssnEncrypted: true } } },
      },
    },
    orderBy: [{ associateId: 'asc' }, { effectiveDate: 'asc' }],
  });
  const depIds = [...new Set(enrollments.flatMap((e) => e.coveredDependentIds))];
  const dependents = depIds.length ? await prisma.dependent.findMany({ where: { tenantId, id: { in: depIds } } }) : [];
  const depById = new Map(dependents.map((d) => [d.id, d]));
  const qles = await prisma.qualifyingLifeEvent.findMany({ where: { tenantId, status: 'APPROVED', associateId: { in: [...new Set(enrollments.map((e) => e.associateId))] } }, orderBy: { eventDate: 'desc' } });

  const maintenanceOf = (e: (typeof enrollments)[number]): MaintenanceType => {
    if (mode === 'FULL' || !since) return mode === 'FULL' ? '030' : '021';
    if (e.terminationDate && e.terminationDate <= new Date(todayDate.getTime() + 90 * 86_400_000)) return '024';
    if (e.createdAt > since) return '021';
    return '001';
  };
  const reasonOf = (associateId: string, maint: MaintenanceType, effective: Date): string => {
    if (maint === '030') return 'XN';
    if (maint === '024') return '07';
    const q = qles.find((x) => x.associateId === associateId && Math.abs(effective.getTime() - x.eventDate.getTime()) <= 60 * 86_400_000);
    if (q) return REASON_BY_QLE[q.kind] ?? 'AI';
    return maint === '021' ? '28' : 'AI';
  };

  const byPerson = new Map<string, typeof enrollments>();
  for (const e of enrollments) byPerson.set(e.associateId, [...(byPerson.get(e.associateId) ?? []), e]);
  const members: Edi834Member[] = [];
  const excluded: string[] = [];
  for (const [, list] of byPerson) {
    const a = list[0]!.associate;
    const ssn = a.w4Submission?.ssnEncrypted ? decryptString(a.w4Submission.ssnEncrypted) : null;
    if (!ssn) {
      excluded.push(`${a.firstName} ${a.lastName}: no SSN on file (collect the W-4)`);
      continue;
    }
    const coverage = (e: (typeof list)[number], maint: MaintenanceType, level: string): Edi834Coverage => {
      const plan = planById.get(e.planId)!;
      return {
        maintenance: maint,
        insuranceLine: plan.insuranceLineCode ?? INSURANCE_LINE_BY_KIND[plan.kind] ?? 'HLT',
        planCode: plan.carrierPlanCode,
        coverageLevel: level,
        begin: ymd(e.effectiveDate)!,
        end: maint === '024' || e.terminationDate ? ymd(e.terminationDate) : null,
      };
    };
    const subCoverages = list.map((e) => {
      const deps = e.coveredDependentIds.map((id) => depById.get(id)).filter((d): d is NonNullable<typeof d> => !!d && !d.deletedAt);
      const level = e.coverageLevel && e.coverageLevel !== 'EMP' ? e.coverageLevel : coverageLevelFor(deps);
      return coverage(e, maintenanceOf(e), level);
    });
    const maints = new Set(subCoverages.map((c) => c.maintenance));
    const subMaint: MaintenanceType = maints.size === 1 ? [...maints][0]! : '001';
    const firstEffective = list[0]!.effectiveDate;
    members.push({
      subscriber: true,
      relationship: RELATIONSHIP_CODES.SELF!,
      maintenance: subMaint,
      reason: reasonOf(a.id, subMaint, firstEffective),
      employmentStatus: a.separatedAt ? 'TE' : 'FT',
      subscriberId: ssn,
      lastName: a.lastName,
      firstName: a.firstName,
      ssn,
      dob: ymd(a.dob),
      gender: 'U',
      phone: a.phone,
      address: { line1: a.addressLine1, line2: a.addressLine2, city: a.city, state: a.state, zip: a.zip },
      hireDate: ymd(a.hireDate),
      coverages: subCoverages,
    });
    // Each covered dependent, with the coverages that list them.
    const depCoverages = new Map<string, Edi834Coverage[]>();
    list.forEach((e, i) => {
      for (const id of e.coveredDependentIds) {
        const d = depById.get(id);
        if (!d) continue;
        const cov = { ...subCoverages[i]!, maintenance: d.deletedAt && mode !== 'FULL' ? ('024' as MaintenanceType) : subCoverages[i]!.maintenance };
        depCoverages.set(id, [...(depCoverages.get(id) ?? []), cov]);
      }
    });
    for (const [id, covs] of depCoverages) {
      const d = depById.get(id)!;
      if (d.deletedAt && mode === 'FULL') continue;
      const dm = new Set(covs.map((c) => c.maintenance));
      const maint: MaintenanceType = dm.size === 1 ? [...dm][0]! : '001';
      members.push({
        subscriber: false,
        relationship: RELATIONSHIP_CODES[d.relation] ?? 'G8',
        maintenance: maint,
        reason: reasonOf(a.id, maint, firstEffective),
        employmentStatus: null,
        subscriberId: ssn,
        lastName: d.lastName,
        firstName: d.firstName,
        // We keep only a dependent's last four; carriers match dependents by name and birth date.
        ssn: null,
        dob: ymd(d.dob),
        gender: 'U',
        phone: null,
        address: null,
        hireDate: null,
        coverages: covs,
      });
    }
  }
  return { members, excluded };
}

function shapeFile(f: Prisma.Edi834FileGetPayload<object>) {
  return { id: f.id, mode: f.mode, controlNumber: f.controlNumber, memberCount: f.memberCount, status: f.status, error: f.error, sentAt: f.sentAt?.toISOString() ?? null, createdAt: f.createdAt.toISOString() };
}

benefitCarriersRouter.post('/benefit-carriers/:id/files', PROCESS, async (req, res) => {
  refuseNarrowed(req.user!);
  const c = await carrierOr404(String(req.params.id));
  const { mode } = z.object({ mode: z.enum(['FULL', 'CHANGE']) }).parse(req.body ?? {});
  const tenantId = tenantIdForWrite();
  const sponsor = await prisma.employerOrganization.findFirst({ where: { tenantId, isDefault: true } });
  const last = await prisma.edi834File.findFirst({ where: { carrierId: c.id, status: { in: ['GENERATED', 'SENT'] } }, orderBy: { createdAt: 'desc' } });
  const now = new Date();
  const { members, excluded } = await membersFor(c.id, mode, last?.createdAt ?? null, now);
  if (!members.length) {
    res.json({ file: null, excluded, message: mode === 'CHANGE' ? 'Nothing has changed for this carrier since the last file.' : 'No one is enrolled in this carrier’s plans.' });
    return;
  }
  const file = await prisma.$transaction(async (tx) => {
    const bumped = await tx.benefitCarrier.update({ where: { id: c.id }, data: { lastControlNumber: { increment: 1 } } });
    const control = bumped.lastControlNumber % 1_000_000_000;
    const built = build834(
      { senderQualifier: c.senderQualifier, senderId: c.senderId, receiverQualifier: c.receiverQualifier, receiverId: c.receiverId, usage: c.usageIndicator === 'P' ? 'P' : 'T', controlNumber: control, createdAt: now },
      { mode, referenceId: `${c.id.slice(0, 8)}-${control}`, policyNumber: c.policyNumber, effectiveDate: now.toISOString().slice(0, 10), sponsorName: sponsor?.legalName ?? 'Employer', sponsorTaxId: c.sponsorTaxId ?? sponsor?.ein?.replace(/\D/g, '') ?? null, carrierName: c.name },
      members,
    );
    return tx.edi834File.create({
      data: { tenantId, carrierId: c.id, mode, controlNumber: control, content: encryptString(built.content).toString('base64'), memberCount: built.memberCount, createdById: req.user!.id },
    });
  });
  audit(req, 'benefits.edi834_generated', 'Edi834File', file.id, { carrierId: c.id, mode, members: members.length, excluded: excluded.length });
  res.status(201).json({ file: shapeFile(file), excluded });
});

benefitCarriersRouter.get('/benefit-carriers/:id/files', PROCESS, async (req, res) => {
  const c = await carrierOr404(String(req.params.id));
  const files = await prisma.edi834File.findMany({ where: { carrierId: c.id, tenantId: tenantIdForWrite() }, orderBy: { createdAt: 'desc' }, take: 200 });
  res.json({ files: files.map(shapeFile), truncated: files.length === 200 });
});

async function fileOr404(id: string) {
  const f = await prisma.edi834File.findFirst({ where: { id, tenantId: tenantIdForWrite() }, include: { carrier: true } });
  if (!f) throw new HttpError(404, 'not_found', 'That file was not found.');
  return f;
}

benefitCarriersRouter.get('/benefit-files/:id/download', EXPORT_PII, async (req, res) => {
  const authority = assertBulkPiiExporter(req);
  const f = await fileOr404(String(req.params.id));
  audit(req, 'benefits.edi834_downloaded', 'Edi834File', f.id, { members: f.memberCount, authority });
  res.setHeader('Content-Type', 'application/edi-x12');
  res.setHeader('Content-Disposition', `attachment; filename="834-${f.carrier.name.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}-${f.controlNumber}.edi"`);
  res.send(decryptString(Buffer.from(f.content, 'base64')));
});

benefitCarriersRouter.post('/benefit-files/:id/send', PROCESS, async (req, res) => {
  refuseNarrowed(req.user!);
  const f = await fileOr404(String(req.params.id));
  if (f.status === 'SENT') throw new HttpError(409, 'already_sent', 'This file was already sent.');
  const name = `834_${f.carrier.receiverId}_${f.controlNumber}_${f.createdAt.toISOString().slice(0, 10).replace(/-/g, '')}.edi`;
  try {
    const { reference } = await deliverFile(f.carrier.transport as Transport, openConnection(f.carrier.connectionEnc), name, decryptString(Buffer.from(f.content, 'base64')), 'application/edi-x12');
    const updated = await prisma.edi834File.update({ where: { id: f.id }, data: { status: 'SENT', sentAt: new Date(), error: null } });
    audit(req, 'benefits.edi834_sent', 'Edi834File', f.id, { reference });
    res.json({ file: shapeFile(updated), reference });
  } catch (err) {
    if (!(err instanceof DeliveryError)) throw err;
    const updated = await prisma.edi834File.update({ where: { id: f.id }, data: { status: 'FAILED', error: err.message.slice(0, 1000) } });
    audit(req, 'benefits.edi834_send_failed', 'Edi834File', f.id, { error: err.message });
    res.status(502).json({ file: shapeFile(updated), error: { code: 'delivery_failed', message: err.message } });
  }
});
