import type { PrismaClient } from '@prisma/client';
import { prisma } from '../db.js';
import { enqueueAudit } from './audit.js';
import { tenantJob } from './tenantJobs.js';
import { notifyAssociate, notifyUser, trackNotificationWork } from './notify.js';
import { emitLiveEvent } from './liveEvents.js';
import { actsAs } from './roleScope.js';
import { DEFAULT_TIMEZONE } from './timezone.js';
import { dateKeyInZone } from './timeAnomalies.js';
import { fmtDay } from './humanDates.js';
import { riderLang, riderTime, type RiderLang } from './transportRider.js';

/**
 * The "didn't run" sweep (transport upgrade 2026-10-28).
 *
 * A run only leaves when its driver taps Start. One that never did used to
 * sit PLANNED for ever: the driver's home said "Planned" for yesterday's
 * runs, the rides table said its riders were "On a van", and the ops board
 * counted a van that never moved. Every 15 minutes this closes them:
 *
 *   which   PLANNED, never started, and NOT_RUN_AFTER_MINUTES (3 h) past
 *           its departure — never sooner. (A "day already over" rule closed a
 *           Chicago 11:30 PM run at midnight New York, before it could leave:
 *           a run's date is its site's, and the hour is what matters.)
 *   run     CANCELLED, stamped autoClosedAt, the note "Didn't run — the van
 *           never started" (isNotRun in lib/transportConflicts tells it from
 *           a run the desk cancelled)
 *   rides   its REQUESTED / SCHEDULED riders CANCELLED, "The van didn't
 *           run", charge 0 — a ride that never happened is never charged
 *   people  the desk hears once per run; each rider once, in their
 *           language ("Your 5:15 AM ride didn't run — you won't be charged")
 *
 * Idempotent: the run is claimed PLANNED → CANCELLED in one guarded write,
 * so a second sweep (or a second replica) finds nothing to do and nobody
 * hears twice.
 */

type Db = PrismaClient;

export const NOT_RUN_AFTER_MINUTES = 180;
export const NOT_RUN_NOTE = "Didn't run — the van never started";
export const NOT_RUN_RIDE_REASON = "The van didn't run";

const RIDER_WORDS: Record<RiderLang, { subject: (time: string) => string; body: string }> = {
  en: { subject: (t) => `Your ${t} ride didn't run — you won't be charged`, body: 'The van never left, so your ride was cancelled and nothing comes out of your pay. Book again in the Ride tab if you still need one.' },
  es: { subject: (t) => `Su viaje de las ${t} no salió — no se le cobrará`, body: 'La camioneta nunca salió, así que su viaje se canceló y no se descuenta nada de su pago. Reserve otra vez en la pestaña Viajes si todavía lo necesita.' },
  tr: { subject: (t) => `Saat ${t} servisiniz yapılmadı — ücret alınmayacak`, body: 'Araç hiç yola çıkmadı; yolculuğunuz iptal edildi ve maaşınızdan hiçbir şey kesilmeyecek. Hâlâ ihtiyacınız varsa Servis sekmesinden yeniden rezervasyon yapın.' },
  ht: { subject: (t) => `Woulib ou a ${t} pa t fèt — yo p ap fè w peye`, body: 'Kamyonèt la pa janm pati, kidonk yo anile woulib ou a epi yo p ap retire anyen nan peman ou. Rezève ankò nan onglè Woulib la si w toujou bezwen youn.' },
  pt: { subject: (t) => `Sua viagem das ${t} não aconteceu — você não será cobrado`, body: 'A van não saiu, então sua viagem foi cancelada e nada será descontado do seu pagamento. Reserve de novo na aba Viagens se ainda precisar.' },
  uk: { subject: (t) => `Ваша поїздка о ${t} не відбулася — плату не стягнуть`, body: 'Мікроавтобус так і не виїхав, тож поїздку скасовано і з вашої зарплати нічого не утримають. Якщо поїздка ще потрібна, забронюйте знову у вкладці «Поїздки».' },
};

export interface NotRunResult {
  closed: number;
  /** Rides cancelled over every run closed. */
  rides: number;
  runIds: string[];
}

export async function closeRunsThatNeverRan(now = new Date(), db: Db = prisma): Promise<NotRunResult> {
  const candidates = await db.rideRun.findMany({
    where: {
      status: 'PLANNED',
      startedAt: null,
      departAt: { lt: new Date(now.getTime() - NOT_RUN_AFTER_MINUTES * 60_000) },
    },
    orderBy: { departAt: 'asc' },
    select: {
      id: true,
      serviceDate: true,
      departAt: true,
      notes: true,
      driverUserId: true,
      van: { select: { name: true } },
      driver: { select: { email: true, associate: { select: { firstName: true, lastName: true } } } },
      // The run's clock is its riders' place's (the board's times).
      rides: { take: 1, select: { location: { select: { timezone: true } } } },
    },
  });
  const out: NotRunResult = { closed: 0, rides: 0, runIds: [] };
  const desk = candidates.length
    ? await db.user.findMany({ where: { ...actsAs('TRANSPORTATION_DIRECTOR'), status: 'ACTIVE', deletedAt: null }, select: { id: true } })
    : [];
  for (const run of candidates) {
    const cancelled = await db.$transaction(async (tx) => {
      // The claim: only the sweep that moves it off PLANNED goes on.
      const claimed = await tx.rideRun.updateMany({
        where: { id: run.id, status: 'PLANNED', startedAt: null },
        data: { status: 'CANCELLED', autoClosedAt: now, notes: [run.notes, NOT_RUN_NOTE].filter(Boolean).join(' · ').slice(0, 500) },
      });
      if (claimed.count === 0) return null;
      const rides = await tx.ride.findMany({
        where: { runId: run.id, status: { in: ['REQUESTED', 'SCHEDULED'] } },
        select: {
          id: true,
          targetAt: true,
          pickupAt: true,
          associateId: true,
          location: { select: { timezone: true } },
          associate: { select: { user: { select: { language: true } } } },
        },
      });
      if (rides.length > 0) {
        await tx.ride.updateMany({
          where: { id: { in: rides.map((r) => r.id) }, status: { in: ['REQUESTED', 'SCHEDULED'] } },
          // Never charged: no fare, no fee, nothing waived (there was nothing to waive).
          data: { status: 'CANCELLED', cancelledAt: now, cancelledById: null, cancelReason: NOT_RUN_RIDE_REASON, chargeCents: 0 },
        });
      }
      return rides;
    });
    if (!cancelled) continue;
    out.closed += 1;
    out.rides += cancelled.length;
    out.runIds.push(run.id);
    enqueueAudit(
      { actorUserId: null, action: 'transport.run_not_run', entityType: 'RideRun', entityId: run.id, metadata: { serviceDate: run.serviceDate, ridesCancelled: cancelled.length } },
      'transportNotRun',
    );
    for (const r of cancelled) {
      const lang = riderLang(r.associate.user?.language);
      const words = RIDER_WORDS[lang];
      void trackNotificationWork(
        notifyAssociate(r.associateId, {
          subject: words.subject(riderTime(r.pickupAt ?? r.targetAt, r.location.timezone, lang)),
          body: words.body,
          category: 'transport',
          linkUrl: '/rides',
        }),
      );
    }
    const driver = run.driver.associate ? `${run.driver.associate.firstName} ${run.driver.associate.lastName}` : run.driver.email;
    const zone = run.rides[0]?.location.timezone ?? DEFAULT_TIMEZONE;
    const when = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit' }).format(run.departAt);
    const day = run.serviceDate === dateKeyInZone(now, zone) ? '' : ` on ${fmtDay(run.serviceDate, { weekday: true })}`;
    for (const u of desk) {
      void trackNotificationWork(
        notifyUser(u.id, {
          subject: `${run.van.name}'s ${when} run didn't run`,
          body:
            `${driver} never started it${day}, so it was closed.` +
            (cancelled.length > 0 ? ` Its ${cancelled.length === 1 ? 'rider was' : `${cancelled.length} riders were`} told the ride is off — nobody was charged.` : ' Nobody was on it.'),
          category: 'transport',
          linkUrl: `/transport?date=${run.serviceDate}`,
        }),
      );
      emitLiveEvent(u.id, 'transport');
    }
  }
  return out;
}

let timer: NodeJS.Timeout | null = null;
const SWEEP_EVERY_MS = 15 * 60_000;

/** Every 15 minutes: a planned run that never left is closed and its riders told (per tenant, transportation on). */
export function startNotRunSweepCron(): void {
  if (timer) return;
  if (process.env.NODE_ENV === 'test') return;
  const tick = () => {
    void tenantJob('transportNotRun', () => closeRunsThatNeverRan(), { module: 'transportation' })().catch((err) =>
      console.error('[alto-people/api] didn\'t-run sweep failed:', err),
    );
  };
  tick();
  timer = setInterval(tick, SWEEP_EVERY_MS);
  timer.unref();
}
