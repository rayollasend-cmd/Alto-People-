import type { PrismaClient } from '@prisma/client';
import { PRODUCT_NAME, SUB_PROCESSORS, TRUST_COMMITMENTS, type TrustControlPublic, type TrustStatus, type TrustSummary, type TrustSummaryPublic } from '@alto-people/shared';
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

async function platformChain(db: Db) {
  const last = await db.auditChainCheck.findFirst({ where: { tenantId: ALTO_TENANT_ID }, orderBy: { checkedAt: 'desc' }, select: { ok: true, checkedAt: true } });
  return { verifiedAt: last?.checkedAt.toISOString() ?? null, ok: last?.ok ?? null };
}

async function platformAgents(db: Db) {
  const [registered, certified] = await Promise.all([
    db.worker.count({ where: { type: 'AGENT', status: { in: ['ONBOARDING', 'ACTIVE', 'SUSPENDED'] } } }),
    db.agentProfile.count({ where: { certifiedAt: { not: null } } }),
  ]);
  return { registered, certified, governed: true as const };
}

let publicCache: { at: number; value: TrustSummaryPublic } | null = null;

export async function trustSummaryPublic(db: Db, now: Date = new Date()): Promise<TrustSummaryPublic> {
  if (publicCache && now.getTime() - publicCache.at < 60_000) return publicCache.value;
  const [controls, auditChain, agents, setting] = await Promise.all([
    platformControls(db, now),
    platformChain(db),
    platformAgents(db),
    db.orgSetting.findUnique({ where: { id: 'singleton' }, select: { securityContactEmail: true } }),
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
    db.agentProfile.count({ where: { certifiedAt: { not: null }, worker: { tenantId } } }),
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
