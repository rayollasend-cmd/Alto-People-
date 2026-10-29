import { prisma } from '../db.js';
import { nextPaydayFor } from './associatePayday.js';
import { periodContaining, scheduleMembershipFor } from './payScheduleMembership.js';
import { NO_SHOW_WAIT_MINUTES, owedCents } from './transport.js';

/**
 * The rider's side of the transport upgrade (2026-10-28): what the Ride
 * tab's live card says beyond the van on the map — who to look for, where
 * to wait, how long the van waits, who to call, and what the ride costs and
 * when it comes out of pay (MyLiveRideAdditions, packages/shared
 * transportOps). Riders read the app in English, Spanish, Turkish, Haitian
 * Creole, Portuguese or Ukrainian; the few sentences the server writes for
 * them come in their language.
 */

export type RiderLang = 'en' | 'es' | 'tr' | 'ht' | 'pt' | 'uk';

export function riderLang(v: string | null | undefined): RiderLang {
  return v === 'es' || v === 'tr' || v === 'ht' || v === 'pt' || v === 'uk' ? v : 'en';
}

/** The locale a rider's dates and times are written in. Haitian Creole reads French dates. */
const LOCALE: Record<RiderLang, string> = { en: 'en-US', es: 'es-US', tr: 'tr-TR', ht: 'fr-HT', pt: 'pt-BR', uk: 'uk-UA' };

/** "Nov 6" in the rider's language (a YYYY-MM-DD calendar day). */
export function riderDay(ymd: string, lang: RiderLang): string {
  return new Date(`${ymd}T12:00:00Z`).toLocaleDateString(LOCALE[lang], { timeZone: 'UTC', month: 'short', day: 'numeric' });
}

/** "5:15 AM" in the rider's language, in the store's zone. */
export function riderTime(at: Date, tz: string, lang: RiderLang): string {
  return new Intl.DateTimeFormat(LOCALE[lang], { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(at);
}

const FARE_WORDS: Record<RiderLang, { free: string; on: (day: string) => string; pay: string }> = {
  en: { free: 'No charge', on: (d) => `Taken from your pay on ${d}`, pay: 'Taken from your pay' },
  es: { free: 'Sin costo', on: (d) => `Se descuenta de su pago del ${d}`, pay: 'Se descuenta de su pago' },
  tr: { free: 'Ücretsiz', on: (d) => `${d} tarihli maaşınızdan kesilir`, pay: 'Maaşınızdan kesilir' },
  ht: { free: 'Gratis', on: (d) => `Yo retire l nan peman ou ${d}`, pay: 'Yo retire l nan peman ou' },
  pt: { free: 'Sem custo', on: (d) => `Descontado do seu pagamento de ${d}`, pay: 'Descontado do seu pagamento' },
  uk: { free: 'Безкоштовно', on: (d) => `Утримується з вашої зарплати ${d}`, pay: 'Утримується з вашої зарплати' },
};

/**
 * The payday a ride's fare comes out on: the paycheck of the pay period
 * the ride falls in (payroll's applyRideCharges takes rides on or before
 * the period's last day) — the next payday for anything up to its period's
 * end, the later period's payday for a ride booked further out. Null for a
 * rider on no pay schedule (no date is promised that no run would keep).
 */
export async function ridePayday(associateId: string, serviceDate: string, now = new Date()): Promise<string | null> {
  const next = await nextPaydayFor(associateId, now);
  if (!next) return null;
  if (serviceDate <= next.periodEnd) return next.payDate;
  const m = (await scheduleMembershipFor(prisma, [associateId], serviceDate)).get(associateId) ?? null;
  if (!m) return next.payDate;
  const schedule = await prisma.payrollSchedule.findUnique({ where: { id: m.scheduleId }, include: { versions: true } });
  if (!schedule) return next.payDate;
  const w = periodContaining(schedule, serviceDate);
  return w.payDate >= next.payDate ? w.payDate : next.payDate;
}

export interface FareRide {
  status: string;
  serviceDate: string;
  fareCents: number;
  chargeCents: number;
  waivedAt: Date | null;
}

/** What this ride costs the rider and how it is paid: "Taken from your pay on Nov 6", or "No charge". */
export async function rideFare(associateId: string, ride: FareRide, lang: RiderLang, now = new Date()): Promise<{ cents: number; words: string }> {
  // Once on board the charge is what is owed (the fare, or nothing when waived); before, the fare booked.
  const taken = ride.status === 'BOARDED' || ride.status === 'COMPLETED';
  const cents = ride.waivedAt ? 0 : taken ? owedCents(ride) : ride.fareCents;
  const w = FARE_WORDS[lang];
  if (cents <= 0) return { cents: 0, words: w.free };
  const payday = await ridePayday(associateId, ride.serviceDate, now).catch(() => null);
  return { cents, words: payday ? w.on(riderDay(payday, lang)) : w.pay };
}

export interface LiveRideFacts {
  associateId: string;
  language: string | null | undefined;
  ride: FareRide & { direction: 'TO_WORK' | 'FROM_WORK'; stop: { notes?: string | null } | null };
  run: {
    driver: { associate: { firstName: string } | null } | null;
    van: { color: string | null; make: string | null; model: string | null; year: number | null };
  } | null;
  dispatchPhone: string | null;
}

/** MyLiveRideAdditions for one ride (packages/shared transportOps). */
export async function liveRideAdditions(f: LiveRideFacts, now = new Date()) {
  const lang = riderLang(f.language);
  return {
    /** First name only — riders never see a driver's surname or number. */
    driverFirstName: f.run?.driver?.associate?.firstName ?? null,
    vanLook: f.run ? { color: f.run.van.color, make: f.run.van.make, model: f.run.van.model, year: f.run.van.year } : null,
    /** Where to wait: the stop's own note. A store pickup and a home address have none. */
    pickupNote: f.ride.direction === 'TO_WORK' ? (f.ride.stop?.notes?.trim() || null) : null,
    waitMinutes: NO_SHOW_WAIT_MINUTES,
    dispatchPhone: f.dispatchPhone,
    fare: await rideFare(f.associateId, f.ride, lang, now),
  };
}
