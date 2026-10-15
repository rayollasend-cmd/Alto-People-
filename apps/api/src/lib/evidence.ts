import type { Prisma, PrismaClient } from '@prisma/client';
import {
  COMPLIANCE_CONTROLS,
  complianceControl,
  type ComplianceControlView,
  type ComplianceEvidenceResponse,
  type ControlState,
  type EvidenceRow,
  type EvidenceStatus,
} from '@alto-people/shared';
import { prisma as defaultPrisma } from '../db.js';
import { platformJob } from './tenantJobs.js';
import { jobSecretStates } from './jobSecrets.js';

/**
 * Brief 2-5 step 1 — the evidence spine.
 *
 *   Each SOC 2 control (COMPLIANCE_CONTROLS) records what it found as an
 *   append-only ComplianceEvidence row: PASS, FAIL or WARN, a one-line
 *   summary and the details an auditor samples. Recording never throws:
 *   evidence must not break the job it describes. The page reads the
 *   latest row per control and colours it by its age against the
 *   control's freshness window.
 *
 *   Platform-level: rows carry no tenant (owner's decision 1).
 */

type Db = PrismaClient;

export interface EvidenceResult {
  status: EvidenceStatus;
  summary: string;
  details?: Record<string, unknown>;
  artifactKey?: string | null;
  periodStart?: Date | null;
  periodEnd?: Date | null;
}

/** Record one collection of a control. Returns the row id, or null when it could not be written. */
export async function recordEvidence(control: string, collectedBy: string, result: EvidenceResult, db: Db = defaultPrisma): Promise<string | null> {
  if (!complianceControl(control)) {
    console.error(`[alto-people/api] evidence for unknown control "${control}" not recorded`);
    return null;
  }
  try {
    const row = await db.complianceEvidence.create({
      data: {
        tenantId: null,
        control,
        status: result.status,
        summary: result.summary.slice(0, 500),
        details: (result.details ?? {}) as Prisma.InputJsonValue,
        artifactKey: result.artifactKey ?? null,
        collectedBy: collectedBy.slice(0, 120),
        periodStart: result.periodStart ?? null,
        periodEnd: result.periodEnd ?? null,
      },
      select: { id: true },
    });
    return row.id;
  } catch (err) {
    console.error(`[alto-people/api] evidence for "${control}" not recorded:`, err);
    return null;
  }
}

const DAY = 86_400_000;

function stateOf(view: { latest: EvidenceRow | null; ageDays: number | null; freshnessDays: number; needsSignoff: boolean }): ControlState {
  if (!view.latest || view.ageDays === null) return 'missing';
  if (view.ageDays > view.freshnessDays) return 'stale';
  if (view.latest.status === 'FAIL') return 'failing';
  if (view.needsSignoff && view.latest.signoffs.length === 0) return 'awaiting-signoff';
  return 'current';
}

type EvidenceWithSignoffs = Prisma.ComplianceEvidenceGetPayload<{ include: { signoffs: true } }>;

async function toRows(db: Db, rows: EvidenceWithSignoffs[]): Promise<EvidenceRow[]> {
  const signerIds = [...new Set(rows.flatMap((r) => r.signoffs.map((s) => s.signedOffById)))];
  const users = signerIds.length ? await db.user.findMany({ where: { id: { in: signerIds } }, select: { id: true, email: true } }) : [];
  const email = new Map(users.map((u) => [u.id, u.email]));
  return rows.map((r) => ({
    id: r.id,
    control: r.control,
    status: r.status,
    summary: r.summary,
    details: r.details,
    collectedAt: r.collectedAt.toISOString(),
    collectedBy: r.collectedBy,
    periodStart: r.periodStart?.toISOString() ?? null,
    periodEnd: r.periodEnd?.toISOString() ?? null,
    signoffs: r.signoffs
      .slice()
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((s) => ({ id: s.id, signedOffById: s.signedOffById, signedOffByEmail: email.get(s.signedOffById) ?? null, note: s.note, createdAt: s.createdAt.toISOString() })),
  }));
}

/** Every control in the catalog with its latest evidence and its state. */
export async function complianceEvidence(db: Db = defaultPrisma, now: Date = new Date()): Promise<ComplianceEvidenceResponse> {
  const latest = await db.complianceEvidence.findMany({
    where: { control: { in: COMPLIANCE_CONTROLS.map((c) => c.id) } },
    distinct: ['control'],
    orderBy: [{ control: 'asc' }, { collectedAt: 'desc' }],
    include: { signoffs: true },
  });
  const rows = await toRows(db, latest);
  const byControl = new Map(rows.map((r) => [r.control, r]));
  const controls: ComplianceControlView[] = COMPLIANCE_CONTROLS.map((c) => {
    const l = byControl.get(c.id) ?? null;
    const ageDays = l ? Math.floor((now.getTime() - new Date(l.collectedAt).getTime()) / DAY) : null;
    return { ...c, latest: l, ageDays, state: stateOf({ latest: l, ageDays, freshnessDays: c.freshnessDays, needsSignoff: c.needsSignoff }) };
  });
  const counts: Record<ControlState, number> = { current: 0, stale: 0, failing: 0, missing: 0, 'awaiting-signoff': 0 };
  for (const c of controls) counts[c.state] += 1;
  return { generatedAt: now.toISOString(), controls, counts };
}

/** One control's history, newest first. */
export async function controlHistory(control: string, db: Db = defaultPrisma, limit = 50): Promise<EvidenceRow[]> {
  const rows = await db.complianceEvidence.findMany({
    where: { control },
    orderBy: { collectedAt: 'desc' },
    take: limit,
    include: { signoffs: true },
  });
  return toRows(db, rows);
}

/** A person signs one evidence row off: a new row, never an edit. */
export async function signOffEvidence(evidenceId: string, signedOffById: string, note: string | null, db: Db = defaultPrisma): Promise<{ id: string } | null> {
  const ev = await db.complianceEvidence.findUnique({ where: { id: evidenceId }, select: { id: true } });
  if (!ev) return null;
  return db.complianceEvidenceSignoff.create({ data: { tenantId: null, evidenceId, signedOffById, note }, select: { id: true } });
}

/* ---------------------------------------------------------------- *
 *  Collectors that need no new infrastructure.
 * ---------------------------------------------------------------- */

/**
 * job-secrets-separated: which per-job secrets are set apart from the
 * field-encryption key. Names and booleans only, never a value. PASS when
 * every job has its own variable; WARN while any still falls back (today's
 * state until the owner sets them, which changes nothing for users).
 */
export function jobSecretsResult(): EvidenceResult {
  const states = jobSecretStates();
  const unset = states.filter((s) => !s.set);
  return {
    status: unset.length === 0 ? 'PASS' : 'WARN',
    summary:
      unset.length === 0
        ? `All ${states.length} per-job secrets are set.`
        : `${unset.length} of ${states.length} per-job secrets fall back to the field-encryption key: ${unset.map((s) => s.variable).join(', ')}.`,
    details: {
      secrets: states.map((s) => ({ job: s.job, variable: s.variable, set: s.set, sharesFieldKey: s.sharesPayoutKey })),
      requireSplitSecrets: process.env.REQUIRE_SPLIT_SECRETS === '1',
    },
  };
}

/**
 * The daily controls, each recorded at most once a day (Brief 2-5 steps 1 and 4): the per-job
 * secrets, the encryption inventory, TLS to the web and the database, the uploads' encryption at
 * rest and the audit log's immutability. Loaded on use: lib/controls reads the whole keyring.
 */
export async function runEvidenceSweep(db: Db = defaultPrisma, now: Date = new Date()): Promise<{ recorded: string[] }> {
  const c = await import('./controls.js');
  const daily: Array<[string, () => EvidenceResult | Promise<EvidenceResult>]> = [
    ['job-secrets-separated', jobSecretsResult],
    ['field-encryption-inventory', () => c.fieldEncryptionInventory(db)],
    ['tls-web', () => c.tlsWeb(now)],
    ['tls-database', () => c.tlsDatabase(db)],
    ['blob-encryption', () => c.blobEncryption()],
    ['audit-log-immutability', () => c.auditLogImmutability(db)],
  ];
  const recorded: string[] = [];
  for (const [control, collect] of daily) {
    const recent = await db.complianceEvidence.findFirst({ where: { control, collectedAt: { gte: new Date(now.getTime() - 20 * 3_600_000) } }, select: { id: true } });
    if (recent) continue;
    const id = await recordEvidence(control, 'evidenceSweep', await collect(), db);
    if (id) recorded.push(control);
  }
  // Brief 2-5 step 6: the quarterly access review, once a quarter, waiting for its sign-off.
  const { runQuarterlyAccessReview } = await import('./accessReview.js');
  if (await runQuarterlyAccessReview(db, now)) recorded.push('access-review');
  return { recorded };
}

const SWEEP_MS = 60 * 60 * 1000;
let timer: NodeJS.Timeout | null = null;

export function startEvidenceCron(): void {
  if (timer) return;
  const run = () =>
    void platformJob('evidenceSweep', () => runEvidenceSweep())().catch((err) => {
      console.error('[alto-people/api] evidence sweep failed:', err);
    });
  run();
  timer = setInterval(run, SWEEP_MS);
  timer.unref();
}

export function stopEvidenceCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
