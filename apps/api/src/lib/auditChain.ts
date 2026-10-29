import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { Prisma, PrismaClient } from '@prisma/client';
import { getBlobStore, tenantBlobKey } from './blobStore.js';
import { encryptBytes } from './crypto.js';
import { enqueueAudit } from './audit.js';
import { env } from '../config/env.js';
import { armJob } from './jobs.js';
import { raiseSecurityAlert } from './securityAlerts.js';
import { platformJob } from './tenantJobs.js';
import { auditChainText } from './evidenceText.js';

/**
 * Brief 2-3 step 4 — tamper evidence and retention for the audit trail
 * (docs/identity-rbac-audit-investigation.md §4.4).
 *
 *   verifyAuditChain   recomputes every chained row's hash in the database
 *                      with the same function the insert trigger used, and
 *                      checks the links and the sequence: an edited row, a
 *                      removed row or a re-ordered row is a break. The last
 *                      run's head must still be there (a cut-off tail).
 *   runAuditChainChecks  every tenant, recorded as AuditChainCheck; a break
 *                      raises a security alert (rule AUDIT_CHAIN).
 *   archiveAuditRows   rows older than the tenant's retention (7 years by
 *                      default, never less) are written, gzipped and
 *                      encrypted, to object storage with the chain head they
 *                      end at. Nothing is deleted (decision 8).
 */

type Db = PrismaClient;

export const MIN_RETENTION_YEARS = 7;

export interface ChainBreak {
  seq: string;
  reason: 'hash' | 'link' | 'gap' | 'start' | 'head_missing';
}

export interface ChainResult {
  tenantId: string | null;
  rows: number;
  headSeq: bigint | null;
  headHash: string | null;
  breaks: ChainBreak[];
}

const tenantClause = (tenantId: string | null) => (tenantId === null ? `"tenantId" IS NULL` : `"tenantId" = $1::uuid`);

export async function verifyAuditChain(db: Db, tenantId: string | null): Promise<ChainResult> {
  const params = tenantId === null ? [] : [tenantId];
  const breaks = await db.$queryRawUnsafe<Array<{ seq: bigint; reason: ChainBreak['reason'] }>>(
    `WITH c AS (
       SELECT a."seq", a."hash", a."prevHash",
              lag(a."hash") OVER w AS "expectedPrev",
              lag(a."seq") OVER w AS "prevSeq",
              encode(sha256(convert_to(coalesce(a."prevHash", '') || '|' || audit_log_canonical(a), 'UTF8')), 'hex') AS "recomputed"
         FROM "AuditLog" a
        WHERE ${tenantClause(tenantId)} AND a."seq" IS NOT NULL
       WINDOW w AS (ORDER BY a."seq")
     )
     SELECT "seq", CASE
              WHEN "hash" IS DISTINCT FROM "recomputed" THEN 'hash'
              WHEN "prevSeq" IS NULL AND ("seq" <> 1 OR "prevHash" IS NOT NULL) THEN 'start'
              WHEN "prevSeq" IS NOT NULL AND "seq" <> "prevSeq" + 1 THEN 'gap'
              WHEN "prevSeq" IS NOT NULL AND "prevHash" IS DISTINCT FROM "expectedPrev" THEN 'link'
            END AS "reason"
       FROM c
      WHERE "hash" IS DISTINCT FROM "recomputed"
         OR ("prevSeq" IS NULL AND ("seq" <> 1 OR "prevHash" IS NOT NULL))
         OR ("prevSeq" IS NOT NULL AND ("seq" <> "prevSeq" + 1 OR "prevHash" IS DISTINCT FROM "expectedPrev"))
      ORDER BY "seq"
      LIMIT 50`,
    ...params,
  );
  const [head] = await db.$queryRawUnsafe<Array<{ rows: bigint; seq: bigint | null; hash: string | null }>>(
    `SELECT count(*) AS "rows", max("seq") AS "seq",
            (SELECT "hash" FROM "AuditLog" WHERE ${tenantClause(tenantId)} AND "seq" IS NOT NULL ORDER BY "seq" DESC LIMIT 1) AS "hash"
       FROM "AuditLog" WHERE ${tenantClause(tenantId)} AND "seq" IS NOT NULL`,
    ...params,
  );
  const out: ChainBreak[] = breaks.map((b) => ({ seq: String(b.seq), reason: b.reason }));
  // The tail: the head the last clean run saw must still be in the chain, with the same hash.
  const last = await db.auditChainCheck.findFirst({ where: { tenantId, ok: true }, orderBy: { checkedAt: 'desc' }, select: { headSeq: true, headHash: true } });
  if (last?.headSeq != null) {
    const still = await db.$queryRawUnsafe<Array<{ hash: string }>>(
      `SELECT "hash" FROM "AuditLog" WHERE ${tenantClause(tenantId)} AND "seq" = $${params.length + 1}::bigint`,
      ...params,
      last.headSeq,
    );
    if (still[0]?.hash !== last.headHash) out.push({ seq: String(last.headSeq), reason: 'head_missing' });
  }
  return { tenantId, rows: Number(head?.rows ?? 0), headSeq: head?.seq ?? null, headHash: head?.hash ?? null, breaks: out };
}

/** Every tenant's chain, recorded; a break raises an alert. Returns the tenants with a break. */
export async function runAuditChainChecks(db: Db): Promise<ChainResult[]> {
  const tenants = await db.tenant.findMany({ select: { id: true } });
  const ids: Array<string | null> = [...tenants.map((t) => t.id), null];
  const broken: ChainResult[] = [];
  for (const tenantId of ids) {
    const r = await verifyAuditChain(db, tenantId);
    if (r.rows === 0 && tenantId === null) continue;
    await db.auditChainCheck.create({
      data: { tenantId, rows: r.rows, headSeq: r.headSeq, headHash: r.headHash, ok: r.breaks.length === 0, breaks: r.breaks as unknown as Prisma.InputJsonArray },
    });
    if (r.breaks.length) {
      broken.push(r);
      const summary = `The audit trail's hash chain is broken for tenant ${tenantId ?? '(none)'} at ${r.breaks.slice(0, 3).map((b) => `#${b.seq} (${b.reason})`).join(', ')}. Investigate before trusting the trail.`;
      // The security contact and the operator's org admins hear it the
      // way every other security alert reaches them (lib/securityAlerts),
      // once an hour per break — not a row nobody reads.
      await raiseSecurityAlert(db, { rule: 'AUDIT_CHAIN', key: `${tenantId ?? '-'}:${r.breaks[0]!.seq}`, summary, auditLogIds: [], linkUrl: '/audit' });
      console.error(`[alto-people/api] ${summary}`);
    }
  }
  return broken;
}

export const AUDIT_CHAIN_CHECK_JOB = 'auditChainCheck';

/**
 * Audit item 20 (2026-10-21): the nightly verifier the identity plan
 * promised. Every tenant's chain, recorded as an AuditChainCheck, a break
 * raised as an AUDIT_CHAIN security alert. Default daily
 * (AUDIT_CHAIN_CHECK_INTERVAL_SECONDS); listed on the jobs panel.
 */
export function startAuditChainCheckCron(db: Db): void {
  armJob({
    name: AUDIT_CHAIN_CHECK_JOB,
    label: 'Audit hash-chain verification (nightly)',
    intervalSeconds: env.AUDIT_CHAIN_CHECK_INTERVAL_SECONDS,
    run: platformJob(AUDIT_CHAIN_CHECK_JOB, () => runAuditChainChecks(db)),
    // The evidence sweep already checks at boot; the first scheduled tick
    // comes after one interval so two checks are not written on every deploy.
    immediate: false,
    note: 'AUDIT_CHAIN_CHECK_INTERVAL_SECONDS; a break raises an AUDIT_CHAIN security alert to the security contact and org admins.',
  });
}

/** The evidence form of the check, for the daily sweep (lib/evidence). */
export async function auditChainEvidence(db: Db): Promise<{ status: 'PASS' | 'FAIL'; summary: string; details: Record<string, unknown> }> {
  const broken = await runAuditChainChecks(db);
  const checked = await db.auditChainCheck.findMany({ where: { checkedAt: { gte: new Date(Date.now() - 3_600_000) } }, select: { tenantId: true, rows: true, ok: true } });
  const rows = checked.reduce((a, c) => a + c.rows, 0);
  // Plain words (lib/evidenceText): "across 1 organization", never "across 1 chains".
  if (broken.length) {
    const details = { broken: broken.map((b) => ({ tenantId: b.tenantId, breaks: b.breaks.slice(0, 10) })) };
    return { status: 'FAIL', summary: auditChainText('FAIL', details)!.summary, details };
  }
  const details = { chains: checked.length, rows };
  return { status: 'PASS', summary: auditChainText('PASS', details)!.summary, details };
}

export async function retentionYearsFor(db: Db, tenantId: string): Promise<number> {
  const t = await db.tenant.findUnique({ where: { id: tenantId }, select: { auditRetentionYears: true } });
  return Math.max(MIN_RETENTION_YEARS, t?.auditRetentionYears ?? MIN_RETENTION_YEARS);
}

/**
 * Archive the tenant's rows older than its retention that no archive holds
 * yet. One object per run: gzipped JSON lines, encrypted with the field
 * keyring, its SHA-256 and the chain head it ends at recorded.
 */
export async function archiveAuditRows(db: Db, tenantId: string, now: Date = new Date(), batch = 50_000): Promise<{ archived: number; objectKey: string | null }> {
  const years = await retentionYearsFor(db, tenantId);
  const before = new Date(now);
  before.setUTCFullYear(before.getUTCFullYear() - years);
  const last = await db.auditArchive.findFirst({ where: { tenantId }, orderBy: { createdAt: 'desc' }, select: { before: true } });
  const rows = await db.auditLog.findMany({
    where: { tenantId, createdAt: { lt: before, ...(last ? { gte: last.before } : {}) } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: batch,
  });
  if (!rows.length) return { archived: 0, objectKey: null };
  const jsonl = rows.map((r) => JSON.stringify({ ...r, seq: r.seq === null ? null : String(r.seq) })).join('\n') + '\n';
  const sealed = encryptBytes(gzipSync(Buffer.from(jsonl, 'utf8')));
  const sha256 = createHash('sha256').update(sealed).digest('hex');
  const end = rows.length === batch ? rows[rows.length - 1]!.createdAt : before;
  // eslint-disable-next-line no-restricted-syntax -- UTC on purpose: the archive's object name spans instants (createdAt), not a company day
  const objectKey = tenantBlobKey(`audit-archive/${rows[0]!.createdAt.toISOString().slice(0, 10)}_${end.toISOString().slice(0, 10)}_${sha256.slice(0, 12)}.jsonl.gz.enc`, tenantId);
  await getBlobStore().put(objectKey, sealed, 'application/octet-stream');
  const seqs = rows.map((r) => r.seq).filter((s): s is bigint => s !== null);
  const lastChained = [...rows].reverse().find((r) => r.hash !== null);
  const archive = await db.auditArchive.create({
    data: {
      tenantId,
      fromSeq: seqs.length ? seqs.reduce((a, b) => (a < b ? a : b)) : null,
      toSeq: seqs.length ? seqs.reduce((a, b) => (a > b ? a : b)) : null,
      before: end,
      rows: rows.length,
      objectKey,
      sha256,
      headHash: lastChained?.hash ?? null,
    },
  });
  enqueueAudit({ actorUserId: null, tenantId, action: 'audit.archived', entityType: 'AuditArchive', entityId: archive.id, metadata: { rows: rows.length, objectKey, retentionYears: years } }, 'auditArchive');
  return { archived: rows.length, objectKey };
}
