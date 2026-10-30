import { redactSensitiveNumbers } from '@alto-people/shared';
import { Prisma, type PrismaClient } from '@prisma/client';
import { loadTenantProfile } from './tenantProfile.js';
import { detectConfirmAnswer, detectHugoIntent, type HugoIntentKey } from './hugo.js';
import { prisma as defaultPrisma } from '../db.js';
import { nextPaydayFor } from './associatePayday.js';
import { emitLiveEvent } from './liveEvents.js';
import { placedClientIds } from './openShiftEligibility.js';
import { resolveStoreForAssociate, storeSupervisors } from './readyToWork.js';
import { formatDateInZone, formatTimeInZone } from './timezone.js';
import { companyWorkweek } from './timeAnomalies.js';
import { sendWhatsApp } from './whatsapp.js';
import { discloserFor } from './agentDisclosure.js';
import { inProcessAgent, logBuiltInAgentAction } from './agents.js';
import { tenantIdForWrite } from './tenant.js';
import { getBrandingSync } from './branding.js';
import { WA_REPLY, toWaLang, type WaLang } from './whatsappContent.js';
import { pendingOffer, startReply, voidOffers } from './hugoWhatsappOffers.js';

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
 *
 * Hugo's brain (lib/hugoWhatsapp, Muse phase 6): after the commands that
 * must stay deterministic (an unknown number, a call-out, the YES/NO to the
 * Workforce agent, STOP, START, a language, "who are you"), a question goes
 * the way the app's do — the registry at once for a plain one about their
 * own records, the model for the rest (their own records as its tools),
 * work to hand over offered with "Reply START" — and the registry answers,
 * exactly as below, whenever the model can't.
 */

type Db = PrismaClient;

export interface InboundMessage {
  from: string;
  waMessageId: string;
  text: string;
  timestamp?: Date;
}

/**
 * Hugo's intents as WhatsApp sees them (lib/hugo: the registry), plus the attendance.confirm answers;
 * MODEL: the model answered (lib/hugoWhatsapp); TASK_START: a START reply took a task offer.
 */
export type Intent = HugoIntentKey | 'CONFIRM_YES' | 'CONFIRM_NO' | 'CALL_OUT' | 'MODEL' | 'TASK_START';

export { detectConfirmAnswer };

/** An associate on WhatsApp, every module on: the registry's precedence (tests and certification read it). */
export function detectIntent(text: string): { intent: Intent; lang?: WaLang } {
  return detectHugoIntent(text, { channel: 'whatsapp', audience: 'associate', moduleOn: () => true, capabilityOn: () => true });
}

const when = (d: Date, tz: string, lang: WaLang) => {
  const locale = lang === 'es' ? 'es-US' : lang === 'tr' ? 'tr-TR' : 'en-US';
  return new Intl.DateTimeFormat(locale, { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d);
};
const longDay = (ymd: string, lang: WaLang) => {
  const locale = lang === 'es' ? 'es-US' : lang === 'tr' ? 'tr-TR' : 'en-US';
  return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(`${ymd}T12:00:00Z`));
};

/**
 * The next payday, or — when the person is on no pay schedule — only that
 * fact (`scheduled: false`). Nothing is sent to anyone here: each channel
 * decides what happens next (WhatsApp passes it on; the app offers to).
 */
export async function answerPayday(associateId: string, lang: WaLang, now: Date): Promise<{ text: string; scheduled: boolean }> {
  const p = await nextPaydayFor(associateId, now);
  if (!p) return { text: WA_REPLY.noPayday(lang), scheduled: false };
  return { text: WA_REPLY.payday(lang, longDay(p.payDate, lang), `${longDay(p.periodStart, lang)} – ${longDay(p.periodEnd, lang)}`), scheduled: true };
}

export async function answerRide(db: Db, associateId: string, lang: WaLang, now: Date): Promise<string> {
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
  const tz = ride.location.timezone ?? companyWorkweek().timezone;
  const at = ride.pickupAt ?? ride.targetAt;
  const where = ride.direction === 'TO_WORK' ? (ride.stop?.name ?? ride.address ?? '—') : ride.location.name;
  return WA_REPLY.ride(lang, when(at, tz, lang), where, ride.run?.van.name ?? null);
}

export async function answerSchedule(db: Db, associateId: string, lang: WaLang, now: Date): Promise<string> {
  const shifts = await db.shift.findMany({
    where: { assignedAssociateId: associateId, status: 'ASSIGNED', publishedAt: { not: null }, endsAt: { gte: now } },
    orderBy: { startsAt: 'asc' },
    take: 3,
    select: { position: true, startsAt: true, endsAt: true, client: { select: { name: true } }, locationRel: { select: { name: true, timezone: true } } },
  });
  if (shifts.length === 0) return WA_REPLY.noShifts(lang);
  const lines = shifts.map((s) => {
    const tz = s.locationRel?.timezone ?? companyWorkweek().timezone;
    return `• ${formatDateInZone(s.startsAt, tz)} ${formatTimeInZone(s.startsAt, tz)}–${formatTimeInZone(s.endsAt, tz)} · ${s.position} · ${s.locationRel?.name ?? s.client?.name ?? ''}`;
  });
  return WA_REPLY.schedule(lang, lines);
}

/**
 * Hand the question to a supervisor at the associate's store: a direct
 * thread in the app (reused when one exists) carrying the question, so
 * the answer comes back through the inbox the supervisor already works.
 */
/** `channel` is the label the thread's first message is tagged with: "WhatsApp", or the tenant's name for the assistant when the question came from the app. */
export async function handoff(db: Db, associateId: string, userId: string | null, text: string, now: Date, channel: string = 'WhatsApp'): Promise<{ conversationId: string | null; who: string | null }> {
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
  const preview = `${channel}: ${text}`.slice(0, 160);
  const conversation =
    existing ??
    (await db.conversation.create({
      data: { kind: 'DIRECT', createdById: userId, participants: { create: [{ userId }, { userId: lead.userId }] } },
      select: { id: true },
    }));
  await db.message.create({ data: { conversationId: conversation.id, senderId: userId, kind: 'TEXT', body: `[${channel}] ${text}`.slice(0, 4000) } });
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

export async function handleInbound(received: InboundMessage, db: Db = defaultPrisma, now: Date = new Date()): Promise<HandledInbound> {
  // An SSN or account number is never stored, answered on or handed off (shared/sensitiveText).
  const msg = { ...received, text: redactSensitiveNumbers(received.text) };
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
  // Brief 2-1b / step 3: an intent whose module is off is not matched at all (the registry filters it).
  const profile = await loadTenantProfile();
  // A family capability Hugo routes to (RENEW → document.chase) is offered only while it runs.
  // Loaded on use, like attendanceConfirm below: agentCapabilities must stay out of this module's import graph.
  const { runningCapabilityKeys } = await import('./agentCapabilities.js');
  const running = await runningCapabilityKeys(db, tenantIdForWrite());
  const { intent, lang: wanted } = detectHugoIntent(msg.text, { channel: 'whatsapp', audience: 'associate', moduleOn: (m) => profile.modules[m], capabilityOn: (k) => running.has(k) });

  // AI disclosure (lib/agentDisclosure): an answer or a handoff ends by saying the assistant is an AI
  // agent and who answers for it (its registry record's owner). A SYSTEM reply — the opt-in with its
  // self-introduction, the opt-out, the language switch, a YES/NO acknowledgement — echoes the
  // person's own command and carries no line.
  const tenantId = tenantIdForWrite();
  const me = await inProcessAgent(db, 'whatsapp-assistant', tenantId);
  const disclose = await discloserFor(db, { workerId: me?.workerId ?? '', name: getBrandingSync(tenantId).assistantName, ownerUserId: me?.ownerUserId ?? null, tenantId }, lang);
  // `trail` adds to the reply's line on the agent trail (Hugo's brain: the intent MODEL and the tier); `lastSent`: it reached WhatsApp.
  let lastSent = false;
  const say = async (text: string, kind: 'ANSWER' | 'SYSTEM' | 'HANDOFF' = 'ANSWER', conversationId: string | null = null, trail: Record<string, unknown> = {}) => {
    const out = kind === 'SYSTEM' ? text : disclose(text, lang);
    const sent = await sendWhatsApp(db, { associateId, text: () => out, lang, category: 'assistant', kind, replyToId: replyTo }, now);
    lastSent = sent?.status === 'SENT';
    if (sent && conversationId) await db.whatsAppMessage.update({ where: { id: sent.id }, data: { conversationId } });
    // Brief 1D-2: the assistant is a registered agent; every reply is on its trail.
    await logBuiltInAgentAction(db, 'whatsapp-assistant', { action: 'agent.whatsapp.reply', entityType: 'WhatsAppMessage', entityId: sent?.id ?? replyTo ?? 'unsent', metadata: { intent, kind, lang, associateId, ...trail } });
    return out;
  };

  // A call-out — "I can't make it", or the YES/NO to our "call out of …?" — before anything else:
  // an open call-out ask is more recent than the Workforce agent's "are you coming?".
  // Loaded on use: callOuts reaches the cover flow and the agents, which must stay out of this module's graph.
  const { handleCallOutText } = await import('./callOutChannels.js');
  const callOut = await handleCallOutText({ associateId, text: msg.text, channel: 'WHATSAPP', language: user?.language ?? null, now }, db);
  if (callOut) return { intent: 'CALL_OUT', reply: await say(callOut.reply, 'SYSTEM'), associateId };

  // A bare YES/NO answers the Workforce agent's open ask, when there is one; otherwise it falls through.
  const yn = detectConfirmAnswer(msg.text);
  if (yn) {
    // Loaded on use: attendanceConfirm reaches agentCapabilities, which must not be
    // in this module's import graph (agentControls → … → here closed a cycle).
    const { answerFromWhatsApp } = await import('./attendanceConfirm.js');
    const answered = await answerFromWhatsApp(db, associateId, yn, now);
    if (answered) {
      const tz = answered.shift.timezone ?? companyWorkweek().timezone;
      const when = `${answered.shift.position}, ${formatDateInZone(answered.shift.startsAt, tz)} ${formatTimeInZone(answered.shift.startsAt, tz)}`;
      const intentYn: Intent = yn === 'YES' ? 'CONFIRM_YES' : 'CONFIRM_NO';
      return { intent: intentYn, reply: await say(yn === 'YES' ? WA_REPLY.confirmedYes(lang, when) : WA_REPLY.confirmedNo(lang, when), 'SYSTEM'), associateId };
    }
  }

  // Hugo's brain (lib/hugoWhatsapp), loaded on use: it reaches the registry, the model and the tasks.
  const turn = async () => {
    const brain = await import('./hugoWhatsapp.js');
    const t: import('./hugoWhatsapp.js').WaTurn = {
      db,
      now,
      associateId,
      userId: user?.id ?? null,
      lang,
      text: msg.text,
      inboundId: replyTo,
      say: async (text, kind, conversationId, trail) => ({ text: await say(text, kind, conversationId, trail), sent: lastSent }),
      handoff: (text) => handoff(db, associateId, user?.id ?? null, text, now),
      registry: (extra) => registryAnswer(extra),
    };
    return { brain, t };
  };

  switch (intent) {
    case 'OPT_OUT': {
      await db.whatsAppConsent.update({ where: { associateId }, data: { status: 'OPTED_OUT', optedOutAt: now, source: 'reply' } });
      // A task offer waiting on START is set aside: STOP means stop.
      await voidOffers(db, associateId, now);
      // Their last word still gets its one confirmation.
      const text = WA_REPLY.optedOut(lang);
      await db.whatsAppConsent.update({ where: { associateId }, data: { status: 'OPTED_IN' } });
      await say(text, 'SYSTEM');
      await db.whatsAppConsent.update({ where: { associateId }, data: { status: 'OPTED_OUT' } });
      return { intent, reply: text, associateId };
    }
    case 'OPT_IN': {
      // Already on, with a task offer of theirs waiting: START is their tap on it (lib/hugoWhatsapp).
      if (consent.status === 'OPTED_IN' && user && startReply(msg.text) && (await pendingOffer(db, associateId, now))) {
        const { brain, t } = await turn();
        const taken = await brain.takeOfferOnWhatsApp(t);
        if (taken) return taken;
      }
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
  }

  /** The registry's answer, exactly as before Hugo's brain; `extra`: one line said after it (the allowance notice). */
  async function registryAnswer(extra?: string): Promise<HandledInbound> {
    const plus = (text: string) => (extra ? `${text}\n\n${extra}` : text);
    switch (intent) {
      case 'RENEW': {
        const { answerRenewals } = await import('./complianceAgent.js');
        return { intent, reply: await say(plus((await answerRenewals(db, tenantIdForWrite(), associateId!, lang, now)).reply)), associateId };
      }
      case 'PAYDAY': {
        const pay = await answerPayday(associateId!, lang, now);
        if (pay.scheduled) return { intent, reply: await say(plus(pay.text)), associateId };
        // No schedule to read: a person has to set one up, so the question goes
        // to one — as any question Hugo can't answer does on WhatsApp. The reply
        // says it was passed on only when it was.
        const h = await handoff(db, associateId!, user?.id ?? null, msg.text, now);
        const next = h.conversationId ? WA_REPLY.handoff(lang, h.who) : WA_REPLY.handoffUnsent(lang);
        return { intent, reply: await say(plus(`${pay.text} ${next}`), 'HANDOFF', h.conversationId), associateId };
      }
      case 'RIDE':
        return { intent, reply: await say(plus(await answerRide(db, associateId!, lang, now))), associateId };
      case 'SCHEDULE':
        return { intent, reply: await say(plus(await answerSchedule(db, associateId!, lang, now))), associateId };
      default: {
        const h = await handoff(db, associateId!, user?.id ?? null, msg.text, now);
        const reply = h.conversationId ? WA_REPLY.handoff(lang, h.who) : WA_REPLY.handoffUnsent(lang);
        return { intent: 'HANDOFF', reply: await say(plus(reply), 'HANDOFF', h.conversationId), associateId };
      }
    }
  }

  // Everything above stays deterministic. The rest is Hugo's brain — the same one the app has —
  // for someone still opted in with an account: work to hand over, the registry at once for a
  // plain question about their own records, the model for the rest, the registry when the model
  // can't (lib/hugoWhatsapp). Opted out, nothing goes out, so nothing is asked of the model.
  if (consent.status === 'OPTED_IN' && user) {
    const { brain, t } = await turn();
    return brain.answerOnWhatsApp(t);
  }
  return registryAnswer();
}
