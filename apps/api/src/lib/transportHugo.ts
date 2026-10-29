import type { Prisma, PrismaClient } from '@prisma/client';
import { companyWorkweek } from './timeAnomalies.js';
import type { WaLang } from './whatsappContent.js';

/**
 * Floor walk 19 — what the assistant answers a DRIVER (lib/hugo's driver
 * audience). A driver used to be offered the rider's "What time is my
 * ride?"; these are their own: the next run, who's on it, how to report
 * a van that can't run. Records only — the run board the driver already
 * sees, in a sentence.
 */

type Db = Pick<PrismaClient, 'rideRun'>;

const fmt = (d: Date, tz: string, lang: WaLang) =>
  new Intl.DateTimeFormat(lang === 'es' ? 'es-US' : lang === 'tr' ? 'tr-TR' : 'en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(d);

const runSelect = {
  id: true,
  status: true,
  direction: true,
  departAt: true,
  van: { select: { name: true, plate: true } },
  rides: {
    where: { status: { in: ['SCHEDULED', 'BOARDED'] } },
    orderBy: [{ pickupOrder: 'asc' }, { targetAt: 'asc' }],
    select: { status: true, pickupAt: true, stop: { select: { name: true } }, address: true, associate: { select: { firstName: true, lastName: true } }, location: { select: { name: true, timezone: true } } },
  },
} satisfies Prisma.RideRunSelect;

async function nextRun(db: Db, driverUserId: string, now: Date) {
  const active = await db.rideRun.findFirst({ where: { driverUserId, status: 'ACTIVE' }, orderBy: { departAt: 'asc' }, select: runSelect });
  if (active) return active;
  return db.rideRun.findFirst({
    where: { driverUserId, status: 'PLANNED', departAt: { gte: new Date(now.getTime() - 2 * 3_600_000) } },
    orderBy: { departAt: 'asc' },
    select: runSelect,
  });
}

export async function answerDriverNextRun(db: Db, driverUserId: string, lang: WaLang, now = new Date()): Promise<string> {
  const run = await nextRun(db, driverUserId, now);
  if (!run) {
    return lang === 'es' ? 'No tienes ninguna ruta planificada por ahora. Transporte te avisa cuando te asigne una.' : lang === 'tr' ? 'Şu an planlanmış bir rotan yok. Ulaşım bir rota atadığında haber verir.' : 'No run is planned for you right now. Transportation tells you when one is yours.';
  }
  const tz = run.rides[0]?.location.timezone ?? companyWorkweek().timezone;
  const store = run.rides[0]?.location.name ?? '';
  const n = run.rides.length;
  const when = fmt(run.departAt, tz, lang);
  const way = run.direction === 'TO_WORK';
  if (lang === 'es') {
    return run.status === 'ACTIVE'
      ? `Estás en ruta con ${run.van.name}: ${n} pasajero${n === 1 ? '' : 's'}, ${way ? `hacia ${store}` : `a casa desde ${store}`}.`
      : `Tu próxima ruta sale ${when} con ${run.van.name}: ${n} pasajero${n === 1 ? '' : 's'}, ${way ? `hacia ${store}` : `a casa desde ${store}`}.`;
  }
  if (lang === 'tr') {
    return run.status === 'ACTIVE'
      ? `${run.van.name} ile yoldasın: ${n} yolcu, ${way ? `${store} yönüne` : `${store} konumundan eve`}.`
      : `Bir sonraki rotan ${when} ${run.van.name} ile çıkıyor: ${n} yolcu, ${way ? `${store} yönüne` : `${store} konumundan eve`}.`;
  }
  return run.status === 'ACTIVE'
    ? `You're on the road in ${run.van.name}: ${n} rider${n === 1 ? '' : 's'}, ${way ? `to ${store}` : `home from ${store}`}.`
    : `Your next run leaves ${when} in ${run.van.name}: ${n} rider${n === 1 ? '' : 's'}, ${way ? `to ${store}` : `home from ${store}`}.`;
}

export async function answerDriverRiders(db: Db, driverUserId: string, lang: WaLang, now = new Date()): Promise<string> {
  const run = await nextRun(db, driverUserId, now);
  if (!run) return answerDriverNextRun(db, driverUserId, lang, now);
  const tz = run.rides[0]?.location.timezone ?? companyWorkweek().timezone;
  const lines = run.rides.map((r) => {
    const place = run.direction === 'TO_WORK' ? (r.stop?.name ?? r.address ?? '') : r.location.name;
    const at = r.pickupAt ? ` · ${new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(r.pickupAt)}` : '';
    const mark = r.status === 'BOARDED' ? (lang === 'es' ? ' · a bordo' : lang === 'tr' ? ' · araçta' : ' · on board') : '';
    return `• ${r.associate.firstName} ${r.associate.lastName} — ${place}${at}${mark}`;
  });
  const head = lang === 'es' ? `${run.rides.length} en ${run.van.name}:` : lang === 'tr' ? `${run.van.name} üzerinde ${run.rides.length} yolcu:` : `${run.rides.length} on ${run.van.name}:`;
  return [head, ...lines].join('\n');
}

export function answerDriverVanIssue(lang: WaLang): string {
  if (lang === 'es') return 'Toca "Reportar un problema" en tus rutas, describe qué pasa y, si la van no puede circular con seguridad, marca "La van no puede circular": la van queda fuera de servicio, transporte lo ve de inmediato y mueve tus rutas a otra van.';
  if (lang === 'tr') return 'Rotalarında "Sorun bildir"e dokun, ne olduğunu yaz ve araç güvenle gidemiyorsa "Araç güvenle gidemez" seçeneğini işaretle: araç servis dışı kalır, ulaşım hemen görür ve rotalarını başka bir araca taşır.';
  return 'Tap "Report a problem" on your runs, say what\'s wrong, and if the van can\'t run safely tick "Van can\'t run safely": the van is taken off the road, transportation sees it right away and moves your runs to another van.';
}
