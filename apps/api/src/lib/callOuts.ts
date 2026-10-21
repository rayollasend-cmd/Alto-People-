import { Prisma, type CallOutChannel, type CallOutReason, type PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { enqueueAudit } from './audit.js';
import { recordCallOutAttendance } from './attendance.js';
import { runCoverFlow, type CoverStep } from './coverShift.js';
import { notifyAssociate, notifyClientSupervisors, trackNotificationWork } from './notify.js';
import { DEFAULT_TIMEZONE } from './timezone.js';

/**
 * Call-outs, handled. A worker says they can't make a shift — on WhatsApp,
 * by text, from the shift card in the app, or by phone — and the rest
 * happens on its own:
 *
 *   1. the absence is recorded on the shift: reason, channel, how much
 *      notice (a call-out inside LATE_CALL_OUT_MINUTES is flagged late);
 *   2. the attendance policy is applied (lib/attendance: a CALL_OUT is worth
 *      its points; bereavement, jury duty and sick time the worker has
 *      accrued are excused). Never discipline — a person decides that;
 *   3. cover starts at once (lib/coverShift: post → bench → agent);
 *   4. the shift's leads hear who called out and how cover is going;
 *   5. the worker is told, in their language.
 *
 * One call-out per (shift, worker): a second text about the same shift is
 * a no-op. On WhatsApp and SMS the first message asks for a YES first —
 * a typo never releases a shift — and the call-out waits as PENDING for
 * PENDING_MINUTES.
 */

type Db = PrismaClient;

export const LATE_CALL_OUT_MINUTES = 120;
export const PENDING_MINUTES = 15;
/** How far ahead a worker can call out from their phone without naming a shift. */
const NEXT_SHIFT_HORIZON_MS = 36 * 3_600_000;
/** Reasons the policy always excuses. Sick is excused when the worker has the sick time accrued. */
const EXCUSED_REASONS: ReadonlySet<CallOutReason> = new Set(['BEREAVEMENT', 'JURY_DUTY']);

/* ----- Words --------------------------------------------------------------- */

export type CallOutLang = 'en' | 'es' | 'tr' | 'ht' | 'pt' | 'uk';
export const toCallOutLang = (v: string | null | undefined): CallOutLang =>
  v === 'es' || v === 'tr' || v === 'ht' || v === 'pt' || v === 'uk' ? v : 'en';

const LOCALES: Record<CallOutLang, string> = { en: 'en-US', es: 'es-US', tr: 'tr-TR', ht: 'fr-HT', pt: 'pt-BR', uk: 'uk-UA' };

export function whenLabel(d: Date, tz: string, lang: CallOutLang): string {
  return new Intl.DateTimeFormat(LOCALES[lang], { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d);
}

/** Every message a worker hears about a call-out, in their language. */
export const CALL_OUT_TEXT = {
  ask: (l: CallOutLang, place: string, when: string) =>
    ({
      en: `Call out of your shift at ${place}, ${when}? Reply YES to confirm or NO to keep it.`,
      es: `¿Avisas que no irás a tu turno en ${place}, ${when}? Responde SÍ para confirmar o NO para mantenerlo.`,
      tr: `${place}, ${when} vardiyana gelemeyeceğini bildirmek istiyor musun? Onaylamak için EVET, vardiyayı tutmak için HAYIR yaz.`,
      ht: `Ou vle di ou p ap ka vini nan chif ou nan ${place}, ${when}? Reponn WI pou konfime oswa NON pou kenbe l.`,
      pt: `Avisar que não vai ao seu turno em ${place}, ${when}? Responda SIM para confirmar ou NÃO para manter.`,
      uk: `Повідомити, що не вийдете на зміну в ${place}, ${when}? Відповідайте ТАК, щоб підтвердити, або НІ, щоб залишити зміну.`,
    })[l],
  confirmed: (l: CallOutLang, place: string, when: string) =>
    ({
      en: `Got it — you're called out of ${place}, ${when}. Your lead has been told and we're finding cover. Feel better soon.`,
      es: `Listo: avisamos que no irás a ${place}, ${when}. Tu líder ya lo sabe y estamos buscando quien te cubra.`,
      tr: `Tamam — ${place}, ${when} vardiyan için yokluğun kaydedildi. Liderine haber verildi, yerine birini arıyoruz.`,
      ht: `Dakò — nou note ou p ap vini nan ${place}, ${when}. Nou di lidè ou sa e n ap chèche yon moun pou ranplase w.`,
      pt: `Pronto — registramos que você não vai a ${place}, ${when}. Seu líder foi avisado e estamos buscando cobertura.`,
      uk: `Готово — ми зафіксували, що вас не буде в ${place}, ${when}. Керівника повідомлено, шукаємо заміну.`,
    })[l],
  kept: (l: CallOutLang, when: string) =>
    ({
      en: `OK — you're still on for ${when}.`,
      es: `De acuerdo, sigues en tu turno de ${when}.`,
      tr: `Tamam — ${when} vardiyan duruyor.`,
      ht: `Dakò — ou toujou nan chif ${when} la.`,
      pt: `Tudo bem — você continua no turno de ${when}.`,
      uk: `Добре — зміна ${when} залишається за вами.`,
    })[l],
  noShift: (l: CallOutLang) =>
    ({
      en: `I don't see a shift coming up for you in the next day and a half. If that's wrong, tell your lead.`,
      es: `No veo ningún turno tuyo en el próximo día y medio. Si es un error, avisa a tu líder.`,
      tr: `Önümüzdeki bir buçuk günde sana ait bir vardiya görmüyorum. Yanlışsa liderine söyle.`,
      ht: `Mwen pa wè okenn chif pou ou nan pwochen jou edmi an. Si se pa sa, di lidè ou.`,
      pt: `Não vejo nenhum turno seu no próximo dia e meio. Se estiver errado, avise seu líder.`,
      uk: `Я не бачу ваших змін протягом наступних півтори доби. Якщо це помилка, скажіть керівнику.`,
    })[l],
  already: (l: CallOutLang, when: string) =>
    ({
      en: `You're already called out of ${when} — nothing else to do.`,
      es: `Ya avisaste que no irás a ${when}; no tienes que hacer nada más.`,
      tr: `${when} için zaten haber verdin — başka bir şey yapmana gerek yok.`,
      ht: `Ou deja di ou p ap vini ${when} — pa gen anyen ankò pou fè.`,
      pt: `Você já avisou que não vai em ${when} — não precisa fazer mais nada.`,
      uk: `Ви вже повідомили про ${when} — більше нічого робити не потрібно.`,
    })[l],
};

/* ----- Recognising a call-out in a message ------------------------------- */

const CALL_OUT_PATTERNS: RegExp[] = [
  /\b(call(ing)?\s*out|callout|can'?t\s+(make|come|work)|cannot\s+(make|come|work)|won'?t\s+(make|be\s+(in|there))|not\s+coming|i'?m\s+sick|feeling\s+sick|out\s+sick)\b/i,
  /\b(no\s+puedo\s+(ir|trabajar|llegar)|no\s+voy\s+a\s+(ir|poder)|estoy\s+enferm[oa])\b/i,
  /\b(gelemeyece(ğim|gim)|gelemiyorum|hastay[ıi]m)\b/i,
  /\b(mwen\s+p(a|ap)\s+ka\s+vini|mwen\s+malad)\b/i,
  /\b(n[ãa]o\s+vou\s+(conseguir|poder)|n[ãa]o\s+posso\s+ir|estou\s+doente)\b/i,
  /(не\s+зможу\s+(прийти|вийти)|я\s+захвор)/i,
];

export function detectCallOut(text: string): { reason: CallOutReason } | null {
  if (!CALL_OUT_PATTERNS.some((re) => re.test(text))) return null;
  return { reason: reasonFromText(text) };
}

export function reasonFromText(text: string): CallOutReason {
  const t = text.toLowerCase();
  if (/(funeral|passed\s+away|bereave|funeraria|velorio|cenaze|antèman|falec|похорон)/.test(t)) return 'BEREAVEMENT';
  if (/(jury|jurado|jüri|jiri|júri|присяжн)/.test(t)) return 'JURY_DUTY';
  if (/(car|ride|bus|van|transport|carro|auto|coche|araba|otobüs|machin|ônibus|машин|автобус)/.test(t)) return 'TRANSPORT';
  if (/(kid|child|baby|family|daughter|son|mom|dad|hijo|hija|familia|çocu|aile|pitit|fanmi|filh|famíl|дит|сім)/.test(t)) return 'FAMILY';
  if (/(emergenc|urgen|acil|ijans|emergên|термінов)/.test(t)) return 'EMERGENCY';
  if (/(sick|ill|fever|flu|enferm|hasta|malad|doente|хвор|захвор)/.test(t)) return 'SICK';
  return 'OTHER';
}

/* ----- The shift they mean ------------------------------------------------ */

export const CALL_OUT_SHIFT_SELECT = {
  id: true,
  clientId: true,
  locationId: true,
  status: true,
  assignedAssociateId: true,
  publishedAt: true,
  startsAt: true,
  endsAt: true,
  position: true,
  notes: true,
  locationRel: { select: { name: true, timezone: true } },
  client: { select: { name: true } },
} satisfies Prisma.ShiftSelect;

export type CallOutShift = Prisma.ShiftGetPayload<{ select: typeof CALL_OUT_SHIFT_SELECT }>;

/** Their next assigned shift that hasn't started, inside the horizon. */
export async function nextCallableShift(db: Db, associateId: string, now = new Date()): Promise<CallOutShift | null> {
  return db.shift.findFirst({
    where: { assignedAssociateId: associateId, status: 'ASSIGNED', startsAt: { gt: now, lte: new Date(now.getTime() + NEXT_SHIFT_HORIZON_MS) } },
    orderBy: { startsAt: 'asc' },
    select: CALL_OUT_SHIFT_SELECT,
  });
}

export const placeOf = (s: CallOutShift) => s.locationRel?.name ?? s.client?.name ?? s.position;
export const zoneOf = (s: CallOutShift) => s.locationRel?.timezone ?? DEFAULT_TIMEZONE;

/* ----- Recording, confirming, cancelling --------------------------------- */

export class CallOutError extends Error {
  constructor(
    public code: 'shift_not_found' | 'not_your_shift' | 'shift_started' | 'shift_closed',
    message: string,
  ) {
    super(message);
  }
}

export interface CallOutResult {
  outcome: 'confirmed' | 'pending' | 'duplicate';
  callOutId: string;
  shift: CallOutShift;
  steps: CoverStep[] | null;
}

/**
 * Record a call-out. `confirm: false` (WhatsApp, SMS) leaves it PENDING
 * until the worker's YES; anything else applies it at once.
 */
export async function recordCallOut(
  input: {
    associateId: string;
    shiftId: string;
    channel: CallOutChannel;
    reason: CallOutReason;
    note?: string | null;
    recordingUrl?: string | null;
    createdById?: string | null;
    confirm: boolean;
    now?: Date;
  },
  db: Db = defaultPrisma,
): Promise<CallOutResult> {
  const now = input.now ?? new Date();
  const shift = await db.shift.findUnique({ where: { id: input.shiftId }, select: CALL_OUT_SHIFT_SELECT });
  if (!shift) throw new CallOutError('shift_not_found', 'Shift not found.');

  const existing = await db.callOut.findUnique({ where: { shiftId_associateId: { shiftId: shift.id, associateId: input.associateId } } });
  if (existing?.status === 'CONFIRMED') return { outcome: 'duplicate', callOutId: existing.id, shift, steps: null };

  if (shift.assignedAssociateId !== input.associateId) throw new CallOutError('not_your_shift', 'That shift isn’t assigned to them.');
  if (shift.status === 'CANCELLED' || shift.status === 'COMPLETED') throw new CallOutError('shift_closed', 'That shift is closed.');
  if (shift.startsAt.getTime() <= now.getTime()) throw new CallOutError('shift_started', 'That shift has already started — tell the lead directly.');

  const minutesBeforeStart = Math.max(0, Math.round((shift.startsAt.getTime() - now.getTime()) / 60_000));
  const data = {
    channel: input.channel,
    reason: input.reason,
    note: input.note?.slice(0, 1000) ?? null,
    recordingUrl: input.recordingUrl ?? null,
    minutesBeforeStart,
    late: minutesBeforeStart < LATE_CALL_OUT_MINUTES,
    createdById: input.createdById ?? null,
    clientId: shift.clientId,
    locationId: shift.locationId,
  };
  let id: string;
  if (existing) {
    // A PENDING (or CANCELLED) ask about the same shift: this is the same call-out, re-asked.
    const row = await db.callOut.update({ where: { id: existing.id }, data: { ...data, status: 'PENDING', createdAt: existing.status === 'CANCELLED' ? now : existing.createdAt } });
    id = row.id;
  } else {
    try {
      const row = await db.callOut.create({ data: { ...data, shiftId: shift.id, associateId: input.associateId, status: 'PENDING' } });
      id = row.id;
    } catch (err) {
      // Two messages racing: the unique (shift, worker) row says one already exists.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const row = await db.callOut.findUniqueOrThrow({ where: { shiftId_associateId: { shiftId: shift.id, associateId: input.associateId } } });
        if (row.status === 'CONFIRMED') return { outcome: 'duplicate', callOutId: row.id, shift, steps: null };
        id = row.id;
      } else throw err;
    }
  }
  if (!input.confirm) return { outcome: 'pending', callOutId: id, shift, steps: null };
  const confirmed = await confirmCallOut(id, now, db);
  return confirmed ?? { outcome: 'duplicate', callOutId: id, shift, steps: null };
}

/** The worker's open ask, if they sent one in the last PENDING_MINUTES. */
export async function pendingCallOutFor(db: Db, associateId: string, now = new Date()) {
  return db.callOut.findFirst({
    where: { associateId, status: 'PENDING', createdAt: { gte: new Date(now.getTime() - PENDING_MINUTES * 60_000) } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, shift: { select: CALL_OUT_SHIFT_SELECT } },
  });
}

export async function cancelCallOut(db: Db, id: string): Promise<void> {
  await db.callOut.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'CANCELLED' } });
}

/**
 * Apply a call-out: claim it (PENDING → CONFIRMED, once), then the
 * attendance policy, the cover flow, the leads and the worker. Returns
 * null when someone else already confirmed it.
 */
export async function confirmCallOut(id: string, now: Date = new Date(), db: Db = defaultPrisma): Promise<CallOutResult | null> {
  const claimed = await db.callOut.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'CONFIRMED', confirmedAt: now } });
  if (claimed.count === 0) return null;
  const row = await db.callOut.findUniqueOrThrow({
    where: { id },
    include: { shift: { select: CALL_OUT_SHIFT_SELECT }, associate: { select: { id: true, firstName: true, lastName: true } } },
  });
  const shift = row.shift;
  const name = `${row.associate.firstName} ${row.associate.lastName}`.trim();

  // The worker may have been taken off the shift between ask and YES.
  if (shift.assignedAssociateId !== row.associateId || shift.startsAt.getTime() <= now.getTime()) {
    await db.callOut.update({ where: { id }, data: { status: 'CANCELLED' } });
    return null;
  }

  // The Workforce agent's open "are you coming?" is answered too: they're not.
  await db.attendanceConfirmation.updateMany({ where: { shiftId: shift.id, associateId: row.associateId, answer: null }, data: { answer: 'NO', answeredAt: now, answeredVia: 'CALL_OUT' } });

  // 2. The attendance policy: excused reasons, and sick time they have.
  const excusedWhy = await excuseFor(db, row.reason, row.associateId, shift);
  await recordCallOutAttendance(db, {
    associateId: row.associateId,
    associateName: name,
    shiftId: shift.id,
    clientId: shift.clientId,
    occurredOn: shift.startsAt,
    excusedWhy,
    note: `${row.late ? 'Late call-out' : 'Call-out'} by ${row.channel.toLowerCase()} (${row.reason.toLowerCase().replace(/_/g, ' ')})${row.note ? `: ${row.note}` : ''}`,
  });

  // 3. Cover, at once.
  const { steps } = await runCoverFlow(db, shift, { reason: `call-out (${row.reason.toLowerCase().replace(/_/g, ' ')})`, now });
  await db.callOut.update({ where: { id }, data: { excused: !!excusedWhy, excusedWhy, coverSteps: steps as unknown as Prisma.InputJsonValue } });

  // 4. The leads on that floor, with the cover already moving.
  const tz = zoneOf(shift);
  const when = whenLabel(shift.startsAt, tz, 'en');
  const reasonWords = row.reason.toLowerCase().replace(/_/g, ' ');
  void trackNotificationWork(
    notifyClientSupervisors(shift.clientId, {
      subject: `${row.late ? 'Late call-out' : 'Call-out'}: ${name} — ${shift.position}, ${when}`,
      body:
        `${name} can't make ${shift.position} at ${placeOf(shift)}, ${when} (${reasonWords}${row.late ? `, ${row.minutesBeforeStart} minutes' notice` : ''}). ` +
        `Cover is under way: ${steps.map((s) => s.detail).join(' ')}`,
      category: 'scheduling',
      linkUrl: `/call-outs?callout=${row.id}`,
      at: { locationId: shift.locationId, startsAt: shift.startsAt },
      aboutAssociateId: row.associateId,
    }),
  );

  // 5. The worker, in their language.
  const user = await db.user.findFirst({ where: { associateId: row.associateId, deletedAt: null }, select: { language: true } });
  const lang = toCallOutLang(user?.language);
  void trackNotificationWork(
    notifyAssociate(row.associateId, {
      subject: CALL_OUT_TEXT.confirmed(lang, placeOf(shift), whenLabel(shift.startsAt, tz, lang)).split(' — ')[0] ?? 'Call-out recorded',
      body: CALL_OUT_TEXT.confirmed(lang, placeOf(shift), whenLabel(shift.startsAt, tz, lang)),
      category: 'scheduling',
      linkUrl: '/scheduling',
    }),
  );

  enqueueAudit(
    {
      actorUserId: row.createdById,
      clientId: shift.clientId,
      action: 'shift.call_out',
      entityType: 'Shift',
      entityId: shift.id,
      metadata: { callOutId: id, associateId: row.associateId, channel: row.channel, reason: row.reason, late: row.late, excused: !!excusedWhy, steps: steps.map((s) => `${s.key}:${s.status}`) },
    },
    'callOuts',
  );
  return { outcome: 'confirmed', callOutId: id, shift, steps };
}

/** Why the policy excuses this call-out, or null when it counts. */
async function excuseFor(db: Db, reason: CallOutReason, associateId: string, shift: CallOutShift): Promise<string | null> {
  if (EXCUSED_REASONS.has(reason)) return reason === 'BEREAVEMENT' ? 'Bereavement — excused by policy' : 'Jury duty — excused by policy';
  if (reason === 'SICK') {
    // Accrued sick time is protected leave in most states: using it can't count against them.
    const minutes = Math.max(0, Math.round(((shift.endsAt?.getTime() ?? shift.startsAt.getTime()) - shift.startsAt.getTime()) / 60_000));
    const bal = await db.timeOffBalance.findFirst({ where: { associateId, category: 'SICK' }, select: { balanceMinutes: true } });
    if (bal && bal.balanceMinutes > 0 && bal.balanceMinutes >= Math.min(minutes, 8 * 60)) return 'Sick — covered by accrued sick time';
  }
  return null;
}

/* ----- Reading: today's call-outs and how cover is going ----------------- */

export type CoverState = 'covered' | 'looking' | 'uncovered';

export function coverStateOf(row: { associateId: string; shift: { assignedAssociateId: string | null; startsAt: Date; status: string } }, now = new Date()): CoverState {
  const s = row.shift;
  if (s.assignedAssociateId && s.assignedAssociateId !== row.associateId) return 'covered';
  if (s.status === 'CANCELLED') return 'covered';
  return s.startsAt.getTime() <= now.getTime() ? 'uncovered' : 'looking';
}
