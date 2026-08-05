import { Router } from 'express';
import { Prisma } from '@prisma/client';
import {
  BackgroundBulkInitiateInputSchema,
  BackgroundBulkInitiateResponseSchema,
  BackgroundCheckDetailSchema,
  BackgroundCheckListResponseSchema,
  BackgroundInitiateInputSchema,
  BackgroundPendingResponseSchema,
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
import { blobExistsForListing } from '../lib/blobStore.js';
import { recordComplianceEvent } from '../lib/audit.js';
import { everifyRouter } from './everify.js';
import { drugTestsRouter } from './drugTests.js';

export const complianceRouter = Router();

const MANAGE = requireCapability('manage:compliance');

// E-Verify directorate lives in its own module — it's roughly the size of
// this file on its own. Mounted here rather than in app.ts so it inherits the
// same view:compliance guard and sits under the same /compliance prefix.
complianceRouter.use('/everify', everifyRouter);

// Drug tests — same reasoning: a full directorate module mounted under the
// same guard and prefix.
complianceRouter.use('/drug-tests', drugTestsRouter);

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/* ===== I-9 ============================================================== */

type RawI9 = Prisma.I9VerificationGetPayload<{
  include: {
    associate: {
      select: {
        firstName: true;
        lastName: true;
        email: true;
        applications: {
          select: { id: true; invitedAt: true; startDate: true };
          orderBy: { invitedAt: 'desc' };
          take: 1;
        };
      };
    };
    section2Verifier: { select: { email: true } };
  };
}>;

function toI9(row: RawI9): I9Verification {
  return {
    id: row.id,
    associateId: row.associateId,
    associateName: `${row.associate.firstName} ${row.associate.lastName}`,
    associateEmail: row.associate.email,
    applicationId: row.associate.applications[0]?.id ?? null,
    section1CompletedAt: row.section1CompletedAt ? row.section1CompletedAt.toISOString() : null,
    section2CompletedAt: row.section2CompletedAt ? row.section2CompletedAt.toISOString() : null,
    section2VerifierUserId: row.section2VerifierUserId,
    section2VerifierEmail: row.section2Verifier?.email ?? null,
    documentList: row.documentList,
    supportingDocIds: Array.isArray(row.supportingDocIds)
      ? (row.supportingDocIds as string[])
      : [],
    // Deadline anchors for the queue: without these HR couldn't tell
    // which of 40 pending I-9s is due tomorrow vs next week, and
    // expiring work authorizations were invisible here.
    startDate: row.associate.applications[0]?.startDate
      ? row.associate.applications[0].startDate.toISOString().slice(0, 10)
      : null,
    workAuthExpiresAt: row.workAuthExpiresAt
      ? row.workAuthExpiresAt.toISOString().slice(0, 10)
      : null,
  };
}

const I9_INCLUDE = {
  associate: {
    select: {
      firstName: true,
      lastName: true,
      email: true,
      applications: {
        select: { id: true, invitedAt: true, startDate: true },
        orderBy: { invitedAt: 'desc' as const },
        take: 1,
      },
    },
  },
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

function toBg(row: RawBg, reportCount?: number): BackgroundCheck {
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
    ...(reportCount !== undefined ? { reportCount } : {}),
  };
}

/** Provider report PDFs are stored as documents of this kind, keyed by
 *  associate — the same pattern as E-Verify closure packets. */
const BG_REPORT_KIND = 'BACKGROUND_CHECK_RESULT' as const;

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
    // Report-on-file counts in one grouped query — the table flags finalized
    // checks that have no evidence behind them without an N+1.
    const counts = await prisma.documentRecord.groupBy({
      by: ['associateId'],
      where: {
        associateId: { in: rows.map((r) => r.associateId) },
        kind: BG_REPORT_KIND,
        deletedAt: null,
      },
      _count: { _all: true },
    });
    const reportsByAssociate = new Map(counts.map((c) => [c.associateId, c._count._all]));
    res.json(
      BackgroundCheckListResponseSchema.parse({
        checks: rows.map((r) => toBg(r, reportsByAssociate.get(r.associateId) ?? 0)),
      })
    );
  } catch (err) {
    next(err);
  }
});

/**
 * Everyone onboarded or onboarding who has NEVER been screened, shaped for
 * the provider's bulk-invitation CSV. Registered before /background/:id so
 * "pending" isn't swallowed as an id. MANAGE because its only purpose is
 * feeding an ordering workflow, and the read is audited as an export.
 */
complianceRouter.get('/background/pending', MANAGE, async (req, res, next) => {
  try {
    // Every never-screened associate, whatever their employment state — the
    // dialog groups by status and defaults to active + onboarding, but HR can
    // opt inactive people (ended, declined, or never applied) into an order.
    // Any existing check — in flight, passed, or failed — means screened.
    const rows = await prisma.associate.findMany({
      take: 501, // one past the cap so truncation is detectable
      where: {
        deletedAt: null,
        backgroundChecks: { none: {} },
      },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        applications: { where: { deletedAt: null }, select: { status: true } },
      },
    });
    const truncated = rows.length > 500;
    const capped = rows.slice(0, 500);

    // Same status rule as the People directory (directory.ts): APPROVED ⇒
    // ACTIVE; any in-flight ⇒ PENDING; otherwise INACTIVE.
    const statusOf = (apps: { status: string }[]) =>
      apps.some((x) => x.status === 'APPROVED')
        ? ('ACTIVE' as const)
        : apps.some(
              (x) =>
                x.status === 'DRAFT' ||
                x.status === 'SUBMITTED' ||
                x.status === 'IN_REVIEW',
            )
          ? ('PENDING' as const)
          : ('INACTIVE' as const);

    await recordComplianceEvent({
      actorUserId: req.user!.id,
      action: 'compliance.background_pending_exported',
      entityType: 'BackgroundCheck',
      entityId: 'bulk',
      associateId: 'bulk', // fleet-wide export — lands in metadata, no FK
      metadata: { count: capped.length, truncated },
      req,
    });

    res.json(
      BackgroundPendingResponseSchema.parse({
        rows: capped.map((a) => ({
          associateId: a.id,
          firstName: a.firstName,
          lastName: a.lastName,
          email: a.email,
          phone: a.phone,
          status: statusOf(a.applications),
        })),
        truncated,
      })
    );
  } catch (err) {
    next(err);
  }
});

/**
 * Record that a bulk order was actually placed — called AFTER the CSV upload
 * to the provider succeeds, never on download. Creates INITIATED rows so the
 * queue reflects the order; associates who gained a check in the meantime
 * (another admin racing) are skipped, not duplicated.
 */
complianceRouter.post('/background/bulk-initiate', MANAGE, async (req, res, next) => {
  try {
    const parsed = BackgroundBulkInitiateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const associates = await prisma.associate.findMany({
      take: 500,
      where: { id: { in: parsed.data.associateIds }, deletedAt: null },
      select: {
        id: true,
        // Same clientId derivation as single initiate.
        applications: { select: { clientId: true }, take: 1 },
      },
    });
    const existing = await prisma.backgroundCheck.findMany({
      where: { associateId: { in: associates.map((a) => a.id) } },
      select: { associateId: true },
    });
    const alreadyChecked = new Set(existing.map((e) => e.associateId));
    const toCreate = associates.filter((a) => !alreadyChecked.has(a.id));

    if (toCreate.length > 0) {
      await prisma.backgroundCheck.createMany({
        data: toCreate.map((a) => ({
          associateId: a.id,
          clientId: a.applications[0]?.clientId ?? null,
          provider: parsed.data.provider,
          status: 'INITIATED' as const,
        })),
      });
    }

    await recordComplianceEvent({
      actorUserId: req.user!.id,
      action: 'compliance.background_bulk_initiated',
      entityType: 'BackgroundCheck',
      entityId: 'bulk',
      associateId: 'bulk', // fleet-wide order — lands in metadata, no FK
      metadata: {
        provider: parsed.data.provider,
        requested: parsed.data.associateIds.length,
        created: toCreate.length,
        skipped: parsed.data.associateIds.length - toCreate.length,
      },
      req,
    });

    res.json(
      BackgroundBulkInitiateResponseSchema.parse({
        created: toCreate.length,
        skipped: parsed.data.associateIds.length - toCreate.length,
      })
    );
  } catch (err) {
    next(err);
  }
});

/**
 * Check + its associate's report documents, for the drawer. Background
 * reports are FCRA-sensitive consumer reports, so every view of the report
 * list is a recorded disclosure — same treatment as the E-Verify case view.
 */
complianceRouter.get('/background/:id', async (req, res, next) => {
  try {
    const row = await prisma.backgroundCheck.findFirst({
      where: { id: req.params.id, ...scopeBackgroundChecks(req.user!) },
      include: BG_INCLUDE,
    });
    if (!row) {
      throw new HttpError(404, 'background_check_not_found', 'Background check not found');
    }
    const docs = await prisma.documentRecord.findMany({
      take: 100,
      where: { associateId: row.associateId, kind: BG_REPORT_KIND, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true, kind: true, filename: true, mimeType: true, s3Key: true },
    });
    const reports = docs.map((d) => ({
      id: d.id,
      kind: d.kind,
      filename: d.filename,
      mimeType: d.mimeType,
      // Local driver: real existsSync. s3 driver: assumed available when
      // s3Key is non-null (see blobStore.ts — S3 doesn't lose blobs on
      // redeploy, which is the failure mode this flag exists for).
      fileAvailable: blobExistsForListing(d.s3Key),
    }));

    await recordComplianceEvent({
      actorUserId: req.user!.id,
      action: 'compliance.background_report_viewed',
      entityType: 'BackgroundCheck',
      entityId: row.id,
      associateId: row.associateId,
      clientId: row.clientId,
      metadata: { reportCount: reports.length },
      req,
    });

    res.json(
      BackgroundCheckDetailSchema.parse({
        check: toBg(row, reports.length),
        reports,
      })
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
        externalId: parsed.data.externalId ?? null,
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
