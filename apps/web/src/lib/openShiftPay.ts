import { paidMinutesForRange } from '@alto-people/shared';

/**
 * What an open shift is worth — one rule on every associate screen
 * (ASSOC-5): its posted pay rate when it has one, else the associate's own
 * rate, times its PAID hours (the shared unpaid-break rule). The same shift
 * read "~$90" on Schedule and Home (their $15) and "$15.50/hr · worth ~$93"
 * on Open shifts (the posted rate, clock hours).
 */
export function openShiftRate(posted: number | string | null | undefined, myRate: number | null | undefined): number | null {
  const p = posted === null || posted === undefined || posted === '' ? NaN : Number(posted);
  if (Number.isFinite(p) && p > 0) return p;
  return myRate != null && Number.isFinite(myRate) && myRate > 0 ? myRate : null;
}

export function openShiftWorth(
  shift: { startsAt: string; endsAt: string },
  posted: number | string | null | undefined,
  myRate: number | null | undefined,
): number | null {
  const rate = openShiftRate(posted, myRate);
  if (rate === null) return null;
  const minutes = paidMinutesForRange(shift.startsAt, shift.endsAt);
  return minutes > 0 ? (minutes / 60) * rate : null;
}
