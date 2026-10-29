import type { AssignmentReason, RankedCandidate, WorkTaskAssignmentView, WorkTaskView } from '@alto-people/shared';
import { can, type CapabilityHolder } from '@alto-people/shared';

/**
 * FLOOR-6 — a person's task cost is their hourly pay × the minutes
 * (engine.ts candidatesFor), so showing it to a shift supervisor shows
 * each worker's pay. Only a role that may see pay reads a PERSON's cost;
 * everyone else sees the engine's reasoning without the money: the cost
 * factor's points stay (cheaper still won), the dollar figure goes. A
 * robot's or agent's cost is policy, not pay, and stays.
 */
export function maySeeTaskCosts(user: CapabilityHolder): boolean {
  return can(user, 'view:comp') || can(user, 'process:payroll');
}

const PAY_HIDDEN_NOTE = 'Weighed on cost (a person’s pay is not shown)';
// rank.ts decideAssignment: "Best option costs $34.00, above the $25.00 the engine may assign on its own".
const QUEUED_COST = /^Best option costs \$[\d,]+\.\d{2}, above the /;

const hideReasons = (reasons: AssignmentReason[]): AssignmentReason[] =>
  reasons.map((r) => (r.factor === 'cost' ? { ...r, note: PAY_HIDDEN_NOTE } : r));

const hideCandidate = (c: RankedCandidate): RankedCandidate =>
  c.workerType === 'PERSON' ? { ...c, costCents: 0, reasons: hideReasons(c.reasons) } : c;

const hideAssignment = (a: WorkTaskAssignmentView): WorkTaskAssignmentView => ({
  ...a,
  ...(a.workerType === 'PERSON' ? { costCents: 0, reasons: hideReasons(a.reasons) } : {}),
  ranking: a.ranking.map(hideCandidate),
});

const hideQueued = (s: string | null): string | null => (s && QUEUED_COST.test(s) ? s.replace(QUEUED_COST, 'Best option costs more than the ') : s);

/** The view as this caller may read it: a person's cost removed unless they may see pay. */
export function taskForViewer<T extends WorkTaskView & { history?: WorkTaskAssignmentView[]; events?: Array<{ note: string | null }> }>(user: CapabilityHolder, view: T): T {
  if (maySeeTaskCosts(user)) return view;
  return {
    ...view,
    assignment: view.assignment ? hideAssignment(view.assignment) : null,
    queuedReason: hideQueued(view.queuedReason),
    ...(view.history ? { history: view.history.map(hideAssignment) } : {}),
    ...(view.events ? { events: view.events.map((e) => ({ ...e, note: hideQueued(e.note) })) } : {}),
  };
}
