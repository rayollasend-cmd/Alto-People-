import type { Request } from 'express';
import type { CandidateEventKind, CandidateStage, Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { enqueueAudit } from './audit.js';

/**
 * A candidate's timeline, and the audit trail behind it.
 *
 * Two records for one action, on purpose. The CandidateEvent is the
 * product surface — the timeline a recruiter reads, and what time-to-hire
 * and funnel conversion are computed from. The AuditLog row is the
 * compliance record, kept with every other entity's in one place.
 *
 * Events are written inside the caller's transaction when there is one,
 * so a stage move and its history commit together. Audit rows are
 * fire-and-forget and must only be enqueued AFTER the write commits —
 * hence two functions rather than one that does both.
 */

type Db = Prisma.TransactionClient | typeof prisma;

export interface CandidateEventInput {
  candidateId: string;
  kind: CandidateEventKind;
  actorUserId: string | null;
  fromStage?: CandidateStage | null;
  toStage?: CandidateStage | null;
  body?: string | null;
  metadata?: Prisma.InputJsonValue;
}

export async function recordCandidateEvent(db: Db, e: CandidateEventInput): Promise<void> {
  await db.candidateEvent.create({
    data: {
      candidateId: e.candidateId,
      kind: e.kind,
      actorUserId: e.actorUserId,
      fromStage: e.fromStage ?? null,
      toStage: e.toStage ?? null,
      body: e.body ?? null,
      ...(e.metadata !== undefined ? { metadata: e.metadata } : {}),
    },
  });
}

/**
 * The compliance record for a recruiting action. `entityType` is the
 * thing acted on (Candidate, Interview, Offer, JobPosting); the candidate
 * it concerns rides in metadata so one candidate's whole history can be
 * pulled from the audit log.
 */
export function auditRecruiting(
  req: Request,
  action: string,
  entityType: 'Candidate' | 'Interview' | 'Offer' | 'JobPosting',
  entityId: string,
  metadata: Record<string, unknown> = {},
): void {
  enqueueAudit(
    {
      actorUserId: req.user?.id ?? null,
      action: `recruiting.${action}`,
      entityType,
      entityId,
      metadata: {
        ip: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
        ...metadata,
      } as Prisma.InputJsonValue,
    },
    `recruiting.${action}`,
  );
}
