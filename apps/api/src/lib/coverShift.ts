import type { PrismaClient } from '@prisma/client';
import { runShiftAutofillSweep } from './shiftAutofill.js';
import { runShiftFill, broadcastWindowPassed } from './workforceAgent.js';

/**
 * Cover a shift: the three moves behind the floor's one-tap "Cover this
 * shift" and behind every call-out (lib/callOuts).
 *
 *   1. post it   open and published, on Open shifts for the bench
 *   2. the bench everyone placed there and free, invited once (one-tap pickup)
 *   3. the agent proposes a fill once the bench has had its window
 *
 * The caller has already checked who may do this and that the shift is
 * coverable (not started, not closed); this only moves it.
 */

export interface CoverStep {
  key: 'post' | 'bench' | 'agent';
  status: 'done' | 'waiting' | 'skipped';
  detail: string;
}

export interface CoverableShift {
  id: string;
  clientId: string | null;
  status: string;
  assignedAssociateId: string | null;
  publishedAt: Date | null;
  startsAt: Date;
  notes: string | null;
}

export async function runCoverFlow(
  db: PrismaClient,
  shift: CoverableShift,
  opts: { reason?: string | null; now?: Date } = {},
): Promise<{ released: boolean; steps: CoverStep[] }> {
  const now = opts.now ?? new Date();
  const steps: CoverStep[] = [];
  const released = shift.status === 'ASSIGNED' && !!shift.assignedAssociateId;

  const updated = await db.shift.update({
    where: { id: shift.id },
    data: {
      status: 'OPEN',
      assignedAssociateId: null,
      acknowledgedAt: null,
      publishedAt: shift.publishedAt ?? now,
      ...(released && opts.reason
        ? { notes: [shift.notes, `Released ${now.toISOString().slice(0, 10)}: ${opts.reason}`].filter(Boolean).join('\n') }
        : {}),
    },
    select: { id: true, publishedAt: true },
  });
  steps.push({
    key: 'post',
    status: 'done',
    detail: released ? 'Released and posted to Open shifts.' : shift.publishedAt ? 'Already on Open shifts.' : 'Posted to Open shifts.',
  });

  try {
    const r = await runShiftAutofillSweep(db, now, { clientId: shift.clientId ?? undefined });
    steps.push({ key: 'bench', status: 'done', detail: r.invitesSent > 0 ? `${r.invitesSent} on the bench invited.` : 'The bench was already asked, or nobody is free.' });
  } catch {
    steps.push({ key: 'bench', status: 'skipped', detail: 'Could not reach the bench just now.' });
  }

  if (broadcastWindowPassed({ publishedAt: updated.publishedAt, startsAt: shift.startsAt }, now)) {
    try {
      const r = await runShiftFill(db, now);
      steps.push({
        key: 'agent',
        status: 'done',
        detail: r.skipped ? 'The agent is off; your approvals carry it.' : r.proposed > 0 ? `${r.proposed} proposal${r.proposed === 1 ? '' : 's'} in your Approvals.` : 'Nothing to propose yet.',
      });
    } catch {
      steps.push({ key: 'agent', status: 'skipped', detail: 'The agent could not run just now.' });
    }
  } else {
    steps.push({ key: 'agent', status: 'waiting', detail: 'The agent proposes a fill if the bench has not taken it in two hours.' });
  }
  return { released, steps };
}
