import type { Prisma, PrismaClient } from '@prisma/client';
import type { ShiftSwapRequest as ShiftSwapRequestDTO } from '@alto-people/shared';
import { HttpError } from '../middleware/error.js';
import { associateWeekLink } from './appLinks.js';
import { shiftSwapManagerTemplate } from './emailTemplates.js';
import { notifyClientSupervisors, notifyManager } from './notify.js';
import { formatShiftLine, notifyShift } from './notifyShift.js';
import { ACTIVE_ASSOCIATE_FILTER } from './schedulablePool.js';
import { benchFor } from './scope.js';
import { blockedForWindow } from './shiftAssign.js';
import { companyWorkweek } from './timeAnomalies.js';
import { formatTimeInZone, localDateKey } from './timezone.js';

/** A shift's store clock; a shift with no store reads the company's. */
const zoneOfShift = (s: { locationRel: { timezone: string | null } | null }): string => s.locationRel?.timezone ?? companyWorkweek().timezone;

/**
 * Peer shift swaps, in one place: the scheduling routes and Hugo's
 * find-cover task (lib/hugoTasks) both ask a coworker through here, so a
 * request Hugo sends on someone's behalf is the same request — same checks,
 * same notices — as one they send from the swap screen.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export type RawSwap = Prisma.ShiftSwapRequestGetPayload<{
  include: {
    shift: {
      include: {
        client: { select: { name: true } };
        locationRel: { select: { timezone: true } };
      };
    };
    counterpartShift: {
      include: {
        client: { select: { name: true } };
        locationRel: { select: { timezone: true } };
      };
    };
    requester: { select: { firstName: true; lastName: true } };
    counterparty: { select: { firstName: true; lastName: true } };
  };
}>;

export const SWAP_INCLUDE = {
  shift: {
    include: {
      client: { select: { name: true } },
      locationRel: { select: { timezone: true } },
    },
  },
  counterpartShift: {
    include: {
      client: { select: { name: true } },
      locationRel: { select: { timezone: true } },
    },
  },
  requester: { select: { firstName: true, lastName: true } },
  counterparty: { select: { firstName: true, lastName: true } },
} as const;

export function toSwap(row: RawSwap): ShiftSwapRequestDTO {
  return {
    id: row.id,
    shiftId: row.shiftId,
    shiftStartsAt: row.shift.startsAt.toISOString(),
    shiftEndsAt: row.shift.endsAt.toISOString(),
    shiftTimezone: zoneOfShift(row.shift),
    shiftPosition: row.shift.position,
    shiftClientName: row.shift.client?.name ?? null,
    inExchange: row.counterpartShift
      ? {
          shiftId: row.counterpartShift.id,
          position: row.counterpartShift.position,
          clientName: row.counterpartShift.client?.name ?? null,
          startsAt: row.counterpartShift.startsAt.toISOString(),
          endsAt: row.counterpartShift.endsAt.toISOString(),
          timezone: zoneOfShift(row.counterpartShift),
        }
      : null,
    requesterAssociateId: row.requesterAssociateId,
    requesterName: `${row.requester.firstName} ${row.requester.lastName}`,
    counterpartyAssociateId: row.counterpartyAssociateId,
    counterpartyName: `${row.counterparty.firstName} ${row.counterparty.lastName}`,
    status: row.status,
    note: row.note,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}


export interface SwapCreate {
  requesterAssociateId: string;
  /** The person who asked — the requester's own account, also when Hugo sends it for them. */
  actorUserId: string;
  shiftId: string;
  counterpartyAssociateId: string;
  counterpartShiftId?: string | null;
  note?: string | null;
}

/**
 * The requester owns the shift and proposes someone else takes it. The
 * counterparty must exist (HR can still reject). `managerCopy: false`
 * keeps the manager and supervisor copies for the moment the coworker says
 * yes — Hugo asks one coworker at a time, and a manager told about every
 * ask would hear about each "no" too; the accept already reaches them.
 */
export async function createSwapRequest(db: Db, input: SwapCreate, opts: { managerCopy?: boolean } = {}): Promise<RawSwap> {
  const { requesterAssociateId, shiftId, counterpartyAssociateId, note, counterpartShiftId } = input;
  if (counterpartyAssociateId === requesterAssociateId) {
    throw new HttpError(400, 'self_swap', 'You cannot swap a shift with yourself');
  }
  const shift = await db.shift.findUnique({ where: { id: shiftId } });
  if (!shift) throw new HttpError(404, 'shift_not_found', 'Shift not found');
  if (shift.assignedAssociateId !== requesterAssociateId) {
    throw new HttpError(403, 'not_your_shift', 'You can only swap shifts assigned to you');
  }
  if (shift.status !== 'ASSIGNED') {
    throw new HttpError(409, 'shift_not_assigned', 'Shift is not in an assignable state');
  }
  const counterparty = await db.associate.findFirst({
    where: { id: counterpartyAssociateId, deletedAt: null },
  });
  if (!counterparty) throw new HttpError(404, 'counterparty_not_found', 'Counterparty associate not found');

  // Trade half: the exchange shift must be a real, upcoming, published
  // shift OF THE COUNTERPARTY — otherwise this degrades into a lever for
  // grabbing arbitrary shifts. Deeper checks (double-booking both ways)
  // run at manager-approve time, when they're actually decisive.
  if (counterpartShiftId) {
    if (counterpartShiftId === shiftId) {
      throw new HttpError(400, 'same_shift', 'Exchange shift must differ from yours');
    }
    const exchange = await db.shift.findUnique({ where: { id: counterpartShiftId } });
    if (
      !exchange ||
      exchange.assignedAssociateId !== counterpartyAssociateId ||
      exchange.status !== 'ASSIGNED' ||
      !exchange.publishedAt ||
      exchange.startsAt <= new Date()
    ) {
      throw new HttpError(
        409,
        'invalid_exchange_shift',
        "The exchange shift must be one of the counterparty's upcoming shifts",
      );
    }
  }

  const created = await db.shiftSwapRequest.create({
    data: {
      shiftId,
      requesterAssociateId,
      counterpartyAssociateId,
      counterpartShiftId: counterpartShiftId ?? null,
      note: note ?? null,
      status: 'PENDING_PEER',
    },
    include: SWAP_INCLUDE,
  });

  void notifyShift(db, {
    associateId: counterpartyAssociateId,
    subject: 'New swap request',
    body: `${created.requester.firstName} ${created.requester.lastName} is asking you to take their shift: ${formatShiftLine(
      {
        position: created.shift.position,
        clientName: created.shift.client?.name ?? null,
        startsAt: created.shift.startsAt,
        endsAt: created.shift.endsAt,
      }
    )}${note ? `\nNote: ${note}` : ''}`,
    category: 'swap_peer_request',
    senderUserId: input.actorUserId,
  });
  if (opts.managerCopy === false) return created;
  // Manager copy: the requester's manager should know a swap is in flight
  // so they can intervene if the peer rejects. No-op if no manager.
  const mgrSwapTpl = shiftSwapManagerTemplate({
    requesterName: `${created.requester.firstName} ${created.requester.lastName}`,
    counterpartyName: `${counterparty.firstName} ${counterparty.lastName}`,
    position: created.shift.position,
    clientName: created.shift.client?.name ?? 'the client',
    // The store's day and clock, as the manager reads the schedule — not UTC.
    shiftDate: localDateKey(created.shift.startsAt, zoneOfShift(created.shift)),
    startsAt: formatTimeInZone(created.shift.startsAt, zoneOfShift(created.shift)),
    endsAt: formatTimeInZone(created.shift.endsAt, zoneOfShift(created.shift)),
  });
  void notifyManager(requesterAssociateId, {
    subject: mgrSwapTpl.subject,
    body: mgrSwapTpl.text,
    html: mgrSwapTpl.html,
    category: 'scheduling',
    // Their week, on the shift's store — the swap in context.
    linkUrl: associateWeekLink({
      associateId: requesterAssociateId,
      clientId: created.shift.clientId,
      week: created.shift.startsAt,
    }),
  });
  // The site's shift supervisor approves swaps but is rarely anyone's
  // managerId — route them a copy keyed on the shift's client.
  void notifyClientSupervisors(created.shift.clientId, {
    subject: mgrSwapTpl.subject,
    body: mgrSwapTpl.text,
    html: mgrSwapTpl.html,
    category: 'scheduling',
    // Still waiting on the coworker — the approvals queue only lists
    // accepted swaps, so this opens the shift; the queue link follows
    // when the coworker accepts.
    linkUrl: `/scheduling?shift=${created.shift.id}`,
    at: { locationId: created.shift.locationId, startsAt: created.shift.startsAt },
  });
  return created;
}

/** The requester withdraws a swap that has not been approved yet. */
export async function cancelSwapRequest(db: Db, swapId: string, requesterAssociateId: string): Promise<RawSwap> {
  const swap = await db.shiftSwapRequest.findUnique({ where: { id: swapId } });
  if (!swap || swap.requesterAssociateId !== requesterAssociateId) {
    throw new HttpError(404, 'swap_not_found', 'Swap request not found');
  }
  if (swap.status === 'MANAGER_APPROVED' || swap.status === 'CANCELLED') {
    throw new HttpError(409, 'invalid_state', `Swap is in ${swap.status}, cannot cancel`);
  }
  // Guarded write: re-assert "not yet approved" AT WRITE TIME. Without
  // this, a cancel racing manager-approve could stamp CANCELLED over an
  // approved swap whose assignment already moved (June audit P0).
  const cas = await db.shiftSwapRequest.updateMany({
    where: {
      id: swap.id,
      status: { notIn: ['MANAGER_APPROVED', 'CANCELLED'] },
    },
    data: { status: 'CANCELLED' },
  });
  if (cas.count === 0) {
    throw new HttpError(409, 'invalid_state', 'This swap was already resolved.');
  }
  return db.shiftSwapRequest.findUniqueOrThrow({
    where: { id: swap.id },
    include: SWAP_INCLUDE,
  });
}

export interface SwapCandidate {
  associateId: string;
  name: string;
  /** Already working an overlapping shift, or off that day. */
  busy: boolean;
  /** Their sign-in, when they have an active one — the only way they can answer. */
  userId: string | null;
}

/**
 * Who the requester can offer this shift to: the schedulable pool (ACTIVE
 * ASSOCIATE-role, onboarded) minus themselves, each flagged `busy` when
 * they already have a shift overlapping this one. Advisory — the swap
 * request and manager approval remain the enforcement points. Null when
 * the shift is not the requester's, published and live.
 */
export async function swapCandidatesFor(
  db: Db,
  shiftId: string,
  requesterAssociateId: string,
): Promise<{ shift: { id: string; clientId: string | null; locationId: string | null; startsAt: Date; endsAt: Date; timezone: string }; candidates: SwapCandidate[] } | null> {
  const shift = await db.shift.findFirst({
    where: {
      id: shiftId,
      assignedAssociateId: requesterAssociateId,
      publishedAt: { not: null },
      status: { notIn: ['CANCELLED'] },
    },
    select: {
      id: true,
      clientId: true,
      locationId: true,
      startsAt: true,
      endsAt: true,
      locationRel: { select: { timezone: true } },
    },
  });
  if (!shift) return null;
  const timezone = zoneOfShift(shift);

  // Schedulable pool ∩ placed at THIS client — offering a Publix shift
  // to someone who has never worked Publix is a dead-on-arrival request.
  // AND-composed because ACTIVE_ASSOCIATE_FILTER carries its own OR;
  // spreading a second OR key would silently overwrite the first.
  const pool = await db.associate.findMany({
    where: {
      AND: [
        ACTIVE_ASSOCIATE_FILTER,
        { id: { not: requesterAssociateId } },
        // Placed at THIS client now (a transfer moves them), or at THIS
        // site for a shift that names no client (a direct employer); a
        // shift naming neither offers to nobody — lib/scope.benchFor.
        benchFor(shift) ?? { id: '00000000-0000-0000-0000-000000000000' },
      ],
    },
    select: { id: true, firstName: true, lastName: true, user: { select: { id: true, status: true } } },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    take: 200,
  });
  const poolIds = pool.map((a) => a.id);
  const [clashes, dayBlocked] = await Promise.all([
    db.shift.findMany({
      where: {
        id: { not: shift.id },
        assignedAssociateId: { in: poolIds },
        status: { notIn: ['CANCELLED'] },
        startsAt: { lt: shift.endsAt },
        endsAt: { gt: shift.startsAt },
      },
      select: { assignedAssociateId: true },
    }),
    // Approved time off + one-off days off count as busy too — a request
    // to someone on vacation dies at manager review anyway.
    blockedForWindow(poolIds, shift.startsAt, shift.endsAt, timezone, db),
  ]);
  const busyIds = new Set([...clashes.map((c) => c.assignedAssociateId as string), ...dayBlocked]);
  return {
    shift: { id: shift.id, clientId: shift.clientId, locationId: shift.locationId, startsAt: shift.startsAt, endsAt: shift.endsAt, timezone },
    candidates: pool.map((a) => ({
      associateId: a.id,
      name: `${a.firstName} ${a.lastName}`,
      busy: busyIds.has(a.id),
      userId: a.user?.status === 'ACTIVE' ? a.user.id : null,
    })),
  };
}
