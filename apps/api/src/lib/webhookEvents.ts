import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { ENTRY_PUBLIC_INCLUDE, SHIFT_PUBLIC_INCLUDE, entryPublic, shiftPublic } from './v1/mappers.js';
import { emitWebhookEvent } from './webhookDispatch.js';

/**
 * Brief 2-4 step 5 — the five events the brief asks for, with the /v1
 * public shapes as payloads (lib/v1/mappers: no pay, no coordinates, no
 * document numbers). Every emit is fire-and-forget: an event never fails
 * or slows the change that caused it; a failure is logged.
 *
 *   shift.created / shift.changed   lib/shiftCreate, lib/shiftAssign, the
 *                                   schedule's update, unassign, publish and bulk paths, /v1
 *   time_entry.approved             the time desk's approve and bulk approve
 *   worker.status_changed           hire approval, separation, deactivation,
 *                                   reactivation, an agent or robot's status
 *   program.alert                   the Monday program digest, once a week per alert
 *   agent.approval_requested/decided  lib/agents' approval queue
 */

type Db = PrismaClient;

const quietly = (p: Promise<unknown>, what: string) => {
  void p.catch((err) => console.error(`[alto-people/api] webhook ${what} failed:`, err));
};

export type ShiftChange = 'created' | 'updated' | 'assigned' | 'unassigned' | 'cancelled' | 'published';

/** shift.created (change 'created') or shift.changed, with the shift as /v1 shows it. */
export function emitShiftEvent(shiftId: string, change: ShiftChange, db: Db = defaultPrisma): void {
  quietly(
    (async () => {
      const s = await db.shift.findUnique({ where: { id: shiftId }, include: SHIFT_PUBLIC_INCLUDE });
      if (!s) return;
      await emitWebhookEvent(change === 'created' ? 'shift.created' : 'shift.changed', { change, shift: shiftPublic(s) }, { clientId: s.clientId, tenantId: s.tenantId, prisma: db });
    })(),
    'shift event',
  );
}

export function emitTimeEntryApproved(entryId: string, db: Db = defaultPrisma): void {
  quietly(
    (async () => {
      const e = await db.timeEntry.findUnique({ where: { id: entryId }, include: ENTRY_PUBLIC_INCLUDE });
      if (!e) return;
      await emitWebhookEvent('time_entry.approved', { timeEntry: entryPublic(e) }, { clientId: e.clientId, tenantId: e.tenantId, prisma: db });
    })(),
    'time_entry.approved',
  );
}

/** A worker's status changed: by its worker id, or a person's by their associate id. */
export function emitWorkerStatusChanged(ref: { workerId?: string; associateId?: string }, reason: string, db: Db = defaultPrisma): void {
  quietly(
    (async () => {
      // A person's worker status follows the associate record on a sweep; bring it current first,
      // so the event never carries yesterday's status. Loaded on use: workers.ts imports this module.
      if (ref.associateId) {
        const { syncPersonWorkerStatus } = await import('./workers.js');
        await syncPersonWorkerStatus(db, ref.associateId);
      }
      const w = ref.workerId
        ? await db.worker.findUnique({ where: { id: ref.workerId }, select: { id: true, type: true, status: true, tenantId: true } })
        : ref.associateId
          ? await db.worker.findUnique({ where: { associateId: ref.associateId }, select: { id: true, type: true, status: true, tenantId: true } })
          : null;
      if (!w) return;
      await emitWebhookEvent('worker.status_changed', { worker: { id: w.id, type: w.type, status: w.status }, reason }, { tenantId: w.tenantId, prisma: db });
    })(),
    'worker.status_changed',
  );
}

/** One program alert: its kind, due date and program, never a document number. */
export function emitProgramAlert(alert: { kind: string; dueOn: string; daysUntil: number; severity: string; programId: string; associateId: string }, tenantId: string, db: Db = defaultPrisma): void {
  quietly(
    (async () => {
      const w = await db.worker.findUnique({ where: { associateId: alert.associateId }, select: { id: true } });
      await emitWebhookEvent('program.alert', { kind: alert.kind, dueOn: alert.dueOn, daysUntil: alert.daysUntil, severity: alert.severity, programId: alert.programId, workerId: w?.id ?? null }, { tenantId, prisma: db });
    })(),
    'program.alert',
  );
}

export function emitAgentApproval(event: 'agent.approval_requested' | 'agent.approval_decided', approval: { id: string; action: string; status: string; summary: string; workerId: string }, tenantId: string | null, db: Db = defaultPrisma): void {
  if (!tenantId) return;
  quietly(
    emitWebhookEvent(event, { approval: { id: approval.id, action: approval.action, status: approval.status, summary: approval.summary, agentId: approval.workerId } }, { tenantId, prisma: db }),
    event,
  );
}
