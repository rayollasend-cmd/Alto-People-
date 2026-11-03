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
  I9ReverificationInputSchema,
  I9ReverificationListResponseSchema,
  I9ReverificationSchema,
  I9BulkDestroyInputSchema,
  I9DestroyInputSchema,
  I9DestroyResponseSchema,
  I9_DESTROY_WORD,
  J1ListResponseSchema,
  J1UpsertInputSchema,
  type BackgroundCheck,
  type BgCheckStatus,
  type WorkStatus,
  type I9Verification,
  type I9NotStarted,
  type I9Reverification,
  type ComplianceWorkforce,
  type WorkforceGroup,
  type J1Profile,
} from '@alto-people/shared';
import { prisma } from '../db.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { scopeAssociates, scopeBackgroundChecks, scopeWhere } from '../lib/scope.js';
import { blobExistsForListing, getBlobStore } from '../lib/blobStore.js';
import {
  adverseStageOf,
  buildEeoReport,
  finalAdverseNotice,
  i9ReverificationWhere,
  i9ReverifyDueAt,
  i9RetainUntil,
  i9RetentionWhere,
  i9PastRetention,
  i9ReverificationDue,
  i9TerminationDay,
  section2DueBy,
  REVERIFYING_CITIZENSHIP,
  i9NeedsReview,
  i9NeedsReviewWhere,
  rehireReuseEnds,
  preAdverseNotice,
  type AdverseStage,
} from '../lib/hiringCompliance.js';
import { markBackgroundTaskDone } from '../lib/backgroundCheckConsent.js';
import type { SendAttachment } from '../lib/notifications.js';
import { recordComplianceEvent, recordCriticalAudit } from '../lib/audit.js';
import { syncProgramFromJ1 } from '../lib/programs.js';
import { J1_INCLUDE, j1ProfilesView, j1Roster } from '../lib/j1Roster.js';
import {
  clientNamesById,
  primaryClientsForAssociates,
} from '../lib/associateClients.js';
import { notifyHrOnApplicationComplete } from '../lib/notify.js';
import { placements } from '../lib/activeDefinition.js';
import { profilePhotoUrlFor } from '../lib/profilePhotoUrl.js';
import { everifyRouter } from './everify.js';
import { drugTestsRouter } from './drugTests.js';
import { fmtDay } from '../lib/humanDates.js';
import { companyWorkweek, orgDateKey, utcInstantOfLocalMidnight } from '../lib/timeAnomalies.js';
import { addDaysToKey } from '../lib/timezone.js';
import { encryptString } from '../lib/crypto.js';
import { hireDatesFor } from '../lib/hireDate.js';
import { employmentSpellsFor, i9ListReach, rehiresFor, terminationDaysFor } from '../lib/i9Records.js';
import { peopleStandings } from '../lib/peopleStatus.js';
import { logger } from '../lib/logger.js';
import { countWorkforce, readWorkforce, workforceFromQuery } from '../lib/complianceWorkforce.js';
import {
  ADVERSE_DEFAULT_WAIT_DAYS,
  ADVERSE_MIN_WAIT_DAYS,
  SCREENING_LIST_CAP,
  adverseNoticeInput,
  backgroundInFlight,
  deliverAdverseNotice,
  lastPassedAt,
  latestByPerson,
  legacyRosterStatus,
  reportAttachmentFor,
  reportCounts,
  reportWindowOf,
  rosterGroupOf,
  statusesOf,
  workforcesFromQuery,
} from '../lib/screeningRecords.js';

export const complianceRouter = Router();

const MANAGE = requireCapability('manage:compliance');

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

/**
 * A ceiling, not a page (owner, 2026-11-03): the whole company is a few
 * hundred I-9s, and the old 1,000-row cut was silent on the tab. Past this
 * the response says `truncated` and the tab says so.
 */
const I9_LIST_MAX = 5000;

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

/** What a row needs beyond its own columns — read once per list. */
interface I9RowContext {
  client?: { clientId: string; clientName: string } | null;
  /** The one hire date (lib/hireDate), YYYY-MM-DD: the employment's first day, the application's planned start before hire. */
  hireKey?: string | null;
  /** The day employment ended (i9TerminationDay); null while they work here. */
  ended?: string | null;
  workStatus?: WorkStatus | null;
  group?: WorkforceGroup | null;
  /** The latest REHIRE Supplement B's rehire day. */
  rehireOn?: string | null;
  /** An earlier employment ended before this one began. */
  rehired?: boolean;
  now?: Date;
}

function toI9(row: RawI9, ctx: I9RowContext = {}): I9Verification {
  const now = ctx.now ?? new Date();
  const hireKey = ctx.hireKey !== undefined ? ctx.hireKey : row.associate.hireDate ? ymd(row.associate.hireDate) : null;
  const ended = ctx.ended !== undefined ? ctx.ended : i9TerminationDay(null, row.associate.separatedAt);
  return {
    id: row.id,
    associateId: row.associateId,
    associateName: `${row.associate.firstName} ${row.associate.lastName}`,
    associateEmail: row.associate.email,
    clientId: ctx.client?.clientId ?? null,
    clientName: ctx.client?.clientName ?? null,
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
    // Retention and reverification (audit 2026-10-21 #14, lib/hiringCompliance):
    // retention from the last day worked (owner, 2026-11-03), reverification
    // only for an alien authorized to work.
    retainUntil: dateOrNull(i9RetainUntil(hireKey, ended)),
    reverifyDueAt: dateOrNull(i9ReverifyDueAt(row.workAuthExpiresAt, row.citizenshipStatus)),
    separatedAt: row.associate.separatedAt ? row.associate.separatedAt.toISOString() : null,
    // null = no headshot: the list's avatars stop asking for a photo that 404s.
    photoUrl: profilePhotoUrlFor({ id: row.associateId, photoS3Key: row.associate.photoS3Key, photoUpdatedAt: row.associate.photoUpdatedAt }),
    citizenshipStatus: row.citizenshipStatus,
    // One hire-date anchor for the Section 2 deadline (owner, 2026-11-03):
    // the employment's first day, the same date E-Verify counts from.
    hireDate: hireKey,
    section2DueBy: dateOrNull(section2DueBy(hireKey)),
    section2ExaminedOn: row.section2ExaminedOn ? ymd(row.section2ExaminedOn) : null,
    documentsSubmittedAt: row.documentsSubmittedAt ? row.documentsSubmittedAt.toISOString() : null,
    reverifyDue: i9ReverificationDue(row, ctx.group ?? null, now),
    leftOn: ended,
    needsReview: i9NeedsReview(row, ctx.group ?? null),
    originalSection2On: originalSection2Day(row),
    rehireOn: ctx.rehireOn ?? null,
    rehired: ctx.rehired ?? false,
    ...(ctx.workStatus !== undefined ? { workStatus: ctx.workStatus } : {}),
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

/** The context of each I-9 row: the one hire date (planned start before hire) and the day employment ended. */
async function i9Contexts(rows: RawI9[]): Promise<{
  hireKey: (id: string) => string | null;
  ended: (id: string) => string | null;
  rehireOn: (id: string) => string | null;
  rehired: (id: string) => boolean;
}> {
  const planned = new Map(rows.map((r) => [r.associateId, r.associate.applications[0]?.startDate ?? null]));
  const ids = rows.map((r) => r.associateId);
  const [hired, ended, rehires, spells] = await Promise.all([
    hireDatesFor(prisma, ids, planned),
    terminationDaysFor(prisma, rows.map((r) => ({ id: r.associateId, separatedAt: r.associate.separatedAt }))),
    rehiresFor(prisma, ids),
    employmentSpellsFor(prisma, ids),
  ]);
  const hireKey = (id: string) => hired.get(id)?.date ?? null;
  const latestRehire = (id: string) => (rehires.get(id) ?? []).map((r) => r.rehiredOn).sort().at(-1) ?? null;
  const rehired = (id: string) => {
    const h = hireKey(id);
    return !!h && (spells.get(id) ?? []).some((s) => !!s.endDate && ymd(s.endDate) < h);
  };
  return { hireKey, ended: (id) => ended.get(id) ?? null, rehireOn: latestRehire, rehired };
}

/**
 * The I-9 list for one group (`?workforce=`, default current; owner,
 * 2026-11-03). `?status=` narrows it: pending, complete, reverification
 * (due by the one rule) or retention (past it — about people who left, so
 * without a group named it reads Former). The chip counts are this list's
 * own people in the caller's reach, before the group is applied.
 */
complianceRouter.get('/i9', async (req, res, next) => {
  try {
    const status = req.query.status?.toString();
    const now = new Date();
    const tenantId = tenantIdForWrite();
    const workforce: ComplianceWorkforce =
      status === 'retention' && req.query.workforce === undefined ? 'former' : workforceFromQuery(req.query);
    const filter: Prisma.I9VerificationWhereInput = {};
    if (status === 'pending') filter.section2CompletedAt = null;
    if (status === 'complete') filter.section2CompletedAt = { not: null };
    // Reverification (Supplement B) due: an alien authorized to work whose
    // authorization expired or ends within REVERIFY_WINDOW_DAYS, still employed.
    if (status === 'reverification') Object.assign(filter, i9ReverificationWhere(now));
    // Past retention: separated, and both the 3-years-from-hire and the
    // 1-year-from-the-last-day-worked marks are behind us — the I-9 may be destroyed.
    if (status === 'retention') Object.assign(filter, i9RetentionWhere(now));
    // Needs review: an end date but no Section 1 citizenship status, still employed.
    if (status === 'needs_review') Object.assign(filter, i9NeedsReviewWhere());
    // This tenant's people in the caller's reach — and the people who left
    // from a site in it (lib/i9Records i9ListReach), for the Former view.
    const where: Prisma.I9VerificationWhereInput = {
      AND: [filter, { tenantId }, { associate: { AND: [{ deletedAt: null }, i9ListReach(req.user!)] } }],
    };
    const [fetched, reading] = await Promise.all([
      prisma.i9Verification.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        take: I9_LIST_MAX + 1,
        include: I9_INCLUDE,
      }),
      readWorkforce(tenantId, now),
    ]);
    const truncated = fetched.length > I9_LIST_MAX;
    const all = truncated ? fetched.slice(0, I9_LIST_MAX) : fetched;
    const ctx = await i9Contexts(all);
    const ctxOf = (id: string): I9RowContext => ({
      hireKey: ctx.hireKey(id),
      ended: ctx.ended(id),
      workStatus: reading.statusOf(id),
      group: reading.groupOf(id),
      rehireOn: ctx.rehireOn(id),
      rehired: ctx.rehired(id),
      now,
    });
    // The two views a rule decides past what the database can say: the
    // reverification rule's group, and the retention dates (lib/hiringCompliance).
    const records = all.filter((r) => {
      if (status === 'reverification') return i9ReverificationDue(r, reading.groupOf(r.associateId), now);
      if (status === 'needs_review') return i9NeedsReview(r, reading.groupOf(r.associateId));
      if (status === 'retention') {
        const ended = ctx.ended(r.associateId);
        return i9PastRetention(i9RetainUntil(ctx.hireKey(r.associateId), ended), ended, now);
      }
      return true;
    });
    // The compliance scorecard measures everyone hired and placed
    // (lib/activeDefinition placements). The working list carries the same
    // population, so the tab's "I-9 complete" and the scorecard's I-9 line
    // are one number: each row says whether its person is placed, and the
    // placed people with no I-9 record at all come back as notStarted
    // (the scorecard counts them missing; the list used to hide them).
    const placed = status === undefined ? await placements({ tenantId }, prisma) : null;
    let notStarted: I9NotStarted[] | undefined;
    if (placed) {
      const withRecord = await prisma.i9Verification.findMany({
        where: { tenantId, associateId: { in: [...placed.keys()] } },
        select: { associateId: true },
      });
      const has = new Set(withRecord.map((r) => r.associateId));
      const missingIds = [...placed.keys()].filter((id) => !has.has(id));
      const people = missingIds.length
        ? await prisma.associate.findMany({
            where: { AND: [{ id: { in: missingIds } }, { tenantId, deletedAt: null }, scopeAssociates(req.user!)] },
            select: { id: true, firstName: true, lastName: true, email: true, hireDate: true, photoS3Key: true, photoUpdatedAt: true },
          })
        : [];
      const [names, hired] = await Promise.all([
        clientNamesById(people.map((p) => placed.get(p.id)?.clientId).filter((c): c is string => !!c)),
        hireDatesFor(prisma, people.map((p) => p.id)),
      ]);
      notStarted = people
        .map((p) => {
          const clientId = placed.get(p.id)?.clientId ?? null;
          const hireKey = hired.get(p.id)?.date ?? (p.hireDate ? ymd(p.hireDate) : null);
          return {
            associateId: p.id,
            associateName: `${p.firstName} ${p.lastName}`,
            associateEmail: p.email,
            clientId,
            clientName: clientId ? names.get(clientId) ?? null : null,
            hireDate: hireKey,
            photoUrl: profilePhotoUrlFor(p),
            workStatus: reading.statusOf(p.id),
            section2DueBy: dateOrNull(section2DueBy(hireKey)),
          };
        })
        .sort((a, b) => a.associateName.localeCompare(b.associateName));
    }
    // The chips: how many of this list's people each group would show.
    const workforceCounts = countWorkforce([...records.map((r) => r.associateId), ...(notStarted ?? []).map((n) => n.associateId)], reading);
    const shown = records.filter((r) => reading.includes(r.associateId, workforce));
    // Current client per associate, for the tab's client filter.
    const placement = await primaryClientsForAssociates(shown.map((r) => r.associateId));
    res.json(
      I9ListResponseSchema.parse({
        i9s: shown.map((r) => ({
          ...toI9(r, { client: placement.get(r.associateId), ...ctxOf(r.associateId) }),
          ...(placed ? { placed: placed.has(r.associateId) } : {}),
        })),
        truncated,
        // "No I-9 on file" is about hired, placed people — the groups that hold them.
        ...(notStarted ? { notStarted: notStarted.filter((n) => reading.includes(n.associateId, workforce)) } : {}),
        workforce,
        workforceCounts,
      }),
    );
  } catch (err) {
    next(err);
  }
});

/** A person by id inside the caller's reach (404 outside it), for the I-9 writes. */
function i9PersonWhere(req: Request): Prisma.AssociateWhereInput {
  return { AND: [{ id: req.params.associateId, deletedAt: null, tenantId: tenantIdForWrite() }, i9ListReach(req.user!)] };
}

/**
 * Destroy several I-9s past retention at once (the Former view's Past
 * retention list): the typed count confirms it, and each record is checked
 * again on its own. Registered before /i9/:associateId so "destroy" is
 * never read as a person.
 */
complianceRouter.post('/i9/destroy', MANAGE, async (req, res, next) => {
  try {
    const parsed = I9BulkDestroyInputSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    const ids = [...new Set(parsed.data.associateIds)];
    if (parsed.data.confirm !== String(ids.length)) {
      throw new HttpError(400, 'confirmation_mismatch', `Type ${ids.length} to confirm destroying ${ids.length === 1 ? 'this I-9' : `these ${ids.length} I-9s`}.`);
    }
    res.json(await destroyI9s(req, ids));
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
    // Inside the caller's reach (owner, 2026-11-03): another store's person
    // is a 404, never a write.
    const associate = await prisma.associate.findFirst({
      where: i9PersonWhere(req),
      select: { id: true, hireDate: true },
    });
    if (!associate) throw new HttpError(404, 'associate_not_found', 'Associate not found');

    const i = parsed.data;
    const existing = await prisma.i9Verification.findUnique({
      where: { associateId: associate.id },
      select: { id: true, section2CompletedAt: true, section2ExaminedOn: true, documentList: true, citizenshipStatus: true, section2Verifier: { select: { email: true } } },
    });
    // Section 1's citizenship status typed from a paper I-9 — the fix for an
    // I-9 that needs review (owner, 2026-11-03). Only when none is on file:
    // the employee's own attestation is never overwritten here.
    if (i.citizenshipStatus !== undefined && existing?.citizenshipStatus && existing.citizenshipStatus !== i.citizenshipStatus) {
      throw new HttpError(409, 'citizenship_on_file', 'This I-9 already has a citizenship status from Section 1; it can’t be changed here.');
    }
    // Unticking a completed Section 2 erases the record of an examination
    // that happened (owner, 2026-11-03): it needs a reason, and the audit row
    // keeps what it erased.
    const clearsSection2 = i.section2CompletedAt === null && !!existing?.section2CompletedAt;
    if (clearsSection2 && !i.reason) {
      throw new HttpError(400, 'reason_required', 'Say why Section 2 is being unticked. The completed Section 2 is kept in the audit trail with your reason.');
    }

    // The day the documents were examined: typed, or today when Section 2 is
    // newly ticked. Never after today; never before the first day of employment.
    const today = orgDateKey(new Date());
    let examinedOn: string | null | undefined;
    if (clearsSection2) examinedOn = null;
    else if (i.section2ExaminedOn !== undefined && i.section2ExaminedOn !== null) examinedOn = i.section2ExaminedOn;
    else if (i.section2CompletedAt && !existing?.section2CompletedAt) examinedOn = today;
    if (examinedOn) {
      if (examinedOn > today) {
        throw new HttpError(400, 'examined_in_future', 'The documents can’t have been examined after today.');
      }
      const hired = await hireDatesFor(prisma, [associate.id]);
      const hireKey = hired.get(associate.id)?.date ?? (associate.hireDate ? ymd(associate.hireDate) : null);
      if (hireKey && examinedOn < hireKey) {
        throw new HttpError(400, 'examined_before_hire', `The documents can’t have been examined before the first day of employment (${hireKey}).`);
      }
    }

    const data: Prisma.I9VerificationUpdateInput & Prisma.I9VerificationCreateInput = {
      associate: { connect: { id: associate.id } },
    };
    if (i.section1CompletedAt !== undefined) {
      data.section1CompletedAt = i.section1CompletedAt ? new Date(i.section1CompletedAt) : null;
    }
    if (i.section2CompletedAt !== undefined) {
      data.section2CompletedAt = i.section2CompletedAt ? new Date(i.section2CompletedAt) : null;
      if (i.section2CompletedAt) data.section2Verifier = { connect: { id: req.user!.id } };
    }
    if (examinedOn !== undefined) {
      data.section2ExaminedOn = examinedOn ? new Date(`${examinedOn}T00:00:00.000Z`) : null;
    }
    if (i.documentList !== undefined) data.documentList = i.documentList;
    if (i.supportingDocIds !== undefined) data.supportingDocIds = i.supportingDocIds;
    if (i.citizenshipStatus !== undefined) data.citizenshipStatus = i.citizenshipStatus;
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
      // Unticking drops the verifier. Only an update can: a `disconnect` in
      // the create half made every untick a 500.
      update: i.section2CompletedAt === null ? { ...data, section2Verifier: { disconnect: true } } : data,
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
        section2ExaminedOn: row.section2ExaminedOn ? ymd(row.section2ExaminedOn) : null,
        workAuthExpiresAt: row.workAuthExpiresAt
          ? ymd(row.workAuthExpiresAt)
          : null,
        // Typed by HR from a paper Section 1 (never the employee's attestation).
        ...(i.citizenshipStatus !== undefined && !existing?.citizenshipStatus ? { citizenshipStatusRecordedByHr: i.citizenshipStatus } : {}),
      },
      req,
    });
    if (clearsSection2 && existing) {
      await recordComplianceEvent({
        actorUserId: req.user!.id,
        action: 'compliance.i9_section2_cleared',
        entityType: 'I9Verification',
        entityId: row.id,
        associateId: associate.id,
        metadata: {
          reason: i.reason ?? null,
          previousSection2CompletedAt: existing.section2CompletedAt?.toISOString() ?? null,
          previousSection2ExaminedOn: existing.section2ExaminedOn ? ymd(existing.section2ExaminedOn) : null,
          previousVerifierEmail: existing.section2Verifier?.email ?? null,
          previousDocumentList: existing.documentList,
        },
        req,
      });
    }

    const ctx = await i9Contexts([row]);
    res.json(toI9(row, { hireKey: ctx.hireKey(row.associateId), ended: ctx.ended(row.associateId), rehireOn: ctx.rehireOn(row.associateId), rehired: ctx.rehired(row.associateId) }));
  } catch (err) {
    next(err);
  }
});

/* ----- I-9 Supplement B: re-verification and rehire ---------------------- */

type RawReverification = Prisma.I9ReverificationGetPayload<{ include: { reviewedBy: { select: { email: true } } } }>;

function toReverification(r: RawReverification): I9Reverification {
  return {
    id: r.id,
    associateId: r.associateId,
    kind: r.kind === 'REHIRE' ? 'REHIRE' : 'REVERIFICATION',
    rehiredOn: r.rehiredOn ? ymd(r.rehiredOn) : null,
    documentTitle: r.documentTitle,
    documentNumberLast4: r.documentNumberLast4,
    issuingAuthority: r.issuingAuthority,
    previousExpiresAt: r.previousExpiresAt ? ymd(r.previousExpiresAt) : null,
    newExpiresAt: r.newExpiresAt ? ymd(r.newExpiresAt) : null,
    reviewedOn: ymd(r.reviewedOn),
    reviewedByEmail: r.reviewedBy?.email ?? null,
    notes: r.notes,
    createdAt: r.createdAt.toISOString(),
  };
}

/** The person's Supplement B entries, newest first — the I-9 drawer's history. */
complianceRouter.get('/i9/:associateId/reverifications', async (req, res, next) => {
  try {
    const associate = await prisma.associate.findFirst({ where: i9PersonWhere(req), select: { id: true } });
    if (!associate) throw new HttpError(404, 'associate_not_found', 'Associate not found');
    const rows = await prisma.i9Reverification.findMany({
      where: { associateId: associate.id, tenantId: tenantIdForWrite() },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: 200,
      include: { reviewedBy: { select: { email: true } } },
    });
    res.json(I9ReverificationListResponseSchema.parse({ reverifications: rows.map(toReverification) }));
  } catch (err) {
    next(err);
  }
});

/** The day the original I-9 was completed: the documents' examined day, else the day Section 2 was recorded. */
function originalSection2Day(i9: { section2ExaminedOn: Date | null; section2CompletedAt: Date | null }): string | null {
  if (i9.section2ExaminedOn) return ymd(i9.section2ExaminedOn);
  return i9.section2CompletedAt ? orgDateKey(i9.section2CompletedAt) : null;
}

/**
 * Record a Supplement B entry (owner, 2026-11-03).
 *
 * REVERIFICATION: the document HR examined and the new end of the
 * authorization — only for an alien authorized to work who still works here.
 * REHIRE: the person came back within 3 years of the original I-9's
 * completion and it is reused; the rehire date, and a re-verified document
 * when their authorization had ended by then (required in that case).
 *
 * A document moves the I-9's workAuthExpiresAt in the same transaction, so
 * that field always holds the CURRENT authorization's end — scheduling's
 * work-authorization block reads only it and the citizenship status.
 */
complianceRouter.post('/i9/:associateId/reverification', MANAGE, async (req, res, next) => {
  try {
    const parsed = I9ReverificationInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const associate = await prisma.associate.findFirst({
      where: i9PersonWhere(req),
      select: {
        id: true,
        separatedAt: true,
        erasedAt: true,
        i9Verification: { select: { id: true, citizenshipStatus: true, workAuthExpiresAt: true, section2ExaminedOn: true, section2CompletedAt: true } },
      },
    });
    if (!associate) throw new HttpError(404, 'associate_not_found', 'Associate not found');
    const i9 = associate.i9Verification;
    if (!i9) throw new HttpError(409, 'no_i9', 'There is no I-9 on file. Record the I-9 first.');
    if (associate.erasedAt) throw new HttpError(409, 'not_employed', 'This person’s record was erased.');
    const d = parsed.data;
    const kind = d.kind ?? 'REVERIFICATION';
    const today = orgDateKey(new Date());
    const reviewedOn = d.reviewedOn ?? today;
    if (reviewedOn > today) {
      throw new HttpError(400, 'reviewed_in_future', 'The documents can’t have been examined after today.');
    }

    if (kind === 'REVERIFICATION') {
      if (i9.citizenshipStatus !== REVERIFYING_CITIZENSHIP) {
        throw new HttpError(
          409,
          'not_reverifiable',
          'Only someone whose I-9 says “an alien authorized to work” is re-verified. Citizens, noncitizen nationals and permanent residents never are — asking them for new documents is not allowed.',
        );
      }
      if (associate.separatedAt) {
        throw new HttpError(409, 'not_employed', 'This person has left; there is nothing to re-verify.');
      }
    } else {
      // A rehire reuses the original I-9 only within 3 years of its completion.
      const original = originalSection2Day(i9);
      if (!original) {
        throw new HttpError(409, 'no_original_i9', 'The original I-9 has no Section 2 on file: complete a new I-9.');
      }
      if (d.rehiredOn! < original) {
        throw new HttpError(400, 'rehired_before_original', 'The rehire date is before the original I-9 was completed.');
      }
      if (d.rehiredOn! > rehireReuseEnds(original)) {
        throw new HttpError(409, 'rehire_too_late', 'More than 3 years since the original I-9: complete a new I-9.');
      }
      // Their authorization ended by the rehire day: Supplement B re-verifies it.
      const ended = i9.citizenshipStatus === REVERIFYING_CITIZENSHIP && !!i9.workAuthExpiresAt && ymd(i9.workAuthExpiresAt) < d.rehiredOn!;
      if (ended && (!d.documentTitle || d.newExpiresAt === undefined)) {
        throw new HttpError(
          400,
          'document_required',
          'Their work authorization ended before the rehire date: record the document you examined and its new expiry (or that it doesn’t expire).',
        );
      }
    }

    const asDate = (k: string) => new Date(`${k}T00:00:00.000Z`);
    const number = d.documentNumber?.trim() ?? null;
    const withDocument = !!d.documentTitle && !!number;
    const tenantId = tenantIdForWrite();
    const created = await prisma.$transaction(async (tx) => {
      const rec = await tx.i9Reverification.create({
        data: {
          tenantId,
          associateId: associate.id,
          i9VerificationId: i9.id,
          kind,
          rehiredOn: kind === 'REHIRE' ? asDate(d.rehiredOn!) : null,
          documentTitle: withDocument ? d.documentTitle! : null,
          documentNumberEnc: withDocument ? encryptString(number!) : null,
          documentNumberLast4: withDocument ? number!.replace(/[^A-Za-z0-9]/g, '').slice(-4) || null : null,
          issuingAuthority: withDocument ? d.issuingAuthority?.trim() || null : null,
          previousExpiresAt: i9.workAuthExpiresAt,
          newExpiresAt: withDocument && d.newExpiresAt ? asDate(d.newExpiresAt) : withDocument ? null : i9.workAuthExpiresAt,
          reviewedById: req.user!.id,
          reviewedOn: asDate(reviewedOn),
          notes: d.notes?.trim() || null,
        },
        include: { reviewedBy: { select: { email: true } } },
      });
      // A document moves the authorization's end; a rehire with none leaves it.
      if (withDocument) {
        await tx.i9Verification.update({
          where: { id: i9.id },
          data: { workAuthExpiresAt: d.newExpiresAt ? asDate(d.newExpiresAt) : null },
        });
      }
      return rec;
    });

    await recordComplianceEvent({
      actorUserId: req.user!.id,
      action: kind === 'REHIRE' ? 'compliance.i9_rehire_recorded' : 'compliance.i9_reverified',
      entityType: 'I9Verification',
      entityId: i9.id,
      associateId: associate.id,
      metadata: {
        reverificationId: created.id,
        kind,
        rehiredOn: d.rehiredOn ?? null,
        documentTitle: created.documentTitle,
        documentNumberLast4: created.documentNumberLast4,
        previousExpiresAt: i9.workAuthExpiresAt ? ymd(i9.workAuthExpiresAt) : null,
        newExpiresAt: created.newExpiresAt ? ymd(created.newExpiresAt) : null,
        reviewedOn,
      },
      req,
    });

    res.status(201).json(I9ReverificationSchema.parse(toReverification(created)));
  } catch (err) {
    next(err);
  }
});

/* ----- I-9 destruction past retention ------------------------------------ */

/** The I-9 copies destroyed with the form: the documents Section 2 named, and every I-9 supporting paper and E-Verify result. */
const I9_DESTROY_KINDS = ['I9_SUPPORTING', 'I9_VERIFICATION_RESULT'] as const;

type DestroyOutcome =
  | { ok: true; associateId: string; documents: number; blobKeys: string[] }
  | { ok: false; associateId: string; code: string; message: string };

/**
 * Destroy one I-9 past retention (owner, 2026-11-03), inside a transaction
 * that checks the rule again: the person left (Former — never someone
 * current, paused, starting or rehired) and the later of three years from
 * hire and one year from the last day worked is behind us. Deletes the I-9,
 * its Supplement B entries and the I-9 document copies; never the person,
 * their separation, pay or anything else. Blobs go after the transaction.
 */
async function destroyOneI9(req: Request, associateId: string, now: Date): Promise<DestroyOutcome> {
  const associate = await prisma.associate.findFirst({
    where: { AND: [{ id: associateId, deletedAt: null, tenantId: tenantIdForWrite() }, i9ListReach(req.user!)] },
    select: { id: true, separatedAt: true },
  });
  if (!associate) return { ok: false, associateId, code: 'not_found', message: 'Not found.' };
  const standing = (await peopleStandings({ tenantId: tenantIdForWrite(), associateIds: [associateId] }, now)).people.get(associateId);
  if (standing?.status !== 'SEPARATED') {
    return { ok: false, associateId, code: 'still_employed', message: 'This person is not a former employee: their I-9 must be kept.' };
  }
  const hired = await hireDatesFor(prisma, [associateId]);
  const ended = (await terminationDaysFor(prisma, [associate])).get(associateId) ?? null;
  const hireKey = hired.get(associateId)?.date ?? null;
  const retainUntil = i9RetainUntil(hireKey, ended);
  if (!i9PastRetention(retainUntil, ended, now)) {
    const until = retainUntil ? fmtDay(ymd(retainUntil), { year: true }) : null;
    return { ok: false, associateId, code: 'retention_not_over', message: until ? `This I-9 must be kept until ${until}.` : 'This I-9 must be kept: there is no hire date to count from.' };
  }
  try {
    return await prisma.$transaction(async (tx) => {
      // Again, inside the transaction: the same rule, on the rows as they are now.
      const i9 = await tx.i9Verification.findFirst({
        where: { AND: [{ associateId, tenantId: tenantIdForWrite() }, i9RetentionWhere(now), { associate: { separatedAt: { not: null } } }] },
        select: { id: true, supportingDocIds: true },
      });
      if (!i9) throw new HttpError(409, 'retention_not_over', 'This I-9 must be kept: it is not past retention.');
      const named = Array.isArray(i9.supportingDocIds) ? (i9.supportingDocIds as string[]) : [];
      const docs = await tx.documentRecord.findMany({
        where: {
          associateId,
          OR: [{ id: { in: named } }, { kind: { in: [...I9_DESTROY_KINDS] } }],
          // A signed document is evidence of something else: it stays.
          signatures: { none: {} },
        },
        select: { id: true, s3Key: true },
      });
      await tx.i9Reverification.deleteMany({ where: { i9VerificationId: i9.id } });
      await tx.i9Verification.delete({ where: { id: i9.id } });
      if (docs.length) await tx.documentRecord.deleteMany({ where: { id: { in: docs.map((d) => d.id) } } });
      return { ok: true as const, associateId, documents: docs.length, blobKeys: docs.map((d) => d.s3Key).filter((k): k is string => !!k) };
    });
  } catch (err) {
    if (err instanceof HttpError) return { ok: false, associateId, code: err.code, message: err.message };
    throw err;
  }
}

/** After the transaction: the permanent audit row (no name, no numbers), then the files, best-effort. */
async function afterDestroy(req: Request, d: Extract<DestroyOutcome, { ok: true }>, now: Date): Promise<void> {
  const [hired, ended] = await Promise.all([
    hireDatesFor(prisma, [d.associateId]),
    prisma.associate.findUnique({ where: { id: d.associateId }, select: { id: true, separatedAt: true } }).then((a) => (a ? terminationDaysFor(prisma, [a]) : new Map<string, string | null>())),
  ]);
  const hireKey = hired.get(d.associateId)?.date ?? null;
  const lastDay = ended.get(d.associateId) ?? null;
  const retainUntil = i9RetainUntil(hireKey, lastDay);
  await recordCriticalAudit(
    {
      actorUserId: req.user!.id,
      tenantId: tenantIdForWrite(),
      action: 'compliance.i9_destroyed',
      entityType: 'Associate',
      entityId: d.associateId,
      metadata: {
        associateId: d.associateId,
        retainUntil: retainUntil ? ymd(retainUntil) : null,
        hireDate: hireKey,
        lastDayWorked: lastDay,
        documentsDestroyed: d.documents,
        destroyedAt: now.toISOString(),
      },
    },
    'compliance.i9_destroyed',
  );
  const store = getBlobStore();
  for (const key of d.blobKeys) {
    try {
      await store.delete(key);
    } catch (err) {
      logger.warn({ err, associateId: d.associateId }, 'i9 destroy: blob delete failed (already gone?)');
    }
  }
}

async function destroyI9s(req: Request, associateIds: string[]) {
  const now = new Date();
  const destroyed: Array<{ associateId: string; documents: number }> = [];
  const refused: Array<{ associateId: string; code: string; message: string }> = [];
  for (const id of associateIds) {
    const r = await destroyOneI9(req, id, now);
    if (r.ok) {
      await afterDestroy(req, r, now);
      destroyed.push({ associateId: r.associateId, documents: r.documents });
    } else {
      refused.push({ associateId: r.associateId, code: r.code, message: r.message });
    }
  }
  return I9DestroyResponseSchema.parse({ destroyed, refused });
}

/** Destroy one I-9 past retention: the typed word DESTROY confirms it. 404 outside reach, 409 while it must be kept. */
complianceRouter.post('/i9/:associateId/destroy', MANAGE, async (req, res, next) => {
  try {
    const id = z.string().uuid().safeParse(req.params.associateId);
    if (!id.success) throw new HttpError(404, 'associate_not_found', 'Associate not found');
    const parsed = I9DestroyInputSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    if (parsed.data.confirm !== I9_DESTROY_WORD) {
      throw new HttpError(400, 'confirmation_mismatch', `Type ${I9_DESTROY_WORD} to confirm.`);
    }
    const body = await destroyI9s(req, [id.data]);
    const refused = body.refused[0];
    if (refused) {
      throw new HttpError(refused.code === 'not_found' ? 404 : 409, refused.code === 'not_found' ? 'associate_not_found' : refused.code, refused.code === 'not_found' ? 'Associate not found' : refused.message);
    }
    res.json(body);
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
  /** Where the person stands (lib/peopleStatus); left out where the caller didn't read it. */
  workStatus?: WorkStatus | null,
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
    ...(workStatus !== undefined ? { workStatus } : {}),
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

const BG_STATUSES: readonly BgCheckStatus[] = ['INITIATED', 'IN_PROGRESS', 'PASSED', 'FAILED', 'NEEDS_REVIEW', 'NOT_RUN'];

/**
 * GET /compliance/background — the screening ledger for one group of people
 * (`?workforce=current|starting|paused|former|all`, default current; owner,
 * 2026-11-03). It used to draw the newest 200 checks of everyone who ever
 * worked here: 255 checks in production, so the oldest were silently gone,
 * and seven in ten rows were people who had left.
 *
 * Alongside the checks, `people` is everyone in the group and the caller's
 * reach, checked or not — the tab's "No passed check" view and its "Last
 * passed" column. A report counts on the check it was filed under (lib/
 * screeningRecords reportWindows), not on every check the person has.
 */
complianceRouter.get('/background', async (req, res, next) => {
  try {
    const now = new Date();
    const tenantId = tenantIdForWrite();
    const workforce = workforceFromQuery(req.query);
    const asked = req.query.status?.toString();
    const status = BG_STATUSES.find((s) => s === asked) ?? null;
    const reach = scopeWhere<Prisma.BackgroundCheckWhereInput>({ tenantId }, scopeBackgroundChecks(req.user!), status && { status });
    const reading = await readWorkforce(tenantId, now);
    const groupIds = reading.idsOf(workforce);
    const [listed, found, people] = await Promise.all([
      // The chips: the ledger's own people in the caller's reach, before the group narrows it.
      prisma.backgroundCheck.findMany({ where: reach, distinct: ['associateId'], select: { associateId: true } }),
      prisma.backgroundCheck.findMany({
        where: scopeWhere<Prisma.BackgroundCheckWhereInput>(reach, groupIds && { associateId: { in: groupIds } }),
        orderBy: [{ initiatedAt: 'desc' }, { id: 'desc' }],
        take: SCREENING_LIST_CAP + 1,
        include: BG_INCLUDE,
      }),
      prisma.associate.findMany({
        where: scopeWhere<Prisma.AssociateWhereInput>({ tenantId, deletedAt: null }, groupIds && { id: { in: groupIds } }, scopeAssociates(req.user!)),
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
        take: SCREENING_LIST_CAP,
        select: { id: true, firstName: true, lastName: true, photoS3Key: true, photoUpdatedAt: true },
      }),
    ]);
    const truncated = found.length > SCREENING_LIST_CAP;
    const rows = found.slice(0, SCREENING_LIST_CAP);
    const concerned = [...new Set([...rows.map((r) => r.associateId), ...people.map((p) => p.id)])];
    // Every check of the people concerned, whatever the status filter, and
    // their filed reports: which check is newest, when they last passed,
    // and which reports belong to which check.
    const [every, docs, placement, ownNames] = await Promise.all([
      prisma.backgroundCheck.findMany({
        where: scopeWhere<Prisma.BackgroundCheckWhereInput>({ tenantId }, scopeBackgroundChecks(req.user!), { associateId: { in: concerned } }),
        select: { id: true, associateId: true, initiatedAt: true, status: true, completedAt: true },
      }),
      prisma.documentRecord.findMany({
        where: { associateId: { in: concerned }, kind: BG_REPORT_KIND, deletedAt: null },
        select: { associateId: true, createdAt: true },
      }),
      // Client label per row for the tab's client filter: the check's own
      // clientId wins when recorded (the client the screen was FOR), else the
      // associate's current placement.
      primaryClientsForAssociates(concerned),
      clientNamesById(rows.map((r) => r.clientId)),
    ]);
    const reportsByCheck = reportCounts(every, docs);
    const newest = latestByPerson(every);
    const byPerson = new Map<string, typeof every>();
    for (const c of every) byPerson.set(c.associateId, [...(byPerson.get(c.associateId) ?? []), c]);
    res.json(
      BackgroundCheckListResponseSchema.parse({
        checks: rows.map((r) => {
          const ref = r.clientId
            ? { clientId: r.clientId, clientName: ownNames.get(r.clientId) ?? null }
            : placement.get(r.associateId) ?? null;
          return toBg(r, reportsByCheck.get(r.id) ?? 0, ref, reading.statusOf(r.associateId));
        }),
        truncated,
        workforce,
        workforceCounts: countWorkforce(listed.map((l) => l.associateId), reading),
        people: people.map((p) => {
          const latest = newest.get(p.id) ?? null;
          const passed = lastPassedAt(byPerson.get(p.id) ?? []);
          return {
            associateId: p.id,
            associateName: `${p.firstName} ${p.lastName}`,
            associatePhotoUrl: profilePhotoUrlFor({ id: p.id, photoS3Key: p.photoS3Key, photoUpdatedAt: p.photoUpdatedAt }),
            clientId: placement.get(p.id)?.clientId ?? null,
            clientName: placement.get(p.id)?.clientName ?? null,
            workStatus: reading.statusOf(p.id),
            latestCheckId: latest?.id ?? null,
            latestStatus: latest?.status ?? null,
            lastPassedAt: passed?.toISOString() ?? null,
          };
        }),
      })
    );
  } catch (err) {
    next(err);
  }
});

/**
 * The bulk-order roster: everyone never screened — no check at all, or a
 * consent whose check never ran (NOT_RUN) — shaped for the provider's
 * bulk-invitation CSV. Registered before /background/:id so "pending" isn't
 * swallowed as an id. MANAGE because its only purpose is feeding an ordering
 * workflow, and the read is audited as an export.
 *
 * People are grouped by their one status (lib/complianceWorkforce, owner
 * 2026-11-03), not by "any approved application = active": Current and
 * Starting soon are ticked in the dialog, Paused is listed unticked, and
 * people who left are never listed — screening them is wasted spend.
 */
complianceRouter.get('/background/pending', MANAGE, async (req, res, next) => {
  try {
    const tenantId = tenantIdForWrite();
    const reading = await readWorkforce(tenantId);
    const rosterIds = (['current', 'starting', 'paused'] as const).flatMap((w) => reading.idsOf(w) ?? []);
    const people = await prisma.associate.findMany({
      // The caller's reach: a store-bound office account orders for its own people.
      where: scopeWhere<Prisma.AssociateWhereInput>({ tenantId, deletedAt: null, id: { in: rosterIds } }, scopeAssociates(req.user!)),
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      select: { id: true, firstName: true, lastName: true, email: true, phone: true },
    });
    const checks = await prisma.backgroundCheck.findMany({
      where: { tenantId, associateId: { in: people.map((p) => p.id) } },
      select: { id: true, associateId: true, initiatedAt: true, status: true },
    });
    const newest = latestByPerson(checks);
    const due = people.flatMap((p) => {
      const latest = newest.get(p.id);
      const group = rosterGroupOf(reading.statusOf(p.id));
      if (!group || (latest && latest.status !== 'NOT_RUN')) return [];
      return [{ p, group, lastStatus: latest?.status ?? null }];
    });
    const truncated = due.length > SCREENING_LIST_CAP;
    const capped = due.slice(0, SCREENING_LIST_CAP);

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
        rows: capped.map(({ p, group, lastStatus }) => ({
          associateId: p.id,
          firstName: p.firstName,
          lastName: p.lastName,
          email: p.email,
          phone: p.phone,
          status: legacyRosterStatus(group),
          group,
          workStatus: reading.statusOf(p.id),
          lastStatus,
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
 * queue reflects the order. With a provider connected, the check's drawer
 * orders it through the connection instead (routes/providerActions). This
 * replaced the stubbed POST /compliance/background that wrote an
 * 'alto-stub' provider (10-21 audit).
 *
 * Re-screening (2026-11-03): a finished check — passed, failed — no longer
 * blocks a new one; only a check still in flight does (another admin
 * racing, or a report not yet decided). A consent whose check never ran
 * (NOT_RUN) IS the check this order runs: it moves to INITIATED rather than
 * leaving a never-run row behind.
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
    const tenantId = tenantIdForWrite();
    const associates = await prisma.associate.findMany({
      take: 500,
      // The people in the caller's reach only (scope-every-list).
      where: scopeWhere<Prisma.AssociateWhereInput>({ id: { in: parsed.data.associateIds }, deletedAt: null, tenantId }, scopeAssociates(req.user!)),
      select: {
        id: true,
        // Same clientId derivation as single initiate.
        applications: { select: { clientId: true }, take: 1 },
      },
    });
    if (parsed.data.associateIds.length === 1 && associates.length === 0) {
      throw new HttpError(404, 'associate_not_found', 'Associate not found');
    }
    const existing = await prisma.backgroundCheck.findMany({
      where: { tenantId, associateId: { in: associates.map((a) => a.id) } },
      select: { id: true, associateId: true, initiatedAt: true, status: true, adjudication: true },
    });
    const busy = new Set(existing.filter(backgroundInFlight).map((e) => e.associateId));
    const newest = latestByPerson(existing);
    const toRun = associates.filter((a) => !busy.has(a.id));
    const neverRan = toRun.filter((a) => newest.get(a.id)?.status === 'NOT_RUN');
    const fresh = toRun.filter((a) => newest.get(a.id)?.status !== 'NOT_RUN');
    const now = new Date();
    const ref = parsed.data.externalId || null;

    const reused = await Promise.all(
      neverRan.map((a) =>
        prisma.backgroundCheck.update({
          where: { id: newest.get(a.id)!.id },
          data: { provider: parsed.data.provider, externalId: ref, status: 'INITIATED', initiatedAt: now, completedAt: null, rawStatus: null, lastError: null },
          select: { id: true },
        }),
      ),
    );
    const made = fresh.length > 0
      ? await prisma.backgroundCheck.createManyAndReturn({
          data: fresh.map((a) => ({
            associateId: a.id,
            clientId: a.applications[0]?.clientId ?? null,
            provider: parsed.data.provider,
            externalId: ref,
            status: 'INITIATED' as const,
          })),
          select: { id: true },
        })
      : [];

    await recordComplianceEvent({
      actorUserId: req.user!.id,
      action: 'compliance.background_bulk_initiated',
      entityType: 'BackgroundCheck',
      entityId: 'bulk',
      associateId: 'bulk', // fleet-wide order — lands in metadata, no FK
      metadata: {
        provider: parsed.data.provider,
        requested: parsed.data.associateIds.length,
        created: toRun.length,
        rescreened: fresh.filter((a) => newest.has(a.id)).length,
        skipped: parsed.data.associateIds.length - toRun.length,
      },
      req,
    });

    res.json(
      BackgroundBulkInitiateResponseSchema.parse({
        created: toRun.length,
        skipped: parsed.data.associateIds.length - toRun.length,
        ids: [...reused, ...made].map((m) => m.id),
      })
    );
  } catch (err) {
    next(err);
  }
});

/** A check in the caller's tenant and reach (the check's and its person's), by the id in the path; 404 otherwise. */
async function bgCheckInReach(req: Request) {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) throw new HttpError(404, 'background_check_not_found', 'Background check not found');
  const row = await prisma.backgroundCheck.findFirst({
    where: scopeWhere<Prisma.BackgroundCheckWhereInput>(
      { id: id.data, tenantId: tenantIdForWrite() },
      scopeBackgroundChecks(req.user!),
      { associate: { is: scopeAssociates(req.user!) } },
    ),
    include: BG_INCLUDE,
  });
  if (!row) throw new HttpError(404, 'background_check_not_found', 'Background check not found');
  return row;
}

/**
 * Check + the report documents filed under it, for the drawer. Background
 * reports are FCRA-sensitive consumer reports, so every view of the report
 * list is a recorded disclosure — same treatment as the E-Verify case view.
 */
complianceRouter.get('/background/:id', async (req, res, next) => {
  try {
    const row = await bgCheckInReach(req);
    const window = await reportWindowOf('background', row);
    const docs = await prisma.documentRecord.findMany({
      take: 100,
      where: {
        associateId: row.associateId,
        kind: BG_REPORT_KIND,
        deletedAt: null,
        ...(window.from || window.to ? { createdAt: { ...(window.from ? { gte: window.from } : {}), ...(window.to ? { lt: window.to } : {}) } } : {}),
      },
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
    const standing = await statusesOf(tenantIdForWrite(), [row.associateId]);

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
        check: toBg(row, reports.length, undefined, standing.get(row.associateId) ?? null),
        reports,
      })
    );
  } catch (err) {
    next(err);
  }
});

/**
 * A status recorded by hand. Two FCRA rules ride on it (2026-11-03):
 *  - FAILED is not a button: failing someone on a consumer report takes the
 *    pre-adverse notice, the wait and the final notice, and the final notice
 *    is what records FAILED. Anything else answers 409 and says the steps.
 *  - PASSED on a check in the adverse-action flow is the decision to clear
 *    them: it is recorded (adjudication ENGAGED), so the check leaves the
 *    worklist and a later provider refresh does not put it back for review.
 */
complianceRouter.post('/background/:id/update', MANAGE, async (req, res, next) => {
  try {
    const parsed = BackgroundUpdateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const existing = await bgCheckInReach(req);
    const target = parsed.data.status;
    if (target === 'FAILED' && existing.adjudication !== 'ADVERSE') {
      throw new HttpError(
        409,
        'adverse_action_required',
        viaProvider(existing)
          ? `To fail this check, start the adverse action in the ${existing.provider} panel on the check: the pre-adverse notice, the waiting period, then the final notice. The final notice records it as failed.`
          : 'To fail this check, send the pre-adverse notice with the report first, wait out the response period, then send the final notice. The final notice records it as failed.',
      );
    }
    if (existing.adjudication === 'PRE_ADVERSE' && target !== 'PASSED' && target !== 'NEEDS_REVIEW') {
      throw new HttpError(409, 'adverse_in_progress', 'A pre-adverse notice is out. Send the final notice once the wait is over, or clear them.');
    }
    if (existing.adjudication === 'PRE_ADVERSE' && target === 'PASSED' && viaProvider(existing)) {
      throw new HttpError(
        409,
        'use_provider_flow',
        `Withdraw the adverse action in the ${existing.provider} panel on this check, so ${existing.provider} cancels the final notice it has scheduled.`,
      );
    }
    const isTerminal = target === 'PASSED' || target === 'FAILED' || target === 'NEEDS_REVIEW';
    // Moving a decided check back to review (or in progress) un-decides it, so it is decided again.
    const reopened = (target === 'NEEDS_REVIEW' || target === 'IN_PROGRESS' || target === 'INITIATED') && (existing.adjudication === 'ENGAGED' || existing.adjudication === 'ADVERSE');
    const updated = await prisma.backgroundCheck.update({
      where: { id: existing.id },
      data: {
        status: target,
        externalId: parsed.data.externalId ?? existing.externalId,
        completedAt: isTerminal ? new Date() : null,
        ...(target === 'PASSED' ? { adjudication: 'ENGAGED', adverseWaitUntil: null } : {}),
        ...(reopened ? { adjudication: null } : {}),
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
      metadata: { status: updated.status, ...(existing.adjudication !== updated.adjudication ? { adjudication: updated.adjudication, was: existing.adjudication } : {}) },
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
// routes cover the checks recorded by hand. The notice helpers live in
// lib/screeningRecords, shared with drug tests obtained through an agency.

async function manualCheckFor(req: Request) {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) throw new HttpError(404, 'background_check_not_found', 'Background check not found');
  const c = await prisma.backgroundCheck.findFirst({
    where: { AND: [{ id: id.data }, { tenantId: tenantIdForWrite() }, scopeBackgroundChecks(req.user!), { associate: { is: scopeAssociates(req.user!) } }] },
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

/** The newest report filed under this check, as an attachment — the notice must carry a copy. */
async function reportAttachment(c: { id: string; associateId: string; initiatedAt: Date }): Promise<SendAttachment | null> {
  return reportAttachmentFor(BG_REPORT_KIND, c.associateId, await reportWindowOf('background', c));
}

const BG_NOTICE_BELL = 'An important notice about your background check — please read it and the enclosed report.';

complianceRouter.post('/background/:id/pre-adverse', MANAGE, async (req, res, next) => {
  try {
    const { waitDays } = z
      .object({ waitDays: z.number().int().min(ADVERSE_MIN_WAIT_DAYS).max(30).optional() })
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
    const attachment = await reportAttachment(c);
    if (!attachment) {
      throw new HttpError(
        409,
        'no_report_on_file',
        'Upload the background report first — the pre-adverse notice has to include a copy of it.',
      );
    }
    const waitUntil = new Date(Date.now() + (waitDays ?? ADVERSE_DEFAULT_WAIT_DAYS) * 86_400_000);
    await deliverAdverseNotice(c.associate, preAdverseNotice(adverseNoticeInput(c, attachment.filename, waitUntil)), attachment, BG_NOTICE_BELL);
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
    const attachment = await reportAttachment(c);
    if (!attachment) {
      throw new HttpError(409, 'no_report_on_file', 'The background report is no longer on file — upload it again before sending the final notice.');
    }
    await deliverAdverseNotice(c.associate, finalAdverseNotice(adverseNoticeInput(c, attachment.filename)), attachment, BG_NOTICE_BELL);
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
 * For one group of people (`?workforce=`, default current — the same group
 * the tab shows) or, on this list alone, several (`?workforce=current,starting`:
 * the Inbox row's view, since adverse action is mostly about applicants),
 * drawn in a fixed order so the cap can never pick an arbitrary 500.
 */
complianceRouter.get('/adverse-actions', async (req, res, next) => {
  try {
    const now = new Date();
    const tenantId = tenantIdForWrite();
    const workforces = workforcesFromQuery(req.query);
    const found = await prisma.backgroundCheck.findMany({
      where: {
        AND: [
          { tenantId },
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
      orderBy: [{ adverseWaitUntil: 'asc' }, { initiatedAt: 'desc' }, { id: 'asc' }],
      take: SCREENING_LIST_CAP + 1,
    });
    const truncated = found.length > SCREENING_LIST_CAP;
    const staged = found
      .slice(0, SCREENING_LIST_CAP)
      .map((r) => ({ r, stage: adverseStageOf(r, now) }))
      .filter((x): x is { r: (typeof found)[number]; stage: AdverseStage } => x.stage !== null);
    const reading = await readWorkforce(tenantId, now);
    const out = staged
      .filter(({ r }) => workforces.some((w) => reading.includes(r.associateId, w)))
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
        workStatus: reading.statusOf(r.associateId),
      }));
    res.json(
      AdverseActionListResponseSchema.parse({
        rows: out,
        truncated,
        ...(workforces.length === 1 ? { workforce: workforces[0] } : {}),
        workforces,
        workforceCounts: countWorkforce(staged.map(({ r }) => r.associateId), reading),
      }),
    );
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

// The list and the row view live in lib/j1Roster (cleared to work, owner
// 2026-11-03): who (the compliance groups and their counts), the program
// end the scheduling block reads, the next shift, and shifts and punches
// after the program end.

complianceRouter.get('/j1', async (req, res, next) => {
  try {
    res.json(J1ListResponseSchema.parse(await j1Roster(req.user!, req.query)));
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
    // Reach (owner, 2026-11-03): the write names a person by id, so it must
    // be someone the caller can see — 404 outside it, as if not there.
    const associate = await prisma.associate.findFirst({
      where: { AND: [{ id: req.params.associateId, deletedAt: null, tenantId: tenantIdForWrite() }, scopeAssociates(req.user!)] },
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
    // so the alerts, the H-2B rule and the cleared-to-work block read one source.
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

    const [view]: J1Profile[] = await j1ProfilesView([row]);
    res.json(view);
  } catch (err) {
    next(err);
  }
});
