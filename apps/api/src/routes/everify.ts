import { Router } from 'express';
import { existsSync } from 'node:fs';
import {
  EVerifyCaseDetailSchema,
  EVerifyCaseInputSchema,
  EVerifyIdentityInputSchema,
  EVerifyRosterResponseSchema,
  type EVerifyStatus,
} from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { recordComplianceEvent } from '../lib/audit.js';
import { tryDecryptString } from '../lib/crypto.js';
import { resolveStoragePath } from '../lib/storage.js';
import {
  evaluateEVerifyReadiness,
  isEVerifyOverdue,
} from '../lib/everifyReadiness.js';

/**
 * E-Verify directorate — a staging surface for the federal E-Verify portal.
 *
 * HR reported ~20 minutes per case, because the fields the government asks for
 * live on five different screens: name and DOB on the associate record, SSN
 * behind the W-4, citizenship status and document list on the I-9, and the
 * identity images in the onboarding checklist. These routes assemble them into
 * one payload, in the portal's own field order.
 *
 * This does NOT talk to E-Verify. Submitting cases programmatically requires a
 * DHS Web Services MOU and interface certification — a separate programme. HR
 * types into the portal and records the outcome here, which is also the first
 * time anything in the product can WRITE eVerifyStatus: the compliance
 * scorecard has been reading that field (and always finding null) since it
 * shipped, so its "E-Verify cleared" signal could never be earned.
 *
 * Mounted at /compliance/everify, inheriting the compliance router's
 * view:compliance guard. Anything returning a decrypted SSN adds MANAGE on
 * top — see the detail route.
 */
export const everifyRouter = Router();

const MANAGE = requireCapability('manage:compliance');

/** Cap mirrors the other compliance lists; reported so a cut is never silent. */
const EVERIFY_ROSTER_MAX = 500;

const NONCONFIRMATION: EVerifyStatus[] = [
  'TENTATIVE_NONCONFIRMATION',
  'FINAL_NONCONFIRMATION',
];

const IDENTITY_DOC_KINDS = [
  'I9_SUPPORTING',
  'ID',
  'SSN_CARD',
  'J1_VISA',
  'J1_DS2019',
] as const;

/**
 * The packet E-Verify returns when a case closes. Reuses the existing
 * I9_VERIFICATION_RESULT kind, whose schema comment already names E-Verify as
 * an intended source — no new enum value, so no migration.
 */
const EVERIFY_PACKET_KIND = 'I9_VERIFICATION_RESULT' as const;

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Everyone onboarded or currently onboarding.
 *
 * Driven by Associate, deliberately — NOT by I9Verification the way
 * GET /compliance/i9 is. Someone mid-onboarding has no I-9 row yet, so an
 * I-9-driven query would hide exactly the people who still need action, which
 * is the population this queue exists to surface.
 */
everifyRouter.get('/', async (_req, res, next) => {
  try {
    const rows = await prisma.associate.findMany({
      where: {
        deletedAt: null,
        // Onboarded or onboarding: any application that wasn't declined.
        applications: { some: { deletedAt: null, status: { not: 'REJECTED' } } },
      },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      take: EVERIFY_ROSTER_MAX + 1,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        dob: true,
        hireDate: true,
        ssnLast4: true,
        i9Verification: {
          select: {
            section1CompletedAt: true,
            section2CompletedAt: true,
            citizenshipStatus: true,
            eVerifyCaseNumber: true,
            eVerifyStatus: true,
            eVerifyCaseOpenedAt: true,
            eVerifyClosedAt: true,
          },
        },
        w4Submission: { select: { ssnEncrypted: true } },
      },
    });

    const truncated = rows.length > EVERIFY_ROSTER_MAX;
    const page = truncated ? rows.slice(0, EVERIFY_ROSTER_MAX) : rows;
    const now = new Date();

    const out = page.map((a) => {
      const i9 = a.i9Verification;
      const readiness = evaluateEVerifyReadiness({
        hasI9: !!i9,
        section1CompletedAt: i9?.section1CompletedAt ?? null,
        section2CompletedAt: i9?.section2CompletedAt ?? null,
        citizenshipStatus: i9?.citizenshipStatus ?? null,
        // Presence only here. Decrypting every row's SSN to compute a queue
        // boolean would be a lot of crypto per page load; the detail route
        // reports an unreadable blob when the case is actually opened.
        hasReadableSsn: !!a.w4Submission?.ssnEncrypted,
        dob: a.dob,
        hireDate: a.hireDate,
      });
      return {
        associateId: a.id,
        associateName: `${a.firstName} ${a.lastName}`,
        associateEmail: a.email,
        hireDate: a.hireDate ? ymd(a.hireDate) : null,
        ssnLast4: a.ssnLast4,
        caseNumber: i9?.eVerifyCaseNumber ?? null,
        status: i9?.eVerifyStatus ?? null,
        caseOpenedAt: i9?.eVerifyCaseOpenedAt?.toISOString() ?? null,
        closedAt: i9?.eVerifyClosedAt?.toISOString() ?? null,
        dueBy: readiness.dueBy ? ymd(readiness.dueBy) : null,
        overdue: isEVerifyOverdue(
          readiness.dueBy,
          i9?.eVerifyCaseOpenedAt ?? null,
          now,
        ),
        blockers: readiness.blockers,
        ready: readiness.ready,
      };
    });

    const counts = {
      total: out.length,
      authorized: out.filter((r) => r.status === 'EMPLOYMENT_AUTHORIZED').length,
      pending: out.filter((r) => r.status === 'PENDING').length,
      nonconfirmation: out.filter(
        (r) => r.status !== null && NONCONFIRMATION.includes(r.status),
      ).length,
      notRun: out.filter((r) => r.status === null).length,
      overdue: out.filter((r) => r.overdue).length,
      blocked: out.filter((r) => !r.ready).length,
    };

    res.json(EVerifyRosterResponseSchema.parse({ rows: out, counts, truncated }));
  } catch (err) {
    next(err);
  }
});

/**
 * The aggregation payload — the whole point of the feature.
 *
 * MANAGE-gated rather than relying on the router's view:compliance, because
 * this returns a decrypted SSN and view:compliance includes EXECUTIVE_CHAIRMAN,
 * a read-only role with no business seeing one. Audited on every read: this is
 * a disclosure of identity data, not just a page view.
 */
everifyRouter.get('/:associateId', MANAGE, async (req, res, next) => {
  try {
    const associate = await prisma.associate.findFirst({
      where: { id: req.params.associateId, deletedAt: null },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        middleInitial: true,
        otherLastNames: true,
        dob: true,
        email: true,
        hireDate: true,
        i9Verification: {
          select: {
            section1CompletedAt: true,
            section2CompletedAt: true,
            citizenshipStatus: true,
            alienRegistrationNumberEnc: true,
            workAuthExpiresAt: true,
            documentList: true,
            eVerifyCaseNumber: true,
            eVerifyStatus: true,
            eVerifyCaseOpenedAt: true,
            eVerifyClosedAt: true,
            section2Verifier: { select: { email: true } },
          },
        },
        w4Submission: { select: { ssnEncrypted: true } },
      },
    });
    if (!associate) {
      throw new HttpError(404, 'not_found', 'Associate not found.');
    }

    const i9 = associate.i9Verification;

    // tryDecryptString, not decryptString: rows written before the 2026-06-11
    // key rotation don't decrypt under the current key, and one bad record
    // shouldn't 500 the screen. A null here surfaces as the NO_SSN blocker,
    // which tells HR to re-collect rather than leaving them guessing.
    const ssn = associate.w4Submission?.ssnEncrypted
      ? tryDecryptString(Buffer.from(associate.w4Submission.ssnEncrypted))
      : null;
    const alienRegistrationNumber = i9?.alienRegistrationNumberEnc
      ? tryDecryptString(Buffer.from(i9.alienRegistrationNumberEnc))
      : null;

    const readiness = evaluateEVerifyReadiness({
      hasI9: !!i9,
      section1CompletedAt: i9?.section1CompletedAt ?? null,
      section2CompletedAt: i9?.section2CompletedAt ?? null,
      citizenshipStatus: i9?.citizenshipStatus ?? null,
      hasReadableSsn: !!ssn,
      dob: associate.dob,
      hireDate: associate.hireDate,
    });

    // Same identity-document set the I-9 verifier screen shows, with the same
    // front/back derivation from the filename tag and the same fileAvailable
    // signal (the deploy target's ephemeral disk can leave rows whose blobs
    // are gone, and a broken <img> in a compliance screen reads as "no
    // document on file").
    // One query for both sets, partitioned below — the identity papers the
    // verifier inspected, and the packet the government returned.
    const docRows = await prisma.documentRecord.findMany({
      take: 500,
      where: {
        associateId: associate.id,
        deletedAt: null,
        kind: { in: [...IDENTITY_DOC_KINDS, EVERIFY_PACKET_KIND] },
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, kind: true, filename: true, mimeType: true, s3Key: true },
    });
    const toDoc = (d: (typeof docRows)[number]) => {
      const lower = d.filename.toLowerCase();
      return {
        id: d.id,
        kind: d.kind,
        filename: d.filename,
        mimeType: d.mimeType,
        side: lower.includes('-front')
          ? ('FRONT' as const)
          : lower.includes('-back')
            ? ('BACK' as const)
            : null,
        fileAvailable: d.s3Key !== null && existsSync(resolveStoragePath(d.s3Key)),
      };
    };
    const documents = docRows
      .filter((d) => d.kind !== EVERIFY_PACKET_KIND)
      .map(toDoc);
    const packets = docRows
      .filter((d) => d.kind === EVERIFY_PACKET_KIND)
      .map(toDoc);

    await recordComplianceEvent({
      actorUserId: req.user!.id,
      action: 'compliance.everify_case_viewed',
      entityType: 'Associate',
      entityId: associate.id,
      associateId: associate.id,
      metadata: {
        ssnDisclosed: ssn !== null,
        documentCount: documents.length,
        packetCount: packets.length,
      },
      req,
    });

    res.json(
      EVerifyCaseDetailSchema.parse({
        associateId: associate.id,
        lastName: associate.lastName,
        firstName: associate.firstName,
        middleInitial: associate.middleInitial,
        otherLastNames: associate.otherLastNames ?? [],
        dob: associate.dob ? ymd(associate.dob) : null,
        ssn,
        email: associate.email,
        citizenshipStatus: i9?.citizenshipStatus ?? null,
        alienRegistrationNumber,
        workAuthExpiresAt: i9?.workAuthExpiresAt ? ymd(i9.workAuthExpiresAt) : null,
        documentList: i9?.documentList ?? null,
        documents,
        packets,
        section1CompletedAt: i9?.section1CompletedAt?.toISOString() ?? null,
        section2CompletedAt: i9?.section2CompletedAt?.toISOString() ?? null,
        section2VerifierEmail: i9?.section2Verifier?.email ?? null,
        hireDate: associate.hireDate ? ymd(associate.hireDate) : null,
        dueBy: readiness.dueBy ? ymd(readiness.dueBy) : null,
        overdue: isEVerifyOverdue(
          readiness.dueBy,
          i9?.eVerifyCaseOpenedAt ?? null,
          new Date(),
        ),
        caseNumber: i9?.eVerifyCaseNumber ?? null,
        status: i9?.eVerifyStatus ?? null,
        caseOpenedAt: i9?.eVerifyCaseOpenedAt?.toISOString() ?? null,
        closedAt: i9?.eVerifyClosedAt?.toISOString() ?? null,
        blockers: readiness.blockers,
        ready: readiness.ready,
      }),
    );
  } catch (err) {
    next(err);
  }
});

/** Record the outcome HR got back from the federal portal. */
everifyRouter.post('/:associateId/case', MANAGE, async (req, res, next) => {
  try {
    const parsed = EVerifyCaseInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const associate = await prisma.associate.findFirst({
      where: { id: req.params.associateId, deletedAt: null },
      select: { id: true, i9Verification: { select: { id: true } } },
    });
    if (!associate) {
      throw new HttpError(404, 'not_found', 'Associate not found.');
    }
    if (!associate.i9Verification) {
      // E-Verify is downstream of Form I-9 by law — a case with no I-9 behind
      // it would be unauditable, and the scorecard signal would be meaningless.
      throw new HttpError(
        409,
        'no_i9',
        'This associate has no I-9 on file — complete Form I-9 before recording an E-Verify case.',
      );
    }

    const d = parsed.data;
    const row = await prisma.i9Verification.update({
      where: { id: associate.i9Verification.id },
      data: {
        ...(d.caseNumber !== undefined ? { eVerifyCaseNumber: d.caseNumber } : {}),
        ...(d.status !== undefined ? { eVerifyStatus: d.status } : {}),
        ...(d.caseOpenedAt !== undefined
          ? { eVerifyCaseOpenedAt: d.caseOpenedAt ? new Date(d.caseOpenedAt) : null }
          : {}),
        ...(d.closedAt !== undefined
          ? { eVerifyClosedAt: d.closedAt ? new Date(d.closedAt) : null }
          : {}),
      },
      select: {
        eVerifyCaseNumber: true,
        eVerifyStatus: true,
        eVerifyCaseOpenedAt: true,
        eVerifyClosedAt: true,
      },
    });

    await recordComplianceEvent({
      actorUserId: req.user!.id,
      action: 'compliance.everify_case_recorded',
      entityType: 'I9Verification',
      entityId: associate.i9Verification.id,
      associateId: associate.id,
      metadata: { caseNumber: row.eVerifyCaseNumber, status: row.eVerifyStatus },
      req,
    });

    res.json({
      caseNumber: row.eVerifyCaseNumber,
      status: row.eVerifyStatus,
      caseOpenedAt: row.eVerifyCaseOpenedAt?.toISOString() ?? null,
      closedAt: row.eVerifyClosedAt?.toISOString() ?? null,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Middle initial and other last names, for backfilling people onboarded before
 * those fields existed. Deliberately narrow: this screen LABELS an identity,
 * it doesn't rewrite one. Legal name, DOB and SSN stay owned by onboarding,
 * where they're collected from the employee with an attestation behind them.
 */
everifyRouter.patch('/:associateId/identity', MANAGE, async (req, res, next) => {
  try {
    const parsed = EVerifyIdentityInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const associate = await prisma.associate.findFirst({
      where: { id: req.params.associateId, deletedAt: null },
      select: { id: true, middleInitial: true, otherLastNames: true },
    });
    if (!associate) {
      throw new HttpError(404, 'not_found', 'Associate not found.');
    }

    const d = parsed.data;
    const row = await prisma.associate.update({
      where: { id: associate.id },
      data: {
        ...(d.middleInitial !== undefined
          ? { middleInitial: d.middleInitial || null }
          : {}),
        ...(d.otherLastNames !== undefined
          ? { otherLastNames: d.otherLastNames }
          : {}),
      },
      select: { middleInitial: true, otherLastNames: true },
    });

    // Old values recorded: a name a case was filed under changing afterwards
    // is exactly what a reviewer needs to be able to trace.
    await recordComplianceEvent({
      actorUserId: req.user!.id,
      action: 'compliance.everify_identity_updated',
      entityType: 'Associate',
      entityId: associate.id,
      associateId: associate.id,
      metadata: {
        previousMiddleInitial: associate.middleInitial,
        previousOtherLastNames: associate.otherLastNames,
        middleInitial: row.middleInitial,
        otherLastNames: row.otherLastNames,
      },
      req,
    });

    res.json(row);
  } catch (err) {
    next(err);
  }
});
