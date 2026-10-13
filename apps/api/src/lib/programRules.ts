import type { Prisma, PrismaClient } from '@prisma/client';
import { HttpError } from '../middleware/error.js';
import { enqueueAudit } from './audit.js';
import { orgDateKey } from './timeAnomalies.js';

/**
 * THE H-2B RULE.
 *
 * An H-2B worker's petition is certified for one employer at one area of
 * employment. Scheduling them at any other client is a violation for Alto
 * and for the worker, so every path that puts an associate on a shift —
 * direct assign, bulk create, a pickup approval, a swap approval, and the
 * open-shift list they can claim from — asks here first. A refusal is a
 * clear 409 and an audit row, because an attempt is itself worth knowing.
 */

type Db = Pick<PrismaClient, 'program'>;

const DAY_MS = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

export interface ClientRestriction {
  programId: string;
  clientId: string;
  clientName: string;
  petitionNumber: string | null;
  programEnd: string;
}

/**
 * The client an associate is restricted to today, or null when they may
 * work anywhere: the H-2B program whose dates (plus grace) cover today
 * and that names a petition client. A program closed by hand no longer
 * restricts.
 */
export async function clientRestrictionFor(
  db: Db,
  associateId: string,
  now: Date = new Date(),
): Promise<ClientRestriction | null> {
  const today = orgDateKey(now);
  const rows = await db.program.findMany({
    where: { associateId, type: 'H2B', closedAt: null, petitionClientId: { not: null } },
    select: {
      id: true,
      programStart: true,
      programEnd: true,
      gracePeriodDays: true,
      h2bPetitionNumber: true,
      petitionClient: { select: { id: true, name: true } },
    },
    orderBy: { programEnd: 'desc' },
  });
  for (const p of rows) {
    if (!p.petitionClient) continue;
    const graceEnd = ymd(new Date(p.programEnd.getTime() + p.gracePeriodDays * DAY_MS));
    if (ymd(p.programStart) <= today && today <= graceEnd) {
      return {
        programId: p.id,
        clientId: p.petitionClient.id,
        clientName: p.petitionClient.name,
        petitionNumber: p.h2bPetitionNumber,
        programEnd: ymd(p.programEnd),
      };
    }
  }
  return null;
}

/** Restrictions for many associates at once (bulk create, lists). */
export async function clientRestrictionsFor(
  db: Db,
  associateIds: string[],
  now: Date = new Date(),
): Promise<Map<string, ClientRestriction>> {
  const out = new Map<string, ClientRestriction>();
  if (associateIds.length === 0) return out;
  const today = orgDateKey(now);
  const rows = await db.program.findMany({
    where: { associateId: { in: associateIds }, type: 'H2B', closedAt: null, petitionClientId: { not: null } },
    select: {
      id: true,
      associateId: true,
      programStart: true,
      programEnd: true,
      gracePeriodDays: true,
      h2bPetitionNumber: true,
      petitionClient: { select: { id: true, name: true } },
    },
    orderBy: { programEnd: 'desc' },
  });
  for (const p of rows) {
    if (out.has(p.associateId) || !p.petitionClient) continue;
    const graceEnd = ymd(new Date(p.programEnd.getTime() + p.gracePeriodDays * DAY_MS));
    if (ymd(p.programStart) <= today && today <= graceEnd) {
      out.set(p.associateId, {
        programId: p.id,
        clientId: p.petitionClient.id,
        clientName: p.petitionClient.name,
        petitionNumber: p.h2bPetitionNumber,
        programEnd: ymd(p.programEnd),
      });
    }
  }
  return out;
}

export interface RuleContext {
  actorUserId: string | null;
  /** Which path asked: 'assign' | 'bulk_create' | 'claim_approve' | 'swap_approve' | 'claim'. */
  via: string;
  shiftId?: string | null;
}

/**
 * Throw when `associateId` may not work at `clientId`. The attempt is
 * logged either way it is reached: a blocked assignment is a near-miss
 * the compliance record should show.
 */
export async function assertClientAllowed(
  db: Db,
  associate: { id: string; firstName: string; lastName: string },
  clientId: string,
  ctx: RuleContext,
  now: Date = new Date(),
): Promise<void> {
  const r = await clientRestrictionFor(db, associate.id, now);
  if (!r || r.clientId === clientId) return;
  enqueueAudit(
    {
      actorUserId: ctx.actorUserId,
      clientId,
      action: 'program.cross_client_blocked',
      entityType: 'Program',
      entityId: r.programId,
      metadata: {
        associateId: associate.id,
        attemptedClientId: clientId,
        petitionClientId: r.clientId,
        petitionNumber: r.petitionNumber,
        via: ctx.via,
        shiftId: ctx.shiftId ?? null,
      } as Prisma.InputJsonObject,
    },
    'assertClientAllowed',
  );
  throw new HttpError(
    409,
    'program_client_mismatch',
    `${associate.firstName} ${associate.lastName} is on an H-2B petition certified for ${r.clientName}` +
      `${r.petitionNumber ? ` (${r.petitionNumber})` : ''} and cannot be scheduled at another client until ${r.programEnd}.`,
    { petitionClientId: r.clientId, petitionClientName: r.clientName, programEnd: r.programEnd },
  );
}
