import type { CandidateStage, Prisma } from '@prisma/client';
import { recordCandidateEvent } from './candidateEvents.js';

/**
 * Take a hire back on the recruiting side: the candidate returns to Offer
 * (their signed offer still stands, so they're "ready to hire" again) and
 * the reason goes on their timeline.
 *
 * Shared by the recruiter's Undo hire and by every clean-up that removes
 * the onboarding a hire created — the ghost purge, an invite expiring,
 * a cancelled invite. Before this, a hire whose onboarding was purged
 * stayed Hired forever, pointing at an associate who no longer existed,
 * and couldn't be removed or moved.
 *
 * `by` finds the candidate: the associate the hire created, or the
 * candidate itself. Returns the candidate's id, or null if no hired
 * candidate matched (nothing to take back).
 */
export async function revertCandidateHire(
  tx: Prisma.TransactionClient,
  by: { associateId: string } | { candidateId: string },
  opts: { reason: string; actorUserId: string | null; toStage?: CandidateStage; automatic?: boolean },
): Promise<string | null> {
  const where: Prisma.CandidateWhereInput =
    'associateId' in by
      ? { hiredAssociateId: by.associateId, stage: 'HIRED', deletedAt: null }
      : { id: by.candidateId, stage: 'HIRED', deletedAt: null };
  const c = await tx.candidate.findFirst({ where, select: { id: true } });
  if (!c) return null;
  const toStage = opts.toStage ?? 'OFFER';
  await tx.candidate.update({
    where: { id: c.id },
    data: {
      stage: toStage,
      stageChangedAt: new Date(),
      hiredAssociateId: null,
      hiredClientId: null,
      hiredAt: null,
    },
  });
  await recordCandidateEvent(tx, {
    candidateId: c.id,
    kind: 'HIRE_UNDONE',
    actorUserId: opts.actorUserId,
    fromStage: 'HIRED',
    toStage,
    body: opts.reason,
    metadata: { automatic: Boolean(opts.automatic) },
  });
  return c.id;
}
