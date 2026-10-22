import type { PrismaClient } from '@prisma/client';
import { PRODUCT_NAME, SUB_PROCESSORS, TRUST_COMMITMENTS, type Soc2Progress, type TrustControlPublic, type TrustStatus, type TrustSummary, type TrustSummaryPublic } from '@alto-people/shared';
import { complianceEvidence } from './evidence.js';
import { MIN_RETENTION_YEARS, retentionYearsFor } from './auditChain.js';
import { ALTO_TENANT_ID } from './tenant.js';

/**
 * The Trust Center's numbers (UX upgrade step 4). Everything here is an
 * aggregate the product already keeps; nothing is computed for the page.
 * The public summary is cached a minute and carries statuses and dates
 * only: no control detail, no address, no identifiers.
 */

type Db = PrismaClient;

const statusOf = (s: string | null | undefined, state: string): TrustStatus => {
  if (state === 'missing') return 'PENDING';
  if (s === 'PASS' || s === 'WARN' || s === 'FAIL') return s;
  return 'PENDING';
};

async function platformControls(db: Db, now: Date): Promise<TrustControlPublic[]> {
  const ev = await complianceEvidence(db, now);
  return ev.controls.map((c) => ({
    id: c.id,
    title: c.title,
    criteria: [...c.criteria],
    status: statusOf(c.latest?.status, c.state),
    checkedAt: c.latest?.collectedAt ?? null,
    how: c.how,
  }));
}

/**
 * SOC 2 progress, said from the evidence (audit 2026-10-21). "Audited" only
 * when the operator recorded the auditor's report date; "observation" once
 * every control has evidence inside its freshness window (the period an
 * auditor samples); "preparing" until then. Never a claim the controls do
 * not back.
 */
export function soc2StageFrom(controls: ReadonlyArray<{ state: string; latest: { status: string; collectedAt: string } | null }>, reportIssuedOn: Date | null): Soc2Progress['stage'] {
  if (reportIssuedOn) return 'audited';
  const allCurrent = controls.length > 0 && controls.every((c) => c.state !== 'missing' && c.state !== 'stale');
  return allCurrent ? 'observation' : 'preparing';
}

export async function soc2Progress(db: Db, now: Date = new Date()): Promise<Soc2Progress> {
  const [ev, setting, firsts] = await Promise.all([
    complianceEvidence(db, now),
    db.orgSetting.findUnique({ where: { id: 'singleton' }, select: { soc2ReportIssuedOn: true } }),
    db.complianceEvidence.groupBy({ by: ['control'], _min: { collectedAt: true } }),
  ]);
  const controls = ev.controls;
  const stage = soc2StageFrom(controls, setting?.soc2ReportIssuedOn ?? null);
  const latest = controls.map((c) => c.latest?.collectedAt ?? null).filter((d): d is string => !!d).sort();
  // Observation starts the day the last control first produced evidence.
  const firstByControl = new Map(firsts.map((f) => [f.control, f._min.collectedAt]));
  const starts = controls.map((c) => firstByControl.get(c.id) ?? null);
  const observationSince = stage === 'preparing' || starts.some((d) => !d) ? null : new Date(Math.max(...starts.map((d) => d!.getTime()))).toISOString().slice(0, 10);
  return {
    stage,
    controlsPassing: controls.filter((c) => c.latest?.status === 'PASS' && c.state !== 'stale').length,
    controlsCurrent: controls.filter((c) => c.state !== 'missing' && c.state !== 'stale').length,
    controlsTotal: controls.length,
    lastEvidenceAt: latest.length ? latest[latest.length - 1]! : null,
    observationSince,
    reportIssuedOn: setting?.soc2ReportIssuedOn ? setting.soc2ReportIssuedOn.toISOString().slice(0, 10) : null,
  };
}

async function platformChain(db: Db) {
  const last = await db.auditChainCheck.findFirst({ where: { tenantId: ALTO_TENANT_ID }, orderBy: { checkedAt: 'desc' }, select: { ok: true, checkedAt: true } });
  return { verifiedAt: last?.checkedAt.toISOString() ?? null, ok: last?.ok ?? null };
}

/**
 * "Certified" means what the agent's own record means by it: certified for
 * the model version it runs now (lib/agentControls certification().current).
 * Counting `certifiedAt` alone over-counted — an agent whose version moved
 * past its certificate still had the date, and its record said "Recertify".
 */
async function certifiedCurrent(db: Db, where: { worker?: { tenantId: string } } = {}): Promise<number> {
  const rows = await db.agentProfile.findMany({ where: { certifiedAt: { not: null }, ...where }, select: { modelVersion: true, certifiedModelVersion: true } });
  return rows.filter((r) => r.certifiedModelVersion === r.modelVersion).length;
}

async function platformAgents(db: Db) {
  const [registered, certified] = await Promise.all([
    db.worker.count({ where: { type: 'AGENT', status: { in: ['ONBOARDING', 'ACTIVE', 'SUSPENDED'] } } }),
    certifiedCurrent(db),
  ]);
  return { registered, certified, governed: true as const };
}

let publicCache: { at: number; value: TrustSummaryPublic } | null = null;

export async function trustSummaryPublic(db: Db, now: Date = new Date()): Promise<TrustSummaryPublic> {
  if (publicCache && now.getTime() - publicCache.at < 60_000) return publicCache.value;
  const [controls, auditChain, agents, setting, soc2] = await Promise.all([
    platformControls(db, now),
    platformChain(db),
    platformAgents(db),
    db.orgSetting.findUnique({ where: { id: 'singleton' }, select: { securityContactEmail: true } }),
    soc2Progress(db, now),
  ]);
  const value: TrustSummaryPublic = {
    generatedAt: now.toISOString(),
    product: PRODUCT_NAME,
    controls: { passing: controls.filter((c) => c.status === 'PASS').length, total: controls.length, items: controls },
    auditChain,
    retention: { auditYearsMinimum: MIN_RETENTION_YEARS },
    agents,
    subProcessors: [...SUB_PROCESSORS],
    commitments: [...TRUST_COMMITMENTS],
    securityContactSet: !!setting?.securityContactEmail,
    soc2,
  };
  publicCache = { at: now.getTime(), value };
  return value;
}

export function __resetTrustCacheForTests(): void {
  publicCache = null;
}

/** The in-app view: the public summary plus this tenant's own numbers. */
export async function trustSummary(db: Db, tenantId: string, now: Date = new Date()): Promise<TrustSummary> {
  const base = await trustSummaryPublic(db, now);
  const [chain, retentionYears, archives, sink, connections, scim, workers, certified, suspended, gates, decisionRecords, bias, review] = await Promise.all([
    db.auditChainCheck.findFirst({ where: { tenantId }, orderBy: { checkedAt: 'desc' } }),
    retentionYearsFor(db, tenantId),
    db.auditArchive.count({ where: { tenantId } }),
    db.auditSink.findUnique({ where: { tenantId }, select: { enabled: true, failures: true } }),
    db.identityConnection.findMany({ where: { tenantId, enabled: true }, select: { ssoRequiredForStaff: true } }),
    db.scimToken.count({ where: { tenantId, revokedAt: null } }),
    db.worker.groupBy({ by: ['status'], where: { tenantId, type: 'AGENT' }, _count: true }),
    certifiedCurrent(db, { worker: { tenantId } }),
    db.agentProfile.count({ where: { suspendedAt: { not: null }, worker: { tenantId } } }),
    db.agentGatePolicy.count({ where: { tenantId, OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] } }),
    db.automatedDecisionRecord.count({ where: { tenantId } }),
    db.agentBiasAudit.findFirst({ where: { tenantId }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
    db.complianceEvidence.findFirst({ where: { control: 'access-review' }, orderBy: { collectedAt: 'desc' }, include: { signoffs: { select: { id: true } } } }),
  ]);
  const count = (s: string) => workers.find((w) => w.status === s)?._count ?? 0;
  return {
    ...base,
    tenant: {
      auditChain: { verifiedAt: chain?.checkedAt.toISOString() ?? null, ok: chain?.ok ?? null, rows: chain?.rows ?? 0, headSeq: chain?.headSeq === null || chain?.headSeq === undefined ? null : String(chain.headSeq) },
      retentionYears,
      archives,
      siem: !sink || !sink.enabled ? 'OFF' : sink.failures > 0 ? 'FAILING' : 'ON',
      sso: { connections: connections.length, ssoRequiredForStaff: connections.some((c) => c.ssoRequiredForStaff), scim: scim > 0 },
      agents: {
        registered: count('ONBOARDING') + count('ACTIVE') + count('SUSPENDED'),
        active: count('ACTIVE'),
        certified,
        suspended,
        gates,
        decisionRecords,
        lastBiasAuditAt: bias?.createdAt.toISOString() ?? null,
      },
      accessReview: { lastAt: review?.collectedAt.toISOString() ?? null, signedOff: review ? review.signoffs.length > 0 : null },
    },
  };
}
