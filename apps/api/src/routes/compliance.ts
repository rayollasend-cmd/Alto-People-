import { Router, type Request } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  AdverseActionListResponseSchema,
  EeoApplicantReportSchema,
  BackgroundBulkInitiateInputSchema,
  BackgroundBulkInitiateResponseSchema,
  BackgroundCheckDetailSchema,
  BackgroundCheckListResponseSchema,
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
import { env } from '../config/env.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { scopeAssociates, scopeAssociatesIncludingFormer, scopeBackgroundChecks, scopeWhere } from '../lib/scope.js';
import { blobExistsForListing, getBlobStore } from '../lib/blobStore.js';
import {
  adverseStageOf,
  buildEeoReport,
  finalAdverseNotice,
  i9ReverificationWhere,
  i9ReverifyDueAt,
  i9RetainUntil,
  i9RetentionWhere,
  preAdverseNotice,
  type AdverseStage,
} from '../lib/hiringCompliance.js';
import { markBackgroundTaskDone } from '../lib/backgroundCheckConsent.js';
import { send, type SendAttachment } from '../lib/notifications.js';
import { getBrandingSync } from '../lib/branding.js';
import { recordComplianceEvent } from '../lib/audit.js';
import { syncProgramFromJ1 } from '../lib/programs.js';
import {
  clientNamesById,
  primaryClientsForAssociates,
} from '../lib/associateClients.js';
import { notifyAssociate, notifyHrOnApplicationComplete } from '../lib/notify.js';
import { placements } from '../lib/activeDefinition.js';
import { profilePhotoUrlFor } from '../lib/profilePhotoUrl.js';
import { everifyRouter } from './everify.js';
import { drugTestsRouter } from './drugTests.js';
import { fmtDay } from '../lib/humanDates.js';
import { companyWorkweek, orgDateKey, utcInstantOfLocalMidnight } from '../lib/timeAnomalies.js';
import { addDaysToKey } from '../lib/timezone.js';

export const complianceRouter = Router();

const MANAGE = requireCapability('manage:compliance');
/** Rows a compliance list draws; more than this says so (`truncated`). */
const LIST_PAGE = 1000;

// E-Verify directorate lives in its own module — it's roughly the size of
// this file on its own. Mounted here rather than in app.ts so it inherits the
// same view:compliance guard and sits under the same /compliance prefix.
complianceRouter.use('/everify', everifyRouter);

// Drug tests — same reasoning: a full directorate module mounted under the
// same guard and prefix.
complianceRouter.use('/drug-tests', drugTestsRouter);

/** A @db.Date column's calendar day (hire dates, program dates, work-auth expiry) — never "today" (that is orgDateKey). */
function ymd(d: Date): string {
  // eslint-disable-next-line no-restricted-syntax -- UTC on purpose: date-only columns are stored at UTC midnight
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
        hireDate: true;
        separatedAt: true;
        photoS3Key: true;
        photoUpdatedAt: true;
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

function toI9(
  row: RawI9,
  client?: { clientId: string; clientName: string } | null,
): I9Verification {
  return {
    id: row.id,
    associateId: row.associateId,
    associateName: `${row.associate.firstName} ${row.associate.lastName}`,
    associateEmail: row.associate.email,
    clientId: client?.clientId ?? null,
    clientName: client?.clientName ?? null,
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
      ? ymd(row.associate.applications[0].startDate)
      : null,
    workAuthExpiresAt: row.workAuthExpiresAt
      ? ymd(row.workAuthExpiresAt)
      : null,
    // Retention and reverification (audit 2026-10-21 #14, lib/hiringCompliance).
    retainUntil: dateOrNull(i9RetainUntil(row.associate.hireDate, row.associate.separatedAt)),
    reverifyDueAt: dateOrNull(i9ReverifyDueAt(row.workAuthExpiresAt)),
    separatedAt: row.associate.separatedAt ? row.associate.separatedAt.toISOString() : null,
    // null = no headshot: the list's avatars stop asking for a photo that 404s.
    photoUrl: profilePhotoUrlFor({ id: row.associateId, photoS3Key: row.associate.photoS3Key, photoUpdatedAt: row.associate.photoUpdatedAt }),
  };
}

const dateOrNull = (d: Date | null) => (d ? ymd(d) : null);

const I9_INCLUDE = {
  associate: {
    select: {
      firstName: true,
      lastName: true,
      email: true,
      hireDate: true,
      separatedAt: true,
      photoS3Key: true,
      photoUpdatedAt: true,
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
    const filter: Prisma.I9VerificationWhereInput = {};
    if (status === 'pending') filter.section2CompletedAt = null;
    if (status === 'complete') filter.section2CompletedAt = { not: null };
    // Reverification (Supplement B) due: work authorization expired or
    // expiring within REVERIFY_WINDOW_DAYS, for people still working.
    if (status === 'reverification') Object.assign(filter, i9ReverificationWhere());
    // Past retention: separated, and both the 3-years-from-hire and the
    // 1-year-from-separation marks are behind us — the I-9 may be destroyed.
    if (status === 'retention') Object.assign(filter, i9RetentionWhere());
    // This tenant's people, inside the caller's reach. Retention is about
    // people who left, so it reaches by past placement as well.
    const reach = status === 'retention' ? scopeAssociatesIncludingFormer(req.user!) : scopeAssociates(req.user!);
    const where: Prisma.I9VerificationWhereInput = {
      AND: [filter, { tenantId: tenantIdForWrite() }, { associate: { AND: [{ deletedAt: null }, reach] } }],
    };
    const fetched = await prisma.i9Verification.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      take: LIST_PAGE + 1,
      include: I9_INCLUDE,
    });
    const truncated = fetched.length > LIST_PAGE;
    const rows = truncated ? fetched.slice(0, LIST_PAGE) : fetched;
    // Current client per associate, for the tab's client filter.
    const placement = await primaryClientsForAssociates(
      rows.map((r) => r.associateId),
    );
    // The compliance scorecard measures everyone hired and placed
    // (lib/activeDefinition placements). The working list carries the same
    // population, so the tab's "I-9 complete" and the scorecard's I-9 line
    // are one number: each row says whether its person is placed, and the
    // placed people with no I-9 record at all come back as notStarted
    // (the scorecard counts them missing; the list used to hide them).
    const tenantId = tenantIdForWrite();
    const placed = status === undefined ? await placements({ tenantId }, prisma) : null;
    let notStarted: Array<{
      associateId: string;
      associateName: string;
      associateEmail: string | null;
      clientId: string | null;
      clientName: string | null;
      hireDate: string | null;
      photoUrl: string | null;
    }> | undefined;
    if (placed) {
      const withRecord = await prisma.i9Verification.findMany({
        where: { tenantId, associateId: { in: [...placed.keys()] } },
        select: { associateId: true },
      });
      const has = new Set(withRecord.map((r) => r.associateId));
      const missingIds = [...placed.keys()].filter((id) => !has.has(id));
      const people = missingIds.length
        ? await prisma.associate.findMany({
            where: { AND: [{ id: { in: missingIds } }, { tenantId, deletedAt: null }, reach] },
            select: { id: true, firstName: true, lastName: true, email: true, hireDate: true, photoS3Key: true, photoUpdatedAt: true },
          })
        : [];
      const names = await clientNamesById(
        people.map((p) => placed.get(p.id)?.clientId).filter((c): c is string => !!c),
      );
      notStarted = people
        .map((p) => {
          const clientId = placed.get(p.id)?.clientId ?? null;
          return {
            associateId: p.id,
            associateName: `${p.firstName} ${p.lastName}`,
            associateEmail: p.email,
            clientId,
            clientName: clientId ? names.get(clientId) ?? null : null,
            hireDate: p.hireDate ? ymd(p.hireDate) : null,
            photoUrl: profilePhotoUrlFor(p),
          };
        })
        .sort((a, b) => a.associateName.localeCompare(b.associateName));
    }
    res.json(
      I9ListResponseSchema.parse({
        i9s: rows.map((r) => ({
          ...toI9(r, placement.get(r.associateId)),
          ...(placed ? { placed: placed.has(r.associateId) } : {}),
        })),
        truncated,
        ...(notStarted ? { notStarted } : {}),
      }),
    );
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
      where: { id: req.params.associateId, deletedAt: null, tenantId: tenantIdForWrite() },
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
    if (i.workAuthExpiresAt !== undefined) {
      // @db.Date column — store at UTC midnight (same convention as J-1
      // program dates) so ymd round-trips without timezone drift.
      data.workAuthExpiresAt = i.workAuthExpiresAt
        ? new Date(`${i.workAuthExpiresAt}T00:00:00.000Z`)
        : null;
    }

    const row = await prisma.i9Verification.upsert({
      where: { associateId: associate.id },
      create: data,
      update: data,
      include: I9_INCLUDE,
    });

    // Keep the onboarding checklist in lockstep. HR completing Section 2
    // from THIS tab used to leave the I9_VERIFICATION task IN_PROGRESS —
    // the application could never reach 100%, auto-submit never fired,
    // and Approve 409'd with checklist_incomplete even though the I-9 was
    // fully verified (the onboarding-side section2 route always did this).
    if (row.section1CompletedAt && row.section2CompletedAt) {
      const liveApps = await prisma.application.findMany({
        where: {
          associateId: associate.id,
          deletedAt: null,
          status: { in: ['DRAFT', 'SUBMITTED', 'IN_REVIEW'] },
        },
        select: { id: true },
      });
      if (liveApps.length > 0) {
        await prisma.onboardingTask.updateMany({
          where: {
            checklist: { applicationId: { in: liveApps.map((a) => a.id) } },
            kind: 'I9_VERIFICATION',
            status: { not: 'DONE' },
          },
          data: { status: 'DONE', completedAt: new Date() },
        });
        for (const a of liveApps) void notifyHrOnApplicationComplete(a.id);
      }
    }

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
        workAuthExpiresAt: row.workAuthExpiresAt
          ? ymd(row.workAuthExpiresAt)
          : null,
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

/** The person's photo URL when the include read the photo columns (BG_INCLUDE does); omitted otherwise. */
function bgAssociatePhoto(row: RawBg): { associatePhotoUrl?: string | null } {
  const a = row.associate as { photoS3Key?: string | null; photoUpdatedAt?: Date | null };
  if (a.photoS3Key === undefined) return {};
  return { associatePhotoUrl: profilePhotoUrlFor({ id: row.associateId, photoS3Key: a.photoS3Key, photoUpdatedAt: a.photoUpdatedAt ?? null }) };
}

function toBg(
  row: RawBg,
  reportCount?: number,
  client?: { clientId: string; clientName: string | null } | null,
): BackgroundCheck {
  return {
    id: row.id,
    associateId: row.associateId,
    associateName: `${row.associate.firstName} ${row.associate.lastName}`,
    ...bgAssociatePhoto(row),
    clientId: client?.clientId ?? row.clientId,
    clientName: client?.clientName ?? null,
    provider: row.provider,
    externalId: row.externalId,
    status: row.status,
    initiatedAt: row.initiatedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    ...(reportCount !== undefined ? { reportCount } : {}),
    adjudication: row.adjudication,
    preAdverseSentAt: row.preAdverseSentAt?.toISOString() ?? null,
    adverseWaitUntil: row.adverseWaitUntil?.toISOString() ?? null,
    adverseSentAt: row.adverseSentAt?.toISOString() ?? null,
    result: row.result,
    viaProvider: viaProvider(row),
  };
}

/** Ordered through a connected provider: its adverse action runs in the provider panel. */
const viaProvider = (c: { externalId: string | null; connectionId: string | null }) => !!(c.externalId && c.connectionId);

/** Provider report PDFs are stored as documents of this kind, keyed by
 *  associate — the same pattern as E-Verify closure packets. */
const BG_REPORT_KIND = 'BACKGROUND_CHECK_RESULT' as const;

const BG_INCLUDE = {
  associate: { select: { firstName: true, lastName: true, photoS3Key: true, photoUpdatedAt: true } },
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
    // Client label per row for the tab's client filter: the check's own
    // clientId wins when recorded (the client the screen was FOR), else the
    // associate's current placement.
    const placement = await primaryClientsForAssociates(rows.map((r) => r.associateId));
    const ownNames = await clientNamesById(rows.map((r) => r.clientId));
    res.json(
      BackgroundCheckListResponseSchema.parse({
        checks: rows.map((r) => {
          const ref = r.clientId
            ? { clientId: r.clientId, clientName: ownNames.get(r.clientId) ?? null }
            : placement.get(r.associateId) ?? null;
          return toBg(r, reportsByAssociate.get(r.associateId) ?? 0, ref);
        }),
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
        tenantId: tenantIdForWrite(),
        backgroundChecks: { none: {} },
        // The caller's reach: a store-bound office account orders for its own people.
        AND: [scopeAssociates(req.user!)],
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
 * Record that an order was actually placed in the provider's portal — one
 * person (with the provider's reference) or a bulk CSV upload, called AFTER
 * the upload succeeds, never on download. Creates INITIATED rows so the
 * queue reflects the order; associates who gained a check in the meantime
 * (another admin racing) are skipped, not duplicated. With a provider
 * connected, the check's drawer orders it through the connection instead
 * (routes/providerActions). This replaced the stubbed POST
 * /compliance/background that wrote an 'alto-stub' provider (10-21 audit).
 */
complianceRouter.post('/background/bulk-initiate', MANAGE, async (req, res, next) => {
  try {
    const parsed = BackgroundBulkInitiateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    if (parsed.data.externalId && parsed.data.associateIds.length !== 1) {
      throw new HttpError(400, 'external_id_one_person', 'A provider reference belongs to one person’s order.');
    }
    const associates = await prisma.associate.findMany({
      take: 500,
      // The people in the caller's reach only (scope-every-list).
      where: scopeWhere<Prisma.AssociateWhereInput>({ id: { in: parsed.data.associateIds }, deletedAt: null }, scopeAssociates(req.user!)),
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

    const made = toCreate.length > 0
      ? await prisma.backgroundCheck.createManyAndReturn({
          data: toCreate.map((a) => ({
            associateId: a.id,
            clientId: a.applications[0]?.clientId ?? null,
            provider: parsed.data.provider,
            externalId: parsed.data.externalId || null,
            status: 'INITIATED' as const,
          })),
          select: { id: true },
        })
      : [];
    if (parsed.data.associateIds.length === 1 && associates.length === 0) {
      throw new HttpError(404, 'associate_not_found', 'Associate not found');
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
        ids: made.map((m) => m.id),
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
    // A pass recorded by hand completes the onboarding task the consent left open.
    if (updated.status === 'PASSED') await markBackgroundTaskDone(prisma, updated.associateId);
    res.json(toBg(updated));
  } catch (err) {
    next(err);
  }
});

/* ===== FCRA adverse action (audit 2026-10-21 #14) ======================= */
//
// Before acting on a background report against someone, the FCRA asks for a
// pre-adverse notice carrying a copy of the report and the CFPB "Summary of
// Your Rights", a waiting period for them to respond or dispute, and then
// the final adverse action notice. Checks ordered through a connected
// provider run these steps in the provider panel (/provider-actions); these
// routes cover the checks recorded by hand.

const DEFAULT_WAIT_DAYS = 7;
const MIN_WAIT_DAYS = 5;

async function manualCheckFor(req: Request) {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) throw new HttpError(404, 'background_check_not_found', 'Background check not found');
  const c = await prisma.backgroundCheck.findFirst({
    where: { AND: [{ id: id.data }, { tenantId: tenantIdForWrite() }, scopeBackgroundChecks(req.user!)] },
    include: { associate: { select: { id: true, firstName: true, lastName: true, email: true } } },
  });
  if (!c) throw new HttpError(404, 'background_check_not_found', 'Background check not found');
  if (viaProvider(c)) {
    throw new HttpError(
      409,
      'use_provider_flow',
      `This check was ordered through ${c.provider} — send the notices from the provider panel on the check, so the provider runs them with the report.`,
    );
  }
  return c;
}

/** The newest report on file for the person, as an attachment — the notice must carry a copy. */
async function reportAttachment(associateId: string): Promise<SendAttachment | null> {
  const doc = await prisma.documentRecord.findFirst({
    where: { associateId, kind: BG_REPORT_KIND, deletedAt: null, s3Key: { not: null } },
    orderBy: { createdAt: 'desc' },
    select: { s3Key: true, filename: true, mimeType: true },
  });
  if (!doc?.s3Key) return null;
  const bytes = await getBlobStore().get(doc.s3Key);
  if (!bytes) return null;
  return { filename: doc.filename || 'background-report.pdf', content: bytes, contentType: doc.mimeType || 'application/pdf' };
}

/** Deliver a notice: the bell and email for a person with a login, the email on file otherwise — with the report attached. */
async function deliverNotice(
  associate: { id: string; email: string },
  notice: { subject: string; text: string; html: string },
  attachment: SendAttachment,
): Promise<void> {
  const user = await prisma.user.findFirst({ where: { associateId: associate.id, status: 'ACTIVE' }, select: { id: true } });
  if (user) {
    await notifyAssociate(associate.id, {
      subject: notice.subject,
      body: 'An important notice about your background check — please read it and the enclosed report.',
      html: notice.html,
      text: notice.text,
      category: 'compliance',
      attachments: [attachment],
    });
    return;
  }
  await send({
    channel: 'EMAIL',
    recipient: { userId: null, phone: null, email: associate.email },
    subject: notice.subject,
    body: notice.text,
    html: notice.html,
    attachments: [attachment],
    category: 'compliance',
  });
}

const noticeInput = (c: { provider: string; associate: { firstName: string; lastName: string } }, reportFileName: string, waitUntil?: Date) => ({
  personName: `${c.associate.firstName} ${c.associate.lastName}`,
  orgName: getBrandingSync().orgName,
  providerName: c.provider && !['none', 'stub', 'alto-stub'].includes(c.provider) ? c.provider : null,
  reportFileName,
  waitUntil,
  contactEmail: env.RESEND_FROM ? (env.RESEND_FROM.match(/<([^>]+)>/)?.[1] ?? env.RESEND_FROM) : null,
});

complianceRouter.post('/background/:id/pre-adverse', MANAGE, async (req, res, next) => {
  try {
    const { waitDays } = z
      .object({ waitDays: z.number().int().min(MIN_WAIT_DAYS).max(30).optional() })
      .parse(req.body ?? {});
    const c = await manualCheckFor(req);
    if (c.adjudication === 'PRE_ADVERSE' || c.adjudication === 'ADVERSE') {
      throw new HttpError(409, 'already_started', 'Adverse action has already started for this check.');
    }
    if (c.result === 'clear' || c.status === 'PASSED') {
      throw new HttpError(409, 'report_clear', 'This check cleared — there is nothing to take adverse action on.');
    }
    if (c.status !== 'NEEDS_REVIEW' && c.status !== 'FAILED' && c.result !== 'consider') {
      throw new HttpError(409, 'not_decidable', 'Adverse action starts from a report that needs review. Record the result first.');
    }
    const attachment = await reportAttachment(c.associateId);
    if (!attachment) {
      throw new HttpError(
        409,
        'no_report_on_file',
        'Upload the background report first — the pre-adverse notice has to include a copy of it.',
      );
    }
    const waitUntil = new Date(Date.now() + (waitDays ?? DEFAULT_WAIT_DAYS) * 86_400_000);
    await deliverNotice(c.associate, preAdverseNotice(noticeInput(c, attachment.filename, waitUntil)), attachment);
    const updated = await prisma.backgroundCheck.update({
      where: { id: c.id },
      data: { adjudication: 'PRE_ADVERSE', preAdverseSentAt: new Date(), adverseWaitUntil: waitUntil, status: 'NEEDS_REVIEW' },
      include: BG_INCLUDE,
    });
    await recordComplianceEvent({
      actorUserId: req.user!.id,
      action: 'compliance.background_pre_adverse',
      entityType: 'BackgroundCheck',
      entityId: c.id,
      associateId: c.associateId,
      clientId: c.clientId,
      metadata: { waitUntil: waitUntil.toISOString(), report: attachment.filename },
      req,
    });
    res.json(toBg(updated));
  } catch (err) {
    next(err);
  }
});

complianceRouter.post('/background/:id/final-adverse', MANAGE, async (req, res, next) => {
  try {
    const c = await manualCheckFor(req);
    if (c.adjudication !== 'PRE_ADVERSE') {
      throw new HttpError(409, 'no_pre_adverse', 'Send the pre-adverse notice first.');
    }
    if (!c.adverseWaitUntil || c.adverseWaitUntil.getTime() > Date.now()) {
      throw new HttpError(
        409,
        'waiting_period',
        // An instant, said on the company's calendar (CODE-14), not UTC's.
        `They still have until ${c.adverseWaitUntil ? fmtDay(orgDateKey(c.adverseWaitUntil), { weekday: true }) : 'the end of the waiting period'} to respond to the pre-adverse notice.`,
      );
    }
    const attachment = await reportAttachment(c.associateId);
    if (!attachment) {
      throw new HttpError(409, 'no_report_on_file', 'The background report is no longer on file — upload it again before sending the final notice.');
    }
    await deliverNotice(c.associate, finalAdverseNotice(noticeInput(c, attachment.filename)), attachment);
    const now = new Date();
    const updated = await prisma.backgroundCheck.update({
      where: { id: c.id },
      data: { adjudication: 'ADVERSE', adverseSentAt: now, status: 'FAILED', completedAt: now },
      include: BG_INCLUDE,
    });
    await recordComplianceEvent({
      actorUserId: req.user!.id,
      action: 'compliance.background_adverse',
      entityType: 'BackgroundCheck',
      entityId: c.id,
      associateId: c.associateId,
      clientId: c.clientId,
      req,
    });
    res.json(toBg(updated));
  } catch (err) {
    next(err);
  }
});

complianceRouter.post('/background/:id/withdraw-adverse', MANAGE, async (req, res, next) => {
  try {
    const c = await manualCheckFor(req);
    if (c.adjudication !== 'PRE_ADVERSE') {
      throw new HttpError(409, 'not_pending', 'Only a pending adverse action can be withdrawn.');
    }
    const updated = await prisma.backgroundCheck.update({
      where: { id: c.id },
      data: { adjudication: 'ENGAGED', status: 'PASSED', completedAt: new Date(), adverseWaitUntil: null },
      include: BG_INCLUDE,
    });
    await markBackgroundTaskDone(prisma, c.associateId);
    await recordComplianceEvent({
      actorUserId: req.user!.id,
      action: 'compliance.background_adverse_withdrawn',
      entityType: 'BackgroundCheck',
      entityId: c.id,
      associateId: c.associateId,
      clientId: c.clientId,
      req,
    });
    res.json(toBg(updated));
  } catch (err) {
    next(err);
  }
});

const STAGE_ORDER: Record<AdverseStage, number> = { FINAL_DUE: 0, DECIDE: 1, WAITING: 2, DONE: 3 };

/**
 * GET /compliance/adverse-actions — the FCRA worklist: reports to decide,
 * notices waiting out their period, final notices now due, and those sent
 * in the last 90 days. Provider-ordered and hand-recorded checks alike.
 */
complianceRouter.get('/adverse-actions', async (req, res, next) => {
  try {
    const now = new Date();
    const rows = await prisma.backgroundCheck.findMany({
      where: {
        AND: [
          { tenantId: tenantIdForWrite() },
          scopeBackgroundChecks(req.user!),
          {
            OR: [
              { adjudication: 'PRE_ADVERSE' },
              { adjudication: 'ADVERSE', adverseSentAt: { gte: new Date(now.getTime() - 90 * 86_400_000) } },
              { adjudication: null, OR: [{ status: 'NEEDS_REVIEW' }, { result: 'consider' }] },
            ],
          },
        ],
      },
      include: BG_INCLUDE,
      take: 500,
    });
    const out = rows
      .map((r) => ({ r, stage: adverseStageOf(r, now) }))
      .filter((x): x is { r: (typeof rows)[number]; stage: AdverseStage } => x.stage !== null)
      .sort((a, b) => STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage] || (a.r.adverseWaitUntil?.getTime() ?? 0) - (b.r.adverseWaitUntil?.getTime() ?? 0))
      .map(({ r, stage }) => ({
        checkId: r.id,
        associateId: r.associateId,
        associateName: `${r.associate.firstName} ${r.associate.lastName}`,
        stage,
        waitUntil: r.adverseWaitUntil?.toISOString() ?? null,
        preAdverseSentAt: r.preAdverseSentAt?.toISOString() ?? null,
        adverseSentAt: r.adverseSentAt?.toISOString() ?? null,
        result: r.result,
        status: r.status,
        viaProvider: viaProvider(r),
      }));
    res.json(AdverseActionListResponseSchema.parse({ rows: out }));
  } catch (err) {
    next(err);
  }
});

/* ===== Applicant EEO self-identification (audit 2026-10-21 #14) ========= */

/**
 * GET /compliance/eeo/applicant-report?from&to — counts only. Never a row,
 * never a name: buckets under five read '<5'. The answers are stored apart
 * from candidates and applications (EeoSelfIdentification) and this is
 * their only reader.
 */
complianceRouter.get('/eeo/applicant-report', MANAGE, async (req, res, next) => {
  try {
    const q = z
      .object({
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      })
      .parse(req.query);
    const to = q.to ?? orgDateKey(new Date()); // the company's today, not UTC's
    const from = q.from ?? addDaysToKey(to, -365);
    // The days are the company's, so the window runs midnight to midnight on its calendar:
    // UTC midnights cut off the evening (an answer at 9 PM Eastern fell outside "today").
    const tz = companyWorkweek().timezone;
    const start = utcInstantOfLocalMidnight(from, tz);
    const end = utcInstantOfLocalMidnight(addDaysToKey(to, 1), tz);
    const tenantId = tenantIdForWrite();
    const [rows, candidates, applications] = await Promise.all([
      prisma.eeoSelfIdentification.findMany({
        where: { tenantId, submittedAt: { gte: start, lt: end } },
        select: { declined: true, gender: true, ethnicity: true, veteranStatus: true, disabilityStatus: true },
        take: 50_000,
      }),
      prisma.candidate.count({ where: { tenantId, createdAt: { gte: start, lt: end } } }),
      prisma.application.count({ where: { tenantId, invitedAt: { gte: start, lt: end } } }),
    ]);
    await recordComplianceEvent({
      actorUserId: req.user!.id,
      action: 'compliance.eeo_report_viewed',
      // A view of aggregate counts, about no one — so no associate is named.
      entityType: 'Associate',
      entityId: 'aggregate',
      associateId: 'aggregate',
      metadata: { from, to, report: 'eeo-applicant-self-id' },
      req,
    });
    res.json(EeoApplicantReportSchema.parse(buildEeoReport(rows, candidates + applications, from, to)));
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
    const filter: Prisma.J1ProfileWhereInput = {};
    if (expiringWithin) {
      const days = Number.parseInt(expiringWithin, 10);
      if (Number.isFinite(days)) {
        const cutoff = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
        filter.programEndDate = { lte: cutoff };
      }
    }
    const where: Prisma.J1ProfileWhereInput = {
      AND: [filter, { tenantId: tenantIdForWrite() }, { associate: { AND: [{ deletedAt: null }, scopeAssociates(req.user!)] } }],
    };
    const fetched = await prisma.j1Profile.findMany({
      where,
      orderBy: [{ programEndDate: 'asc' }, { id: 'asc' }],
      take: LIST_PAGE + 1,
      include: J1_INCLUDE,
    });
    const truncated = fetched.length > LIST_PAGE;
    const rows = truncated ? fetched.slice(0, LIST_PAGE) : fetched;
    res.json(J1ListResponseSchema.parse({ profiles: rows.map(toJ1), truncated }));
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
      where: { id: req.params.associateId, deletedAt: null, tenantId: tenantIdForWrite() },
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
    // The Program record (Brief 1C-2) is the richer twin; keep it in step
    // so the alerts and the H-2B rule read one source.
    await syncProgramFromJ1(prisma, row, req.user!.id);

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
