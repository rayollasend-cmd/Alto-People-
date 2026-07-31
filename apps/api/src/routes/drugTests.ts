import { Router } from 'express';
import { existsSync } from 'node:fs';
import { Prisma } from '@prisma/client';
import {
  DrugTestBulkInitiateInputSchema,
  DrugTestBulkInitiateResponseSchema,
  DrugTestDetailSchema,
  DrugTestInitiateInputSchema,
  DrugTestListResponseSchema,
  DrugTestPendingResponseSchema,
  DrugTestUpdateInputSchema,
  type DrugTest,
} from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { scopeDrugTests } from '../lib/scope.js';
import { resolveStoragePath } from '../lib/storage.js';
import { recordComplianceEvent } from '../lib/audit.js';

/**
 * Drug-test directorate — mirrors the background-check surface, with one
 * structural difference: the Walmart SOW (Exhibit E) requires a result
 * within 60 DAYS, so testing recurs. The pending roster is driven by the
 * recency of DRUG_TEST_RESULT documents (the same thing the compliance
 * scorecard's DRUG_TEST_60D signal reads), not by whether a ledger row
 * ever existed.
 *
 * Mounted under /compliance/drug-tests, inheriting the view:compliance
 * guard from the compliance router mount in app.ts.
 */
export const drugTestsRouter = Router();

const MANAGE = requireCapability('manage:compliance');

/** Result PDFs are stored as documents of this kind, keyed by associate —
 *  the same pattern as background reports and E-Verify packets. */
const RESULT_KIND = 'DRUG_TEST_RESULT' as const;

/** The Walmart SOW's recency window for a valid result. */
const RESULT_WINDOW_DAYS = 60;

type RawTest = Prisma.DrugTestGetPayload<{
  include: { associate: { select: { firstName: true; lastName: true } } };
}>;

const TEST_INCLUDE = {
  associate: { select: { firstName: true, lastName: true } },
} as const;

function toTest(row: RawTest, reportCount?: number): DrugTest {
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

drugTestsRouter.get('/', async (req, res, next) => {
  try {
    const status = req.query.status?.toString();
    const where: Prisma.DrugTestWhereInput = {
      ...scopeDrugTests(req.user!),
      ...(status ? { status: status as Prisma.DrugTestWhereInput['status'] } : {}),
    };
    const rows = await prisma.drugTest.findMany({
      where,
      orderBy: { initiatedAt: 'desc' },
      take: 200,
      include: TEST_INCLUDE,
    });
    // Result-on-file counts in one grouped query — no N+1.
    const counts = await prisma.documentRecord.groupBy({
      by: ['associateId'],
      where: {
        associateId: { in: rows.map((r) => r.associateId) },
        kind: RESULT_KIND,
        deletedAt: null,
      },
      _count: { _all: true },
    });
    const reportsByAssociate = new Map(counts.map((c) => [c.associateId, c._count._all]));
    res.json(
      DrugTestListResponseSchema.parse({
        tests: rows.map((r) => toTest(r, reportsByAssociate.get(r.associateId) ?? 0)),
      })
    );
  } catch (err) {
    next(err);
  }
});

/**
 * Everyone who NEEDS a test: no result document inside the 60-day window,
 * no order already in flight, and no recent passed test awaiting its
 * paperwork. Registered before /:id so "pending" isn't swallowed as an id.
 */
drugTestsRouter.get('/pending', MANAGE, async (req, res, next) => {
  try {
    const cutoff = new Date(Date.now() - RESULT_WINDOW_DAYS * 86_400_000);
    const rows = await prisma.associate.findMany({
      take: 501, // one past the cap so truncation is detectable
      where: {
        deletedAt: null,
        // No result filed inside the window…
        documents: {
          none: { kind: RESULT_KIND, deletedAt: null, createdAt: { gte: cutoff } },
        },
        // …and no order in flight, and no recent PASS still awaiting its
        // paperwork — either would make a new order wasted spend.
        drugTests: {
          none: {
            OR: [
              { status: { in: ['INITIATED', 'IN_PROGRESS'] } },
              { status: 'PASSED', completedAt: { gte: cutoff } },
            ],
          },
        },
      },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        applications: { where: { deletedAt: null }, select: { status: true } },
        // Newest result doc, if any — lets the UI say "expired" vs "never".
        documents: {
          where: { kind: RESULT_KIND, deletedAt: null },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { createdAt: true },
        },
      },
    });
    const truncated = rows.length > 500;
    const capped = rows.slice(0, 500);

    // Same status rule as the People directory (directory.ts).
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
      action: 'compliance.drug_test_pending_exported',
      entityType: 'DrugTest',
      entityId: 'bulk',
      associateId: 'bulk', // fleet-wide export — lands in metadata, no FK
      metadata: { count: capped.length, truncated },
      req,
    });

    res.json(
      DrugTestPendingResponseSchema.parse({
        rows: capped.map((a) => ({
          associateId: a.id,
          firstName: a.firstName,
          lastName: a.lastName,
          email: a.email,
          phone: a.phone,
          status: statusOf(a.applications),
          lastResultAt: a.documents[0]?.createdAt.toISOString() ?? null,
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
 * to the provider succeeds, never on download. Associates who gained an open
 * order in the meantime are skipped, not duplicated. A CLOSED history row
 * (older passed/failed test) does NOT block — re-testing is the point.
 */
drugTestsRouter.post('/bulk-initiate', MANAGE, async (req, res, next) => {
  try {
    const parsed = DrugTestBulkInitiateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const associates = await prisma.associate.findMany({
      take: 500,
      where: { id: { in: parsed.data.associateIds }, deletedAt: null },
      select: {
        id: true,
        applications: { select: { clientId: true }, take: 1 },
      },
    });
    const openOrders = await prisma.drugTest.findMany({
      where: {
        associateId: { in: associates.map((a) => a.id) },
        status: { in: ['INITIATED', 'IN_PROGRESS'] },
      },
      select: { associateId: true },
    });
    const hasOpen = new Set(openOrders.map((o) => o.associateId));
    const toCreate = associates.filter((a) => !hasOpen.has(a.id));

    if (toCreate.length > 0) {
      await prisma.drugTest.createMany({
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
      action: 'compliance.drug_test_bulk_initiated',
      entityType: 'DrugTest',
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
      DrugTestBulkInitiateResponseSchema.parse({
        created: toCreate.length,
        skipped: parsed.data.associateIds.length - toCreate.length,
      })
    );
  } catch (err) {
    next(err);
  }
});

/**
 * Test + its associate's result documents, for the drawer. Drug-test results
 * are sensitive medical-adjacent records, so every view of the result list
 * is a recorded disclosure — same treatment as background reports.
 */
drugTestsRouter.get('/:id', async (req, res, next) => {
  try {
    const row = await prisma.drugTest.findFirst({
      where: { id: req.params.id, ...scopeDrugTests(req.user!) },
      include: TEST_INCLUDE,
    });
    if (!row) {
      throw new HttpError(404, 'drug_test_not_found', 'Drug test not found');
    }
    const docs = await prisma.documentRecord.findMany({
      take: 100,
      where: { associateId: row.associateId, kind: RESULT_KIND, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true, kind: true, filename: true, mimeType: true, s3Key: true },
    });
    const reports = docs.map((d) => ({
      id: d.id,
      kind: d.kind,
      filename: d.filename,
      mimeType: d.mimeType,
      fileAvailable: d.s3Key !== null && existsSync(resolveStoragePath(d.s3Key)),
    }));

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
        test: toTest(row, reports.length),
        reports,
      })
    );
  } catch (err) {
    next(err);
  }
});

/** Order a single test. STUBBED like background checks: the row records the
 *  order; HR runs it in the provider portal and flips status via /update. */
drugTestsRouter.post('/', MANAGE, async (req, res, next) => {
  try {
    const parsed = DrugTestInitiateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const associate = await prisma.associate.findFirst({
      where: { id: parsed.data.associateId, deletedAt: null },
      include: { applications: { select: { clientId: true }, take: 1 } },
    });
    if (!associate) throw new HttpError(404, 'associate_not_found', 'Associate not found');

    const created = await prisma.drugTest.create({
      data: {
        associateId: associate.id,
        clientId: associate.applications[0]?.clientId ?? null,
        provider: parsed.data.provider,
        externalId: parsed.data.externalId ?? null,
        status: 'INITIATED',
      },
      include: TEST_INCLUDE,
    });

    await recordComplianceEvent({
      actorUserId: req.user!.id,
      action: 'compliance.drug_test_initiated',
      entityType: 'DrugTest',
      entityId: created.id,
      associateId: associate.id,
      clientId: created.clientId,
      metadata: { provider: created.provider, stub: true },
      req,
    });

    res.status(201).json(toTest(created));
  } catch (err) {
    next(err);
  }
});

drugTestsRouter.post('/:id/update', MANAGE, async (req, res, next) => {
  try {
    const parsed = DrugTestUpdateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const existing = await prisma.drugTest.findFirst({
      where: { id: req.params.id, ...scopeDrugTests(req.user!) },
    });
    if (!existing) {
      throw new HttpError(404, 'drug_test_not_found', 'Drug test not found');
    }
    const isTerminal =
      parsed.data.status === 'PASSED' ||
      parsed.data.status === 'FAILED' ||
      parsed.data.status === 'NEEDS_REVIEW';
    const updated = await prisma.drugTest.update({
      where: { id: existing.id },
      data: {
        status: parsed.data.status,
        externalId: parsed.data.externalId ?? existing.externalId,
        completedAt: isTerminal ? new Date() : null,
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
      metadata: { status: updated.status },
      req,
    });
    res.json(toTest(updated));
  } catch (err) {
    next(err);
  }
});
