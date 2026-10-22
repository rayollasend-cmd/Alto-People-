import type { BackgroundCheck, PrismaClient, Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { activeConnection } from './providers/connections.js';
import { orderBackgroundCheck } from './providers/apply.js';
import { ProviderError } from './providers/http.js';

/**
 * The self-serve background-check consent (2026-10-21 system audit, Tier 1
 * #3). The onboarding task used to write `provider: 'stub', status: PASSED`
 * from a typed name, so every hire cleared without a check ever running.
 *
 * Now the consent does exactly what is true:
 *   - a screening provider is connected → the check is ordered through it
 *     (Checkr: the person gets the provider's own consent email) and stays
 *     INITIATED until the provider's report comes back;
 *   - none is connected → the check is recorded NOT_RUN, with the reason,
 *     and the approval gate names it.
 * Either way the checklist task stays IN_PROGRESS; it turns DONE only when
 * a check actually PASSED (markBackgroundTaskDone below, called by the
 * provider's report and by HR recording a result by hand).
 */

export const NOT_RUN_REASON = 'background check not run: provider not configured';
export const NOT_RUN_MESSAGE = 'Background check not run: provider not configured.';

type Db = PrismaClient | Prisma.TransactionClient;

export interface ConsentOutcome {
  check: BackgroundCheck;
  /** What the provider said when ordering failed (the check stays INITIATED). */
  providerError: string | null;
  /** Set when the check could not run at all. */
  message: string | null;
}

/** A check HR is already tracking (manual or provider-ordered) is never overwritten by a re-consent. */
function isTracked(c: BackgroundCheck): boolean {
  if (c.provider === 'stub' || c.provider === 'none') return false;
  return true;
}

export async function recordSelfServeConsent(
  app: { associateId: string; clientId: string | null; position: string | null },
  db: PrismaClient = defaultPrisma,
): Promise<ConsentOutcome> {
  const existing = await db.backgroundCheck.findFirst({
    where: { associateId: app.associateId },
    orderBy: { initiatedAt: 'desc' },
  });
  if (existing && isTracked(existing) && existing.status !== 'NOT_RUN') {
    return { check: existing, providerError: null, message: null };
  }

  const conn = await activeConnection('BACKGROUND_CHECK');
  const now = new Date();
  if (!conn) {
    const data = {
      provider: 'none',
      status: 'NOT_RUN' as const,
      rawStatus: 'NOT_RUN',
      lastError: NOT_RUN_REASON,
      completedAt: null,
    };
    const check = existing
      ? await db.backgroundCheck.update({ where: { id: existing.id }, data })
      : await db.backgroundCheck.create({
          data: { ...data, associateId: app.associateId, clientId: app.clientId, initiatedAt: now },
        });
    return { check, providerError: null, message: NOT_RUN_MESSAGE };
  }

  const fresh = {
    provider: conn.provider,
    status: 'INITIATED' as const,
    externalId: null,
    rawStatus: null,
    result: null,
    lastError: null,
    completedAt: null,
    initiatedAt: now,
  };
  const row = existing
    ? await db.backgroundCheck.update({ where: { id: existing.id }, data: fresh })
    : await db.backgroundCheck.create({ data: { ...fresh, associateId: app.associateId, clientId: app.clientId } });
  let providerError: string | null = null;
  try {
    await orderBackgroundCheck(conn, row.id, { position: app.position });
  } catch (err) {
    providerError = err instanceof ProviderError ? err.message : 'The screening provider did not answer.';
    await db.backgroundCheck.update({ where: { id: row.id }, data: { lastError: providerError.slice(0, 500) } });
  }
  const check = await db.backgroundCheck.findUniqueOrThrow({ where: { id: row.id } });
  return { check, providerError, message: null };
}

/** The checklist's background-check task, while the check is out: in progress, never done. */
export async function markBackgroundTaskInProgress(db: Db, checklistId: string): Promise<void> {
  await db.onboardingTask.updateMany({
    where: { checklistId, kind: 'BACKGROUND_CHECK', status: { notIn: ['DONE', 'SKIPPED'] } },
    data: { status: 'IN_PROGRESS' },
  });
}

/**
 * A check that PASSED completes the BACKGROUND_CHECK task on every open
 * application of that person. Called when a provider's report comes back
 * clear and when HR records a pass by hand.
 */
export async function markBackgroundTaskDone(db: Db, associateId: string): Promise<number> {
  const r = await db.onboardingTask.updateMany({
    where: {
      kind: 'BACKGROUND_CHECK',
      status: { notIn: ['DONE', 'SKIPPED'] },
      checklist: { application: { associateId, deletedAt: null, status: { in: ['DRAFT', 'SUBMITTED', 'IN_REVIEW'] } } },
    },
    data: { status: 'DONE', completedAt: new Date() },
  });
  return r.count;
}

/**
 * The approval gate's words for a hire whose check has not cleared, or null
 * when it has (or none was ever started — the checklist governs that case).
 */
export function backgroundApprovalWarning(c: Pick<BackgroundCheck, 'status' | 'provider'> | null): string | null {
  if (!c) return null;
  if (c.status === 'NOT_RUN') return 'Background check not run: provider not configured — the hire is not cleared.';
  if (c.status === 'INITIATED' || c.status === 'IN_PROGRESS') return `Background check still pending with ${c.provider}.`;
  if (c.status === 'NEEDS_REVIEW') return `Background check came back for review with ${c.provider} — decide it before the hire.`;
  if (c.status === 'FAILED') return 'Background check failed — adverse action was taken.';
  return null;
}
