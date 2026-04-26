import { Router } from 'express';
import { Prisma } from '@prisma/client';
import {
  BackgroundCheckListResponseSchema,
  BackgroundInitiateInputSchema,
  BackgroundUpdateInputSchema,
  I9ListResponseSchema,
  I9UpsertInputSchema,
  J1ListResponseSchema,
  J1UpsertInputSchema,
  type BackgroundCheck,
  type I9Verification,
  type J1Profile,
} from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { scopeBackgroundChecks } from '../lib/scope.js';
import { recordComplianceEvent } from '../lib/audit.js';

export const complianceRouter = Router();

const MANAGE = requireCapability('manage:compliance');

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/* ===== I-9 ============================================================== */

type RawI9 = Prisma.I9VerificationGetPayload<{
  include: {
    associate: { select: { firstName: true; lastName: true; email: true } };
    section2Verifier: { select: { email: true } };
  };
}>;

function toI9(row: RawI9): I9Verification {
  return {
    id: row.id,
    associateId: row.associateId,
    associateName: `${row.associate.firstName} ${row.associate.lastName}`,
    associateEmail: row.associate.email,
    section1CompletedAt: row.section1CompletedAt ? row.section1CompletedAt.toISOString() : null,
    section2CompletedAt: row.section2CompletedAt ? row.section2CompletedAt.toISOString() : null,
    section2VerifierUserId: row.section2VerifierUserId,
    section2VerifierEmail: row.section2Verifier?.email ?? null,
    documentList: row.documentList,
    supportingDocIds: Array.isArray(row.supportingDocIds)
      ? (row.supportingDocIds as string[])
      : [],
  };
}

const I9_INCLUDE = {
  associate: { select: { firstName: true, lastName: true, email: true } },
  section2Verifier: { select: { email: true } },
} as const;

complianceRouter.get('/i9', async (req, res, next) => {
  try {
    const status = req.query.status?.toString();
    const where: Prisma.I9VerificationWhereInput = {};
    if (status === 'pending') where.section2CompletedAt = null;
    if (status === 'complete') where.section2CompletedAt = { not: null };
    const rows = await prisma.i9Verification.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      take: 200,
      include: I9_INCLUDE,
    });
    res.json(I9ListResponseSchema.parse({ i9s: rows.map(toI9) }));
  } catch (err) {
    next(err);
  }
});

complianceRouter.post('/i9/:associateId', MANAGE, async (req, res, next) => {
  try {
    const parsed = I9UpsertInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const associate = await prisma.associate.findFirst({
      where: { id: req.params.associateId, deletedAt: null },
    });
    if (!associate) throw new HttpError(404, 'associate_not_found', 'Associate not found');

    const i = parsed.data;
    const data: Prisma.I9VerificationUpdateInput & Prisma.I9VerificationCreateInput = {
      associate: { connect: { id: associate.id } },
    };
    if (i.section1CompletedAt !== undefined) {
      data.section1CompletedAt = i.section1CompletedAt ? new Date(i.section1CompletedAt) : null;
    }
    if (i.section2CompletedAt !== undefined) {
      data.section2CompletedAt = i.section2CompletedAt ? new Date(i.section2CompletedAt) : null;
      if (i.section2CompletedAt) {
        data.section2Verifier = { connect: { id: req.user!.id } };
      } else {
        data.section2Verifier = { disconnect: true };
      }
    }
    if (i.documentList !== undefined) data.documentList = i.documentList;
    if (i.supportingDocIds !== undefined) data.supportingDocIds = i.supportingDocIds;

    const row = await prisma.i9Verification.upsert({
      where: { associateId: associate.id },
      create: data,
      update: data,
      include: I9_INCLUDE,
    });

    await recordComplianceEvent({
      actorUserId: req.user!.id,
      action: 'compliance.i9_updated',
      entityType: 'I9Verification',
      entityId: row.id,
      associateId: associate.id,
      metadata: {
        section1: !!row.section1CompletedAt,
        section2: !!row.section2CompletedAt,
        documentList: row.documentList,
      },
      req,
    });

    res.json(toI9(row));
  } catch (err) {
    next(err);
  }
});

/* ===== Background checks =============================================== */

type RawBg = Prisma.BackgroundCheckGetPayload<{
  include: { associate: { select: { firstName: true; lastName: true } } };
}>;

function toBg(row: RawBg): BackgroundCheck {
  return {
    id: row.id,
    associateId: row.associateId,
    associateName: `${row.associate.firstName} ${row.associate.lastName}`,
    clientId: row.clientId,
    provider: row.provider,
    externalId: row.externalId,
    status: row.status,
    initiatedAt: row.initiatedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}

const BG_INCLUDE = {
  associate: { select: { firstName: true, lastName: true } },
} as const;

complianceRouter.get('/background', async (req, res, next) => {
  try {
    const status = req.query.status?.toString();
    const where: Prisma.BackgroundCheckWhereInput = {
      ...scopeBackgroundChecks(req.user!),
      ...(status ? { status: status as Prisma.BackgroundCheckWhereInput['status'] } : {}),
    };
    const rows = await prisma.backgroundCheck.findMany({
      where,
      orderBy: { initiatedAt: 'desc' },
      take: 200,
      include: BG_INCLUDE,
    });
    res.json(
      BackgroundCheckListResponseSchema.parse({ checks: rows.map(toBg) })
    );
  } catch (err) {
    next(err);
  }
});

/**
 * Initiate a background check. STUBBED: real provider integration (Checkr,
 * Sterling, etc.) lives here in a future phase. We just create the record
 * with INITIATED status; HR can flip it manually via /update.
 */
complianceRouter.post('/background', MANAGE, async (req, res, next) => {
  try {
    const parsed = BackgroundInitiateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const associate = await prisma.associate.findFirst({
      where: { id: parsed.data.associateId, deletedAt: null },
      include: { applications: { select: { clientId: true }, take: 1 } },
    });
    if (!associate) throw new HttpError(404, 'associate_not_found', 'Associate not found');

    const created = await prisma.backgroundCheck.create({
      data: {
        associateId: associate.id,
        clientId: associate.applications[0]?.clientId ?? null,
        provider: parsed.data.provider,
        status: 'INITIATED',
      },
      include: BG_INCLUDE,
    });

    await recordComplianceEvent({
      actorUserId: req.user!.id,
      action: 'compliance.background_initiated',
      entityType: 'BackgroundCheck',
      entityId: created.id,
      associateId: associate.id,
      clientId: created.clientId,
      metadata: { provider: created.provider, stub: true },
      req,
    });

    res.status(201).json(toBg(created));
  } catch (err) {
    next(err);
  }
});

complianceRouter.post('/background/:id/update', MANAGE, async (req, res, next) => {
  try {
    const parsed = BackgroundUpdateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const existing = await prisma.backgroundCheck.findFirst({
      where: { id: req.params.id, ...scopeBackgroundChecks(req.user!) },
    });
    if (!existing) {
      throw new HttpError(404, 'background_check_not_found', 'Background check not found');
    }
    const isTerminal =
      parsed.data.status === 'PASSED' ||
      parsed.data.status === 'FAILED' ||
      parsed.data.status === 'NEEDS_REVIEW';
    const updated = await prisma.backgroundCheck.update({
      where: { id: existing.id },
      data: {
        status: parsed.data.status,
        externalId: parsed.data.externalId ?? existing.externalId,
        completedAt: isTerminal ? new Date() : null,
      },
      include: BG_INCLUDE,
    });
    await recordComplianceEvent({
      actorUserId: req.user!.id,
      action: 'compliance.background_updated',
      entityType: 'BackgroundCheck',
      entityId: updated.id,
      associateId: updated.associateId,
      clientId: updated.clientId,
      metadata: { status: updated.status },
      req,
    });
    res.json(toBg(updated));
  } catch (err) {
    next(err);
  }
});

/* ===== J-1 ============================================================= */

type RawJ1 = Prisma.J1ProfileGetPayload<{
  include: { associate: { select: { firstName: true; lastName: true; email: true } } };
}>;

function toJ1(row: RawJ1): J1Profile {
  const now = Date.now();
  const days = Math.floor((row.programEndDate.getTime() - now) / (1000 * 60 * 60 * 24));
  return {
    id: row.id,
    associateId: row.associateId,
    associateName: `${row.associate.firstName} ${row.associate.lastName}`,
    associateEmail: row.associate.email,
    programStartDate: ymd(row.programStartDate),
    programEndDate: ymd(row.programEndDate),
    ds2019Number: row.ds2019Number,
    sponsorAgency: row.sponsorAgency,
    visaNumber: row.visaNumber,
    sevisId: row.sevisId,
    country: row.country,
    daysUntilEnd: days,
  };
}

const J1_INCLUDE = {
  associate: { select: { firstName: true, lastName: true, email: true } },
} as const;

complianceRouter.get('/j1', async (req, res, next) => {
  try {
    const expiringWithin = req.query.expiringWithin?.toString();
    const where: Prisma.J1ProfileWhereInput = {};
    if (expiringWithin) {
      const days = Number.parseInt(expiringWithin, 10);
      if (Number.isFinite(days)) {
        const cutoff = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
        where.programEndDate = { lte: cutoff };
      }
    }
    const rows = await prisma.j1Profile.findMany({
      where,
      orderBy: { programEndDate: 'asc' },
      take: 200,
      include: J1_INCLUDE,
    });
    res.json(J1ListResponseSchema.parse({ profiles: rows.map(toJ1) }));
  } catch (err) {
    next(err);
  }
});

complianceRouter.post('/j1/:associateId', MANAGE, async (req, res, next) => {
  try {
    const parsed = J1UpsertInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const associate = await prisma.associate.findFirst({
      where: { id: req.params.associateId, deletedAt: null },
    });
    if (!associate) throw new HttpError(404, 'associate_not_found', 'Associate not found');

    const i = parsed.data;
    const data = {
      programStartDate: new Date(`${i.programStartDate}T00:00:00.000Z`),
      programEndDate: new Date(`${i.programEndDate}T00:00:00.000Z`),
      ds2019Number: i.ds2019Number,
      sponsorAgency: i.sponsorAgency,
      visaNumber: i.visaNumber ?? null,
      sevisId: i.sevisId ?? null,
      country: i.country,
    };

    const row = await prisma.j1Profile.upsert({
      where: { associateId: associate.id },
      create: { associateId: associate.id, ...data },
      update: data,
      include: J1_INCLUDE,
    });

    // Auto-flag the associate as J-1 once we have a profile.
    if (!associate.j1Status) {
      await prisma.associate.update({
        where: { id: associate.id },
        data: { j1Status: true },
      });
    }

    await recordComplianceEvent({
      actorUserId: req.user!.id,
      action: 'compliance.j1_upserted',
      entityType: 'J1Profile',
      entityId: row.id,
      associateId: associate.id,
      metadata: { ds2019: row.ds2019Number, country: row.country },
      req,
    });

    res.json(toJ1(row));
  } catch (err) {
    next(err);
  }
});
