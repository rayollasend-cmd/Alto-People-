import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import {
  EVerifyCaseDetailSchema,
  EVerifyCaseInputSchema,
  EVerifyIdentityInputSchema,
  EVerifyRosterResponseSchema,
  IDENTITY_DOCUMENT_KINDS,
  type ComplianceWorkforce,
  type EVerifyRosterResponse,
  type EVerifyRosterRow,
  type EVerifyStatus,
} from '@alto-people/shared';
import type { SessionUser } from '../types/express.js';
import { prisma } from '../db.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { dateColumnKey } from '../lib/timezone.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { recordComplianceEvent } from '../lib/audit.js';
import { tryDecryptString } from '../lib/crypto.js';
import { blobExistsForListing } from '../lib/blobStore.js';
import { evaluateEVerifyReadiness } from '../lib/everifyReadiness.js';
import { primaryClientsForAssociates } from '../lib/associateClients.js';
import { profilePhotoUrlFor } from '../lib/profilePhotoUrl.js';
import { hireDatesFor } from '../lib/hireDate.js';
import { countWorkforce, readWorkforce, workforceFromQuery, type WorkforceReading } from '../lib/complianceWorkforce.js';
import { peopleStandings } from '../lib/peopleStatus.js';
import { caseFromEarlierEmployment, earlierI9Reused, eVerifyCaseOpen, eVerifyDueBy, eVerifyOverdue } from '../lib/hiringCompliance.js';
import { employmentSpellsFor, i9ListReach, perRequest, rehiresFor, terminationDaysFor, workforceForRequest } from '../lib/i9Records.js';

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
 * WHO THE LIST IS ABOUT (owner, 2026-11-03). The roster used to start from
 * everyone ever onboarded — 524 people in production, cut silently at 500,
 * ~70% of them gone — and the 24 current hires with no case were lost in
 * it. It now opens on the current workforce (`?workforce=`, default
 * current; lib/complianceWorkforce), with no cap a real roster reaches, and
 * every by-id route answers only inside the caller's reach.
 *
 * Mounted at /compliance/everify, inheriting the compliance router's
 * view:compliance guard. Anything returning a decrypted SSN adds MANAGE on
 * top — see the detail route.
 */
export const everifyRouter = Router();

const MANAGE = requireCapability('manage:compliance');

/**
 * A ceiling, not a page: the whole company is a few hundred people. Past
 * it the response says `truncated` and the tab says so — never a silent cut.
 */
const EVERIFY_ROSTER_MAX = 5000;

const NONCONFIRMATION: EVerifyStatus[] = [
  'TENTATIVE_NONCONFIRMATION',
  'FINAL_NONCONFIRMATION',
];

const IDENTITY_DOC_KINDS: readonly string[] = IDENTITY_DOCUMENT_KINDS;

/**
 * The packet E-Verify returns when a case closes. Reuses the existing
 * I9_VERIFICATION_RESULT kind, whose schema comment already names E-Verify as
 * an intended source — no new enum value, so no migration.
 */
const EVERIFY_PACKET_KIND = 'I9_VERIFICATION_RESULT' as const;

/** A date column's YYYY-MM-DD (hire, birth and expiry dates; dueBy is business days after a hire date). */
const ymd = dateColumnKey;

/** The one hire date (lib/hireDate) as a date column value. */
const dayOf = (key: string | null | undefined): Date | null => (key ? new Date(`${key}T00:00:00.000Z`) : null);

/** A person by id, inside the caller's reach (404 outside it — nothing revealed). */
function personWhere(user: SessionUser, associateId: string): Prisma.AssociateWhereInput {
  return { AND: [{ id: associateId, deletedAt: null, tenantId: tenantIdForWrite() }, i9ListReach(user)] };
}

/** The I-9's E-Verify columns a case reading needs. */
const CASE_SELECT = {
  eVerifyCaseNumber: true,
  eVerifyStatus: true,
  eVerifyCaseOpenedAt: true,
  eVerifyClosedAt: true,
  eVerifyDueBy: true,
  eVerifyTncDecision: true,
  eVerifyReferredAt: true,
  eVerifyReferralDeadline: true,
  eVerifyClosureReason: true,
} as const;

interface CaseColumns {
  eVerifyCaseNumber: string | null;
  eVerifyStatus: EVerifyStatus | null;
  eVerifyCaseOpenedAt: Date | null;
  eVerifyClosedAt: Date | null;
  eVerifyDueBy: Date | null;
  eVerifyTncDecision: string | null;
  eVerifyReferredAt: Date | null;
  eVerifyReferralDeadline: Date | null;
  eVerifyClosureReason: string | null;
}

/**
 * The case as THIS employment sees it. A rehire whose stored case was
 * opened for an earlier employment has no case yet (owner, 2026-11-03): the
 * case fields read empty, the old case moves to `previousCase`, and the due
 * day runs from the new first day — the row reads "Not yet run", not done.
 * Unless the earlier I-9 was reused on a REHIRE Supplement B for this
 * employment and that earlier case ended Employment Authorized: then the
 * authorization stands and no new case is needed (earlierI9Reused).
 */
function caseReading(
  i9: CaseColumns | null,
  hireKey: string | null,
  spells: ReadonlyArray<{ hireDate: Date; endDate: Date | null }>,
  rehires: ReadonlyArray<{ rehiredOn: string; reviewedOn: string }>,
  now: Date,
) {
  const fromEarlier = !!i9 && caseFromEarlierEmployment(i9.eVerifyCaseOpenedAt, hireKey, spells);
  const reused = fromEarlier && earlierI9Reused(i9?.eVerifyStatus, rehires, hireKey);
  const needsNewCase = fromEarlier && !reused;
  const cur = i9 && !needsNewCase ? i9 : null;
  const hasCase = !!cur && !!(cur.eVerifyCaseNumber || cur.eVerifyStatus || cur.eVerifyCaseOpenedAt);
  const dueBy = eVerifyDueBy(hireKey, cur?.eVerifyDueBy ?? null);
  return {
    caseNumber: cur?.eVerifyCaseNumber ?? null,
    status: cur?.eVerifyStatus ?? null,
    caseOpenedAt: cur?.eVerifyCaseOpenedAt?.toISOString() ?? null,
    closedAt: cur?.eVerifyClosedAt?.toISOString() ?? null,
    tncDecision: cur?.eVerifyTncDecision ?? null,
    referralDeadline: cur?.eVerifyReferralDeadline ? ymd(cur.eVerifyReferralDeadline) : null,
    closureReason: cur?.eVerifyClosureReason ?? null,
    caseOpen: !!cur && eVerifyCaseOpen(cur),
    needsNewCase,
    earlierI9Reused: reused,
    previousCase:
      needsNewCase && i9
        ? {
            caseNumber: i9.eVerifyCaseNumber,
            status: i9.eVerifyStatus,
            caseOpenedAt: i9.eVerifyCaseOpenedAt?.toISOString() ?? null,
            closedAt: i9.eVerifyClosedAt?.toISOString() ?? null,
          }
        : null,
    dueBy: dueBy ? ymd(dueBy) : null,
    overdue: eVerifyOverdue(dueBy, hasCase, now),
  };
}

/** The roster's people: onboarded or onboarding (any application that wasn't declined), in the caller's reach. */
function rosterWhere(user: SessionUser): Prisma.AssociateWhereInput {
  return {
    AND: [
      { deletedAt: null, tenantId: tenantIdForWrite() },
      i9ListReach(user),
      { applications: { some: { deletedAt: null, status: { notIn: ['REJECTED', 'CANCELLED'] } } } },
    ],
  };
}

/**
 * The roster for one group, with its counts — the list route's body, and
 * what the Inbox counts (so the Inbox number is the list it opens).
 */
export async function everifyRoster(
  user: SessionUser,
  workforce: ComplianceWorkforce,
  opts: { now?: Date; reading?: WorkforceReading } = {},
): Promise<EVerifyRosterResponse> {
  const now = opts.now ?? new Date();
  const reading = opts.reading ?? (await readWorkforce(tenantIdForWrite(), now));

  // Everyone the roster could show, light: the chip counts, and the cases
  // left open by people who left, are about the whole roster in reach.
  const population = await prisma.associate.findMany({
    where: rosterWhere(user),
    select: { id: true, i9Verification: { select: { eVerifyStatus: true, eVerifyClosedAt: true, eVerifyReferredAt: true } } },
  });
  const workforceCounts = countWorkforce(population.map((p) => p.id), reading);
  const formerOpenCases = population.filter((p) => reading.groupOf(p.id) === 'former' && !!p.i9Verification && eVerifyCaseOpen(p.i9Verification)).length;
  const groupIds = population.filter((p) => reading.includes(p.id, workforce)).map((p) => p.id);

  const fetched = groupIds.length
    ? await prisma.associate.findMany({
        where: { id: { in: groupIds } },
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
        take: EVERIFY_ROSTER_MAX + 1,
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          dob: true,
          hireDate: true,
          separatedAt: true,
          ssnLast4: true,
          photoS3Key: true,
          photoUpdatedAt: true,
          i9Verification: {
            select: {
              section1CompletedAt: true,
              section2CompletedAt: true,
              citizenshipStatus: true,
              ...CASE_SELECT,
            },
          },
          w4Submission: { select: { ssnEncrypted: true } },
        },
      })
    : [];
  const truncated = fetched.length > EVERIFY_ROSTER_MAX;
  const page = truncated ? fetched.slice(0, EVERIFY_ROSTER_MAX) : fetched;
  const ids = page.map((a) => a.id);
  const [placement, hired, spells, ended, rehires] = await Promise.all([
    // Current client per associate, for the roster's client filter.
    primaryClientsForAssociates(ids),
    // The one hire date (lib/hireDate, PEOPLE-10): the employment record's, the same
    // date the person's record shows — it also sets E-Verify's three-day deadline.
    hireDatesFor(prisma, ids),
    employmentSpellsFor(prisma, ids),
    terminationDaysFor(prisma, page),
    rehiresFor(prisma, ids),
  ]);

  const rows: EVerifyRosterRow[] = page.map((a) => {
    const i9 = a.i9Verification;
    const hireKey = hired.get(a.id)?.date ?? (a.hireDate ? ymd(a.hireDate) : null);
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
      hireDate: dayOf(hireKey),
    });
    const c = caseReading(i9, hireKey, spells.get(a.id) ?? [], rehires.get(a.id) ?? [], now);
    return {
      associateId: a.id,
      associateName: `${a.firstName} ${a.lastName}`,
      associateEmail: a.email,
      associatePhotoUrl: profilePhotoUrlFor(a),
      clientId: placement.get(a.id)?.clientId ?? null,
      clientName: placement.get(a.id)?.clientName ?? null,
      hireDate: hireKey,
      ssnLast4: a.ssnLast4,
      ...c,
      blockers: readiness.blockers,
      ready: readiness.ready,
      workStatus: reading.statusOf(a.id),
      leftOn: ended.get(a.id) ?? null,
    };
  });

  const counts = {
    total: rows.length,
    authorized: rows.filter((r) => r.status === 'EMPLOYMENT_AUTHORIZED').length,
    pending: rows.filter((r) => r.status === 'PENDING').length,
    nonconfirmation: rows.filter((r) => r.status !== null && NONCONFIRMATION.includes(r.status)).length,
    notRun: rows.filter((r) => r.status === null).length,
    overdue: rows.filter((r) => r.overdue).length,
    // "Can't submit yet": no case for this employment and something still missing.
    // A person with a case isn't blocked, whatever the readiness check says about re-submitting.
    blocked: rows.filter((r) => !r.ready && r.caseNumber === null && r.status === null).length,
  };

  return { rows, counts, truncated, workforce, workforceCounts, formerOpenCases };
}

/**
 * The current workforce's roster for one request — the Inbox's two E-Verify
 * sources count from the same rows the linked list shows.
 */
const currentRosterMemo = new WeakMap<object, Promise<EVerifyRosterResponse>>();
export function currentEVerifyRoster(user: SessionUser): Promise<EVerifyRosterResponse> {
  return perRequest(currentRosterMemo, () => workforceForRequest(user).then((reading) => everifyRoster(user, 'current', { reading })));
}

/**
 * Everyone onboarded or currently onboarding, in one group (`?workforce=`,
 * default current).
 *
 * Driven by Associate, deliberately — NOT by I9Verification the way
 * GET /compliance/i9 is. Someone mid-onboarding has no I-9 row yet, so an
 * I-9-driven query would hide exactly the people who still need action, which
 * is the population this queue exists to surface.
 */
everifyRouter.get('/', async (req, res, next) => {
  try {
    const body = await everifyRoster(req.user!, workforceFromQuery(req.query));
    res.json(EVerifyRosterResponseSchema.parse(body));
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
    // Inside the caller's reach (owner, 2026-11-03): another store's person is
    // a 404 here, as on the list.
    const associate = await prisma.associate.findFirst({
      where: personWhere(req.user!, req.params.associateId),
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
            ...CASE_SELECT,
            section2Verifier: { select: { email: true } },
          },
        },
        w4Submission: { select: { ssnEncrypted: true } },
      },
    });
    if (!associate) {
      throw new HttpError(404, 'not_found', 'Associate not found.');
    }
    // The one hire date (lib/hireDate), as on the roster row, and the spells
    // that tell a rehire's earlier case from this employment's.
    const [hired, spells, standing, rehires] = await Promise.all([
      hireDatesFor(prisma, [associate.id]),
      employmentSpellsFor(prisma, [associate.id]),
      // Where this one person stands (lib/peopleStatus) — not the whole company's reading.
      peopleStandings({ tenantId: tenantIdForWrite(), associateIds: [associate.id] }),
      rehiresFor(prisma, [associate.id]),
    ]);
    const hireKey = hired.get(associate.id)?.date ?? (associate.hireDate ? ymd(associate.hireDate) : null);

    /**
     * FIRST DAY WORKED, WHICH IS NOT THE HIRE DATE.
     *
     * The I-9 clock runs from the first day of employment for pay — the day
     * they actually started — while the hire date on the record is the day
     * the offer was dated. Those are routinely days or weeks apart: someone
     * hired on the 1st who first walks the floor on the 14th has a Section 2
     * deadline keyed to the 14th, and a reviewer reading only the hire date
     * is looking at the wrong number.
     *
     * The earliest clock-in is the closest thing the system holds to that
     * fact. Null until they have worked once, which is itself worth seeing:
     * an associate who has never clocked in has not started, so the
     * three-day clock has not begun.
     */
    const firstShift = await prisma.timeEntry.findFirst({
      where: { associateId: associate.id },
      orderBy: { clockInAt: 'asc' },
      select: { clockInAt: true },
    });

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
      hireDate: dayOf(hireKey),
    });
    const c = caseReading(i9, hireKey, spells.get(associate.id) ?? [], rehires.get(associate.id) ?? [], new Date());

    // Same identity-document set the I-9 verifier screen shows, with the same
    // front/back derivation from the filename tag and the same fileAvailable
    // signal (the deploy target's ephemeral disk can leave rows whose blobs
    // are gone, and a broken <img> in a compliance screen reads as "no
    // document on file").
    // Deliberately UNFILTERED by kind — one query, partitioned below into
    // the identity papers the verifier inspected, the packet the government
    // returned, and everything else. The last bucket is the misfiled-passport
    // net: associates upload identity papers into the wrong checklist slot,
    // and a kind-filtered query would conclude "no documents on file" while
    // the passport sits on the record as OTHER.
    const docRows = await prisma.documentRecord.findMany({
      take: 500,
      where: {
        associateId: associate.id,
        deletedAt: null,
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        kind: true,
        filename: true,
        mimeType: true,
        s3Key: true,
        side: true,
        i9DocTitle: true,
        i9List: true,
      },
    });
    const toDoc = (d: (typeof docRows)[number]) => {
      // Stored side column wins; filename tags are the pre-catalog fallback.
      const lower = d.filename.toLowerCase();
      return {
        id: d.id,
        kind: d.kind,
        filename: d.filename,
        mimeType: d.mimeType,
        i9DocTitle: d.i9DocTitle,
        i9List: d.i9List,
        side:
          d.side ??
          (lower.includes('-front')
            ? ('FRONT' as const)
            : lower.includes('-back')
              ? ('BACK' as const)
              : null),
        // Local driver: real existsSync. s3 driver: assumed available when
        // s3Key is non-null (see blobStore.ts — S3 doesn't lose blobs on
        // redeploy, which is the failure mode this flag exists for).
        fileAvailable: blobExistsForListing(d.s3Key),
      };
    };
    const documents = docRows
      .filter((d) => IDENTITY_DOC_KINDS.includes(d.kind))
      .map(toDoc);
    const packets = docRows
      .filter((d) => d.kind === EVERIFY_PACKET_KIND)
      .map(toDoc);
    const otherDocuments = docRows
      .filter(
        (d) =>
          !IDENTITY_DOC_KINDS.includes(d.kind) && d.kind !== EVERIFY_PACKET_KIND,
      )
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
        otherDocumentCount: otherDocuments.length,
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
        otherDocuments,
        section1CompletedAt: i9?.section1CompletedAt?.toISOString() ?? null,
        section2CompletedAt: i9?.section2CompletedAt?.toISOString() ?? null,
        section2VerifierEmail: i9?.section2Verifier?.email ?? null,
        hireDate: hireKey,
        firstClockInAt: firstShift?.clockInAt.toISOString() ?? null,
        ...c,
        blockers: readiness.blockers,
        ready: readiness.ready,
        workStatus: standing.people.get(associate.id)?.status ?? null,
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
      where: personWhere(req.user!, req.params.associateId),
      select: { id: true, hireDate: true, i9Verification: { select: { id: true, ...CASE_SELECT } } },
    });
    if (!associate) {
      throw new HttpError(404, 'not_found', 'Associate not found.');
    }
    // CSV-migrated associates were I-9'd and E-Verified on paper before the
    // system existed, so they have no I9Verification row — refusing the case
    // here (the old 409) locked out exactly the people whose verification is
    // already done. Create an empty shell instead: the case lands, while the
    // roster still honestly shows Section 1/2 as incomplete until HR
    // backfills the paper I-9 dates on the I-9 tab.
    const i9Id =
      associate.i9Verification?.id ??
      (
        await prisma.i9Verification.create({
          data: { associateId: associate.id },
          select: { id: true },
        })
      ).id;

    const d = parsed.data;
    // A rehire opening this employment's case (owner, 2026-11-03): the stored
    // case belongs to an earlier employment, so its closing stamp, mismatch
    // choice, referral and closure reason must not carry over onto the new
    // one. The old case is kept in the audit row below.
    const stored = associate.i9Verification;
    const [hired, spells] = await Promise.all([hireDatesFor(prisma, [associate.id]), employmentSpellsFor(prisma, [associate.id])]);
    const hireKey = hired.get(associate.id)?.date ?? (associate.hireDate ? ymd(associate.hireDate) : null);
    const opensNewCase =
      !!stored &&
      caseFromEarlierEmployment(stored.eVerifyCaseOpenedAt, hireKey, spells.get(associate.id) ?? []) &&
      (!!d.caseOpenedAt || (d.caseNumber !== undefined && d.caseNumber !== stored.eVerifyCaseNumber));
    const row = await prisma.i9Verification.update({
      where: { id: i9Id },
      data: {
        ...(opensNewCase
          ? {
              eVerifyCaseNumber: null,
              eVerifyStatus: null,
              eVerifyClosedAt: null,
              eVerifyDueBy: null,
              eVerifyRawStatus: null,
              eVerifyTncNotifiedAt: null,
              eVerifyTncDecision: null,
              eVerifyReferredAt: null,
              eVerifyReferralDeadline: null,
              eVerifyClosureReason: null,
              eVerifyConnectionId: null,
              eVerifyLastSyncAt: null,
              eVerifyLastError: null,
            }
          : {}),
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
      entityId: i9Id,
      associateId: associate.id,
      metadata: {
        caseNumber: row.eVerifyCaseNumber,
        status: row.eVerifyStatus,
        // Flag when the shell was created by this very call — the audit
        // trail should say the I-9 record began life as a case backfill.
        ...(associate.i9Verification ? {} : { i9CreatedByCaseBackfill: true }),
        // A rehire's new case: the earlier employment's case it replaced.
        ...(opensNewCase && stored
          ? {
              previousCase: {
                caseNumber: stored.eVerifyCaseNumber,
                status: stored.eVerifyStatus,
                caseOpenedAt: stored.eVerifyCaseOpenedAt?.toISOString() ?? null,
                closedAt: stored.eVerifyClosedAt?.toISOString() ?? null,
              },
            }
          : {}),
      },
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
      where: personWhere(req.user!, req.params.associateId),
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
