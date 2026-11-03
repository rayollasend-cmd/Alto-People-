import { Router, type Request } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  DrugTestBulkInitiateInputSchema,
  DrugTestBulkInitiateResponseSchema,
  DrugTestDetailSchema,
  DrugTestListResponseSchema,
  DrugTestPendingResponseSchema,
  DrugTestUpdateInputSchema,
  type DrugTest,
  type DrugTestStatus,
  type WorkStatus,
} from '@alto-people/shared';
import { prisma } from '../db.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { scopeAssociates, scopeDrugTests, scopeWhere } from '../lib/scope.js';
import {
  clientNamesById,
  primaryClientsForAssociates,
} from '../lib/associateClients.js';
import { blobExistsForListing } from '../lib/blobStore.js';
import { recordComplianceEvent } from '../lib/audit.js';
import { profilePhotoUrlFor } from '../lib/profilePhotoUrl.js';
import { countWorkforce, readWorkforce, workforceFromQuery } from '../lib/complianceWorkforce.js';
import { finalAdverseNotice, preAdverseNotice } from '../lib/hiringCompliance.js';
import { fmtDay } from '../lib/humanDates.js';
import { orgDateKey } from '../lib/timeAnomalies.js';
import {
  ADVERSE_DEFAULT_WAIT_DAYS,
  ADVERSE_MIN_WAIT_DAYS,
  SCREENING_LIST_CAP,
  adverseNoticeInput,
  deliverAdverseNotice,
  drugClockFrom,
  drugOrderBlocked,
  drugResultDue,
  isConsumerReportingAgency,
  lastPassedAt,
  latestByPerson,
  legacyRosterStatus,
  reportAttachmentFor,
  reportCounts,
  reportWindowOf,
  rosterGroupOf,
  statusesOf,
} from '../lib/screeningRecords.js';

/**
 * Drug-test directorate — mirrors the background-check surface, with one
 * structural difference: the Walmart SOW (Exhibit E) requires a result
 * within 60 DAYS, so testing recurs. The pending roster is driven by when
 * the person's newest passed test finished (2026-11-03: it used to be when
 * someone filed the PDF, so a late upload reset the clock), not by whether a
 * ledger row ever existed.
 *
 * Mounted under /compliance/drug-tests, inheriting the view:compliance
 * guard from the compliance router mount in app.ts. Lists are about one
 * group of people (`?workforce=`, default current; owner 2026-11-03), the
 * same group on every compliance tab (lib/complianceWorkforce).
 */
export const drugTestsRouter = Router();

const MANAGE = requireCapability('manage:compliance');

/** Result PDFs are stored as documents of this kind, keyed by associate —
 *  the same pattern as background reports and E-Verify packets. */
const RESULT_KIND = 'DRUG_TEST_RESULT' as const;

const DRUG_STATUSES: readonly DrugTestStatus[] = ['INITIATED', 'IN_PROGRESS', 'PASSED', 'FAILED', 'NEEDS_REVIEW'];

type RawTest = Prisma.DrugTestGetPayload<{
  include: { associate: { select: { firstName: true; lastName: true; photoS3Key: true; photoUpdatedAt: true } } };
}>;

const TEST_INCLUDE = {
  associate: { select: { firstName: true, lastName: true, photoS3Key: true, photoUpdatedAt: true } },
} as const;

function toTest(
  row: RawTest,
  reportCount?: number,
  client?: { clientId: string; clientName: string | null } | null,
  /** Where the person stands (lib/peopleStatus); left out where the caller didn't read it. */
  workStatus?: WorkStatus | null,
): DrugTest {
  return {
    id: row.id,
    associateId: row.associateId,
    associateName: `${row.associate.firstName} ${row.associate.lastName}`,
    associatePhotoUrl: profilePhotoUrlFor({ id: row.associateId, ...row.associate }),
    clientId: client?.clientId ?? row.clientId,
    clientName: client?.clientName ?? null,
    provider: row.provider,
    externalId: row.externalId,
    status: row.status,
    initiatedAt: row.initiatedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    ...(reportCount !== undefined ? { reportCount } : {}),
    ...(workStatus !== undefined ? { workStatus } : {}),
    reason: row.reason,
    viaCra: isConsumerReportingAgency(row.provider),
    adjudication: row.adjudication,
    preAdverseSentAt: row.preAdverseSentAt?.toISOString() ?? null,
    adverseWaitUntil: row.adverseWaitUntil?.toISOString() ?? null,
    adverseSentAt: row.adverseSentAt?.toISOString() ?? null,
  };
}

/** The newest result document filed per person (any date). */
async function newestResultFiled(associateIds: string[]): Promise<Map<string, Date>> {
  if (associateIds.length === 0) return new Map();
  const rows = await prisma.documentRecord.groupBy({
    by: ['associateId'],
    where: { associateId: { in: associateIds }, kind: RESULT_KIND, deletedAt: null },
    _max: { createdAt: true },
  });
  return new Map(rows.filter((r) => r._max.createdAt).map((r) => [r.associateId, r._max.createdAt!]));
}

drugTestsRouter.get('/', async (req, res, next) => {
  try {
    const now = new Date();
    const tenantId = tenantIdForWrite();
    const workforce = workforceFromQuery(req.query);
    const asked = req.query.status?.toString();
    const status = DRUG_STATUSES.find((s) => s === asked) ?? null;
    const reach = scopeWhere<Prisma.DrugTestWhereInput>({ tenantId }, scopeDrugTests(req.user!), status && { status });
    const reading = await readWorkforce(tenantId, now);
    const groupIds = reading.idsOf(workforce);
    const [listed, found, people] = await Promise.all([
      // The chips: the ledger's own people in the caller's reach, before the group narrows it.
      prisma.drugTest.findMany({ where: reach, distinct: ['associateId'], select: { associateId: true } }),
      prisma.drugTest.findMany({
        where: scopeWhere<Prisma.DrugTestWhereInput>(reach, groupIds && { associateId: { in: groupIds } }),
        orderBy: [{ initiatedAt: 'desc' }, { id: 'desc' }],
        take: SCREENING_LIST_CAP + 1,
        include: TEST_INCLUDE,
      }),
      // Everyone in the group and reach, tested or not — the "No passed test" view.
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
    // Every test of the people concerned, whatever the status filter, and
    // their filed results: which test is newest, when they last passed,
    // where the 60-day clock runs from, and which results are whose.
    const [every, docs, placement, ownNames] = await Promise.all([
      prisma.drugTest.findMany({
        where: scopeWhere<Prisma.DrugTestWhereInput>({ tenantId }, scopeDrugTests(req.user!), { associateId: { in: concerned } }),
        select: { id: true, associateId: true, initiatedAt: true, status: true, completedAt: true },
      }),
      prisma.documentRecord.findMany({
        where: { associateId: { in: concerned }, kind: RESULT_KIND, deletedAt: null },
        select: { associateId: true, createdAt: true },
      }),
      // Client label per row for the tab's client filter: the test's own
      // clientId wins when recorded, else the associate's current placement.
      primaryClientsForAssociates(concerned),
      clientNamesById(rows.map((r) => r.clientId)),
    ]);
    const reportsByTest = reportCounts(every, docs);
    const newest = latestByPerson(every);
    const byPerson = new Map<string, typeof every>();
    for (const t of every) byPerson.set(t.associateId, [...(byPerson.get(t.associateId) ?? []), t]);
    const filed = new Map<string, Date>();
    for (const d of docs) if (!filed.has(d.associateId) || d.createdAt > filed.get(d.associateId)!) filed.set(d.associateId, d.createdAt);
    res.json(
      DrugTestListResponseSchema.parse({
        tests: rows.map((r) => {
          const ref = r.clientId
            ? { clientId: r.clientId, clientName: ownNames.get(r.clientId) ?? null }
            : placement.get(r.associateId) ?? null;
          return toTest(r, reportsByTest.get(r.id) ?? 0, ref, reading.statusOf(r.associateId));
        }),
        truncated,
        workforce,
        workforceCounts: countWorkforce(listed.map((l) => l.associateId), reading),
        people: people.map((p) => {
          const tests = byPerson.get(p.id) ?? [];
          const latest = newest.get(p.id) ?? null;
          const passed = lastPassedAt(tests);
          const clock = drugClockFrom(tests, filed.get(p.id) ?? null);
          return {
            associateId: p.id,
            associateName: `${p.firstName} ${p.lastName}`,
            associatePhotoUrl: profilePhotoUrlFor({ id: p.id, photoS3Key: p.photoS3Key, photoUpdatedAt: p.photoUpdatedAt }),
            clientId: placement.get(p.id)?.clientId ?? null,
            clientName: placement.get(p.id)?.clientName ?? null,
            workStatus: reading.statusOf(p.id),
            latestTestId: latest?.id ?? null,
            latestStatus: latest?.status ?? null,
            lastPassedAt: passed?.toISOString() ?? null,
            lastResultAt: clock?.toISOString() ?? null,
          };
        }),
      })
    );
  } catch (err) {
    next(err);
  }
});

/**
 * Everyone who NEEDS a test: their 60-day clock ran out (or never started),
 * and no order is out or awaiting review. Registered before /:id so
 * "pending" isn't swallowed as an id.
 *
 * 2026-11-03: people are grouped by their one status (lib/complianceWorkforce),
 * not "any approved application = active" — Current and Starting soon are
 * ticked in the dialog, Paused listed unticked, people who left never listed.
 * A result awaiting the Medical Review Officer (NEEDS_REVIEW) or a failed
 * newest test (a decision is owed, not another test) keeps a person off it,
 * and the clock runs from the test's completion, not the PDF's upload.
 */
drugTestsRouter.get('/pending', MANAGE, async (req, res, next) => {
  try {
    const now = new Date();
    const tenantId = tenantIdForWrite();
    const reading = await readWorkforce(tenantId, now);
    const rosterIds = (['current', 'starting', 'paused'] as const).flatMap((w) => reading.idsOf(w) ?? []);
    const people = await prisma.associate.findMany({
      // The caller's reach: a store-bound office account orders for its own people.
      where: scopeWhere<Prisma.AssociateWhereInput>({ tenantId, deletedAt: null, id: { in: rosterIds } }, scopeAssociates(req.user!)),
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      select: { id: true, firstName: true, lastName: true, email: true, phone: true },
    });
    const ids = people.map((p) => p.id);
    const [tests, filed] = await Promise.all([
      prisma.drugTest.findMany({
        where: { tenantId, associateId: { in: ids } },
        select: { id: true, associateId: true, initiatedAt: true, status: true, completedAt: true, adjudication: true },
      }),
      newestResultFiled(ids),
    ]);
    const byPerson = new Map<string, typeof tests>();
    for (const t of tests) byPerson.set(t.associateId, [...(byPerson.get(t.associateId) ?? []), t]);
    const due = people.flatMap((p) => {
      const group = rosterGroupOf(reading.statusOf(p.id));
      const mine = byPerson.get(p.id) ?? [];
      const clock = drugClockFrom(mine, filed.get(p.id) ?? null);
      if (!group || !drugResultDue(clock, now) || drugOrderBlocked(mine, null)) return [];
      return [{ p, group, clock }];
    });
    const truncated = due.length > SCREENING_LIST_CAP;
    const capped = due.slice(0, SCREENING_LIST_CAP);

    await recordComplianceEvent({
      actorUserId: req.user!.id,
      action: 'compliance.drug_test_pending_exported',
      entityType: 'DrugTest',
      entityId: 'bulk',
      associateId: 'bulk', // fleet-wide export — lands in metadata, no FK
      metadata: { count: capped.length, truncated },
      req,
    });

    res.json(
      DrugTestPendingResponseSchema.parse({
        rows: capped.map(({ p, group, clock }) => ({
          associateId: p.id,
          firstName: p.firstName,
          lastName: p.lastName,
          email: p.email,
          phone: p.phone,
          status: legacyRosterStatus(group),
          group,
          workStatus: reading.statusOf(p.id),
          lastResultAt: clock?.toISOString() ?? null,
        })),
        truncated,
      })
    );
  } catch (err) {
    next(err);
  }
});

/**
 * Record that an order was actually placed — one person's (the Order test
 * dialog) or a bulk CSV upload, called AFTER the upload to the provider
 * succeeds, never on download. A CLOSED history row (an older passed test)
 * does NOT block — re-testing is the point. A test still out or awaiting
 * review does, and so does a failed newest test unless the order is the
 * return-to-duty or follow-up test that follows one (2026-11-03). Every
 * order records why it was ordered and who runs it ('manual' when not said
 * — it used to say 'checkr' whatever the truth).
 */
drugTestsRouter.post('/bulk-initiate', MANAGE, async (req, res, next) => {
  try {
    const parsed = DrugTestBulkInitiateInputSchema.safeParse(req.body);
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
        applications: { select: { clientId: true }, take: 1 },
      },
    });
    if (parsed.data.associateIds.length === 1 && associates.length === 0) {
      throw new HttpError(404, 'associate_not_found', 'Associate not found');
    }
    const history = await prisma.drugTest.findMany({
      where: { tenantId, associateId: { in: associates.map((a) => a.id) } },
      select: { id: true, associateId: true, initiatedAt: true, status: true, adjudication: true },
    });
    const byPerson = new Map<string, typeof history>();
    for (const t of history) byPerson.set(t.associateId, [...(byPerson.get(t.associateId) ?? []), t]);
    const reason = parsed.data.reason ?? null;
    const toCreate = associates.filter((a) => !drugOrderBlocked(byPerson.get(a.id) ?? [], reason));

    const made = toCreate.length > 0
      ? await prisma.drugTest.createManyAndReturn({
          data: toCreate.map((a) => ({
            associateId: a.id,
            clientId: a.applications[0]?.clientId ?? null,
            provider: parsed.data.provider,
            externalId: parsed.data.externalId || null,
            reason,
            status: 'INITIATED' as const,
          })),
          select: { id: true },
        })
      : [];

    await recordComplianceEvent({
      actorUserId: req.user!.id,
      action: 'compliance.drug_test_bulk_initiated',
      entityType: 'DrugTest',
      entityId: 'bulk',
      associateId: 'bulk', // fleet-wide order — lands in metadata, no FK
      metadata: {
        provider: parsed.data.provider,
        reason,
        requested: parsed.data.associateIds.length,
        created: toCreate.length,
        skipped: parsed.data.associateIds.length - toCreate.length,
      },
      req,
    });

    res.json(
      DrugTestBulkInitiateResponseSchema.parse({
        created: toCreate.length,
        skipped: parsed.data.associateIds.length - toCreate.length,
        ids: made.map((m) => m.id),
      })
    );
  } catch (err) {
    next(err);
  }
});

/** A test in the caller's tenant and reach (the test's and its person's), by the id in the path; 404 otherwise. */
async function testInReach(req: Request) {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) throw new HttpError(404, 'drug_test_not_found', 'Drug test not found');
  const row = await prisma.drugTest.findFirst({
    where: scopeWhere<Prisma.DrugTestWhereInput>(
      { id: id.data, tenantId: tenantIdForWrite() },
      scopeDrugTests(req.user!),
      { associate: { is: scopeAssociates(req.user!) } },
    ),
    include: TEST_INCLUDE,
  });
  if (!row) throw new HttpError(404, 'drug_test_not_found', 'Drug test not found');
  return row;
}

/**
 * Test + the result documents filed under it, for the drawer. Drug-test
 * results are sensitive medical-adjacent records, so every view of the
 * result list is a recorded disclosure — same treatment as background reports.
 */
drugTestsRouter.get('/:id', async (req, res, next) => {
  try {
    const row = await testInReach(req);
    const window = await reportWindowOf('drug', row);
    const docs = await prisma.documentRecord.findMany({
      take: 100,
      where: {
        associateId: row.associateId,
        kind: RESULT_KIND,
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
      action: 'compliance.drug_test_report_viewed',
      entityType: 'DrugTest',
      entityId: row.id,
      associateId: row.associateId,
      clientId: row.clientId,
      metadata: { reportCount: reports.length },
      req,
    });

    res.json(
      DrugTestDetailSchema.parse({
        test: toTest(row, reports.length, undefined, standing.get(row.associateId) ?? null),
        reports,
      })
    );
  } catch (err) {
    next(err);
  }
});

/**
 * A status recorded by hand. For a test obtained through a consumer
 * reporting agency (2026-11-03) the same FCRA rules ride on it as on a
 * background check: FAILED is recorded by the final adverse notice, not a
 * button (409 that says the steps), and PASSED on a test in those steps is
 * the decision to clear them. Any pass recorded by hand is a decision
 * (ENGAGED), so a later lab refresh does not put it back for review.
 */
drugTestsRouter.post('/:id/update', MANAGE, async (req, res, next) => {
  try {
    const parsed = DrugTestUpdateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const existing = await testInReach(req);
    const target = parsed.data.status;
    const viaCra = isConsumerReportingAgency(existing.provider);
    if (target === 'FAILED' && viaCra && existing.adjudication !== 'ADVERSE') {
      throw new HttpError(
        409,
        'adverse_action_required',
        `This result came through ${existing.provider}, a consumer reporting agency. To fail them on it, send the pre-adverse notice with the result first, wait out the response period, then send the final notice. The final notice records it as failed.`,
      );
    }
    if (existing.adjudication === 'PRE_ADVERSE' && target !== 'PASSED' && target !== 'NEEDS_REVIEW') {
      throw new HttpError(409, 'adverse_in_progress', 'A pre-adverse notice is out. Send the final notice once the wait is over, or clear them.');
    }
    const isTerminal = target === 'PASSED' || target === 'FAILED' || target === 'NEEDS_REVIEW';
    // Moving a decided test back to review (or in progress) un-decides it, so it is decided again.
    const reopened = (target === 'NEEDS_REVIEW' || target === 'IN_PROGRESS' || target === 'INITIATED') && (existing.adjudication === 'ENGAGED' || existing.adjudication === 'ADVERSE');
    const updated = await prisma.drugTest.update({
      where: { id: existing.id },
      data: {
        status: target,
        externalId: parsed.data.externalId ?? existing.externalId,
        completedAt: isTerminal ? new Date() : null,
        ...(target === 'PASSED' ? { adjudication: 'ENGAGED', adverseWaitUntil: null } : {}),
        ...(reopened ? { adjudication: null } : {}),
      },
      include: TEST_INCLUDE,
    });
    await recordComplianceEvent({
      actorUserId: req.user!.id,
      action: 'compliance.drug_test_updated',
      entityType: 'DrugTest',
      entityId: updated.id,
      associateId: updated.associateId,
      clientId: updated.clientId,
      metadata: { status: updated.status, ...(existing.adjudication !== updated.adjudication ? { adjudication: updated.adjudication, was: existing.adjudication } : {}) },
      req,
    });
    res.json(toTest(updated));
  } catch (err) {
    next(err);
  }
});

/* ----- FCRA adverse action for a test through an agency (2026-11-03) ------ *
 * A drug test ordered through a consumer reporting agency (Checkr, Sterling…)
 * is a consumer report: before deciding against someone on it, the pre-adverse
 * notice with a copy of the result and the summary of rights, a waiting
 * period, then the final notice — the same letters as a background check
 * (lib/hiringCompliance, delivered by lib/screeningRecords). A lab ordered
 * directly is not an agency; its result is decided after the Medical Review
 * Officer, with no notices.
 * -------------------------------------------------------------------------- */

const DRUG_NOTICE_BELL = 'An important notice about your drug test — please read it and the enclosed result.';

async function craTestFor(req: Request) {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) throw new HttpError(404, 'drug_test_not_found', 'Drug test not found');
  const t = await prisma.drugTest.findFirst({
    where: scopeWhere<Prisma.DrugTestWhereInput>(
      { id: id.data, tenantId: tenantIdForWrite() },
      scopeDrugTests(req.user!),
      { associate: { is: scopeAssociates(req.user!) } },
    ),
    include: { associate: { select: { id: true, firstName: true, lastName: true, email: true } } },
  });
  if (!t) throw new HttpError(404, 'drug_test_not_found', 'Drug test not found');
  if (!isConsumerReportingAgency(t.provider)) {
    throw new HttpError(
      409,
      'not_a_consumer_report',
      'This result came straight from the lab, not through a consumer reporting agency, so the FCRA notices don’t apply. Record the outcome once the Medical Review Officer has verified it.',
    );
  }
  return t;
}

async function resultAttachment(t: { id: string; associateId: string; initiatedAt: Date }) {
  return reportAttachmentFor(RESULT_KIND, t.associateId, await reportWindowOf('drug', t));
}

drugTestsRouter.post('/:id/pre-adverse', MANAGE, async (req, res, next) => {
  try {
    const { waitDays } = z
      .object({ waitDays: z.number().int().min(ADVERSE_MIN_WAIT_DAYS).max(30).optional() })
      .parse(req.body ?? {});
    const t = await craTestFor(req);
    if (t.adjudication === 'PRE_ADVERSE' || t.adjudication === 'ADVERSE') {
      throw new HttpError(409, 'already_started', 'Adverse action has already started for this test.');
    }
    if (t.status === 'PASSED') {
      throw new HttpError(409, 'report_clear', 'This test passed — there is nothing to take adverse action on.');
    }
    if (t.status !== 'NEEDS_REVIEW' && t.status !== 'FAILED') {
      throw new HttpError(409, 'not_decidable', 'Adverse action starts from a result that needs review. Record the result first.');
    }
    const attachment = await resultAttachment(t);
    if (!attachment) {
      throw new HttpError(409, 'no_report_on_file', 'Upload the result first — the pre-adverse notice has to include a copy of it.');
    }
    const waitUntil = new Date(Date.now() + (waitDays ?? ADVERSE_DEFAULT_WAIT_DAYS) * 86_400_000);
    await deliverAdverseNotice(t.associate, preAdverseNotice(adverseNoticeInput(t, attachment.filename, waitUntil)), attachment, DRUG_NOTICE_BELL);
    const updated = await prisma.drugTest.update({
      where: { id: t.id },
      data: { adjudication: 'PRE_ADVERSE', preAdverseSentAt: new Date(), adverseWaitUntil: waitUntil, status: 'NEEDS_REVIEW' },
      include: TEST_INCLUDE,
    });
    await recordComplianceEvent({
      actorUserId: req.user!.id,
      action: 'compliance.drug_test_pre_adverse',
      entityType: 'DrugTest',
      entityId: t.id,
      associateId: t.associateId,
      clientId: t.clientId,
      metadata: { waitUntil: waitUntil.toISOString(), report: attachment.filename },
      req,
    });
    res.json(toTest(updated));
  } catch (err) {
    next(err);
  }
});

drugTestsRouter.post('/:id/final-adverse', MANAGE, async (req, res, next) => {
  try {
    const t = await craTestFor(req);
    if (t.adjudication !== 'PRE_ADVERSE') {
      throw new HttpError(409, 'no_pre_adverse', 'Send the pre-adverse notice first.');
    }
    if (!t.adverseWaitUntil || t.adverseWaitUntil.getTime() > Date.now()) {
      throw new HttpError(
        409,
        'waiting_period',
        // An instant, said on the company's calendar (CODE-14), not UTC's.
        `They still have until ${t.adverseWaitUntil ? fmtDay(orgDateKey(t.adverseWaitUntil), { weekday: true }) : 'the end of the waiting period'} to respond to the pre-adverse notice.`,
      );
    }
    const attachment = await resultAttachment(t);
    if (!attachment) {
      throw new HttpError(409, 'no_report_on_file', 'The result is no longer on file — upload it again before sending the final notice.');
    }
    await deliverAdverseNotice(t.associate, finalAdverseNotice(adverseNoticeInput(t, attachment.filename)), attachment, DRUG_NOTICE_BELL);
    const now = new Date();
    const updated = await prisma.drugTest.update({
      where: { id: t.id },
      data: { adjudication: 'ADVERSE', adverseSentAt: now, status: 'FAILED', completedAt: now },
      include: TEST_INCLUDE,
    });
    await recordComplianceEvent({
      actorUserId: req.user!.id,
      action: 'compliance.drug_test_adverse',
      entityType: 'DrugTest',
      entityId: t.id,
      associateId: t.associateId,
      clientId: t.clientId,
      req,
    });
    res.json(toTest(updated));
  } catch (err) {
    next(err);
  }
});

drugTestsRouter.post('/:id/withdraw-adverse', MANAGE, async (req, res, next) => {
  try {
    const t = await craTestFor(req);
    if (t.adjudication !== 'PRE_ADVERSE') {
      throw new HttpError(409, 'not_pending', 'Only a pending adverse action can be withdrawn.');
    }
    const updated = await prisma.drugTest.update({
      where: { id: t.id },
      data: { adjudication: 'ENGAGED', status: 'PASSED', completedAt: new Date(), adverseWaitUntil: null },
      include: TEST_INCLUDE,
    });
    await recordComplianceEvent({
      actorUserId: req.user!.id,
      action: 'compliance.drug_test_adverse_withdrawn',
      entityType: 'DrugTest',
      entityId: t.id,
      associateId: t.associateId,
      clientId: t.clientId,
      req,
    });
    res.json(toTest(updated));
  } catch (err) {
    next(err);
  }
});
