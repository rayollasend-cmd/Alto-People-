import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { recordChange } from '../lib/associateHistory.js';
import { emit as emitWorkflow } from '../lib/workflow.js';
import { profilePhotoUrlFor } from '../lib/profilePhotoUrl.js';
import { decryptString, encryptString } from '../lib/crypto.js';
import { enqueueAudit } from '../lib/audit.js';
import { send } from '../lib/notifications.js';
import { purgeAssociateBiometrics } from '../lib/kioskMaintenance.js';

/**
 * Phase 82 — Self-service post-onboarding.
 *
 * Routes are gated only by authentication (no capability) — the user is
 * always editing their OWN associate record (req.user.associateId). HR
 * has parallel /associates/:id/* endpoints in earlier phases.
 *
 * Surface:
 *   - profile (address, phone)
 *   - emergency contacts (CRUD)
 *   - dependents (CRUD)
 *   - beneficiaries (CRUD with primary 100% validation)
 *   - life events (associate creates → HR reviews)
 *   - tax documents (read-only download list)
 */

export const selfServiceRouter = Router();

function requireAssociate(req: Request): string {
  const associateId = req.user?.associateId;
  if (!associateId) {
    throw new HttpError(
      403,
      'not_an_associate',
      'This route is only available to associate-linked accounts.',
    );
  }
  return associateId;
}

// ----- Profile (subset) ---------------------------------------------------

const ProfileUpdateSchema = z.object({
  phone: z.string().min(7).max(40).nullable().optional(),
  addressLine1: z.string().max(120).nullable().optional(),
  addressLine2: z.string().max(120).nullable().optional(),
  city: z.string().max(80).nullable().optional(),
  state: z.string().regex(/^[A-Z]{2}$/).nullable().optional(),
  zip: z.string().regex(/^\d{5}(-\d{4})?$/).nullable().optional(),
});

selfServiceRouter.get('/me/profile', async (req, res) => {
  const id = requireAssociate(req);
  const a = await prisma.associate.findUnique({
    where: { id },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      addressLine1: true,
      addressLine2: true,
      city: true,
      state: true,
      zip: true,
      employmentType: true,
      photoS3Key: true,
      photoUpdatedAt: true,
      department: { select: { name: true } },
      jobProfile: { select: { title: true } },
      manager: { select: { firstName: true, lastName: true } },
    },
  });
  if (!a) throw new HttpError(404, 'not_found', 'Associate not found.');
  const { photoS3Key, photoUpdatedAt, manager, ...rest } = a;
  res.json({
    ...rest,
    managerName: manager
      ? `${manager.firstName} ${manager.lastName}`.trim()
      : null,
    photoUrl: profilePhotoUrlFor({ id: a.id, photoS3Key, photoUpdatedAt }),
  });
});

selfServiceRouter.put('/me/profile', async (req, res) => {
  const id = requireAssociate(req);
  const input = ProfileUpdateSchema.parse(req.body);
  const before = await prisma.associate.findUnique({
    where: { id },
    select: { state: true, addressLine1: true, addressLine2: true, city: true, zip: true },
  });
  const updated = await prisma.associate.update({
    where: { id },
    data: {
      phone: input.phone === undefined ? undefined : input.phone,
      addressLine1: input.addressLine1 === undefined ? undefined : input.addressLine1,
      addressLine2: input.addressLine2 === undefined ? undefined : input.addressLine2,
      city: input.city === undefined ? undefined : input.city,
      state: input.state === undefined ? undefined : input.state,
      zip: input.zip === undefined ? undefined : input.zip,
    },
  });
  if (input.state !== undefined && input.state !== before?.state) {
    await recordChange(prisma, {
      associateId: id,
      managerId: updated.managerId,
      departmentId: updated.departmentId,
      costCenterId: updated.costCenterId,
      jobProfileId: updated.jobProfileId,
      state: updated.state,
      hourlyRate: null,
      reason: 'self_service_state_change',
      actorUserId: req.user!.id,
    });
  }
  res.json({ ok: true });
});

// ----- Employee number ----------------------------------------------------

selfServiceRouter.get('/me/employee-number', async (req, res) => {
  const id = requireAssociate(req);
  const pin = await prisma.kioskPin.findUnique({
    where: { associateId: id },
    select: { pinEncrypted: true, createdAt: true },
  });
  if (!pin?.pinEncrypted) {
    res.json({ employeeNumber: null, issuedAt: null });
    return;
  }
  res.json({
    employeeNumber: decryptString(pin.pinEncrypted),
    issuedAt: pin.createdAt.toISOString(),
  });
});

// ----- Face-verification consent -------------------------------------------
// BIPA-style biometric rights are strongest when the data subject can
// exercise them directly — withdrawing through a manager (the kiosk-admin
// path) is a fallback, not the only door. Both directions are valid here
// because the caller IS the associate, authenticated: granting from your
// own profile is affirmative consent; declining scrubs stored biometrics
// immediately, same rule as every other decline path.

selfServiceRouter.get('/me/face-consent', async (req, res) => {
  const id = requireAssociate(req);
  const a = await prisma.associate.findUnique({
    where: { id },
    select: { faceConsentStatus: true, faceConsentAt: true },
  });
  if (!a) throw new HttpError(404, 'not_found', 'Associate not found.');
  res.json({
    status: a.faceConsentStatus,
    at: a.faceConsentAt?.toISOString() ?? null,
  });
});

selfServiceRouter.post('/me/face-consent', async (req, res) => {
  const id = requireAssociate(req);
  const { consent } = z.object({ consent: z.boolean() }).parse(req.body);
  const status = consent ? 'GRANTED' : 'DECLINED';
  await prisma.associate.update({
    where: { id },
    data: { faceConsentStatus: status, faceConsentAt: new Date() },
  });
  if (!consent) {
    await purgeAssociateBiometrics(prisma, id);
  }
  enqueueAudit(
    {
      actorUserId: req.user!.id,
      action: consent
        ? 'kiosk.face_consent_granted_self'
        : 'kiosk.face_consent_declined_self',
      entityType: 'Associate',
      entityId: id,
      metadata: {},
    },
    consent
      ? 'kiosk.face_consent_granted_self'
      : 'kiosk.face_consent_declined_self',
  );
  res.json({ ok: true, status });
});

// ----- Emergency contacts -------------------------------------------------

const EmergencyContactInputSchema = z.object({
  name: z.string().min(1).max(120),
  relation: z.enum(['SPOUSE', 'PARENT', 'CHILD', 'SIBLING', 'FRIEND', 'OTHER']),
  phone: z.string().min(7).max(40),
  email: z.string().email().nullable().optional(),
  isPrimary: z.boolean().optional(),
});

selfServiceRouter.get('/me/emergency-contacts', async (req, res) => {
  const id = requireAssociate(req);
  const rows = await prisma.emergencyContact.findMany({
    take: 500,
    where: { associateId: id, deletedAt: null },
    orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }],
  });
  res.json({ contacts: rows });
});

selfServiceRouter.post('/me/emergency-contacts', async (req, res) => {
  const id = requireAssociate(req);
  const input = EmergencyContactInputSchema.parse(req.body);
  await prisma.$transaction(async (tx) => {
    if (input.isPrimary) {
      await tx.emergencyContact.updateMany({
        where: { associateId: id, isPrimary: true, deletedAt: null },
        data: { isPrimary: false },
      });
    }
    await tx.emergencyContact.create({
      data: {
        associateId: id,
        name: input.name,
        relation: input.relation,
        phone: input.phone,
        email: input.email ?? null,
        isPrimary: input.isPrimary ?? false,
      },
    });
  });
  res.status(201).json({ ok: true });
});

selfServiceRouter.put('/me/emergency-contacts/:id', async (req, res) => {
  const associateId = requireAssociate(req);
  const id = req.params.id;
  const input = EmergencyContactInputSchema.partial().parse(req.body);
  const existing = await prisma.emergencyContact.findUnique({ where: { id } });
  if (!existing || existing.associateId !== associateId || existing.deletedAt) {
    throw new HttpError(404, 'not_found', 'Contact not found.');
  }
  await prisma.$transaction(async (tx) => {
    if (input.isPrimary) {
      await tx.emergencyContact.updateMany({
        where: {
          associateId,
          isPrimary: true,
          deletedAt: null,
          id: { not: id },
        },
        data: { isPrimary: false },
      });
    }
    await tx.emergencyContact.update({
      where: { id },
      data: {
        name: input.name ?? undefined,
        relation: input.relation ?? undefined,
        phone: input.phone ?? undefined,
        email: input.email === undefined ? undefined : input.email,
        isPrimary: input.isPrimary ?? undefined,
      },
    });
  });
  res.json({ ok: true });
});

selfServiceRouter.delete('/me/emergency-contacts/:id', async (req, res) => {
  const associateId = requireAssociate(req);
  const id = req.params.id;
  const existing = await prisma.emergencyContact.findUnique({ where: { id } });
  if (!existing || existing.associateId !== associateId || existing.deletedAt) {
    throw new HttpError(404, 'not_found', 'Contact not found.');
  }
  await prisma.emergencyContact.update({
    where: { id },
    data: { deletedAt: new Date(), isPrimary: false },
  });
  res.status(204).end();
});

// ----- Dependents ---------------------------------------------------------

const DependentInputSchema = z.object({
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  relation: z.enum(['SPOUSE', 'CHILD', 'DOMESTIC_PARTNER', 'OTHER']),
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  ssnLast4: z.string().regex(/^\d{4}$/).optional().nullable(),
  isCovered: z.boolean().optional(),
});

selfServiceRouter.get('/me/dependents', async (req, res) => {
  const id = requireAssociate(req);
  const rows = await prisma.dependent.findMany({
    take: 500,
    where: { associateId: id, deletedAt: null },
    orderBy: { lastName: 'asc' },
  });
  res.json({ dependents: rows });
});

selfServiceRouter.post('/me/dependents', async (req, res) => {
  const id = requireAssociate(req);
  const input = DependentInputSchema.parse(req.body);
  const created = await prisma.dependent.create({
    data: {
      associateId: id,
      firstName: input.firstName,
      lastName: input.lastName,
      relation: input.relation,
      dob: input.dob ? new Date(input.dob) : null,
      ssnLast4: input.ssnLast4 ?? null,
      isCovered: input.isCovered ?? true,
    },
  });
  res.status(201).json({ id: created.id });
});

selfServiceRouter.put('/me/dependents/:id', async (req, res) => {
  const associateId = requireAssociate(req);
  const id = req.params.id;
  const input = DependentInputSchema.partial().parse(req.body);
  const existing = await prisma.dependent.findUnique({ where: { id } });
  if (!existing || existing.associateId !== associateId || existing.deletedAt) {
    throw new HttpError(404, 'not_found', 'Dependent not found.');
  }
  await prisma.dependent.update({
    where: { id },
    data: {
      firstName: input.firstName ?? undefined,
      lastName: input.lastName ?? undefined,
      relation: input.relation ?? undefined,
      dob:
        input.dob === undefined
          ? undefined
          : input.dob
            ? new Date(input.dob)
            : null,
      ssnLast4: input.ssnLast4 === undefined ? undefined : input.ssnLast4,
      isCovered: input.isCovered ?? undefined,
    },
  });
  res.json({ ok: true });
});

selfServiceRouter.delete('/me/dependents/:id', async (req, res) => {
  const associateId = requireAssociate(req);
  const id = req.params.id;
  const existing = await prisma.dependent.findUnique({ where: { id } });
  if (!existing || existing.associateId !== associateId || existing.deletedAt) {
    throw new HttpError(404, 'not_found', 'Dependent not found.');
  }
  await prisma.dependent.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
  res.status(204).end();
});

// ----- Beneficiaries ------------------------------------------------------

const BeneficiaryInputSchema = z.object({
  name: z.string().min(1).max(120),
  relation: z.enum(['SPOUSE', 'CHILD', 'DOMESTIC_PARTNER', 'OTHER']),
  kind: z.enum(['PRIMARY', 'CONTINGENT']).optional(),
  percentage: z.number().int().min(0).max(100),
  dependentId: z.string().uuid().nullable().optional(),
});

selfServiceRouter.get('/me/beneficiaries', async (req, res) => {
  const id = requireAssociate(req);
  const rows = await prisma.beneficiary.findMany({
    take: 500,
    where: { associateId: id, deletedAt: null },
    orderBy: [{ kind: 'asc' }, { name: 'asc' }],
  });
  res.json({ beneficiaries: rows });
});

selfServiceRouter.post('/me/beneficiaries', async (req, res) => {
  const associateId = requireAssociate(req);
  const input = BeneficiaryInputSchema.parse(req.body);
  await prisma.beneficiary.create({
    data: {
      associateId,
      name: input.name,
      relation: input.relation,
      kind: input.kind ?? 'PRIMARY',
      percentage: input.percentage,
      dependentId: input.dependentId ?? null,
    },
  });
  res.status(201).json({ ok: true });
});

selfServiceRouter.put('/me/beneficiaries/:id', async (req, res) => {
  const associateId = requireAssociate(req);
  const id = req.params.id;
  const input = BeneficiaryInputSchema.partial().parse(req.body);
  const existing = await prisma.beneficiary.findUnique({ where: { id } });
  if (!existing || existing.associateId !== associateId || existing.deletedAt) {
    throw new HttpError(404, 'not_found', 'Beneficiary not found.');
  }
  await prisma.beneficiary.update({
    where: { id },
    data: {
      name: input.name ?? undefined,
      relation: input.relation ?? undefined,
      kind: input.kind ?? undefined,
      percentage: input.percentage ?? undefined,
      dependentId: input.dependentId === undefined ? undefined : input.dependentId,
    },
  });
  res.json({ ok: true });
});

selfServiceRouter.delete('/me/beneficiaries/:id', async (req, res) => {
  const associateId = requireAssociate(req);
  const id = req.params.id;
  const existing = await prisma.beneficiary.findUnique({ where: { id } });
  if (!existing || existing.associateId !== associateId || existing.deletedAt) {
    throw new HttpError(404, 'not_found', 'Beneficiary not found.');
  }
  await prisma.beneficiary.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
  res.status(204).end();
});

// ----- Life events --------------------------------------------------------

const LifeEventInputSchema = z.object({
  kind: z.enum([
    'MARRIAGE',
    'DIVORCE',
    'BIRTH',
    'ADOPTION',
    'DEATH_OF_DEPENDENT',
    'ADDRESS_CHANGE',
    'NAME_CHANGE',
    'OTHER',
  ]),
  eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().max(1000).optional().nullable(),
});

selfServiceRouter.get('/me/life-events', async (req, res) => {
  const id = requireAssociate(req);
  const rows = await prisma.lifeEvent.findMany({
    take: 500,
    where: { associateId: id },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ events: rows });
});

selfServiceRouter.post('/me/life-events', async (req, res) => {
  const associateId = requireAssociate(req);
  const input = LifeEventInputSchema.parse(req.body);
  const created = await prisma.lifeEvent.create({
    data: {
      associateId,
      kind: input.kind,
      eventDate: new Date(input.eventDate),
      notes: input.notes ?? null,
    },
  });
  // Fire workflow: associate hired isn't relevant; this is informational
  // for HR. We use ASSOCIATE_HIRED-style channel? No — there's no
  // dedicated trigger yet, so just create a CREATE_AUDIT_LOG via emit
  // would be circular. Skip workflow emit until a LIFE_EVENT trigger
  // is added in a future expansion.
  await emitWorkflow({
    trigger: 'COMPLIANCE_EXPIRING', // best-fit existing trigger; replace
    entityType: 'LifeEvent',
    entityId: created.id,
    context: {
      kind: created.kind,
      associateId,
      eventDate: input.eventDate,
    },
  }).catch(() => {
    // workflow emit is best-effort; don't block the user-facing write.
  });
  res.status(201).json({ id: created.id });
});

// ----- Tax documents ------------------------------------------------------

// Tier-3 — the real W-2 / W-2c / 1099 PDFs live on TaxForm rows and the
// per-form PDF route already allows owner download. This listing merges
// them (with a working downloadUrl) with any legacy TaxDocument rows, so
// self-service finally serves actual bytes instead of a stub note.
selfServiceRouter.get('/me/tax-documents', async (req, res) => {
  const id = requireAssociate(req);
  const [rows, forms] = await Promise.all([
    prisma.taxDocument.findMany({
      take: 500,
      where: { associateId: id },
      orderBy: [{ taxYear: 'desc' }, { kind: 'asc' }],
    }),
    prisma.taxForm.findMany({
      take: 200,
      where: {
        associateId: id,
        kind: { in: ['W2', 'W2C', 'F1099_NEC', 'F1099_MISC'] },
        status: { not: 'VOIDED' },
      },
      orderBy: [{ taxYear: 'desc' }, { kind: 'asc' }],
    }),
  ]);
  res.json({
    documents: [
      ...forms.map((f) => ({
        id: f.id,
        kind: f.kind,
        taxYear: f.taxYear,
        issuedAt: (f.filedAt ?? f.createdAt).toISOString(),
        fileSize: null as number | null,
        downloadUrl: `/api/tax-forms/${f.id}/pdf`,
      })),
      ...rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        taxYear: r.taxYear,
        issuedAt: r.issuedAt.toISOString(),
        fileSize: r.fileSize,
        downloadUrl: null as string | null,
      })),
    ],
  });
});

selfServiceRouter.get('/me/tax-documents/:id/download', async (req, res) => {
  const associateId = requireAssociate(req);
  const id = req.params.id;
  // TaxForm ids resolve to the real PDF route (the owner-scoped renderer).
  const form = await prisma.taxForm.findFirst({
    where: { id, associateId, status: { not: 'VOIDED' } },
    select: { id: true },
  });
  if (form) {
    res.redirect(302, `/api/tax-forms/${form.id}/pdf`);
    return;
  }
  const doc = await prisma.taxDocument.findUnique({ where: { id } });
  if (!doc || doc.associateId !== associateId) {
    throw new HttpError(404, 'not_found', 'Document not found.');
  }
  throw new HttpError(
    410,
    'legacy_document',
    'This legacy document has no stored file. Current W-2s and 1099s download directly from this page.',
  );
});

// ----- W-4 (Tier-3 self-service) -----------------------------------------

const W4UpdateSchema = z.object({
  filingStatus: z.enum(['SINGLE', 'MARRIED_FILING_JOINTLY', 'HEAD_OF_HOUSEHOLD']),
  multipleJobs: z.boolean().optional(),
  dependentsAmount: z.number().min(0).max(50_000).optional(),
  otherIncome: z.number().min(0).max(10_000_000).optional(),
  deductions: z.number().min(0).max(10_000_000).optional(),
  extraWithholding: z.number().min(0).max(100_000).optional(),
});

selfServiceRouter.get('/me/w4', async (req, res) => {
  const id = requireAssociate(req);
  const w4 = await prisma.w4Submission.findUnique({
    where: { associateId: id },
    select: {
      filingStatus: true,
      multipleJobs: true,
      dependentsAmount: true,
      otherIncome: true,
      deductions: true,
      extraWithholding: true,
      signedAt: true,
      updatedAt: true,
    },
  });
  if (!w4) throw new HttpError(404, 'no_w4', 'No W-4 on file yet — complete onboarding first.');
  res.json({
    filingStatus: w4.filingStatus,
    multipleJobs: w4.multipleJobs,
    dependentsAmount: Number(w4.dependentsAmount),
    otherIncome: Number(w4.otherIncome),
    deductions: Number(w4.deductions),
    extraWithholding: Number(w4.extraWithholding),
    signedAt: w4.signedAt?.toISOString() ?? null,
    updatedAt: w4.updatedAt.toISOString(),
  });
});

/**
 * POST /me/w4 — a life change (marriage, new dependent) shouldn't require
 * an HR ticket to adjust withholding. Updates the election fields only;
 * the SSN captured at onboarding never changes here. Takes effect on the
 * next payroll run. Audited.
 */
selfServiceRouter.post('/me/w4', async (req, res) => {
  const id = requireAssociate(req);
  const input = W4UpdateSchema.parse(req.body ?? {});
  const existing = await prisma.w4Submission.findUnique({ where: { associateId: id } });
  if (!existing) {
    throw new HttpError(
      409,
      'no_w4',
      'No W-4 on file — the onboarding W-4 (with SSN) must be completed first.',
    );
  }
  await prisma.w4Submission.update({
    where: { associateId: id },
    data: {
      filingStatus: input.filingStatus,
      ...(input.multipleJobs !== undefined ? { multipleJobs: input.multipleJobs } : {}),
      ...(input.dependentsAmount !== undefined ? { dependentsAmount: input.dependentsAmount } : {}),
      ...(input.otherIncome !== undefined ? { otherIncome: input.otherIncome } : {}),
      ...(input.deductions !== undefined ? { deductions: input.deductions } : {}),
      ...(input.extraWithholding !== undefined ? { extraWithholding: input.extraWithholding } : {}),
      signedAt: new Date(),
    },
  });
  enqueueAudit(
    {
      actorUserId: req.user!.id,
      action: 'self.w4_updated',
      entityType: 'Associate',
      entityId: id,
      metadata: { fields: Object.keys(input) },
    },
    'self.w4_updated',
  );
  res.json({ ok: true, effectiveNote: 'Applies from the next payroll run.' });
});

// ----- Payout method (Tier-3 self-service) --------------------------------

/** ABA routing checksum (3-7-1 weighting). */
function isValidRoutingNumber(rtn: string): boolean {
  if (!/^\d{9}$/.test(rtn)) return false;
  const d = rtn.split('').map(Number);
  const sum =
    3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8]);
  return sum % 10 === 0;
}

const PayoutUpdateSchema = z.object({
  routingNumber: z.string().regex(/^\d{9}$/),
  accountNumber: z.string().regex(/^\d{4,17}$/),
  accountType: z.enum(['CHECKING', 'SAVINGS']),
});

selfServiceRouter.get('/me/payout-method', async (req, res) => {
  const id = requireAssociate(req);
  const pm = await prisma.payoutMethod.findFirst({
    where: { associateId: id, isPrimary: true },
  });
  if (!pm) {
    res.json({ method: null });
    return;
  }
  const account = pm.accountNumberEnc ? decryptString(pm.accountNumberEnc) : null;
  res.json({
    method: {
      type: pm.type,
      accountType: pm.accountType,
      accountLast4: account ? account.slice(-4) : null,
      branchCard: pm.branchCardId !== null,
      verifiedAt: pm.verifiedAt?.toISOString() ?? null,
      updatedAt: pm.updatedAt.toISOString(),
    },
  });
});

/**
 * POST /me/payout-method — replace the primary direct-deposit account.
 * Routing number is checksum-validated; the change clears verifiedAt and
 * fires a confirmation email to the associate's address on file (the
 * standard bank-change fraud tripwire: if you didn't make this change,
 * you hear about it immediately). Audited as a critical-adjacent event.
 */
selfServiceRouter.post('/me/payout-method', async (req, res) => {
  const associateId = requireAssociate(req);
  const input = PayoutUpdateSchema.parse(req.body ?? {});
  if (!isValidRoutingNumber(input.routingNumber)) {
    throw new HttpError(400, 'invalid_routing', 'That routing number fails the ABA checksum — double-check it.');
  }
  const associate = await prisma.associate.findUnique({
    where: { id: associateId },
    select: { email: true, firstName: true },
  });
  const existing = await prisma.payoutMethod.findFirst({
    where: { associateId, isPrimary: true },
  });
  const data = {
    type: 'BANK_ACCOUNT' as const,
    routingNumberEnc: encryptString(input.routingNumber),
    accountNumberEnc: encryptString(input.accountNumber),
    accountType: input.accountType,
    verifiedAt: null,
    isPrimary: true,
  };
  if (existing) {
    await prisma.payoutMethod.update({ where: { id: existing.id }, data });
  } else {
    await prisma.payoutMethod.create({ data: { associateId, ...data } });
  }
  enqueueAudit(
    {
      actorUserId: req.user!.id,
      action: 'self.payout_method_updated',
      entityType: 'Associate',
      entityId: associateId,
      metadata: { accountLast4: input.accountNumber.slice(-4) },
    },
    'self.payout_method_updated',
  );
  if (associate?.email) {
    void send({
      channel: 'EMAIL',
      recipient: { userId: req.user!.id, phone: null, email: associate.email },
      subject: 'Your direct deposit account was changed',
      body:
        `Hi ${associate.firstName},\n\nThe bank account for your paychecks was just updated ` +
        `(account ending ${input.accountNumber.slice(-4)}). If you made this change, no action is needed. ` +
        `If you did NOT make this change, contact your manager immediately.`,
    }).catch(() => {});
  }
  res.json({ ok: true, accountLast4: input.accountNumber.slice(-4) });
});
