import { Prisma, type PrismaClient } from '@prisma/client';
import { moduleOn } from './tenantProfile.js';
import { prisma as defaultPrisma } from '../db.js';
import { nextPaydayFor } from './associatePayday.js';
import { emitLiveEvent } from './liveEvents.js';
import { placedClientIds } from './openShiftEligibility.js';
import { resolveStoreForAssociate, storeSupervisors } from './readyToWork.js';
import { DEFAULT_TIMEZONE, formatDateInZone, formatTimeInZone } from './timezone.js';
import { sendWhatsApp } from './whatsapp.js';
import { logBuiltInAgentAction } from './agents.js';
import { getBrandingSync } from './branding.js';
import { WA_REPLY, toWaLang, type WaLang } from './whatsappContent.js';
import { answerFromWhatsApp } from './attendanceConfirm.js';

/**
 * THE ASSISTANT — three questions, answered from the associate's own data.
 *
 *   "When is payday?"        → their pay schedule (lib/associatePayday)
 *   "What time is my ride?"  → their next seat on a van
 *   "What's my schedule?"    → their next assigned, published shifts
 *
 * Plus STOP / START and a language switch. Anything else is handed to a
 * supervisor at their store as a message in the app, with the question
 * quoted, and the associate is told who has it. Every inbound message is
 * logged as a WhatsAppMessage row, and every answer links back to it.
 *
 * The only key into anyone's data is the phone the message came from,
 * resolved to the one associate who opted in with it — nothing here can
 * be steered to another person's record.
 */

type Db = PrismaClient;

export interface InboundMessage {
  from: string;
  waMessageId: string;
  text: string;
  timestamp?: Date;
}

export type Intent = 'OPT_OUT' | 'OPT_IN' | 'LANGUAGE' | 'WHO' | 'PAYDAY' | 'RIDE' | 'SCHEDULE' | 'HANDOFF' | 'CONFIRM_YES' | 'CONFIRM_NO';

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ı/g, 'i')
    .trim();

const OPT_OUT = /^\s*(stop|baja|dur|unsubscribe|cancelar|salir|parar|iptal)\b/;
const OPT_IN = /^\s*(start|alta|basla|unstop|empezar|activar)\b/;
const LANGS: Array<[RegExp, WaLang]> = [
  [/\b(english|ingles)\b/, 'en'],
  [/\b(espanol|spanish|castellano)\b/, 'es'],
  [/\b(turkce|turkish|turk)\b/, 'tr'],
];
// "Who are you?" in three languages: the answer always says the product and that he is an AI.
const WHO = /\b(who are you|what are you|are you (a |an )?(bot|robot|ai|human|real person|person)|is this a (bot|robot|person)|quien eres|que eres|eres (un|una) (bot|robot|persona|humano|ia)|kimsin|nesin|sen kimsin|bot musun|robot musun|insan misin)\b/;
const PAYDAY = /\b(pay ?day|paid|pay\b|paycheck|paystub|cobr\w*|pago|pagan|sueldo|nomina|maas|odeme|para)\b/;
const RIDE = /\b(ride|van|pick ?up|bus|shuttle|viaje|camioneta|recog\w*|transporte|servis|arac|minibus|ulasim)\b/;
/** A one-word answer to the Workforce agent's "are you coming?" (attendance.confirm), in three languages. */
const YES = /^(yes|y|yeah|yep|si|claro|evet|tamam|ok|okay)[.!s]*$/;
const NO = /^(no|n|nope|hayir|olmaz|yok)[.!s]*$/;

/** YES or NO when the whole message is one; null otherwise (the other intents apply). */
export function detectConfirmAnswer(text: string): 'YES' | 'NO' | null {
  const t = norm(text);
  if (YES.test(t)) return 'YES';
  if (NO.test(t)) return 'NO';
  return null;
}

const SCHEDULE = /\b(schedule|shift|shifts|work|working|hours|horario|turno|turnos|trabajo|vardiya|calis\w*|program|mesai)\b/;

export function detectIntent(text: string): { intent: Intent; lang?: WaLang } {
  const t = norm(text);
  if (OPT_OUT.test(t)) return { intent: 'OPT_OUT' };
  if (OPT_IN.test(t)) return { intent: 'OPT_IN' };
  for (const [re, lang] of LANGS) if (re.test(t) && t.split(/\s+/).length <= 4) return { intent: 'LANGUAGE', lang };
  if (WHO.test(t)) return { intent: 'WHO' };
  if (PAYDAY.test(t)) return { intent: 'PAYDAY' };
  if (RIDE.test(t)) return { intent: 'RIDE' };
  if (SCHEDULE.test(t)) return { intent: 'SCHEDULE' };
  return { intent: 'HANDOFF' };
}

const when = (d: Date, tz: string, lang: WaLang) => {
  const locale = lang === 'es' ? 'es-US' : lang === 'tr' ? 'tr-TR' : 'en-US';
  return new Intl.DateTimeFormat(locale, { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d);
};
const longDay = (ymd: string, lang: WaLang) => {
  const locale = lang === 'es' ? 'es-US' : lang === 'tr' ? 'tr-TR' : 'en-US';
  return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(`${ymd}T12:00:00Z`));
};

async function answerPayday(associateId: string, lang: WaLang, now: Date): Promise<string> {
  const p = await nextPaydayFor(associateId, now);
  if (!p) return WA_REPLY.noPayday(lang);
  return WA_REPLY.payday(lang, longDay(p.payDate, lang), `${longDay(p.periodStart, lang)} – ${longDay(p.periodEnd, lang)}`);
}

async function answerRide(db: Db, associateId: string, lang: WaLang, now: Date): Promise<string> {
  const ride = await db.ride.findFirst({
    where: { associateId, status: { in: ['REQUESTED', 'SCHEDULED', 'BOARDED'] }, targetAt: { gte: new Date(now.getTime() - 2 * 3_600_000) } },
    orderBy: { targetAt: 'asc' },
    select: {
      targetAt: true,
      pickupAt: true,
      direction: true,
      address: true,
      stop: { select: { name: true } },
      location: { select: { name: true, timezone: true } },
      run: { select: { van: { select: { name: true } } } },
    },
  });
  if (!ride) return WA_REPLY.noRide(lang);
  const tz = ride.location.timezone ?? DEFAULT_TIMEZONE;
  const at = ride.pickupAt ?? ride.targetAt;
  const where = ride.direction === 'TO_WORK' ? (ride.stop?.name ?? ride.address ?? '—') : ride.location.name;
  return WA_REPLY.ride(lang, when(at, tz, lang), where, ride.run?.van.name ?? null);
}

async function answerSchedule(db: Db, associateId: string, lang: WaLang, now: Date): Promise<string> {
  const shifts = await db.shift.findMany({
    where: { assignedAssociateId: associateId, status: 'ASSIGNED', publishedAt: { not: null }, endsAt: { gte: now } },
    orderBy: { startsAt: 'asc' },
    take: 3,
    select: { position: true, startsAt: true, endsAt: true, client: { select: { name: true } }, locationRel: { select: { name: true, timezone: true } } },
  });
  if (shifts.length === 0) return WA_REPLY.noShifts(lang);
  const lines = shifts.map((s) => {
    const tz = s.locationRel?.timezone ?? DEFAULT_TIMEZONE;
    return `• ${formatDateInZone(s.startsAt, tz)} ${formatTimeInZone(s.startsAt, tz)}–${formatTimeInZone(s.endsAt, tz)} · ${s.position} · ${s.locationRel?.name ?? s.client?.name ?? ''}`;
  });
  return WA_REPLY.schedule(lang, lines);
}

/**
 * Hand the question to a supervisor at the associate's store: a direct
 * thread in the app (reused when one exists) carrying the question, so
 * the answer comes back through the inbox the supervisor already works.
 */
async function handoff(db: Db, associateId: string, userId: string | null, text: string, now: Date): Promise<{ conversationId: string | null; who: string | null }> {
  if (!userId) return { conversationId: null, who: null };
  const clientIds = await placedClientIds(associateId, db);
  const clientId = clientIds[0];
  if (!clientId) return { conversationId: null, who: null };
  const store = await resolveStoreForAssociate(db, associateId, clientId);
  const { supervisors } = await storeSupervisors(db, clientId, store?.id ?? null);
  const lead = supervisors[0];
  if (!lead) return { conversationId: null, who: null };
  const existing = await db.conversation.findFirst({
    where: {
      kind: 'DIRECT',
      AND: [{ participants: { some: { userId } } }, { participants: { some: { userId: lead.userId } } }],
    },
    select: { id: true },
  });
  const preview = `WhatsApp: ${text}`.slice(0, 160);
  const conversation =
    existing ??
    (await db.conversation.create({
      data: { kind: 'DIRECT', createdById: userId, participants: { create: [{ userId }, { userId: lead.userId }] } },
      select: { id: true },
    }));
  await db.message.create({ data: { conversationId: conversation.id, senderId: userId, kind: 'TEXT', body: `[WhatsApp] ${text}`.slice(0, 4000) } });
  await db.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: now, lastPreview: preview } });
  emitLiveEvent(lead.userId, 'message');
  return { conversationId: conversation.id, who: lead.name };
}

export interface HandledInbound {
  intent: Intent;
  reply: string | null;
  associateId: string | null;
  duplicate?: boolean;
}

export async function handleInbound(msg: InboundMessage, db: Db = defaultPrisma, now: Date = new Date()): Promise<HandledInbound> {
  const phone = msg.from.replace(/\D/g, '');
  const consent = await db.whatsAppConsent.findFirst({ where: { phone }, orderBy: { updatedAt: 'desc' } });
  const associateId = consent?.associateId ?? null;
  // Log first — a replayed webhook is the unique index saying no.
  try {
    await db.whatsAppMessage.create({
      data: { associateId, phone, direction: 'INBOUND', kind: 'QUESTION', waMessageId: msg.waMessageId, body: msg.text.slice(0, 4000), status: 'RECEIVED', statusAt: now },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return { intent: 'HANDOFF', reply: null, associateId, duplicate: true };
    throw err;
  }
  const inbound = await db.whatsAppMessage.findUnique({ where: { waMessageId: msg.waMessageId }, select: { id: true } });
  const replyTo = inbound?.id ?? null;

  if (!consent || !associateId) {
    // Unknown number: say how to link it, once, and keep no data.
    return { intent: 'HANDOFF', reply: null, associateId: null };
  }
  await db.whatsAppConsent.update({ where: { associateId }, data: { lastInboundAt: now } });
  const user = await db.user.findFirst({ where: { associateId, deletedAt: null }, select: { id: true, language: true } });
  let lang = toWaLang(user?.language);
  const { intent, lang: wanted } = detectIntent(msg.text);

  const say = async (text: string, kind: 'ANSWER' | 'SYSTEM' | 'HANDOFF' = 'ANSWER', conversationId: string | null = null) => {
    const sent = await sendWhatsApp(db, { associateId, text: () => text, lang, category: 'assistant', kind, replyToId: replyTo }, now);
    if (sent && conversationId) await db.whatsAppMessage.update({ where: { id: sent.id }, data: { conversationId } });
    // Brief 1D-2: the assistant is a registered agent; every reply is on its trail.
    await logBuiltInAgentAction(db, 'whatsapp-assistant', { action: 'agent.whatsapp.reply', entityType: 'WhatsAppMessage', entityId: sent?.id ?? replyTo ?? 'unsent', metadata: { intent, kind, lang, associateId } });
    return text;
  };

  // A bare YES/NO answers the Workforce agent's open ask, when there is one; otherwise it falls through.
  const yn = detectConfirmAnswer(msg.text);
  if (yn) {
    const answered = await answerFromWhatsApp(db, associateId, yn, now);
    if (answered) {
      const tz = answered.shift.timezone ?? DEFAULT_TIMEZONE;
      const when = `${answered.shift.position}, ${formatDateInZone(answered.shift.startsAt, tz)} ${formatTimeInZone(answered.shift.startsAt, tz)}`;
      const intentYn: Intent = yn === 'YES' ? 'CONFIRM_YES' : 'CONFIRM_NO';
      return { intent: intentYn, reply: await say(yn === 'YES' ? WA_REPLY.confirmedYes(lang, when) : WA_REPLY.confirmedNo(lang, when), 'SYSTEM'), associateId };
    }
  }

  // Brief 2-1b: a capability that depends on a disabled module is not offered.
  const effective: Intent = intent === 'RIDE' && !(await moduleOn('transportation')) ? 'HANDOFF' : intent;
  switch (effective) {
    case 'OPT_OUT': {
      await db.whatsAppConsent.update({ where: { associateId }, data: { status: 'OPTED_OUT', optedOutAt: now, source: 'reply' } });
      // Their last word still gets its one confirmation.
      const text = WA_REPLY.optedOut(lang);
      await db.whatsAppConsent.update({ where: { associateId }, data: { status: 'OPTED_IN' } });
      await say(text, 'SYSTEM');
      await db.whatsAppConsent.update({ where: { associateId }, data: { status: 'OPTED_OUT' } });
      return { intent, reply: text, associateId };
    }
    case 'OPT_IN': {
      await db.whatsAppConsent.update({ where: { associateId }, data: { status: 'OPTED_IN', optedInAt: now, optedOutAt: null, source: 'reply' } });
      return { intent, reply: await say(WA_REPLY.optedIn(lang, getBrandingSync().assistantName), 'SYSTEM'), associateId };
    }
    case 'WHO':
      return { intent, reply: await say(WA_REPLY.whoAmI(lang, getBrandingSync().assistantName)), associateId };
    case 'LANGUAGE': {
      lang = wanted ?? lang;
      if (user) await db.user.update({ where: { id: user.id }, data: { language: lang } });
      return { intent, reply: await say(WA_REPLY.languageSet(lang), 'SYSTEM'), associateId };
    }
    case 'PAYDAY':
      return { intent, reply: await say(await answerPayday(associateId, lang, now)), associateId };
    case 'RIDE':
      return { intent, reply: await say(await answerRide(db, associateId, lang, now)), associateId };
    case 'SCHEDULE':
      return { intent, reply: await say(await answerSchedule(db, associateId, lang, now)), associateId };
    default: {
      const h = await handoff(db, associateId, user?.id ?? null, msg.text, now);
      return { intent: 'HANDOFF', reply: await say(WA_REPLY.handoff(lang, h.who), 'HANDOFF', h.conversationId), associateId };
    }
  }
}
