import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  ManualAttestationCreateInputSchema,
  ManualAttestationListResponseSchema,
  ScorecardActionsResponseSchema,
  ScorecardBillingResponseSchema,
  ScorecardExpirationsResponseSchema,
  ScorecardOnboardingResponseSchema,
  ScorecardShiftsResponseSchema,
  ScorecardTrainingResponseSchema,
  type ComplianceTag,
  type ManualAttestationSignal,
  type ScorecardAction,
  type ScorecardActionsResponse,
  type ScorecardBillingResponse,
  type ScorecardExpiringItem,
  type ScorecardExpirationsResponse,
  type ScorecardOnboardingResponse,
  type ScorecardOnboardingSignal,
  type ScorecardSeverity,
  type ScorecardShiftsResponse,
  type ScorecardTrainingResponse,
  ScorecardActionStateInputSchema,
  ScorecardHistoryResponseSchema,
  scorecardSeverityFromFailPct,
  scorecardGrade,
  SafetyIncidentCreateInputSchema,
  SafetyIncidentUpdateInputSchema,
  SafetyIncidentListResponseSchema,
  ScorecardSafetyResponseSchema,
  isRecordableOutcome,
  isDartOutcome,
  OSHA_TRIR_TARGET,
  type SafetyIncident,
  type SafetyIncidentOutcome,
  type ScorecardSafetyResponse,
} from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { addBusinessDays } from '../lib/everifyReadiness.js';
import { notifyUser, notifyAllAdmins } from '../lib/notify.js';
import { getShiftMetrics, isConfigured as asnNexusConfigured, type AsnNexusMetric } from '../lib/asnNexus.js';
import {
  ATTESTATION_CONFIGS,
  classifyStatus,
  dueDateFor,
  getAttestationConfig,
  periodForNow,
  type AttestationConfig,
} from '../lib/manualAttestation.js';
import { enqueueAudit } from '../lib/audit.js';
import { ReportPdf } from '../lib/reportPdf.js';
import { formatRef } from '../lib/emailTemplates.js';

export const complianceScorecardRouter = Router();

const VIEW = requireCapability('view:compliance');

// Walmart SOW expected bill rates per the spec. Per-position; matched against
// Job.name (case-insensitive substring). Anything not matching falls through
// as "no expectation set" rather than a failure.
const WALMART_BILL_RATES: ReadonlyArray<{ pattern: RegExp; rate: number }> = [
  { pattern: /shift\s*lead/i, rate: 24.24 },
  { pattern: /(associate|stocker|nexus)/i, rate: 21.21 },
];

// Contract-clause labels surfaced on every tooltip. Source of truth for what
// each signal maps to in our agreements.
const CLAUSE = {
  AGE_18: 'Walmart MSP — 18+ associate requirement',
  DRUG_TEST: 'Walmart SOW Exhibit E — drug test within 60 days',
  BACKGROUND: 'FCRA + Walmart MSA — background check on file',
  I9: 'IRCA — I-9 Section 1 + Section 2 completed',
  E_VERIFY: 'IRCA + Walmart MSA — E-Verify case cleared',
  W4: 'IRS — W-4 on file before first paycheck',
  OFFER: 'Walmart MSA — signed offer letter',
  POLICY: 'Walmart MSA — signed policy acknowledgment',
  WC: 'Walmart MSA Section 7 — Workers Comp insurance',
  GL: 'Walmart MSA Section 7 — General Liability insurance',
  DRUG_EXPIRY: 'Walmart SOW Exhibit E — drug test 60-day validity',
  WORK_AUTH: 'IRCA — I-9 work authorization re-verification',
  J1: 'J-1 program end date',
  TRAINING_EXPIRY: 'Training certification re-validation',
  DOC_EXPIRY: 'Document validity — expiring credential on file',
  VAX_EXPIRY: 'Client site requirement — vaccination validity',
  AGREEMENT_EXPIRY: 'Alto People agreement — expiring term',
  FILL_RATE: 'Walmart SOW — 97% shift fill rate target',
  NO_SHOW: 'Walmart SOW — sub-2% no-show rate target',
  SHIFT_LEAD: 'Walmart SOW — 100% Shift Lead presence',
  TEMP_LOG: 'FSMA 204 — temperature log with photo',
  MOD_SIGNOFF: 'Walmart SOW — 100% MOD sign-off',
  FIELDGLASS: 'Walmart SOW — Fieldglass timesheet by Mon 2pm PST',
  INVOICE: 'Walmart MSA — 90-day invoice forfeiture window',
  MONTHLY_REPORT: 'Walmart SOW — monthly compliance report',
  EEO: 'Walmart MTSA Section 5a — EEO + harassment training',
  OSHA_TRAIN: 'Walmart MTSA Section 5b — OSHA safety training',
  CADE: 'Walmart MTSA Exhibit D — CADE system training',
  FOOD_HANDLER: 'Local food code — food handler certification',
  BILL_RATE: 'Walmart SOW — bill rates $21.21 / $24.24',
  OSHA_LOG: 'OSHA 1904 — injury & illness recordkeeping (Form 300)',
} as const;

// Returns the union of associate ids whose most-recent active Application is
// APPROVED. Reused by tiles 1 + 5. Includes Application.clientId so every
// tile can be scoped with ?clientId=.
//
// PERF: micro-cached for 5s per client scope. /compliance-scorecard/actions
// builds five tiles in parallel that each call this — without the cache one
// dashboard render executed the identical query five times.
//
// POPULATION CAP: 5,000 applications, up from the old 500 — which silently
// made associate #501 invisible to the entire scorecard. If the org ever
// exceeds this, the loud console error below is the tripwire to paginate.
const ACTIVE_ASSOCIATES_CAP = 5_000;
const activeAssociatesCache = new Map<
  string,
  { at: number; value: ReturnType<typeof loadActiveAssociates> }
>();
const ACTIVE_ASSOCIATES_TTL_MS = 5_000;

function getActiveAssociates(clientId?: string | null) {
  // The micro-cache is a per-request dedup for production dashboards. In
  // tests it outlives truncateAll() (module state survives between tests
  // in a worker), so sub-5s-apart tests would read each other's
  // populations — bypass it entirely there.
  if (process.env.NODE_ENV === 'test') return loadActiveAssociates(clientId);
  const key = clientId ?? '*';
  const now = Date.now();
  const hit = activeAssociatesCache.get(key);
  if (hit && now - hit.at < ACTIVE_ASSOCIATES_TTL_MS) return hit.value;
  const value = loadActiveAssociates(clientId);
  activeAssociatesCache.set(key, { at: now, value });
  // A failed load must not get pinned for the TTL.
  value.catch(() => {
    if (activeAssociatesCache.get(key)?.value === value) {
      activeAssociatesCache.delete(key);
    }
  });
  return value;
}

async function loadActiveAssociates(clientId?: string | null) {
  const apps = await prisma.application.findMany({
    take: ACTIVE_ASSOCIATES_CAP,
    where: {
      status: 'APPROVED',
      deletedAt: null,
      associate: { deletedAt: null },
      ...(clientId ? { clientId } : {}),
    },
    select: {
      associateId: true,
      clientId: true,
      associate: {
        select: { firstName: true, lastName: true, dob: true, hireDate: true },
      },
      client: { select: { name: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (apps.length === ACTIVE_ASSOCIATES_CAP) {
    console.error(
      `[compliance-scorecard] active-associate query hit the ${ACTIVE_ASSOCIATES_CAP}-row cap — ` +
        'the scorecard is no longer covering the whole workforce. Paginate loadActiveAssociates.',
    );
  }
  // De-dup by associateId — one associate may have multiple historical
  // approved applications; we keep the most recent.
  const seen = new Set<string>();
  const rows: Array<{
    associateId: string;
    associateName: string;
    clientId: string;
    clientName: string;
    dob: Date | null;
    hireDate: Date | null;
  }> = [];
  for (const a of apps) {
    if (seen.has(a.associateId)) continue;
    seen.add(a.associateId);
    rows.push({
      associateId: a.associateId,
      associateName: `${a.associate.firstName} ${a.associate.lastName}`,
      clientId: a.clientId,
      clientName: a.client.name,
      dob: a.associate.dob,
      hireDate: a.associate.hireDate,
    });
  }
  return rows;
}

// Severity thresholds live in shared/contracts (scorecardSeverityFromFailPct)
// so the UI's progress bars and these tile badges can never disagree again.
const severityFromPercent = scorecardSeverityFromFailPct;

/** Optional ?clientId= scope, validated. */
function clientScope(req: { query: Record<string, unknown> }): string | null {
  const raw = req.query.clientId;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const parsed = z.string().uuid().safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(400, 'invalid_client_id', 'clientId must be a UUID.');
  }
  return parsed.data;
}

/* ============================================================ TILE 1 ===== *
 * Onboarding completeness — % of active associates with each signal.
 * ========================================================================= */

complianceScorecardRouter.get('/onboarding', VIEW, async (req, res) => {
  const body = await buildOnboardingTile(clientScope(req));
  res.json(body);
});

export async function buildOnboardingTile(
  clientId?: string | null,
): Promise<ScorecardOnboardingResponse> {
  const active = await getActiveAssociates(clientId);
  const ids = active.map((a) => a.associateId);
  const total = active.length;
  const subjectByid = new Map(active.map((a) => [a.associateId, a]));

  // Empty fast-path so every downstream query gets `WHERE id IN ()` skipped.
  if (total === 0) {
    return ScorecardOnboardingResponseSchema.parse({
      activeAssociateCount: 0,
      fullyCompliantCount: 0,
      signals: [],
      severity: 'ok',
      generatedAt: new Date().toISOString(),
    });
  }

  // All signal queries fan out in parallel.
  const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 3600 * 1000);
  const eighteenYearsAgo = new Date();
  eighteenYearsAgo.setFullYear(eighteenYearsAgo.getFullYear() - 18);

  // Every query is `distinct: ['associateId']` with `take: ids.length` —
  // with distinct, the row count is bounded by the population, so the take
  // is EXACT, never a truncation. The old flat `take: 500` without distinct
  // meant ~250 associates holding two drug-test documents exhausted the
  // window and pushed healthy associates into "missing" — a compliance
  // dashboard reporting false criticals.
  const [drugRows, bgRows, bgDocRows, i9Rows, w4Rows, offerDocs, policyAcks] =
    await Promise.all([
      prisma.documentRecord.findMany({
        take: ids.length,
        distinct: ['associateId'],
        where: {
          associateId: { in: ids },
          kind: 'DRUG_TEST_RESULT',
          deletedAt: null,
          createdAt: { gte: sixtyDaysAgo },
        },
        select: { associateId: true },
      }),
      prisma.backgroundCheck.findMany({
        take: ids.length,
        distinct: ['associateId'],
        where: { associateId: { in: ids }, status: 'PASSED' },
        select: { associateId: true },
      }),
      prisma.documentRecord.findMany({
        take: ids.length,
        distinct: ['associateId'],
        where: {
          associateId: { in: ids },
          kind: 'BACKGROUND_CHECK_RESULT',
          deletedAt: null,
        },
        select: { associateId: true },
      }),
      prisma.i9Verification.findMany({
        take: ids.length,
        distinct: ['associateId'],
        where: {
          associateId: { in: ids },
          section1CompletedAt: { not: null },
          section2CompletedAt: { not: null },
        },
        select: {
          associateId: true,
          eVerifyStatus: true,
        },
      }),
      prisma.w4Submission.findMany({
        take: ids.length,
        distinct: ['associateId'],
        where: { associateId: { in: ids } },
        select: { associateId: true },
      }),
      prisma.documentRecord.findMany({
        take: ids.length,
        distinct: ['associateId'],
        where: {
          associateId: { in: ids },
          kind: 'OFFER_LETTER',
          deletedAt: null,
        },
        select: { associateId: true },
      }),
      prisma.policyAcknowledgment.findMany({
        take: ids.length,
        where: { associateId: { in: ids } },
        select: { associateId: true },
        distinct: ['associateId'],
      }),
    ]);

  const setOf = (rows: Array<{ associateId: string }>) =>
    new Set(rows.map((r) => r.associateId));

  const drugSet = setOf(drugRows);
  const bgSet = new Set([...setOf(bgRows), ...setOf(bgDocRows)]);
  const i9Set = setOf(i9Rows);
  const eVerifyClearedSet = new Set(
    i9Rows.filter((r) => r.eVerifyStatus === 'EMPLOYMENT_AUTHORIZED').map((r) => r.associateId),
  );
  const w4Set = setOf(w4Rows);
  const offerSet = setOf(offerDocs);
  const policySet = setOf(policyAcks);

  const ageOkSet = new Set(
    active.filter((a) => a.dob && a.dob <= eighteenYearsAgo).map((a) => a.associateId),
  );

  // Statutory clocks: I-9 §2 and the E-Verify case both run on a federal
  // three-business-day window from the hire date. These two signals carry
  // actual fine exposure, so their gaps get a deadline + overdue math and
  // any overdue forces the signal critical regardless of population size.
  const STATUTORY_KEYS = new Set<ScorecardOnboardingSignal['key']>([
    'I9_BOTH_SECTIONS',
    'E_VERIFY',
  ]);
  const now = new Date();

  function buildSignal(
    key: ScorecardOnboardingSignal['key'],
    label: string,
    contractClause: string,
    completed: Set<string>,
  ): ScorecardOnboardingSignal {
    const missingIds = ids.filter((id) => !completed.has(id));
    const statutory = STATUTORY_KEYS.has(key);
    let overdueCount = 0;
    if (statutory) {
      for (const id of missingIds) {
        const hire = subjectByid.get(id)?.hireDate;
        if (hire && addBusinessDays(hire, 3) < now) overdueCount++;
      }
    }
    return {
      key,
      label,
      contractClause,
      completedCount: completed.size,
      missingCount: missingIds.length,
      ...(statutory ? { overdueCount } : {}),
      // Cap the missing list at 100 per signal so a deluge doesn't blow up
      // the response. The drawer in the UI shows count + first N. Overdue
      // subjects sort first so the cap never hides a federal deadline.
      missing: missingIds
        .map((id) => {
          const s = subjectByid.get(id)!;
          const dueBy =
            statutory && s.hireDate ? addBusinessDays(s.hireDate, 3) : null;
          const daysOverdue = dueBy
            ? Math.floor((now.getTime() - dueBy.getTime()) / 86_400_000)
            : null;
          return {
            associateId: s.associateId,
            associateName: s.associateName,
            clientId: s.clientId,
            clientName: s.clientName,
            ...(dueBy
              ? {
                  dueBy: dueBy.toISOString().slice(0, 10),
                  daysOverdue,
                }
              : {}),
          };
        })
        .sort((a, b) => (b.daysOverdue ?? -1e9) - (a.daysOverdue ?? -1e9))
        .slice(0, 100),
    };
  }

  const signals: ScorecardOnboardingSignal[] = [
    buildSignal('AGE_18_PLUS', 'Age verified 18+', CLAUSE.AGE_18, ageOkSet),
    buildSignal('DRUG_TEST_60D', 'Drug test result within 60 days', CLAUSE.DRUG_TEST, drugSet),
    buildSignal('BACKGROUND_CHECK', 'Background check on file', CLAUSE.BACKGROUND, bgSet),
    buildSignal('I9_BOTH_SECTIONS', 'I-9 Section 1 + Section 2', CLAUSE.I9, i9Set),
    buildSignal('E_VERIFY', 'E-Verify cleared', CLAUSE.E_VERIFY, eVerifyClearedSet),
    buildSignal('W4_ON_FILE', 'W-4 on file', CLAUSE.W4, w4Set),
    buildSignal('OFFER_LETTER_SIGNED', 'Offer letter on file', CLAUSE.OFFER, offerSet),
    buildSignal('POLICY_ACK_SIGNED', 'Policy acknowledged', CLAUSE.POLICY, policySet),
  ];

  // Tile severity = worst per-signal failure — with a hard override: any
  // gap past a statutory deadline is critical no matter how small a slice
  // of the population it is. One overdue I-9 is a federal exposure; 0.4%
  // is not a comfort.
  const anyStatutoryOverdue = signals.some((s) => (s.overdueCount ?? 0) > 0);
  const worst = signals.reduce((worstPct, s) => {
    const pct = total === 0 ? 0 : (s.missingCount / total) * 100;
    return Math.max(worstPct, pct);
  }, 0);

  // Fully compliant = passes every signal. Computed from the uncapped sets
  // because the per-signal `missing[]` payload is sliced for response size.
  const allSignalSets: Array<Set<string>> = [
    ageOkSet, drugSet, bgSet, i9Set, eVerifyClearedSet, w4Set, offerSet, policySet,
  ];
  const fullyCompliantCount = ids.filter((id) =>
    allSignalSets.every((s) => s.has(id)),
  ).length;

  return ScorecardOnboardingResponseSchema.parse({
    activeAssociateCount: total,
    fullyCompliantCount,
    signals,
    severity: anyStatutoryOverdue ? 'critical' : severityFromPercent(worst),
    generatedAt: new Date().toISOString(),
  });
}

/* ============================================================ TILE 2 ===== *
 * Expiring documents — 30/60/90 day rollup.
 * ========================================================================= */

complianceScorecardRouter.get('/expirations', VIEW, async (req, res) => {
  const body = await buildExpirationsTile(clientScope(req));
  res.json(body);
});

export async function buildExpirationsTile(
  clientId?: string | null,
): Promise<ScorecardExpirationsResponse> {
  const now = new Date();
  const ninetyDaysOut = new Date(now.getTime() + 90 * 24 * 3600 * 1000);

  const active = await getActiveAssociates(clientId);
  const activeIds = active.map((a) => a.associateId);
  const subjectById = new Map(active.map((a) => [a.associateId, a]));

  // Drug test expiry is computed: createdAt + 60 days. Anything created in
  // the last 90 days is in our window because the latest expiry is 60 days
  // out from now (test created today expires 60 days from now).
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 3600 * 1000);

  const [drugDocs, i9Rows, j1Rows, certRows, expiringDocs, vaxRows, agreementRows] =
    await Promise.all([
      // LATEST drug test per associate — the old query pushed one item per
      // document, so a retested associate showed a stale duplicate expiry.
      prisma.documentRecord.findMany({
        take: activeIds.length,
        distinct: ['associateId'],
        orderBy: { createdAt: 'desc' },
        where: {
          kind: 'DRUG_TEST_RESULT',
          deletedAt: null,
          createdAt: { gte: ninetyDaysAgo },
          associateId: { in: activeIds },
        },
        select: {
          associateId: true,
          createdAt: true,
          associate: { select: { firstName: true, lastName: true } },
        },
      }),
      prisma.i9Verification.findMany({
        take: 2000,
        where: {
          workAuthExpiresAt: { gte: now, lte: ninetyDaysOut },
          associateId: { in: activeIds },
        },
        select: {
          associateId: true,
          workAuthExpiresAt: true,
          associate: { select: { firstName: true, lastName: true } },
        },
      }),
      prisma.j1Profile.findMany({
        take: 2000,
        where: {
          programEndDate: { gte: now, lte: ninetyDaysOut },
          associateId: { in: activeIds },
        },
        select: {
          associateId: true,
          programEndDate: true,
          associate: { select: { firstName: true, lastName: true } },
        },
      }),
      prisma.courseEnrollment.findMany({
        take: 2000,
        where: {
          expiresAt: { gte: now, lte: ninetyDaysOut },
          associateId: { in: activeIds },
          status: 'COMPLETED',
        },
        select: {
          associateId: true,
          expiresAt: true,
          course: { select: { title: true } },
          associate: { select: { firstName: true, lastName: true } },
        },
      }),
      // DocumentRecord.expiresAt is a real, indexed expiry column the tile
      // never queried — it computed drug-test expiry from createdAt instead
      // and ignored everything else that carries a date.
      prisma.documentRecord.findMany({
        take: 2000,
        where: {
          expiresAt: { gte: now, lte: ninetyDaysOut },
          deletedAt: null,
          status: { notIn: ['REJECTED'] },
          associateId: { in: activeIds },
          // Drug tests are handled by the computed-window entry above.
          kind: { not: 'DRUG_TEST_RESULT' },
        },
        select: {
          associateId: true,
          expiresAt: true,
          kind: true,
          filename: true,
          associate: { select: { firstName: true, lastName: true } },
        },
      }),
      prisma.vaccinationRecord.findMany({
        take: 2000,
        where: {
          expiresOn: { gte: now, lte: ninetyDaysOut },
          associateId: { in: activeIds },
        },
        select: {
          associateId: true,
          expiresOn: true,
          kind: true,
          customLabel: true,
          associate: { select: { firstName: true, lastName: true } },
        },
      }),
      prisma.agreement.findMany({
        take: 2000,
        where: {
          expiresOn: { gte: now, lte: ninetyDaysOut },
          associateId: { in: activeIds },
          deletedAt: null,
          status: { in: ['PENDING_SIGNATURE', 'SIGNED'] },
        },
        select: {
          associateId: true,
          expiresOn: true,
          kind: true,
          customLabel: true,
          associate: { select: { firstName: true, lastName: true } },
        },
      }),
    ]);

  const items: ScorecardExpiringItem[] = [];

  for (const d of drugDocs) {
    const expiresAt = new Date(d.createdAt.getTime() + 60 * 24 * 3600 * 1000);
    if (expiresAt < now || expiresAt > ninetyDaysOut) continue;
    const subj = subjectById.get(d.associateId);
    items.push({
      kind: 'DRUG_TEST',
      label: 'Drug test (60-day window)',
      expiresAt: expiresAt.toISOString(),
      daysUntil: Math.round((expiresAt.getTime() - now.getTime()) / 86_400_000),
      subject: {
        associateId: d.associateId,
        associateName: `${d.associate.firstName} ${d.associate.lastName}`,
        clientId: subj?.clientId ?? null,
        clientName: subj?.clientName ?? null,
      },
    });
  }
  for (const r of i9Rows) {
    if (!r.workAuthExpiresAt) continue;
    const subj = subjectById.get(r.associateId);
    items.push({
      kind: 'I9_WORK_AUTH',
      label: 'I-9 work authorization',
      expiresAt: r.workAuthExpiresAt.toISOString(),
      daysUntil: Math.round((r.workAuthExpiresAt.getTime() - now.getTime()) / 86_400_000),
      subject: {
        associateId: r.associateId,
        associateName: `${r.associate.firstName} ${r.associate.lastName}`,
        clientId: subj?.clientId ?? null,
        clientName: subj?.clientName ?? null,
      },
    });
  }
  for (const j of j1Rows) {
    const subj = subjectById.get(j.associateId);
    items.push({
      kind: 'J1_DS2019',
      label: 'J-1 DS-2019 program end',
      expiresAt: j.programEndDate.toISOString(),
      daysUntil: Math.round((j.programEndDate.getTime() - now.getTime()) / 86_400_000),
      subject: {
        associateId: j.associateId,
        associateName: `${j.associate.firstName} ${j.associate.lastName}`,
        clientId: subj?.clientId ?? null,
        clientName: subj?.clientName ?? null,
      },
    });
  }
  for (const e of certRows) {
    if (!e.expiresAt) continue;
    const subj = subjectById.get(e.associateId);
    items.push({
      kind: 'TRAINING_CERT',
      label: e.course.title,
      expiresAt: e.expiresAt.toISOString(),
      daysUntil: Math.round((e.expiresAt.getTime() - now.getTime()) / 86_400_000),
      subject: {
        associateId: e.associateId,
        associateName: `${e.associate.firstName} ${e.associate.lastName}`,
        clientId: subj?.clientId ?? null,
        clientName: subj?.clientName ?? null,
      },
    });
  }
  const humanizeEnum = (v: string) =>
    v
      .toLowerCase()
      .replace(/_/g, ' ')
      .replace(/^\w/, (c) => c.toUpperCase());
  for (const d of expiringDocs) {
    if (!d.expiresAt) continue;
    const subj = subjectById.get(d.associateId);
    items.push({
      kind: 'DOCUMENT',
      label: `${humanizeEnum(d.kind)} — ${d.filename}`,
      expiresAt: d.expiresAt.toISOString(),
      daysUntil: Math.round((d.expiresAt.getTime() - now.getTime()) / 86_400_000),
      subject: {
        associateId: d.associateId,
        associateName: `${d.associate.firstName} ${d.associate.lastName}`,
        clientId: subj?.clientId ?? null,
        clientName: subj?.clientName ?? null,
      },
    });
  }
  for (const v of vaxRows) {
    if (!v.expiresOn) continue;
    const subj = subjectById.get(v.associateId);
    items.push({
      kind: 'VACCINATION',
      label:
        v.kind === 'OTHER' && v.customLabel
          ? `Vaccination — ${v.customLabel}`
          : `Vaccination — ${humanizeEnum(v.kind)}`,
      expiresAt: v.expiresOn.toISOString(),
      daysUntil: Math.round((v.expiresOn.getTime() - now.getTime()) / 86_400_000),
      subject: {
        associateId: v.associateId,
        associateName: `${v.associate.firstName} ${v.associate.lastName}`,
        clientId: subj?.clientId ?? null,
        clientName: subj?.clientName ?? null,
      },
    });
  }
  for (const a of agreementRows) {
    if (!a.expiresOn) continue;
    const subj = subjectById.get(a.associateId);
    items.push({
      kind: 'AGREEMENT',
      label:
        a.kind === 'OTHER' && a.customLabel
          ? `Agreement — ${a.customLabel}`
          : `Agreement — ${humanizeEnum(a.kind)}`,
      expiresAt: a.expiresOn.toISOString(),
      daysUntil: Math.round((a.expiresOn.getTime() - now.getTime()) / 86_400_000),
      subject: {
        associateId: a.associateId,
        associateName: `${a.associate.firstName} ${a.associate.lastName}`,
        clientId: subj?.clientId ?? null,
        clientName: subj?.clientName ?? null,
      },
    });
  }

  const red = items.filter((i) => i.daysUntil >= 0 && i.daysUntil <= 30);
  const amber = items.filter((i) => i.daysUntil > 30 && i.daysUntil <= 60);
  const green = items.filter((i) => i.daysUntil > 60 && i.daysUntil <= 90);

  // Sort each bucket nearest-first.
  for (const arr of [red, amber, green]) {
    arr.sort((a, b) => a.daysUntil - b.daysUntil);
  }

  const attestations = await loadAttestationSignals('EXPIRATIONS');
  const overdueAttestations = attestations.filter((a) => a.status === 'overdue').length;
  const dueSoonAttestations = attestations.filter((a) => a.status === 'due_soon').length;

  // Severity rolls together expiry-bucket rollup AND insurance attestations:
  // any red doc OR overdue insurance = critical; amber/due_soon = warn.
  const severity: ScorecardSeverity =
    red.length > 0 || overdueAttestations > 0
      ? 'critical'
      : amber.length > 0 || dueSoonAttestations > 0
        ? 'warn'
        : 'ok';

  return ScorecardExpirationsResponseSchema.parse({
    buckets: { red, amber, green },
    attestations,
    severity,
    generatedAt: new Date().toISOString(),
  });
}

/* ============================================================ TILE 3 ===== *
 * Shift compliance — fill rate is real; everything else is "coming soon".
 * ========================================================================= */

complianceScorecardRouter.get('/shifts', VIEW, async (req, res) => {
  const body = await buildShiftsTile(clientScope(req));
  res.json(body);
});

// Tile 3 silently falls back when ASN Nexus is unreachable / misconfigured —
// every fallback path looks identical to the user. This endpoint surfaces the
// actual reason so ops can tell unconfigured from broken without grepping
// Railway logs. Returns hostname only (never the full URL or the API key).
complianceScorecardRouter.get('/asn-nexus/diagnostic', VIEW, async (_req, res) => {
  const baseUrl = process.env.ASN_NEXUS_BASE_URL ?? null;
  const keySet = !!process.env.ASN_NEXUS_API_KEY;
  let hostname: string | null = null;
  if (baseUrl) {
    try {
      hostname = new URL(baseUrl).host;
    } catch {
      hostname = '<invalid URL>';
    }
  }

  const out: {
    configured: boolean;
    baseUrlHost: string | null;
    apiKeySet: boolean;
    probe: {
      attempted: boolean;
      ok: boolean;
      durationMs: number | null;
      errorClass: string | null;
      errorMessage: string | null;
      sampleFillRate: number | null;
    };
  } = {
    configured: asnNexusConfigured(),
    baseUrlHost: hostname,
    apiKeySet: keySet,
    probe: {
      attempted: false,
      ok: false,
      durationMs: null,
      errorClass: null,
      errorMessage: null,
      sampleFillRate: null,
    },
  };

  if (asnNexusConfigured()) {
    out.probe.attempted = true;
    const start = Date.now();
    try {
      const result = await getShiftMetrics({ windowDays: 30, timeoutMs: 4000 });
      out.probe.durationMs = Date.now() - start;
      out.probe.ok = true;
      out.probe.sampleFillRate = result?.metrics.fillRate.value ?? null;
    } catch (err) {
      out.probe.durationMs = Date.now() - start;
      out.probe.errorClass = err instanceof Error ? err.constructor.name : typeof err;
      out.probe.errorMessage = err instanceof Error ? err.message : String(err);
    }
  }

  res.json(out);
});

export async function buildShiftsTile(
  clientId?: string | null,
): Promise<ScorecardShiftsResponse> {
  const windowDays = 30;

  // ASN Nexus is the source of truth for shift events. If the integration
  // is configured (env vars set + endpoint reachable), every signal comes
  // from there. If a metric is null in the response, ASN hasn't built it
  // yet — surface as "Coming soon".
  //
  // If the integration isn't configured OR the call fails, fall back to
  // our built-in fill-rate query against the local Shift table — keeps
  // dev environments and emergency outages working with a degraded view.
  //
  // CLIENT SCOPE: ASN Nexus metrics are org-wide — when a client filter is
  // active we always use the local per-client query so the number actually
  // reflects the selected client instead of quietly ignoring the filter.
  let asn: Awaited<ReturnType<typeof getShiftMetrics>> = null;
  if (!clientId && asnNexusConfigured()) {
    try {
      asn = await getShiftMetrics({ windowDays });
    } catch (err) {
      console.warn('[compliance-scorecard] ASN Nexus fetch failed; falling back:', err);
      asn = null;
    }
  }

  if (asn) {
    const signals: ScorecardShiftsResponse['signals'] = [
      asnSignal('FILL_RATE', 'Shift fill rate', CLAUSE.FILL_RATE, asn.metrics.fillRate),
      asnSignal('NO_SHOW_RATE', 'No-show rate', CLAUSE.NO_SHOW, asn.metrics.noShowRate),
      asnSignal('SHIFT_LEAD_PRESENT', 'Shift Lead present', CLAUSE.SHIFT_LEAD, asn.metrics.shiftLeadPresent),
      asnSignal('TEMPERATURE_LOGS', 'Temperature logs with photos', CLAUSE.TEMP_LOG, asn.metrics.temperatureLogs),
      asnSignal('MOD_SIGNOFF', 'MOD sign-off captured', CLAUSE.MOD_SIGNOFF, asn.metrics.modSignoff),
      asnSignal('FIELDGLASS_TIMESHEETS', 'Fieldglass timesheet by Mon 2pm PST', CLAUSE.FIELDGLASS, asn.metrics.fieldglassTimesheetsOnTime),
    ];

    return ScorecardShiftsResponseSchema.parse({
      windowDays: asn.windowDays,
      signals,
      severity: shiftsSeverity(signals),
      generatedAt: asn.generatedAt,
    });
  }

  // -------- Fallback: local fill-rate query --------------------------------
  // Fill rate = ASSIGNED + COMPLETED / (everything except DRAFT and CANCELLED).
  // DRAFT is unpublished scratch; CANCELLED was pulled (doesn't count against
  // fill rate). OPEN is published-but-unfilled — that's the gap.
  const since = new Date(Date.now() - windowDays * 24 * 3600 * 1000);
  const counts = await prisma.shift.groupBy({
    by: ['status'],
    _count: { _all: true },
    where: {
      startsAt: { gte: since },
      status: { in: ['OPEN', 'ASSIGNED', 'COMPLETED', 'CANCELLED'] },
      ...(clientId ? { clientId } : {}),
    },
  });
  const byStatus = new Map(counts.map((c) => [c.status, c._count._all]));
  const filled = (byStatus.get('ASSIGNED') ?? 0) + (byStatus.get('COMPLETED') ?? 0);
  const open = byStatus.get('OPEN') ?? 0;
  const denominator = filled + open;
  const fillRate = denominator === 0 ? null : Number(((filled / denominator) * 100).toFixed(1));

  const fillSeverity: ScorecardSeverity =
    fillRate === null ? 'ok' : fillRate >= 97 ? 'ok' : fillRate >= 90 ? 'warn' : 'critical';

  const placeholderReason = 'Connect ASN Nexus (set ASN_NEXUS_BASE_URL + ASN_NEXUS_API_KEY) to enable.';

  const signals: ScorecardShiftsResponse['signals'] = [
    {
      key: 'FILL_RATE',
      label: 'Shift fill rate (local — last 30 days)',
      contractClause: CLAUSE.FILL_RATE,
      status: 'live',
      value: fillRate,
      target: 97,
      reason: null,
    },
    { key: 'NO_SHOW_RATE',         label: 'No-show rate',                          contractClause: CLAUSE.NO_SHOW,      status: 'unsupported', value: null, target: 2,   reason: placeholderReason },
    { key: 'SHIFT_LEAD_PRESENT',   label: 'Shift Lead present',                    contractClause: CLAUSE.SHIFT_LEAD,   status: 'unsupported', value: null, target: 100, reason: placeholderReason },
    { key: 'TEMPERATURE_LOGS',     label: 'Temperature logs with photos',          contractClause: CLAUSE.TEMP_LOG,     status: 'unsupported', value: null, target: 100, reason: placeholderReason },
    { key: 'MOD_SIGNOFF',          label: 'MOD sign-off captured',                 contractClause: CLAUSE.MOD_SIGNOFF,  status: 'unsupported', value: null, target: 100, reason: placeholderReason },
    { key: 'FIELDGLASS_TIMESHEETS',label: 'Fieldglass timesheet by Mon 2pm PST',   contractClause: CLAUSE.FIELDGLASS,   status: 'unsupported', value: null, target: 100, reason: placeholderReason },
  ];

  return ScorecardShiftsResponseSchema.parse({
    windowDays,
    signals,
    severity: fillSeverity,
    generatedAt: new Date().toISOString(),
  });
}

// Maps an ASN Nexus metric onto a scorecard signal. value=null means ASN
// hasn't implemented the signal yet — render as unsupported with a note.
function asnSignal(
  key: ScorecardShiftsResponse['signals'][number]['key'],
  label: string,
  contractClause: string,
  metric: AsnNexusMetric,
): ScorecardShiftsResponse['signals'][number] {
  if (metric.value === null) {
    return {
      key,
      label,
      contractClause,
      status: 'unsupported',
      value: null,
      target: metric.target,
      reason: metric.note ?? 'ASN Nexus has not implemented this signal yet.',
    };
  }
  return {
    key,
    label,
    contractClause,
    status: 'live',
    value: metric.value,
    target: metric.target,
    reason: metric.note ?? null,
  };
}

// Tile severity from the ASN-driven signal mix. NO_SHOW_RATE is the only
// signal where lower is better — invert it before scoring.
function shiftsSeverity(signals: ScorecardShiftsResponse['signals']): ScorecardSeverity {
  let worst: ScorecardSeverity = 'ok';
  for (const s of signals) {
    if (s.status !== 'live' || s.value === null || s.target === null) continue;
    const isNoShow = s.key === 'NO_SHOW_RATE';
    const passes = isNoShow ? s.value <= s.target : s.value >= s.target;
    if (passes) continue;
    const ratio = isNoShow ? s.target / Math.max(s.value, 0.01) : s.value / s.target;
    const severity: ScorecardSeverity = ratio >= 0.93 ? 'warn' : 'critical';
    if (severity === 'critical') return 'critical';
    if (severity === 'warn') worst = 'warn';
  }
  return worst;
}

/* ============================================================ TILE 4 ===== *
 * Billing & invoicing — bill-rate match is real; the rest are "coming soon".
 * ========================================================================= */

complianceScorecardRouter.get('/billing', VIEW, async (req, res) => {
  const body = await buildBillingTile(clientScope(req));
  res.json(body);
});

export async function buildBillingTile(
  clientId?: string | null,
): Promise<ScorecardBillingResponse> {
  // Pull every active job with a bill rate set; map to expected Walmart SOW
  // rate by name pattern. Mismatches feed the open-actions tile.
  const jobs = await prisma.job.findMany({
    take: 1000,
    where: {
      isActive: true,
      billRate: { not: null },
      ...(clientId ? { clientId } : {}),
    },
    select: {
      id: true,
      name: true,
      billRate: true,
      client: { select: { id: true, name: true } },
    },
    orderBy: [{ client: { name: 'asc' } }, { name: 'asc' }],
  });

  const rateChecks: ScorecardBillingResponse['rateChecks'] = jobs.map((j) => {
    const expected = WALMART_BILL_RATES.find((r) => r.pattern.test(j.name));
    const billRate = Number(j.billRate);
    return {
      clientId: j.client.id,
      clientName: j.client.name,
      jobId: j.id,
      jobName: j.name,
      billRate,
      expectedRate: expected?.rate ?? null,
      // Match is true if no expected rate (we have no opinion) OR billRate
      // is within $0.01 of the expected. Strict equality on Decimal would
      // be brittle.
      match: expected ? Math.abs(billRate - expected.rate) < 0.01 : true,
    };
  });

  const mismatches = rateChecks.filter(
    (r) => r.expectedRate !== null && !r.match,
  ).length;

  const attestations = await loadAttestationSignals('BILLING');

  // Tile severity now considers both bill-rate mismatches AND attestation
  // state. Any overdue attestation = critical; any mismatch or due_soon =
  // warn; otherwise ok.
  const overdueCount = attestations.filter((a) => a.status === 'overdue').length;
  const dueSoonCount = attestations.filter((a) => a.status === 'due_soon').length;
  const severity: ScorecardSeverity =
    overdueCount > 0
      ? 'critical'
      : mismatches > 0 || dueSoonCount > 0
        ? 'warn'
        : 'ok';

  return ScorecardBillingResponseSchema.parse({
    rateChecks,
    attestations,
    severity,
    generatedAt: new Date().toISOString(),
  });
}

/* ----- Manual compliance attestation endpoints --------------------------- */

const MANAGE_COMPLIANCE = requireCapability('manage:compliance');

complianceScorecardRouter.get('/attestations', VIEW, async (_req, res, next) => {
  try {
    const signals = await loadAttestationSignals();
    res.json(ManualAttestationListResponseSchema.parse({ signals }));
  } catch (err) {
    next(err);
  }
});

complianceScorecardRouter.post(
  '/attestations',
  MANAGE_COMPLIANCE,
  async (req, res, next) => {
    try {
      const input = ManualAttestationCreateInputSchema.parse(req.body);
      const config = getAttestationConfig(input.key);
      if (!config) {
        throw new HttpError(
          400,
          'unknown_attestation_key',
          `Unknown attestation key: ${input.key}`,
        );
      }
      const periodStart = parseDateOnly(input.periodStart);
      // Verify the supplied period matches a real period for this signal —
      // reject random dates so the unique (key, periodStart) index can't
      // be polluted with off-grid rows.
      const expected = periodForNow(config.cadence, periodStart);
      if (
        toDateKey(periodStart) !== toDateKey(expected.periodStart)
      ) {
        throw new HttpError(
          400,
          'invalid_period',
          'periodStart must align with the cadence (Monday for WEEKLY, 1st of month for MONTHLY, Jan 1 for ANNUAL).',
        );
      }

      const row = await prisma.manualComplianceAttestation.upsert({
        where: { key_periodStart: { key: input.key, periodStart } },
        create: {
          key: input.key,
          periodStart,
          periodEnd: expected.periodEnd,
          outcome: input.outcome,
          actionTakenAt: input.actionTakenAt
            ? new Date(input.actionTakenAt)
            : null,
          attestedById: req.user!.id,
          notes: input.notes,
          evidenceDocumentId: input.evidenceDocumentId,
        },
        update: {
          outcome: input.outcome,
          actionTakenAt: input.actionTakenAt
            ? new Date(input.actionTakenAt)
            : null,
          attestedById: req.user!.id,
          attestedAt: new Date(),
          notes: input.notes,
          evidenceDocumentId: input.evidenceDocumentId,
        },
      });

      enqueueAudit(
        {
          actorUserId: req.user!.id,
          action: 'compliance.attestation.upsert',
          entityType: 'ManualComplianceAttestation',
          entityId: row.id,
          metadata: {
            key: input.key,
            periodStart: toDateKey(periodStart),
            outcome: input.outcome,
          },
        },
        'attestation upsert',
      );

      const signals = await loadAttestationSignals();
      const signal = signals.find((s) => s.key === input.key);
      res.status(201).json({ signal });
    } catch (err) {
      if (err instanceof z.ZodError) {
        next(new HttpError(400, 'invalid_body', 'Invalid attestation', err.flatten()));
        return;
      }
      next(err);
    }
  },
);

async function loadAttestationSignals(
  tile?: 'BILLING' | 'EXPIRATIONS' | 'SAFETY',
): Promise<ManualAttestationSignal[]> {
  const now = new Date();
  const signals: ManualAttestationSignal[] = [];

  const configs = tile
    ? ATTESTATION_CONFIGS.filter((c) => c.tile === tile)
    : ATTESTATION_CONFIGS;

  for (const config of configs) {
    const { periodStart, periodEnd } = periodForNow(config.cadence, now);
    const previousPeriod = previousPeriodFor(config, periodStart);

    const rows = await prisma.manualComplianceAttestation.findMany({
      where: {
        key: config.key,
        periodStart: {
          in: [periodStart, previousPeriod.periodStart],
        },
      },
      include: { attestedBy: { select: { email: true } } },
    });
    const current = rows.find(
      (r) => toDateKey(r.periodStart) === toDateKey(periodStart),
    );
    const previous = rows.find(
      (r) => toDateKey(r.periodStart) === toDateKey(previousPeriod.periodStart),
    );

    signals.push({
      key: config.key,
      label: config.label,
      description: config.description,
      cadence: config.cadence,
      periodStart: toDateKey(periodStart),
      periodEnd: toDateKey(periodEnd),
      dueDate: toDateKey(dueDateFor(config, periodStart)),
      status: classifyStatus(config, periodStart, !!current, now),
      current: current
        ? {
            id: current.id,
            outcome: current.outcome,
            actionTakenAt: current.actionTakenAt
              ? current.actionTakenAt.toISOString()
              : null,
            attestedById: current.attestedById,
            attestedByEmail: current.attestedBy.email,
            attestedAt: current.attestedAt.toISOString(),
            notes: current.notes,
            evidenceDocumentId: current.evidenceDocumentId,
          }
        : null,
      previous: previous
        ? {
            periodStart: toDateKey(previous.periodStart),
            periodEnd: toDateKey(previous.periodEnd),
            outcome: previous.outcome,
            actionTakenAt: previous.actionTakenAt
              ? previous.actionTakenAt.toISOString()
              : null,
          }
        : null,
    });
  }

  return signals;
}

function previousPeriodFor(
  config: AttestationConfig,
  currentStart: Date,
): { periodStart: Date; periodEnd: Date } {
  if (config.cadence === 'WEEKLY') {
    const start = new Date(currentStart);
    start.setUTCDate(start.getUTCDate() - 7);
    return periodForNow('WEEKLY', start);
  }
  if (config.cadence === 'ANNUAL') {
    const start = new Date(currentStart);
    start.setUTCFullYear(start.getUTCFullYear() - 1);
    return periodForNow('ANNUAL', start);
  }
  const start = new Date(currentStart);
  start.setUTCMonth(start.getUTCMonth() - 1);
  return periodForNow('MONTHLY', start);
}

function toDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parseDateOnly(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/* ============================================================ TILE 5 ===== *
 * Training completeness — per ComplianceTag, % of active associates with
 * a COMPLETED enrollment in any course tagged that way.
 * ========================================================================= */

complianceScorecardRouter.get('/training', VIEW, async (req, res) => {
  const body = await buildTrainingTile(clientScope(req));
  res.json(body);
});

export async function buildTrainingTile(
  clientId?: string | null,
): Promise<ScorecardTrainingResponse> {
  const active = await getActiveAssociates(clientId);
  const activeIds = active.map((a) => a.associateId);
  const subjectById = new Map(active.map((a) => [a.associateId, a]));
  const total = active.length;

  const tags: Array<{
    tag: ComplianceTag;
    label: string;
    contractClause: string;
  }> = [
    { tag: 'EEO_HARASSMENT', label: 'EEO + harassment training', contractClause: CLAUSE.EEO },
    { tag: 'OSHA_SAFETY', label: 'OSHA safety training', contractClause: CLAUSE.OSHA_TRAIN },
    { tag: 'WALMART_CADE', label: 'Walmart CADE training', contractClause: CLAUSE.CADE },
    { tag: 'FOOD_HANDLER', label: 'Food handler certification', contractClause: CLAUSE.FOOD_HANDLER },
  ];

  const courses = await prisma.course.findMany({
    take: 1000,
    where: { complianceTag: { not: null }, deletedAt: null },
    select: { id: true, complianceTag: true },
  });
  const courseIdsByTag = new Map<ComplianceTag, string[]>();
  for (const c of courses) {
    if (!c.complianceTag) continue;
    const arr = courseIdsByTag.get(c.complianceTag) ?? [];
    arr.push(c.id);
    courseIdsByTag.set(c.complianceTag, arr);
  }

  const allCourseIds = courses.map((c) => c.id);
  const enrollments = allCourseIds.length === 0 || activeIds.length === 0
    ? []
    : await prisma.courseEnrollment.findMany({
        // Exact bound + distinct: the old take:500 silently marked associate
        // #501's completed training as missing once enrollments grew.
        take: allCourseIds.length * activeIds.length,
        distinct: ['courseId', 'associateId'],
        where: {
          courseId: { in: allCourseIds },
          associateId: { in: activeIds },
          status: 'COMPLETED',
        },
        select: { courseId: true, associateId: true },
      });

  const completedByCourse = new Map<string, Set<string>>();
  for (const e of enrollments) {
    const set = completedByCourse.get(e.courseId) ?? new Set<string>();
    set.add(e.associateId);
    completedByCourse.set(e.courseId, set);
  }

  const signals: ScorecardTrainingResponse['signals'] = tags.map(({ tag, label, contractClause }) => {
    const cIds = courseIdsByTag.get(tag) ?? [];
    if (cIds.length === 0) {
      return {
        tag, label, contractClause,
        status: 'no_course' as const,
        completedCount: 0,
        totalAssociates: total,
        missing: [],
      };
    }
    // Completed = associates with at least one COMPLETED enrollment in any
    // course tagged this category. Multiple courses = OR.
    const completed = new Set<string>();
    for (const cId of cIds) {
      const s = completedByCourse.get(cId);
      if (s) for (const id of s) completed.add(id);
    }
    const missingIds = activeIds.filter((id) => !completed.has(id));
    return {
      tag, label, contractClause,
      status: 'live' as const,
      completedCount: completed.size,
      totalAssociates: total,
      missing: missingIds.slice(0, 100).map((id) => {
        const s = subjectById.get(id)!;
        return {
          associateId: s.associateId,
          associateName: s.associateName,
          clientId: s.clientId,
          clientName: s.clientName,
        };
      }),
    };
  });

  const liveSignals = signals.filter((s) => s.status === 'live');
  const worst = liveSignals.reduce((worstPct, s) => {
    const pct = total === 0 ? 0 : ((s.totalAssociates - s.completedCount) / total) * 100;
    return Math.max(worstPct, pct);
  }, 0);

  return ScorecardTrainingResponseSchema.parse({
    signals,
    severity: liveSignals.length === 0 ? 'ok' : severityFromPercent(worst),
    generatedAt: new Date().toISOString(),
  });
}

/* ============================================================ TILE 7 ===== *
 * OSHA safety — incident log (Form 300 shape) + TRIR/DART normalized
 * against real hours worked from TimeEntry. Recordability is derived from
 * the outcome per 1904.7 at write time, never re-decided at read time.
 * ========================================================================= */

const SAFETY_OUTCOME_LABEL: Record<SafetyIncidentOutcome, string> = {
  NEAR_MISS: 'near miss',
  FIRST_AID_ONLY: 'first aid only',
  MEDICAL_TREATMENT: 'medical treatment',
  RESTRICTED_DUTY: 'restricted duty',
  DAYS_AWAY: 'days away from work',
  LOSS_OF_CONSCIOUSNESS: 'loss of consciousness',
  FATALITY: 'fatality',
};

const incidentInclude = {
  associate: { select: { firstName: true, lastName: true } },
  client: { select: { name: true } },
  reportedBy: { select: { email: true } },
} as const;

type IncidentRow = Prisma.SafetyIncidentGetPayload<{ include: typeof incidentInclude }>;

function serializeIncident(r: IncidentRow): SafetyIncident {
  return {
    id: r.id,
    associateId: r.associateId,
    associateName: `${r.associate.firstName} ${r.associate.lastName}`,
    clientId: r.clientId,
    clientName: r.client?.name ?? null,
    occurredAt: r.occurredAt.toISOString(),
    location: r.location,
    description: r.description,
    outcome: r.outcome,
    recordable: r.recordable,
    daysAway: r.daysAway,
    daysRestricted: r.daysRestricted,
    status: r.status,
    closedAt: r.closedAt?.toISOString() ?? null,
    closureNotes: r.closureNotes,
    reportedByEmail: r.reportedBy?.email ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

/** TRIR/DART denominator: hours actually worked (closed, non-rejected time
 *  entries) since `since`. Summed in SQL — a year of punches is far too many
 *  rows to pull into JS just to subtract timestamps. */
async function hoursWorkedSince(since: Date, clientId?: string | null): Promise<number> {
  const rows = clientId
    ? await prisma.$queryRaw<Array<{ hours: unknown }>>`
        SELECT COALESCE(SUM(EXTRACT(EPOCH FROM ("clockOutAt" - "clockInAt"))) / 3600, 0) AS hours
        FROM "TimeEntry"
        WHERE "clockOutAt" IS NOT NULL
          AND "status"::text IN ('COMPLETED', 'APPROVED')
          AND "clockInAt" >= ${since}
          AND "clientId" = ${clientId}::uuid`
    : await prisma.$queryRaw<Array<{ hours: unknown }>>`
        SELECT COALESCE(SUM(EXTRACT(EPOCH FROM ("clockOutAt" - "clockInAt"))) / 3600, 0) AS hours
        FROM "TimeEntry"
        WHERE "clockOutAt" IS NOT NULL
          AND "status"::text IN ('COMPLETED', 'APPROVED')
          AND "clockInAt" >= ${since}`;
  return Number(rows[0]?.hours ?? 0);
}

complianceScorecardRouter.get('/safety', VIEW, async (req, res) => {
  res.json(await buildSafetyTile(clientScope(req)));
});

export async function buildSafetyTile(
  clientId?: string | null,
): Promise<ScorecardSafetyResponse> {
  const now = new Date();
  const ytdStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const scope = clientId ? { clientId } : {};

  const [ytdRecordables, lastRecordable, openRows, hours] = await Promise.all([
    prisma.safetyIncident.findMany({
      take: 10_000,
      where: { recordable: true, occurredAt: { gte: ytdStart }, ...scope },
      select: { outcome: true },
    }),
    prisma.safetyIncident.findFirst({
      where: { recordable: true, ...scope },
      orderBy: { occurredAt: 'desc' },
      select: { occurredAt: true },
    }),
    prisma.safetyIncident.findMany({
      where: { status: 'OPEN', ...scope },
      orderBy: { occurredAt: 'desc' },
      take: 50,
      include: incidentInclude,
    }),
    hoursWorkedSince(ytdStart, clientId),
  ]);

  const recordableCountYtd = ytdRecordables.length;
  const dartCountYtd = ytdRecordables.filter((r) => isDartOutcome(r.outcome)).length;
  const hoursWorkedYtd = Math.round(hours * 10) / 10;
  // OSHA normalization: incidents × 200,000 ÷ hours (100 FTE-years).
  const trir =
    hoursWorkedYtd > 0
      ? Number(((recordableCountYtd * 200_000) / hoursWorkedYtd).toFixed(2))
      : null;
  const dart =
    hoursWorkedYtd > 0
      ? Number(((dartCountYtd * 200_000) / hoursWorkedYtd).toFixed(2))
      : null;
  const daysSinceLastRecordable = lastRecordable
    ? Math.max(
        0,
        Math.floor((now.getTime() - lastRecordable.occurredAt.getTime()) / 86_400_000),
      )
    : null;

  const attestations = await loadAttestationSignals('SAFETY');
  const overdueAtt = attestations.filter((a) => a.status === 'overdue').length;
  const dueSoonAtt = attestations.filter((a) => a.status === 'due_soon').length;

  // Severity: a fatality or days-away case still open, or an overdue 300A
  // posting, is critical. Any other open incident, a TRIR above target, or
  // a 300A coming due is warn.
  const openSevere = openRows.some(
    (r) => r.outcome === 'FATALITY' || r.outcome === 'DAYS_AWAY',
  );
  const severity: ScorecardSeverity =
    openSevere || overdueAtt > 0
      ? 'critical'
      : openRows.length > 0 || dueSoonAtt > 0 || (trir !== null && trir > OSHA_TRIR_TARGET)
        ? 'warn'
        : 'ok';

  return ScorecardSafetyResponseSchema.parse({
    daysSinceLastRecordable,
    recordableCountYtd,
    dartCountYtd,
    hoursWorkedYtd,
    trir,
    dart,
    openIncidents: openRows.map(serializeIncident),
    attestations,
    severity,
    generatedAt: new Date().toISOString(),
  });
}

/* ----- Incident log CRUD -------------------------------------------------- */

complianceScorecardRouter.get('/safety-incidents', VIEW, async (req, res, next) => {
  try {
    const clientId = clientScope(req);
    const status =
      req.query.status === 'OPEN' || req.query.status === 'CLOSED'
        ? req.query.status
        : undefined;
    const rows = await prisma.safetyIncident.findMany({
      where: {
        ...(clientId ? { clientId } : {}),
        ...(status ? { status } : {}),
      },
      orderBy: { occurredAt: 'desc' },
      take: 200,
      include: incidentInclude,
    });
    res.json(
      SafetyIncidentListResponseSchema.parse({
        incidents: rows.map(serializeIncident),
      }),
    );
  } catch (err) {
    next(err);
  }
});

complianceScorecardRouter.post('/safety-incidents', MANAGE_COMPLIANCE, async (req, res, next) => {
  try {
    const input = SafetyIncidentCreateInputSchema.parse(req.body);
    const occurredAt = new Date(input.occurredAt);
    if (occurredAt.getTime() > Date.now() + 60_000) {
      throw new HttpError(400, 'future_incident', 'An incident cannot occur in the future.');
    }
    // Client attribution snapshots the associate's active placement at
    // report time so a later transfer doesn't rewrite this client's TRIR.
    const app = await prisma.application.findFirst({
      where: { associateId: input.associateId, status: 'APPROVED', deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { clientId: true },
    });
    const recordable = isRecordableOutcome(input.outcome);

    const row = await prisma.safetyIncident.create({
      data: {
        associateId: input.associateId,
        clientId: app?.clientId ?? null,
        occurredAt,
        location: input.location ?? null,
        description: input.description,
        outcome: input.outcome,
        recordable,
        daysAway: input.daysAway ?? 0,
        daysRestricted: input.daysRestricted ?? 0,
        reportedById: req.user!.id,
      },
      include: incidentInclude,
    });

    enqueueAudit(
      {
        actorUserId: req.user!.id,
        action: 'compliance.safety_incident.created',
        entityType: 'SafetyIncident',
        entityId: row.id,
        metadata: {
          associateId: input.associateId,
          outcome: input.outcome,
          recordable,
        },
      },
      'safety incident created',
    );

    // A recordable is org news — every admin hears about it once, loudly.
    // Near-misses and first-aid stay in the log without a broadcast.
    if (recordable) {
      void notifyAllAdmins({
        subject: `Recordable safety incident — ${row.associate.firstName} ${row.associate.lastName}`,
        body:
          `${SAFETY_OUTCOME_LABEL[row.outcome]} on ${occurredAt.toISOString().slice(0, 10)}` +
          `${row.location ? ` at ${row.location}` : ''}. ` +
          `${input.description.slice(0, 200)}${input.description.length > 200 ? '…' : ''}\n\n` +
          'Review it on the compliance scorecard (Safety tile).',
        category: 'compliance',
        linkUrl: '/compliance?tab=scorecard',
      });
    }

    res.status(201).json({ incident: serializeIncident(row) });
  } catch (err) {
    if (err instanceof z.ZodError) {
      next(new HttpError(400, 'invalid_body', 'Invalid incident', err.flatten()));
      return;
    }
    next(err);
  }
});

complianceScorecardRouter.patch('/safety-incidents/:id', MANAGE_COMPLIANCE, async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const input = SafetyIncidentUpdateInputSchema.parse(req.body);
    const existing = await prisma.safetyIncident.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!existing) throw new HttpError(404, 'not_found', 'Incident not found.');

    const data: Prisma.SafetyIncidentUpdateInput = {
      ...(input.outcome !== undefined
        ? { outcome: input.outcome, recordable: isRecordableOutcome(input.outcome) }
        : {}),
      ...(input.daysAway !== undefined ? { daysAway: input.daysAway } : {}),
      ...(input.daysRestricted !== undefined ? { daysRestricted: input.daysRestricted } : {}),
      ...(input.closureNotes !== undefined ? { closureNotes: input.closureNotes } : {}),
    };
    if (input.status !== undefined && input.status !== existing.status) {
      data.status = input.status;
      data.closedAt = input.status === 'CLOSED' ? new Date() : null;
    }

    const row = await prisma.safetyIncident.update({
      where: { id },
      data,
      include: incidentInclude,
    });

    enqueueAudit(
      {
        actorUserId: req.user!.id,
        action: 'compliance.safety_incident.updated',
        entityType: 'SafetyIncident',
        entityId: id,
        metadata: {
          status: input.status ?? null,
          outcome: input.outcome ?? null,
        },
      },
      'safety incident updated',
    );

    res.json({ incident: serializeIncident(row) });
  } catch (err) {
    if (err instanceof z.ZodError) {
      next(new HttpError(400, 'invalid_body', 'Invalid incident update', err.flatten()));
      return;
    }
    next(err);
  }
});

/* ============================================================ TILE 6 ===== *
 * Open actions — server-side rollup so the page renders without 5 tiles
 * each fetching twice.
 * ========================================================================= */

complianceScorecardRouter.get('/actions', VIEW, async (req, res) => {
  const body = await buildActionsTile(clientScope(req));
  res.json(body);
});

/** All five live tiles, built once. Shared by the actions rollup, the daily
 *  snapshot cron and the board PDF so none of them triple-query the tiles. */
export async function buildScorecardBundle(clientId?: string | null) {
  const [onboarding, expirations, shifts, billing, training, safety] = await Promise.all([
    buildOnboardingTile(clientId),
    buildExpirationsTile(clientId),
    buildShiftsTile(clientId),
    buildBillingTile(clientId),
    buildTrainingTile(clientId),
    buildSafetyTile(clientId),
  ]);
  return { onboarding, expirations, shifts, billing, training, safety };
}
export type ScorecardBundle = Awaited<ReturnType<typeof buildScorecardBundle>>;

/* ------------------------------------------------------------------------- *
 * Weighted 0–100 compliance score. Weights encode legal exposure, not tile
 * symmetry: statutory items (I-9, E-Verify) dominate; a single statutory
 * deadline blown past costs a flat 10 points on top of its weighted share.
 *   Onboarding signals ......... 60 pts (I9 12, E-Verify 10, background 10,
 *                                 drug 8, age 6, W-4 6, offer 4, policy 4)
 *   Training tags .............. 12 pts (4 × 3)
 *   Expirations (red bucket) ... 10 pts (scaled by red ÷ active headcount)
 *   Shift fill rate ............ 10 pts (scaled by shortfall vs target)
 *   Safety ..................... 8 pts (each OPEN recordable costs 2)
 *   Statutory-overdue penalty .. −10 flat
 * ------------------------------------------------------------------------- */
const ONBOARDING_WEIGHTS: Record<ScorecardOnboardingSignal['key'], number> = {
  I9_BOTH_SECTIONS: 12,
  E_VERIFY: 10,
  BACKGROUND_CHECK: 10,
  DRUG_TEST_60D: 8,
  AGE_18_PLUS: 6,
  W4_ON_FILE: 6,
  OFFER_LETTER_SIGNED: 4,
  POLICY_ACK_SIGNED: 4,
};
const TRAINING_WEIGHT_PER_TAG = 3;
const EXPIRATIONS_WEIGHT = 10;
const SHIFTS_WEIGHT = 10;
const SAFETY_WEIGHT = 8;
const STATUTORY_OVERDUE_PENALTY = 10;

export function computeWeightedScore(bundle: ScorecardBundle): number {
  const { onboarding, expirations, shifts, training, safety } = bundle;
  const total = onboarding.activeAssociateCount;

  // Empty org = nothing out of compliance. 100, not NaN.
  if (total === 0) return 100;

  let score = 0;

  for (const sig of onboarding.signals) {
    const weight = ONBOARDING_WEIGHTS[sig.key] ?? 0;
    score += weight * Math.max(0, 1 - sig.missingCount / total);
  }

  for (const sig of training.signals) {
    // no_course = we can't measure it; award full credit rather than
    // punishing the org for a course catalog gap the tile already flags.
    if (sig.status !== 'live' || sig.totalAssociates === 0) {
      score += TRAINING_WEIGHT_PER_TAG;
      continue;
    }
    score += TRAINING_WEIGHT_PER_TAG * (sig.completedCount / sig.totalAssociates);
  }

  score += EXPIRATIONS_WEIGHT * Math.max(0, 1 - expirations.buckets.red.length / total);

  const fill = shifts.signals.find((s) => s.key === 'FILL_RATE');
  if (fill && fill.status === 'live' && fill.value !== null && fill.target) {
    score += SHIFTS_WEIGHT * Math.max(0, Math.min(1, fill.value / fill.target));
  } else {
    score += SHIFTS_WEIGHT;
  }

  // Each OPEN recordable incident costs a quarter of the safety weight.
  // TRIR/DART stay informational — the score punishes unresolved incidents,
  // not the historical rate the org can no longer change.
  const openRecordables = safety.openIncidents.filter((i) => i.recordable).length;
  score += SAFETY_WEIGHT * Math.max(0, 1 - openRecordables / 4);

  const anyStatutoryOverdue = onboarding.signals.some((s) => (s.overdueCount ?? 0) > 0);
  if (anyStatutoryOverdue) score -= STATUTORY_OVERDUE_PENALTY;

  return Math.max(0, Math.min(100, Math.round(score)));
}

export async function buildActionsTile(
  clientId?: string | null,
  prebuilt?: ScorecardBundle,
): Promise<ScorecardActionsResponse> {
  // Run the live tiles in parallel and synthesize an action per failure.
  const bundle = prebuilt ?? (await buildScorecardBundle(clientId));
  const { onboarding, expirations, shifts, billing, training, safety } = bundle;

  const actions: ScorecardAction[] = [];

  // Tile 1 — one action per missing associate per signal (capped via the
  // signal's own missing[] cap).
  for (const sig of onboarding.signals) {
    for (const subject of sig.missing) {
      actions.push({
        id: `onb:${sig.key}:${subject.associateId}`,
        // Critical signals: missing background check, missing I-9, missing
        // E-Verify. Others are warn — they'd block payroll but not work.
        severity:
          sig.key === 'BACKGROUND_CHECK' || sig.key === 'I9_BOTH_SECTIONS' || sig.key === 'E_VERIFY'
            ? 'critical'
            : 'warn',
        title: `${subject.associateName ?? 'Associate'} — missing ${sig.label.toLowerCase()}`,
        contractClause: sig.contractClause,
        subject,
        link: onboardingFixLink(sig.key, subject.associateId),
      });
    }
  }

  // Tile 2 — anything in the red bucket is critical; amber is warn.
  for (const item of expirations.buckets.red) {
    actions.push({
      id: `exp:${item.kind}:${item.subject.associateId ?? 'global'}:${item.expiresAt}`,
      severity: 'critical',
      title: `${item.subject.associateName ?? 'Item'} — ${item.label} expires in ${item.daysUntil}d`,
      contractClause: getExpirationClause(item.kind),
      subject: item.subject,
      link: expirationFixLink(item.kind, item.subject.associateId),
    });
  }
  for (const item of expirations.buckets.amber) {
    actions.push({
      id: `exp:${item.kind}:${item.subject.associateId ?? 'global'}:${item.expiresAt}`,
      severity: 'warn',
      title: `${item.subject.associateName ?? 'Item'} — ${item.label} expires in ${item.daysUntil}d`,
      contractClause: getExpirationClause(item.kind),
      subject: item.subject,
      link: expirationFixLink(item.kind, item.subject.associateId),
    });
  }

  // Tile 3 — only the live one (fill rate) can fail; "coming soon" tiles
  // don't generate actions.
  for (const s of shifts.signals) {
    if (s.status !== 'live' || s.value === null || s.target === null) continue;
    if (s.value >= s.target) continue;
    actions.push({
      id: `shf:${s.key}`,
      severity: s.value >= s.target * 0.93 ? 'warn' : 'critical',
      title: `${s.label}: ${s.value}% (target ${s.target}%)`,
      contractClause: s.contractClause,
      subject: { associateId: null, associateName: null, clientId: null, clientName: null },
      link: '/scheduling',
    });
  }

  // Tile 4 — bill-rate mismatches (only ones with a known expected rate).
  for (const r of billing.rateChecks) {
    if (r.expectedRate === null || r.match) continue;
    actions.push({
      id: `bil:${r.jobId}`,
      severity: 'warn',
      title: `${r.clientName} / ${r.jobName} — bill rate $${r.billRate.toFixed(2)} ≠ SOW $${r.expectedRate.toFixed(2)}`,
      contractClause: CLAUSE.BILL_RATE,
      subject: {
        associateId: null,
        associateName: null,
        clientId: r.clientId,
        clientName: r.clientName,
      },
      link: `/clients/${r.clientId}`,
    });
  }

  // Tile 5 — missing training per associate per tag.
  for (const sig of training.signals) {
    if (sig.status !== 'live') continue;
    for (const subject of sig.missing) {
      actions.push({
        id: `trn:${sig.tag}:${subject.associateId}`,
        severity: 'warn',
        title: `${subject.associateName ?? 'Associate'} — missing ${sig.label.toLowerCase()}`,
        contractClause: sig.contractClause,
        subject,
        // Training gaps are fixed on the person record (enrollments live
        // there) — and the People page reads ?associateId=, not ?associate=.
        link: subject.associateId ? `/people?associateId=${subject.associateId}` : null,
      });
    }
  }

  // Tile 7 — every open safety incident is an action until a human closes
  // it. Fatality / days-away cases are critical; the rest warn.
  for (const inc of safety.openIncidents) {
    actions.push({
      id: `saf:${inc.id}`,
      severity:
        inc.outcome === 'FATALITY' || inc.outcome === 'DAYS_AWAY' ? 'critical' : 'warn',
      title: `${inc.associateName ?? 'Associate'} — open safety incident (${SAFETY_OUTCOME_LABEL[inc.outcome]}, ${inc.occurredAt.slice(0, 10)})`,
      contractClause: CLAUSE.OSHA_LOG,
      subject: {
        associateId: inc.associateId,
        associateName: inc.associateName,
        clientId: inc.clientId,
        clientName: inc.clientName,
      },
      // The incident is closed on the safety tile itself, same page.
      link: null,
    });
  }

  // Attach persisted remediation state. The table only ever holds TOUCHED
  // rows (assigned/snoozed/done) so fetching them all is a handful of rows,
  // not a scan of the derived action space.
  const stateRows = await prisma.complianceActionState.findMany({
    where: { OR: [{ status: { not: 'OPEN' } }, { assigneeUserId: { not: null } }] },
    select: {
      actionKey: true,
      status: true,
      assigneeUserId: true,
      snoozedUntil: true,
      updatedAt: true,
      assignee: { select: { email: true } },
    },
  });
  const stateByKey = new Map(stateRows.map((s) => [s.actionKey, s]));
  const now = Date.now();

  const withState = actions
    .map((a) => {
      const s = stateByKey.get(a.id);
      if (!s) return a;
      return {
        ...a,
        state: {
          status: s.status as 'OPEN' | 'SNOOZED' | 'DONE',
          assigneeUserId: s.assigneeUserId,
          assigneeEmail: s.assignee?.email ?? null,
          snoozedUntil: s.snoozedUntil?.toISOString() ?? null,
          updatedAt: s.updatedAt.toISOString(),
        },
      };
    })
    .filter((a) => {
      const s = a.state;
      if (!s) return true;
      // DONE = resolved by a human; if the underlying gap re-opens the
      // derived id survives, so stale DONEs are the operator's own record.
      if (s.status === 'DONE') return false;
      // SNOOZED hides the row until the snooze lapses.
      if (s.status === 'SNOOZED' && s.snoozedUntil && Date.parse(s.snoozedUntil) > now) {
        return false;
      }
      return true;
    });

  // Critical first, then warn, then ok. Stable within group.
  const order: Record<ScorecardSeverity, number> = { critical: 0, warn: 1, ok: 2 };
  withState.sort((a, b) => order[a.severity] - order[b.severity]);

  const criticalCount = withState.filter((a) => a.severity === 'critical').length;
  const warnCount = withState.filter((a) => a.severity === 'warn').length;

  return ScorecardActionsResponseSchema.parse({
    // Cap total list at 200 to keep the response bounded; the page is a
    // dashboard, not an issue tracker. truncated + totalActionCount let the
    // UI and CSV say so instead of passing a page off as the world.
    actions: withState.slice(0, 200),
    criticalCount,
    warnCount,
    score: computeWeightedScore(bundle),
    truncated: withState.length > 200,
    totalActionCount: withState.length,
    generatedAt: new Date().toISOString(),
  });
}

/* ----- Action remediation state (assign / snooze / done) ----------------- */

complianceScorecardRouter.post(
  '/actions/state',
  MANAGE_COMPLIANCE,
  async (req, res, next) => {
    try {
      const input = ScorecardActionStateInputSchema.parse(req.body);
      if (input.status === 'SNOOZED' && !input.snoozedUntil) {
        throw new HttpError(400, 'missing_snooze_until', 'snoozedUntil is required when snoozing.');
      }

      const patch: {
        status?: string;
        assigneeUserId?: string | null;
        snoozedUntil?: Date | null;
      } = {};
      if (input.status !== undefined) {
        patch.status = input.status;
        // Leaving SNOOZED clears the timer; the stale date must not re-hide
        // the row if someone snoozes again later without a new date.
        if (input.status !== 'SNOOZED') patch.snoozedUntil = null;
      }
      if (input.assigneeUserId !== undefined) patch.assigneeUserId = input.assigneeUserId;
      if (input.snoozedUntil !== undefined) {
        patch.snoozedUntil = input.snoozedUntil ? new Date(input.snoozedUntil) : null;
      }

      const row = await prisma.complianceActionState.upsert({
        where: { actionKey: input.actionId },
        create: {
          actionKey: input.actionId,
          status: input.status ?? 'OPEN',
          assigneeUserId: input.assigneeUserId ?? null,
          snoozedUntil: input.snoozedUntil ? new Date(input.snoozedUntil) : null,
          updatedById: req.user!.id,
        },
        update: { ...patch, updatedById: req.user!.id },
        select: {
          status: true,
          assigneeUserId: true,
          snoozedUntil: true,
          updatedAt: true,
          assignee: { select: { email: true } },
        },
      });

      enqueueAudit(
        {
          actorUserId: req.user!.id,
          action: 'compliance.action_state.upsert',
          entityType: 'ComplianceActionState',
          entityId: input.actionId,
          metadata: {
            status: input.status ?? null,
            assigneeUserId: input.assigneeUserId ?? null,
            snoozedUntil: input.snoozedUntil ?? null,
          },
        },
        'compliance action state',
      );

      // Tell the assignee — bell-only (quiet): assignment is workflow
      // plumbing, not an emergency, and the email-overload work taught us
      // not to burn a send on it. Self-assignment skips even the bell.
      if (
        input.assigneeUserId &&
        input.assigneeUserId !== req.user!.id &&
        row.assigneeUserId === input.assigneeUserId
      ) {
        await notifyUser(input.assigneeUserId, {
          subject: 'Compliance action assigned to you',
          body: `You were assigned a compliance scorecard action (${input.actionId}).`,
          category: 'compliance',
          linkUrl: '/compliance?tab=scorecard',
          quiet: true,
        });
      }

      res.json({
        state: {
          status: row.status as 'OPEN' | 'SNOOZED' | 'DONE',
          assigneeUserId: row.assigneeUserId,
          assigneeEmail: row.assignee?.email ?? null,
          snoozedUntil: row.snoozedUntil?.toISOString() ?? null,
          updatedAt: row.updatedAt.toISOString(),
        },
      });
    } catch (err) {
      if (err instanceof z.ZodError) {
        next(new HttpError(400, 'invalid_body', 'Invalid action state', err.flatten()));
        return;
      }
      next(err);
    }
  },
);

/* ----- Score history (daily snapshots) ----------------------------------- */

complianceScorecardRouter.get('/history', VIEW, async (req, res, next) => {
  try {
    const clientId = clientScope(req);
    const days = Math.min(365, Math.max(7, Number(req.query.days) || 90));
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);

    const rows = await prisma.complianceScoreSnapshot.findMany({
      where: { clientId: clientId ?? null, day: { gte: since } },
      orderBy: { day: 'asc' },
      take: 400,
      select: {
        day: true,
        score: true,
        criticalCount: true,
        warnCount: true,
        activeAssociateCount: true,
        fullyCompliantCount: true,
      },
    });

    const points = rows.map((r) => ({
      day: r.day.toISOString().slice(0, 10),
      score: r.score,
      criticalCount: r.criticalCount,
      warnCount: r.warnCount,
      activeAssociateCount: r.activeAssociateCount,
      fullyCompliantCount: r.fullyCompliantCount,
    }));

    // Week delta = latest score minus the closest snapshot ≥6 days older
    // than the latest (tolerates missed cron days).
    let weekDelta: number | null = null;
    if (points.length >= 2) {
      const latest = points[points.length - 1];
      const latestMs = Date.parse(latest.day);
      const anchor = [...points]
        .reverse()
        .find((p) => latestMs - Date.parse(p.day) >= 6 * 24 * 3600 * 1000);
      if (anchor) weekDelta = latest.score - anchor.score;
    }

    res.json(ScorecardHistoryResponseSchema.parse({ points, weekDelta }));
  } catch (err) {
    next(err);
  }
});

/* ----- Board one-pager PDF ------------------------------------------------ */

complianceScorecardRouter.get('/report.pdf', VIEW, async (req, res, next) => {
  try {
    const clientId = clientScope(req);
    const [bundle, client] = await Promise.all([
      buildScorecardBundle(clientId),
      clientId
        ? prisma.client.findUnique({ where: { id: clientId }, select: { name: true } })
        : Promise.resolve(null),
    ]);
    const { onboarding, expirations, shifts, billing, training, safety } = bundle;
    const score = computeWeightedScore(bundle);
    const grade = scorecardGrade(score);
    const scopeLabel = client?.name ?? 'All clients';

    // Trend context from snapshots (best-effort — a fresh install has none).
    const since = new Date(Date.now() - 35 * 24 * 3600 * 1000);
    const snaps = await prisma.complianceScoreSnapshot.findMany({
      where: { clientId: clientId ?? null, day: { gte: since } },
      orderBy: { day: 'asc' },
      select: { day: true, score: true },
    });
    const weekAgo = [...snaps]
      .reverse()
      .find((s) => Date.now() - s.day.getTime() >= 6 * 24 * 3600 * 1000);

    const pdf = new ReportPdf({
      title: 'Compliance Scorecard — Executive Summary',
      subtitle: `Scope: ${scopeLabel} · Generated ${new Date().toISOString().slice(0, 10)}`,
      reference: formatRef(),
      facts: [
        { label: 'Score', value: `${score} / 100 (${grade})` },
        ...(weekAgo
          ? [{ label: 'vs last week', value: `${score - weekAgo.score >= 0 ? '+' : ''}${score - weekAgo.score} pts` }]
          : []),
        { label: 'Active associates', value: String(onboarding.activeAssociateCount) },
        { label: 'Fully compliant', value: String(onboarding.fullyCompliantCount) },
      ],
    });

    pdf.heading('Posture at a glance');
    pdf.kv([
      { label: 'Weighted score', value: `${score} / 100 — grade ${grade}` },
      { label: 'Onboarding', value: tileLine(onboarding.severity) },
      { label: 'Expirations', value: `${tileLine(expirations.severity)} · ${expirations.buckets.red.length} inside 30 days` },
      { label: 'Shift compliance', value: tileLine(shifts.severity) },
      { label: 'Billing', value: tileLine(billing.severity) },
      { label: 'Training', value: tileLine(training.severity) },
      { label: 'Safety (OSHA)', value: tileLine(safety.severity) },
    ]);

    const overdueStatutory = onboarding.signals
      .filter((s) => (s.overdueCount ?? 0) > 0)
      .map((s) => `${s.label}: ${s.overdueCount} past the statutory deadline`);
    if (overdueStatutory.length > 0) {
      pdf.callout(
        `STATUTORY EXPOSURE — ${overdueStatutory.join('; ')}. ` +
          'Federal timing rules (I-9 §2 / E-Verify: three business days from hire) are already blown for these associates.',
      );
    }

    pdf.heading('Onboarding signals');
    pdf.table(
      [
        { label: 'Signal' },
        { label: 'Compliant', width: 80, align: 'right' },
        { label: 'Missing', width: 70, align: 'right' },
        { label: 'Overdue', width: 70, align: 'right' },
      ],
      onboarding.signals.map((s) => [
        s.label,
        onboarding.activeAssociateCount - s.missingCount,
        s.missingCount,
        s.overdueCount ?? 0,
      ]),
    );

    pdf.heading('Expiring in the next 30 days');
    if (expirations.buckets.red.length === 0) {
      pdf.para('Nothing expires in the next 30 days.', { muted: true });
    } else {
      pdf.table(
        [
          { label: 'Associate', width: 150 },
          { label: 'Item' },
          { label: 'Days', width: 50, align: 'right' },
        ],
        expirations.buckets.red
          .slice(0, 25)
          .map((i) => [i.subject.associateName ?? '—', i.label, i.daysUntil]),
      );
      if (expirations.buckets.red.length > 25) {
        pdf.para(`…and ${expirations.buckets.red.length - 25} more — see the live scorecard.`, { muted: true });
      }
    }

    pdf.heading('Safety (OSHA)');
    pdf.kv([
      {
        label: 'Days since last recordable',
        value:
          safety.daysSinceLastRecordable === null
            ? 'No recordable incident on file'
            : `${safety.daysSinceLastRecordable} days`,
      },
      {
        label: 'TRIR (YTD)',
        value:
          safety.trir === null
            ? '— (no hours yet)'
            : `${safety.trir} (target ≤ ${OSHA_TRIR_TARGET})`,
      },
      {
        label: 'DART (YTD)',
        value: safety.dart === null ? '— (no hours yet)' : String(safety.dart),
      },
      {
        label: 'Recordables YTD',
        value: `${safety.recordableCountYtd} across ${Math.round(safety.hoursWorkedYtd).toLocaleString('en-US')} hours worked`,
      },
      { label: 'Open incidents', value: String(safety.openIncidents.length) },
    ]);

    if (snaps.length >= 2) {
      pdf.heading('Score trend (last 5 weeks)');
      pdf.table(
        [
          { label: 'Day', width: 110 },
          { label: 'Score', width: 60, align: 'right' },
        ],
        snaps.slice(-10).map((s) => [s.day.toISOString().slice(0, 10), s.score]),
      );
    }

    const buffer = await pdf.render();
    enqueueAudit(
      {
        actorUserId: req.user!.id,
        action: 'compliance.scorecard.report',
        entityType: 'ComplianceScoreSnapshot',
        entityId: clientId ?? 'org',
        metadata: { score, scope: scopeLabel },
      },
      'scorecard board report',
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="alto-compliance-scorecard-${new Date().toISOString().slice(0, 10)}.pdf"`,
    );
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

function tileLine(sev: ScorecardSeverity): string {
  return sev === 'critical' ? 'CRITICAL' : sev === 'warn' ? 'Needs attention' : 'On track';
}

/* ------------------------------------------------------------------------- *
 * Fix-link routing. Every action deep-links the surface that actually FIXES
 * it: the compliance directorate tab that owns the signal (those tabs consume
 * ?associateId= and auto-open the person), falling back to the person record
 * for genuinely person-level gaps. NOTE: the People page reads ?associateId=,
 * never ?associate= — the old param landed every click on the unfiltered
 * directory. ?return= sends the fixer back to the scorecard when done.
 * ------------------------------------------------------------------------- */

const SCORECARD_RETURN = `&return=${encodeURIComponent('/compliance?tab=scorecard')}`;

function onboardingFixLink(
  key: ScorecardOnboardingSignal['key'],
  associateId: string | null,
): string | null {
  if (!associateId) return null;
  switch (key) {
    case 'I9_BOTH_SECTIONS':
      return `/compliance?tab=i9&associateId=${associateId}${SCORECARD_RETURN}`;
    case 'E_VERIFY':
      return `/compliance?tab=everify&associateId=${associateId}${SCORECARD_RETURN}`;
    case 'BACKGROUND_CHECK':
      return `/compliance?tab=background&associateId=${associateId}`;
    case 'DRUG_TEST_60D':
      return `/compliance?tab=drugtests&associateId=${associateId}`;
    // Age, W-4, offer letter, policy ack — person-record-level gaps.
    default:
      return `/people?associateId=${associateId}`;
  }
}

function expirationFixLink(
  kind: ScorecardExpiringItem['kind'],
  associateId: string | null,
): string | null {
  if (!associateId) return null;
  switch (kind) {
    case 'I9_WORK_AUTH':
      return `/compliance?tab=i9&associateId=${associateId}${SCORECARD_RETURN}`;
    case 'DRUG_TEST':
      return `/compliance?tab=drugtests&associateId=${associateId}`;
    case 'J1_DS2019':
      return `/compliance?tab=j1&associateId=${associateId}`;
    // Insurance rows carry no associate (link stays null upstream);
    // training certs are renewed from the person record.
    case 'DOCUMENT':
      return `/people?associateId=${associateId}&tab=documents`;
    case 'AGREEMENT':
      return `/agreements?associateId=${associateId}`;
    case 'WORKERS_COMP':
    case 'GENERAL_LIABILITY':
    case 'TRAINING_CERT':
    case 'VACCINATION':
      return `/people?associateId=${associateId}`;
  }
}

function getExpirationClause(kind: ScorecardExpiringItem['kind']): string {
  switch (kind) {
    case 'WORKERS_COMP': return CLAUSE.WC;
    case 'GENERAL_LIABILITY': return CLAUSE.GL;
    case 'DRUG_TEST': return CLAUSE.DRUG_EXPIRY;
    case 'I9_WORK_AUTH': return CLAUSE.WORK_AUTH;
    case 'J1_DS2019': return CLAUSE.J1;
    case 'TRAINING_CERT': return CLAUSE.TRAINING_EXPIRY;
    case 'DOCUMENT': return CLAUSE.DOC_EXPIRY;
    case 'VACCINATION': return CLAUSE.VAX_EXPIRY;
    case 'AGREEMENT': return CLAUSE.AGREEMENT_EXPIRY;
  }
}

// Suppress the "imported but unused" if Prisma typings ever drop the import.
void Prisma;
