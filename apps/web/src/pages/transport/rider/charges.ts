import { fmtDayShort, fmtMoney, parseYmd } from '@/lib/format';
import type { Translate } from '@/lib/i18n';
import type { MyTransport, Ride } from '@/lib/transportApi';
import '@/lib/i18n/en/ride';

/**
 * What a rider owes, Uber-style (the transport upgrade, 2026-10-28): the
 * balance in one line, and a ledger with one row per charge and its state
 * in words. Money is exact here — it is a ledger. Pure: the Ride page, the
 * Home card and the tests read the same answer.
 */

/** Fields the ledger reads when the API sends them (optional until it does). */
export type LedgerRide = Ride & {
  /** The sweep closed the run before it left — never charged. */
  notRun?: boolean;
  /** When payroll took it, and the payday that took it. */
  chargedAt?: string | null;
  chargedPayDate?: string | null;
};

export type Payday = MyTransport['charges']['nextPayday'];

const cents = (n: number) => fmtMoney(n / 100);
const day = (ymd: string) => fmtDayShort(parseYmd(ymd) ?? ymd, { anchored: true });

/** The ride's date in its own store's calendar (YYYY-MM-DD). */
const dateOf = (r: Ride) => r.serviceDate;

/**
 * "$5.00 — taken from your pay on Fri, Nov 6": a fare in words, never a
 * bare number. A ride after the coming payday's period is taken from the
 * one after it; with no pay schedule it just says "from your pay".
 */
export function fareWords(t: Translate, amountCents: number, payday: Payday, serviceDate?: string | null): string {
  const amount = cents(amountCents);
  if (payday && (!serviceDate || serviceDate <= payday.periodEnd)) return t('ride.fare.words', { amount, date: day(payday.payDate) });
  if (payday) return t('ride.fare.wordsLater', { amount });
  return t('ride.total', { amount });
}

/** The van didn't run: the sweep cancelled the ride, and nothing is charged. */
export function didntRun(r: LedgerRide): boolean {
  return r.status === 'CANCELLED' && (!!r.notRun || /didn[’']?t run/i.test(r.cancelReason ?? ''));
}

export type ChargeState = 'pending' | 'held' | 'taken' | 'waived' | 'notCharged' | 'notRun';

export interface ChargeRow {
  ride: LedgerRide;
  kind: 'fare' | 'noShow';
  cents: number;
  state: ChargeState;
  /** YYYY-MM-DD in the store's calendar. */
  date: string;
  /** The payday that took it, when the API says. */
  takenOn: string | null;
  /** Why it was waived, for the rider (null when no reason was written). */
  reason: string | null;
  /** Counts toward what is owed (pending or held) or was taken. */
  counts: boolean;
}

/** One row per charge: taken rides (the fare), missed vans (the fee), and the rides that were never charged and why. */
export function chargeRows(rides: LedgerRide[]): ChargeRow[] {
  const rows: ChargeRow[] = [];
  for (const r of rides) {
    const noShow = r.status === 'NO_SHOW';
    const taken = r.status === 'BOARDED' || r.status === 'COMPLETED';
    const notRun = didntRun(r);
    if (!noShow && !taken && !notRun) continue;
    const kind = noShow ? 'noShow' : 'fare';
    const listed = noShow ? r.noShowFeeCents : r.fareCents;
    const amount = r.owedCents > 0 ? r.owedCents : listed;
    const state: ChargeState = notRun
      ? 'notRun'
      : r.waived && r.waiveKind === 'NOT_AUTHORIZED'
        ? 'notCharged'
        : r.waived
          ? 'waived'
          : r.charged
            ? 'taken'
            : r.heldForSignature
              ? 'held'
              : 'pending';
    // A free ride is not a charge.
    if (amount <= 0 && (state === 'pending' || state === 'taken' || state === 'held')) continue;
    rows.push({
      ride: r,
      kind,
      cents: notRun ? r.fareCents : state === 'notCharged' ? (r.uncollectedCents ?? listed) : amount,
      state,
      date: dateOf(r),
      takenOn: r.chargedPayDate ?? (r.chargedAt ? r.chargedAt.slice(0, 10) : null),
      reason: state === 'waived' ? (r.waiveReason?.trim() || null) : null,
      counts: state === 'pending' || state === 'held' || state === 'taken',
    });
  }
  return rows.sort((a, b) => (a.date === b.date ? Date.parse(b.ride.targetAt) - Date.parse(a.ride.targetAt) : a.date < b.date ? 1 : -1));
}

export type ChargeGroupKind = 'current' | 'later' | 'held' | 'payday' | 'taken' | 'earlier';

export interface ChargeGroup {
  key: string;
  kind: ChargeGroupKind;
  /** The payday it comes out on / came out on. */
  payDate: string | null;
  rows: ChargeRow[];
  /** What the group's charges add up to (owed or taken — never the uncharged). */
  totalCents: number;
}

/**
 * The ledger's sections: this pay period (owed, with its running total),
 * anything that falls to a later payday, fares held for a signature, then
 * past paydays (collapsed), and older rides that were never charged.
 */
export function chargeGroups(rows: ChargeRow[], payday: Payday): ChargeGroup[] {
  const current: ChargeRow[] = [];
  const later: ChargeRow[] = [];
  const held: ChargeRow[] = [];
  const earlier: ChargeRow[] = [];
  const paid = new Map<string, ChargeRow[]>();
  for (const row of rows) {
    if (row.state === 'pending') {
      (payday && row.date > payday.periodEnd ? later : current).push(row);
    } else if (row.state === 'held') {
      held.push(row);
    } else if (row.state === 'taken') {
      const k = row.takenOn ?? '';
      paid.set(k, [...(paid.get(k) ?? []), row]);
    } else if (!payday) {
      current.push(row);
    } else if (row.date > payday.periodEnd) {
      later.push(row);
    } else if (row.date >= payday.periodStart) {
      current.push(row);
    } else {
      earlier.push(row);
    }
  }
  const sum = (list: ChargeRow[]) => list.reduce((n, r) => n + (r.counts ? r.cents : 0), 0);
  const groups: ChargeGroup[] = [];
  if (current.length) groups.push({ key: 'current', kind: 'current', payDate: payday?.payDate ?? null, rows: current, totalCents: sum(current) });
  if (later.length) groups.push({ key: 'later', kind: 'later', payDate: null, rows: later, totalCents: sum(later) });
  if (held.length) groups.push({ key: 'held', kind: 'held', payDate: null, rows: held, totalCents: sum(held) });
  const days = [...paid.keys()].filter(Boolean).sort().reverse();
  for (const d of days) groups.push({ key: `paid-${d}`, kind: 'payday', payDate: d, rows: paid.get(d)!, totalCents: sum(paid.get(d)!) });
  // Taken before the API said on which payday: one group, still collapsed.
  if (paid.has('')) groups.push({ key: 'paid', kind: 'taken', payDate: null, rows: paid.get('')!, totalCents: sum(paid.get('')!) });
  if (earlier.length) groups.push({ key: 'earlier', kind: 'earlier', payDate: null, rows: earlier, totalCents: 0 });
  return groups;
}

export interface OwedSummary {
  cents: number;
  rides: number;
  noShows: number;
  /** The payday it comes out on. */
  payDate: string | null;
  /** Of `cents`, what falls to a later payday than `payDate`. */
  laterCents: number;
  /** Of `cents`, fares held until the rider signs the authorization. */
  heldCents: number;
}

/** The balance for the "What you owe" card and the Home card. */
export function owedSummary(data: MyTransport): OwedSummary {
  const c = data.charges;
  const rows = chargeRows(data.rides);
  const payday = c.nextPayday;
  const laterCents = payday ? rows.filter((r) => r.state === 'pending' && r.date > payday.periodEnd).reduce((n, r) => n + r.cents, 0) : 0;
  const heldCents = rows.filter((r) => r.state === 'held').reduce((n, r) => n + r.cents, 0);
  return {
    cents: c.pendingCents,
    rides: c.rides,
    noShows: c.noShows,
    payDate: payday?.payDate ?? null,
    laterCents: Math.min(laterCents, c.pendingCents),
    heldCents: Math.min(heldCents, c.pendingCents),
  };
}

/** "Fri, Nov 6" from a YYYY-MM-DD. */
export const paydayText = day;
