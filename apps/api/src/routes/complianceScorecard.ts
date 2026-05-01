import { Router } from 'express';
import { Prisma } from '@prisma/client';
import {
  ScorecardActionsResponseSchema,
  ScorecardBillingResponseSchema,
  ScorecardExpirationsResponseSchema,
  ScorecardOnboardingResponseSchema,
  ScorecardShiftsResponseSchema,
  ScorecardTrainingResponseSchema,
  type ComplianceTag,
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
} from '@alto-people/shared';
import { prisma } from '../db.js';
import { requireCapability } from '../middleware/auth.js';
import { getShiftMetrics, isConfigured as asnNexusConfigured, type AsnNexusMetric } from '../lib/asnNexus.js';

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
} as const;

// Returns the union of associate ids whose most-recent active Application is
// APPROVED. Reused by tiles 1 + 5. Includes Application.clientId so the
// scorecard can show client-scoped rollups later.
async function getActiveAssociates() {
  const apps = await prisma.application.findMany({
    where: {
      status: 'APPROVED',
      deletedAt: null,
      associate: { deletedAt: null },
    },
    select: {
      associateId: true,
      clientId: true,
      associate: { select: { firstName: true, lastName: true, dob: true } },
      client: { select: { name: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  // De-dup by associateId — one associate may have multiple historical
  // approved applications; we keep the most recent.
  const seen = new Set<string>();
  const rows: Array<{
    associateId: string;
    associateName: string;
    clientId: string;
    clientName: string;
    dob: Date | null;
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
    });
  }
  return rows;
}

// Tile severity rule of thumb: any signal failing > 10% of the population is
// critical; any failure at all is warn; all clear is ok. Tunable later.
function severityFromPercent(failPct: number): ScorecardSeverity {
  if (failPct > 10) return 'critical';
  if (failPct > 0) return 'warn';
  return 'ok';
}

/* ============================================================ TILE 1 ===== *
 * Onboarding completeness — % of active associates with each signal.
 * ========================================================================= */

complianceScorecardRouter.get('/onboarding', VIEW, async (_req, res) => {
  const body = await buildOnboardingTile();
  res.json(body);
});

async function buildOnboardingTile(): Promise<ScorecardOnboardingResponse> {
  const active = await getActiveAssociates();
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

  const [drugRows, bgRows, bgDocRows, i9Rows, w4Rows, offerDocs, policyAcks] =
    await Promise.all([
      prisma.documentRecord.findMany({
        where: {
          associateId: { in: ids },
          kind: 'DRUG_TEST_RESULT',
          deletedAt: null,
          createdAt: { gte: sixtyDaysAgo },
        },
        select: { associateId: true },
      }),
      prisma.backgroundCheck.findMany({
        where: { associateId: { in: ids }, status: 'PASSED' },
        select: { associateId: true },
      }),
      prisma.documentRecord.findMany({
        where: {
          associateId: { in: ids },
          kind: 'BACKGROUND_CHECK_RESULT',
          deletedAt: null,
        },
        select: { associateId: true },
      }),
      prisma.i9Verification.findMany({
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
        where: { associateId: { in: ids } },
        select: { associateId: true },
      }),
      prisma.documentRecord.findMany({
        where: {
          associateId: { in: ids },
          kind: 'OFFER_LETTER',
          deletedAt: null,
        },
        select: { associateId: true },
      }),
      prisma.policyAcknowledgment.findMany({
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

  function buildSignal(
    key: ScorecardOnboardingSignal['key'],
    label: string,
    contractClause: string,
    completed: Set<string>,
  ): ScorecardOnboardingSignal {
    const missingIds = ids.filter((id) => !completed.has(id));
    return {
      key,
      label,
      contractClause,
      completedCount: completed.size,
      missingCount: missingIds.length,
      // Cap the missing list at 100 per signal so a deluge doesn't blow up
      // the response. The drawer in the UI shows count + first N.
      missing: missingIds.slice(0, 100).map((id) => {
        const s = subjectByid.get(id)!;
        return {
          associateId: s.associateId,
          associateName: s.associateName,
          clientId: s.clientId,
          clientName: s.clientName,
        };
      }),
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

  // Tile severity = worst per-signal failure.
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
    severity: severityFromPercent(worst),
    generatedAt: new Date().toISOString(),
  });
}

/* ============================================================ TILE 2 ===== *
 * Expiring documents — 30/60/90 day rollup.
 * ========================================================================= */

complianceScorecardRouter.get('/expirations', VIEW, async (_req, res) => {
  const body = await buildExpirationsTile();
  res.json(body);
});

async function buildExpirationsTile(): Promise<ScorecardExpirationsResponse> {
  const now = new Date();
  const ninetyDaysOut = new Date(now.getTime() + 90 * 24 * 3600 * 1000);

  const active = await getActiveAssociates();
  const activeIds = active.map((a) => a.associateId);
  const subjectById = new Map(active.map((a) => [a.associateId, a]));

  // Drug test expiry is computed: createdAt + 60 days. Anything created in
  // the last 90 days is in our window because the latest expiry is 60 days
  // out from now (test created today expires 60 days from now).
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 3600 * 1000);

  const [drugDocs, i9Rows, j1Rows, certRows] = await Promise.all([
    prisma.documentRecord.findMany({
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

  const red = items.filter((i) => i.daysUntil >= 0 && i.daysUntil <= 30);
  const amber = items.filter((i) => i.daysUntil > 30 && i.daysUntil <= 60);
  const green = items.filter((i) => i.daysUntil > 60 && i.daysUntil <= 90);

  // Sort each bucket nearest-first.
  for (const arr of [red, amber, green]) {
    arr.sort((a, b) => a.daysUntil - b.daysUntil);
  }

  const severity: ScorecardSeverity =
    red.length > 0 ? 'critical' : amber.length > 0 ? 'warn' : 'ok';

  return ScorecardExpirationsResponseSchema.parse({
    buckets: { red, amber, green },
    unsupported: [
      {
        kind: 'WORKERS_COMP',
        label: 'Workers Comp insurance',
        reason: 'No insurance-policy model yet; track manually until the vendor-management module ships.',
      },
      {
        kind: 'GENERAL_LIABILITY',
        label: 'General Liability insurance',
        reason: 'No insurance-policy model yet; track manually until the vendor-management module ships.',
      },
    ],
    severity,
    generatedAt: new Date().toISOString(),
  });
}

/* ============================================================ TILE 3 ===== *
 * Shift compliance — fill rate is real; everything else is "coming soon".
 * ========================================================================= */

complianceScorecardRouter.get('/shifts', VIEW, async (_req, res) => {
  const body = await buildShiftsTile();
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

async function buildShiftsTile(): Promise<ScorecardShiftsResponse> {
  const windowDays = 30;

  // ASN Nexus is the source of truth for shift events. If the integration
  // is configured (env vars set + endpoint reachable), every signal comes
  // from there. If a metric is null in the response, ASN hasn't built it
  // yet — surface as "Coming soon".
  //
  // If the integration isn't configured OR the call fails, fall back to
  // our built-in fill-rate query against the local Shift table — keeps
  // dev environments and emergency outages working with a degraded view.
  let asn: Awaited<ReturnType<typeof getShiftMetrics>> = null;
  if (asnNexusConfigured()) {
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

complianceScorecardRouter.get('/billing', VIEW, async (_req, res) => {
  const body = await buildBillingTile();
  res.json(body);
});

async function buildBillingTile(): Promise<ScorecardBillingResponse> {
  // Pull every active job with a bill rate set; map to expected Walmart SOW
  // rate by name pattern. Mismatches feed the open-actions tile.
  const jobs = await prisma.job.findMany({
    where: { isActive: true, billRate: { not: null } },
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
  const severity: ScorecardSeverity = mismatches === 0 ? 'ok' : 'warn';

  return ScorecardBillingResponseSchema.parse({
    rateChecks,
    unsupported: [
      {
        key: 'INVOICE_FORFEITURE',
        label: 'Invoices nearing 90-day forfeiture',
        reason: 'No Invoice model in schema; track in QuickBooks until the AR module ships.',
      },
      {
        key: 'MONTHLY_REPORT',
        label: 'Monthly compliance report submitted',
        reason: 'No model tracking client-report submission state.',
      },
      {
        key: 'FIELDGLASS_LAST_SUBMIT',
        label: 'Last Fieldglass submission',
        reason: 'No Fieldglass integration in schema yet.',
      },
    ],
    severity,
    generatedAt: new Date().toISOString(),
  });
}

/* ============================================================ TILE 5 ===== *
 * Training completeness — per ComplianceTag, % of active associates with
 * a COMPLETED enrollment in any course tagged that way.
 * ========================================================================= */

complianceScorecardRouter.get('/training', VIEW, async (_req, res) => {
  const body = await buildTrainingTile();
  res.json(body);
});

async function buildTrainingTile(): Promise<ScorecardTrainingResponse> {
  const active = await getActiveAssociates();
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

/* ============================================================ TILE 6 ===== *
 * Open actions — server-side rollup so the page renders without 5 tiles
 * each fetching twice.
 * ========================================================================= */

complianceScorecardRouter.get('/actions', VIEW, async (_req, res) => {
  const body = await buildActionsTile();
  res.json(body);
});

async function buildActionsTile(): Promise<ScorecardActionsResponse> {
  // Run the live tiles in parallel and synthesize an action per failure.
  const [onboarding, expirations, shifts, billing, training] = await Promise.all([
    buildOnboardingTile(),
    buildExpirationsTile(),
    buildShiftsTile(),
    buildBillingTile(),
    buildTrainingTile(),
  ]);

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
        link: subject.associateId ? `/people?associate=${subject.associateId}` : null,
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
      link: item.subject.associateId ? `/people?associate=${item.subject.associateId}` : null,
    });
  }
  for (const item of expirations.buckets.amber) {
    actions.push({
      id: `exp:${item.kind}:${item.subject.associateId ?? 'global'}:${item.expiresAt}`,
      severity: 'warn',
      title: `${item.subject.associateName ?? 'Item'} — ${item.label} expires in ${item.daysUntil}d`,
      contractClause: getExpirationClause(item.kind),
      subject: item.subject,
      link: item.subject.associateId ? `/people?associate=${item.subject.associateId}` : null,
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
        link: subject.associateId ? `/people?associate=${subject.associateId}` : null,
      });
    }
  }

  // Critical first, then warn, then ok. Stable within group.
  const order: Record<ScorecardSeverity, number> = { critical: 0, warn: 1, ok: 2 };
  actions.sort((a, b) => order[a.severity] - order[b.severity]);

  const criticalCount = actions.filter((a) => a.severity === 'critical').length;
  const warnCount = actions.filter((a) => a.severity === 'warn').length;

  return ScorecardActionsResponseSchema.parse({
    // Cap total list at 200 to keep the response bounded; the page is a
    // dashboard, not an issue tracker.
    actions: actions.slice(0, 200),
    criticalCount,
    warnCount,
    generatedAt: new Date().toISOString(),
  });
}

function getExpirationClause(kind: ScorecardExpiringItem['kind']): string {
  switch (kind) {
    case 'WORKERS_COMP': return CLAUSE.WC;
    case 'GENERAL_LIABILITY': return CLAUSE.GL;
    case 'DRUG_TEST': return CLAUSE.DRUG_EXPIRY;
    case 'I9_WORK_AUTH': return CLAUSE.WORK_AUTH;
    case 'J1_DS2019': return CLAUSE.J1;
    case 'TRAINING_CERT': return CLAUSE.TRAINING_EXPIRY;
  }
}

// Suppress the "imported but unused" if Prisma typings ever drop the import.
void Prisma;
