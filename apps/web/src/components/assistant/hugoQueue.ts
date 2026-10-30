import type { HugoTaskView } from '@alto-people/shared';

/**
 * "Waiting for you" (the Tasks tab's approvals queue): every task of any
 * kind that only the person can move on, most urgent first — the ones about
 * a shift by how soon it starts, then the rest by how long they have been
 * waiting (the oldest ask first).
 */

/** The shift a waiting task is about, as an instant; null when it is about no shift. */
export function shiftTimeOf(task: Pick<HugoTaskView, 'subject' | 'result'>): number | null {
  const s = task.subject;
  if (s.shift?.startsAt) return Date.parse(s.shift.startsAt);
  const calledOff = task.result?.calledOff;
  if (calledOff?.length) return Math.min(...calledOff.map((x) => Date.parse(x.startsAt)));
  // A chase is about a day: its start (close enough to sort with shifts).
  if (s.date) return Date.parse(`${s.date}T00:00:00`);
  return null;
}

/** When it started waiting on them: the last line on its trail, else when it last changed. */
export function askedAtOf(task: Pick<HugoTaskView, 'events' | 'updatedAt'>): number {
  const last = task.events[task.events.length - 1];
  return Date.parse(last?.at ?? task.updatedAt);
}

export function waitingOrder(a: HugoTaskView, b: HugoTaskView): number {
  const sa = shiftTimeOf(a);
  const sb = shiftTimeOf(b);
  if (sa !== null && sb !== null && sa !== sb) return sa - sb;
  if (sa !== null && sb === null) return -1;
  if (sa === null && sb !== null) return 1;
  return askedAtOf(a) - askedAtOf(b);
}
