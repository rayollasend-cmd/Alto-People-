import type { PrismaClient } from '@prisma/client';
import { buildAccessReport, WORKFORCE_ROLES, type AccessFlag } from './accessCleanup.js';
import { recordEvidence } from './evidence.js';
import { ALTO_TENANT_ID } from './tenant.js';

/**
 * Brief 2-5 step 6 — the quarterly access review (CC6.2, CC6.3).
 *
 *   The 1A-4 access report's elevated accounts and flags, plus every AI
 *   agent with its owner, scopes, capabilities, gates, credentials' age and
 *   last use, and its own flags. Run quarterly (and on demand) as an
 *   access-review evidence row that waits for a named approver's sign-off on
 *   the evidence page (the approver's note records which flags are accepted
 *   and why). The evidence holds counts and ids only, never an email.
 *
 *   Platform-level, like all SOC 2 evidence: it reviews the operator tenant
 *   (Alto People's own accounts and agents).
 */

type Db = PrismaClient;

export const CREDENTIAL_MAX_AGE_DAYS = 90;
export const AGENT_IDLE_DAYS = 90;

export type AgentFlag = 'OWNER_INACTIVE' | 'CREDENTIAL_OLD' | 'IDLE_90D' | 'NO_CAPABILITY_OR_SCOPE' | 'UNGATED_ELEVATED_SCOPE';

export const AGENT_FLAG_LABEL: Record<AgentFlag, string> = {
  OWNER_INACTIVE: 'Its owner’s account is not active',
  CREDENTIAL_OLD: `A live credential older than ${CREDENTIAL_MAX_AGE_DAYS} days`,
  IDLE_90D: `Active, but no call in ${AGENT_IDLE_DAYS} days`,
  NO_CAPABILITY_OR_SCOPE: 'Active with neither a capability nor a scope',
  UNGATED_ELEVATED_SCOPE: 'Holds a write scope with no gate policy of its own',
};

export interface AgentReviewRow {
  id: string;
  name: string;
  status: string;
  owner: { id: string; email: string; status: string } | null;
  scopes: string[];
  capabilities: string[];
  gatePolicies: number;
  liveCredentials: number;
  oldestCredentialDays: number | null;
  lastUsedAt: string | null;
  flags: AgentFlag[];
}

export interface AccessReview {
  generatedAt: string;
  elevatedAccounts: number;
  accountFlags: Record<AccessFlag, number>;
  flaggedAccounts: number;
  agents: AgentReviewRow[];
  agentFlags: Record<AgentFlag, number>;
}

const DAY = 86_400_000;

export async function buildAccessReview(db: Db, now: Date = new Date(), tenantId: string = ALTO_TENANT_ID): Promise<AccessReview> {
  const report = await buildAccessReport(db, now, { tenantId });
  const elevated = report.rows.filter((r) => r.status === 'ACTIVE' && !WORKFORCE_ROLES.includes(r.role));
  const workers = await db.worker.findMany({
    where: { tenantId, type: 'AGENT', status: { not: 'OFFBOARDED' } },
    select: {
      id: true,
      name: true,
      status: true,
      owner: { select: { id: true, email: true, status: true, deletedAt: true } },
      agent: { select: { scopes: true, agentCapabilities: { select: { key: true, enabled: true, suspendedAt: true } }, credentials: { where: { revokedAt: null, expiresAt: { gt: now } }, select: { issuedAt: true, lastUsedAt: true } } } },
    },
  });
  const policies = await db.agentGatePolicy.findMany({ where: { tenantId, scope: 'AGENT', OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] }, select: { scopeKey: true } });
  const agents: AgentReviewRow[] = workers.map((w) => {
    const creds = w.agent?.credentials ?? [];
    const oldest = creds.length ? Math.max(...creds.map((c) => Math.floor((now.getTime() - c.issuedAt.getTime()) / DAY))) : null;
    const lastUsed = creds.map((c) => c.lastUsedAt).filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
    const scopes = w.agent?.scopes ?? [];
    const capabilities = (w.agent?.agentCapabilities ?? []).filter((c) => c.enabled && !c.suspendedAt).map((c) => c.key);
    const gatePolicies = policies.filter((p) => p.scopeKey === w.id).length;
    const flags: AgentFlag[] = [];
    if (!w.owner || w.owner.status !== 'ACTIVE' || w.owner.deletedAt) flags.push('OWNER_INACTIVE');
    if (oldest !== null && oldest > CREDENTIAL_MAX_AGE_DAYS) flags.push('CREDENTIAL_OLD');
    if (w.status === 'ACTIVE' && (!lastUsed || now.getTime() - lastUsed.getTime() > AGENT_IDLE_DAYS * DAY) && creds.length > 0) flags.push('IDLE_90D');
    if (w.status === 'ACTIVE' && !scopes.length && !capabilities.length) flags.push('NO_CAPABILITY_OR_SCOPE');
    if (scopes.some((s) => s.startsWith('manage:') || s.startsWith('open:')) && !gatePolicies) flags.push('UNGATED_ELEVATED_SCOPE');
    return {
      id: w.id,
      name: w.name,
      status: w.status,
      owner: w.owner ? { id: w.owner.id, email: w.owner.email, status: w.owner.status } : null,
      scopes,
      capabilities,
      gatePolicies,
      liveCredentials: creds.length,
      oldestCredentialDays: oldest,
      lastUsedAt: lastUsed?.toISOString() ?? null,
      flags,
    };
  });
  const agentFlags = Object.fromEntries((Object.keys(AGENT_FLAG_LABEL) as AgentFlag[]).map((f) => [f, agents.filter((a) => a.flags.includes(f)).length])) as Record<AgentFlag, number>;
  return {
    generatedAt: now.toISOString(),
    elevatedAccounts: elevated.length,
    accountFlags: report.counts.byFlag,
    flaggedAccounts: report.counts.flaggedAccounts,
    agents,
    agentFlags,
  };
}

/** Records the review as evidence waiting for sign-off: counts and ids only. */
export async function recordAccessReview(db: Db, collectedBy: string, now: Date = new Date()): Promise<string | null> {
  const r = await buildAccessReview(db, now);
  const agentFlagged = r.agents.filter((a) => a.flags.length).length;
  return recordEvidence(
    'access-review',
    collectedBy,
    {
      status: 'WARN',
      summary: `${r.elevatedAccounts} elevated accounts (${r.flaggedAccounts} flagged accounts in all) and ${r.agents.length} agents (${agentFlagged} flagged): waiting for sign-off.`,
      details: {
        elevatedAccounts: r.elevatedAccounts,
        accountFlags: r.accountFlags,
        flaggedAccounts: r.flaggedAccounts,
        agents: r.agents.map((a) => ({ id: a.id, status: a.status, ownerId: a.owner?.id ?? null, scopes: a.scopes, capabilities: a.capabilities, gatePolicies: a.gatePolicies, liveCredentials: a.liveCredentials, oldestCredentialDays: a.oldestCredentialDays, lastUsedAt: a.lastUsedAt, flags: a.flags })),
        agentFlags: r.agentFlags,
      },
      periodEnd: now,
    },
    db,
  );
}

/** The quarterly run: on a quarter's first days, if this quarter has no review yet. */
export async function runQuarterlyAccessReview(db: Db, now: Date = new Date()): Promise<string | null> {
  const quarterStart = new Date(Date.UTC(now.getUTCFullYear(), Math.floor(now.getUTCMonth() / 3) * 3, 1));
  const have = await db.complianceEvidence.findFirst({ where: { control: 'access-review', collectedAt: { gte: quarterStart } }, select: { id: true } });
  if (have) return null;
  return recordAccessReview(db, 'quarterlyAccessReview', now);
}
