import type { PrismaClient } from '@prisma/client';
import { CONTROL_STATUSES, PRODUCT_NAME, PUBLIC_CONTROL_TITLES, SUB_PROCESSORS, TRUST_AREAS, TRUST_COMMITMENTS, trustAreaStatusOf, type ControlStatus, type Soc2Progress, type TrustAreaPublic, type TrustControlPublic, type TrustStatus, type TrustSummary, type TrustSummaryPublic } from '@alto-people/shared';
import { complianceEvidence } from './evidence.js';
import { MIN_RETENTION_YEARS, retentionYearsFor } from './auditChain.js';
import { ALTO_TENANT_ID, tenantIdForWrite } from './tenant.js';
import { dateColumnKey } from './timezone.js';
import { orgDateKey } from './timeAnomalies.js';

/**
 * The Trust Center's numbers (UX upgrade step 4). Everything here is an
 * aggregate the product already keeps; nothing is computed for the page.
 * The public summary is cached a minute and carries statuses and dates
 * only: no control detail, no address, no identifiers.
 */

type Db = PrismaClient;

/** The older four words, derived from the one status so they never disagree with it. */
const TRUST_WORD: Record<ControlStatus, TrustStatus> = { PASSING: 'PASS', NEEDS_SIGNOFF: 'WARN', FAILING: 'FAIL', NO_EVIDENCE: 'PENDING' };

/**
 * The controls as the Trust Center shows them: the same reading and the same
 * status as Compliance evidence (lib/evidence complianceEvidence →
 * controlStatusOf), so "N passing" here is "N passing" there (F500 SH-4).
 */
async function platformControls(db: Db, now: Date): Promise<TrustControlPublic[]> {
  const ev = await complianceEvidence(db, now);
  return ev.controls.map((c) => ({
    id: c.id,
    title: c.title,
    criteria: [...c.criteria],
    status: TRUST_WORD[c.status],
    controlStatus: c.status,
    checkedAt: c.latest?.collectedAt ?? null,
    how: c.how,
    plain: c.plain,
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
  // Observation: every control has evidence inside its window (none is "No evidence").
  if (reportIssuedOn) return 'audited';
  const allCurrent = controls.length > 0 && controls.every((c) => c.state !== 'missing' && c.state !== 'stale');
  return allCurrent ? 'observation' : 'preparing';
}

export async function soc2Progress(db: Db, now: Date = new Date()): Promise<Soc2Progress> {
  const [ev, setting, firsts] = await Promise.all([
    complianceEvidence(db, now),
    db.orgSetting.findUnique({ where: { tenantId: tenantIdForWrite() }, select: { soc2ReportIssuedOn: true } }),
    db.complianceEvidence.groupBy({ by: ['control'], _min: { collectedAt: true } }),
  ]);
  const controls = ev.controls;
  const stage = soc2StageFrom(controls, setting?.soc2ReportIssuedOn ?? null);
  const latest = controls.map((c) => c.latest?.collectedAt ?? null).filter((d): d is string => !!d).sort();
  // Observation starts the day the last control first produced evidence.
  const firstByControl = new Map(firsts.map((f) => [f.control, f._min.collectedAt]));
  const starts = controls.map((c) => firstByControl.get(c.id) ?? null);
  const observationSince = stage === 'preparing' || starts.some((d) => !d) ? null : orgDateKey(new Date(Math.max(...starts.map((d) => d!.getTime()))));
  return {
    stage,
    // The one status (controlStatusOf): the same "passing" the hero and Compliance evidence count.
    controlsPassing: ev.statusCounts.PASSING,
    controlsCurrent: controls.length - ev.statusCounts.NO_EVIDENCE,
    controlsTotal: controls.length,
    lastEvidenceAt: latest.length ? latest[latest.length - 1]! : null,
    observationSince,
    reportIssuedOn: setting?.soc2ReportIssuedOn ? dateColumnKey(setting.soc2ReportIssuedOn) : null,
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

/**
 * What an anonymous visitor reads (F500 G5): each control under its
 * customer-language title with its plain line — never `how` (script
 * names, brief steps, SQL) — and the five areas, one status each.
 */
function publicControl(c: TrustControlPublic): TrustControlPublic {
  const { how: _how, ...rest } = c;
  return { ...rest, title: PUBLIC_CONTROL_TITLES[c.id] ?? c.plain ?? c.title };
}

function publicAreas(controls: TrustControlPublic[]): TrustAreaPublic[] {
  return TRUST_AREAS.map((area) => {
    const inArea = controls.filter((c) => area.controls.includes(c.id));
    const checked = inArea.map((c) => c.checkedAt).filter((d): d is string => !!d).sort();
    return {
      key: area.key,
      label: area.label,
      status: trustAreaStatusOf(inArea.map((c) => c.controlStatus ?? 'NO_EVIDENCE')),
      controls: inArea.map((c) => ({ id: c.id, title: PUBLIC_CONTROL_TITLES[c.id] ?? c.title, summary: c.plain ?? '', criteria: [...c.criteria] })),
      lastCheckedAt: checked.length ? checked[checked.length - 1]! : null,
    };
  }).filter((a) => a.controls.length > 0);
}

export async function trustSummaryPublic(db: Db, now: Date = new Date()): Promise<TrustSummaryPublic> {
  if (publicCache && now.getTime() - publicCache.at < 60_000) return publicCache.value;
  const [controls, auditChain, agents, setting, soc2] = await Promise.all([
    platformControls(db, now),
    platformChain(db),
    platformAgents(db),
    db.orgSetting.findUnique({ where: { tenantId: tenantIdForWrite() }, select: { securityContactEmail: true } }),
    soc2Progress(db, now),
  ]);
  const value: TrustSummaryPublic = {
    generatedAt: now.toISOString(),
    product: PRODUCT_NAME,
    controls: {
      passing: controls.filter((c) => c.controlStatus === 'PASSING').length,
      total: controls.length,
      items: controls.map(publicControl),
      statusCounts: Object.fromEntries(CONTROL_STATUSES.map((s) => [s, controls.filter((c) => c.controlStatus === s).length])) as Record<ControlStatus, number>,
    },
    auditChain,
    retention: { auditYearsMinimum: MIN_RETENTION_YEARS },
    agents,
    subProcessors: [...SUB_PROCESSORS],
    commitments: [...TRUST_COMMITMENTS],
    securityContactSet: !!setting?.securityContactEmail,
    soc2,
    areas: publicAreas(controls),
  };
  publicCache = { at: now.getTime(), value };
  return value;
}

export function __resetTrustCacheForTests(): void {
  publicCache = null;
}

/** The in-app view: the public summary plus this tenant's own numbers. */
export async function trustSummary(db: Db, tenantId: string, now: Date = new Date()): Promise<TrustSummary> {
  const pub = await trustSummaryPublic(db, now);
  // Signed in: the controls as their owners name them, with how each is checked.
  const base = { ...pub, controls: { ...pub.controls, items: await platformControls(db, now) } };
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
