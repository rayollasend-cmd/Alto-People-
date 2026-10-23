import { apiFetch } from './api';

/** Call-outs (apps/api/src/lib/callOuts.ts): a worker's "I can't make it" from any channel. */

export type CallOutReason = 'SICK' | 'FAMILY' | 'TRANSPORT' | 'EMERGENCY' | 'BEREAVEMENT' | 'JURY_DUTY' | 'OTHER';
export type CallOutChannel = 'WHATSAPP' | 'SMS' | 'APP' | 'VOICE' | 'STAFF';
export const CALL_OUT_REASONS: CallOutReason[] = ['SICK', 'FAMILY', 'TRANSPORT', 'EMERGENCY', 'BEREAVEMENT', 'JURY_DUTY', 'OTHER'];

export interface MyCallOut {
  id: string;
  shiftId: string;
  reason: CallOutReason;
  createdAt: string;
  position: string;
  startsAt: string;
  place: string | null;
  timezone: string | null;
}

export interface CallOutItem {
  id: string;
  associateId: string;
  name: string;
  photoUrl: string | null;
  channel: CallOutChannel;
  reason: CallOutReason;
  note: string | null;
  late: boolean;
  excused: boolean;
  excusedWhy: string | null;
  minutesBeforeStart: number;
  hasRecording: boolean;
  calledOutAt: string;
  shift: { id: string; position: string; startsAt: string; endsAt: string; place: string | null; timezone: string | null };
  cover: { state: 'covered' | 'looking' | 'uncovered'; by: string | null; steps: Array<{ key: string; status: string; detail: string }> };
}

export type CallOutRange = 'today' | 'week' | '30d';

export interface CallOutList {
  range: CallOutRange;
  /** The site the list is narrowed to, or null for every site in reach. */
  siteId?: string | null;
  /** Every site in this range's call-outs: the site filter's options. */
  sites?: Array<{ id: string; name: string }>;
  /** Median minutes from a call-out to the shift being someone else's (null: nothing covered by a person). */
  medianMinutesToCover?: number | null;
  /** People with two or more call-outs in the range. */
  repeatCallers?: Array<{ associateId: string; name: string; count: number }>;
  /** The last seven days' record, for the line a quiet day shows. */
  last7Days?: { total: number; covered: number; coveredPct: number | null; medianMinutesToCover: number | null };
  total: number;
  covered: number;
  looking: number;
  uncovered: number;
  late: number;
  truncated: boolean;
  items: CallOutItem[];
}

export const callOutMine = (body: { shiftId: string; reason: CallOutReason; note?: string }) =>
  apiFetch<{ callOutId: string; outcome: 'confirmed' | 'duplicate'; message: string }>('/me/call-outs', { method: 'POST', body });

export const listMyCallOuts = () => apiFetch<{ callOuts: MyCallOut[] }>('/me/call-outs');

export const listCallOuts = (range: CallOutRange, siteId?: string | null) =>
  apiFetch<CallOutList>(`/call-outs?range=${range}${siteId ? `&siteId=${encodeURIComponent(siteId)}` : ''}`);

export const recordCallOutFor = (body: { associateId: string; shiftId: string; reason: CallOutReason; note?: string }) =>
  apiFetch<{ callOutId: string; outcome: string }>('/call-outs', { method: 'POST', body });

/** Said in the last 24 hours. */
export function withinADay(iso: string): boolean {
  return Date.now() - new Date(iso).getTime() <= 86_400_000;
}
