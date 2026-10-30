import type { Prisma, PrismaClient } from '@prisma/client';
import { HugoTaskCreateInputSchema, redactSensitiveNumbers, type HugoTaskCreateInput, type HugoTaskOffer, type HugoTier } from '@alto-people/shared';
import { env } from '../config/env.js';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { enqueueAudit } from './audit.js';
import { WHATSAPP_MAX_CHARS, answerWithModel, modelAvailable, type AssistantTurn } from './assistantModel.js';
import { getBrandingSync } from './branding.js';
import { appLink, publicBaseUrl } from './emailLayout.js';
import { HugoAllowanceError, allowanceUsedLine } from './hugoAllowance.js';
import { canList, escalationFor, registryFor, registryForUser, roleLabelOf } from './hugoRegistry.js';
import { instantIntent, pickTier } from './hugoRouting.js';
import { hugoTaskTurn } from './hugoTaskChat.js';
import { startHugoTask } from './hugoTasks.js';
import { markInbound, pendingOffer, recordOffer, reopenOffer, settleOffer, startReply, type HugoWaState } from './hugoWhatsappOffers.js';
import { WA_HUGO, watchThing, watchWhen } from './hugoWhatsappCopy.js';
import { payTools } from './payAssistantTools.js';
import { tenantIdForWrite } from './tenant.js';
import { companyWorkweek, orgDateKey, utcInstantOfLocalMidnight } from './timeAnomalies.js';
import { WA_REPLY, type WaLang } from './whatsappContent.js';
import type { HandledInbound, Intent } from './whatsappAssistant.js';
import { memoryForChannel } from './hugoMemory.js';

/**
 * Hugo's brain on WhatsApp — the same one the app has (routes/hugo), with
 * every WhatsApp rule kept. lib/whatsappAssistant runs what must stay
 * deterministic first (an unknown number, a call-out, the YES/NO to the
 * Workforce agent, STOP, START, a language, "who are you"); then this:
 *
 *   1. Work to hand over (lib/hugoTaskChat), read as the app reads it. A
 *      WATCH_* task is offered with "Reply START to have me do it": the
 *      offer keeps 30 minutes on the question's row, and the person's
 *      START is the tap — the task then runs as them (sessionUserById),
 *      and its news comes back here and in the app. Watching changes
 *      nothing; finding cover changes a schedule, so it starts in the app.
 *   2. A plain question about their own records (lib/hugoRouting
 *      instantIntent): the registry's answer, exactly as before.
 *   3. Anything else, when the model is on: the quick or the strong model
 *      (pickTier) with the person's own registry tools and pay tools, the
 *      thread's last 8 messages within 24 hours (the AI disclosure lines
 *      taken out), and the WhatsApp rules (plain text, ≤ 900 characters,
 *      app links in full). If it calls escalate_to_person the question goes
 *      to their supervisor at once — the person asked on WhatsApp — and the
 *      reply says it was passed on only when it was.
 *   4. No key, the tenant's daily valve reached (HUGO_WA_MODEL_TENANT_DAILY),
 *      the person's allowance used up (said once a period), or a model
 *      failure: the registry's answer, exactly as before (anything it can't
 *      answer goes to a person).
 *
 * The key into anyone's records is the phone's consent, resolved to one
 * associate; their session is read fresh, so a revoked role or a
 * switched-off assistant leaves only the registry. Every reply goes through
 * `say` (the AI disclosure line, the agent trail with the intent and the
 * tier); the audit's hugo.asked carries the route, never the words.
 */

type Db = PrismaClient;
type SayKind = 'ANSWER' | 'SYSTEM' | 'HANDOFF';

export interface WaTurn {
  db: Db;
  now: Date;
  associateId: string;
  /** The associate's account, when they have one (no account: the registry only). */
  userId: string | null;
  lang: WaLang;
  /** The words, an SSN or account number already taken out. */
  text: string;
  /** The inbound question's row: Hugo's route and any offer are written on it. */
  inboundId: string | null;
  /** Send a reply (the AI disclosure unless SYSTEM) and put it on the trail; `trail` adds to its metadata. `sent`: it reached WhatsApp. */
  say: (text: string, kind?: SayKind, conversationId?: string | null, trail?: Record<string, unknown>) => Promise<{ text: string; sent: boolean }>;
  /** Hand the person's words to their supervisor (whatsappAssistant.handoff). */
  handoff: (text: string) => Promise<{ conversationId: string | null; who: string | null }>;
  /** Today's registry answer, exactly as before; `extra` is one line said after it. */
  registry: (extra?: string) => Promise<HandledInbound>;
}

const HISTORY_TURNS = 8;
const HISTORY_MS = 24 * 3_600_000;
const BODY_CHARS = 1200;

/** The AI disclosure line in any of the six languages (lib/agentDisclosure, lib/hugoWorkCopy). */
const DISCLOSURE = /(an AI agent —|un agente de IA —|um agente de IA —|yapay zeka ajanıdır —|yon ajan IA —|агентом ШІ —)/;

/** A message as the model reads it: the disclosure line taken out, never an SSN or account number. */
export function historyText(body: string): string {
  const kept = body
    .split('\n')
    .filter((line) => !DISCLOSURE.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return redactSensitiveNumbers(kept).slice(0, BODY_CHARS);
}

/**
 * The thread as the model sees it: this associate's last 8 WhatsApp
 * messages within 24 hours (both ways; the one being answered left out,
 * failed sends too), oldest first, a run of one side's messages joined into
 * one turn, opening with the person. Messages of theirs that got no answer
 * are handed back as `pending`, to read with the question.
 */
export async function whatsappHistory(db: Db, associateId: string, exceptId: string | null, now: Date): Promise<{ turns: AssistantTurn[]; pending: string[] }> {
  const rows = await db.whatsAppMessage.findMany({
    where: {
      tenantId: tenantIdForWrite(),
      associateId,
      createdAt: { gte: new Date(now.getTime() - HISTORY_MS) },
      status: { not: 'FAILED' },
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: HISTORY_TURNS,
    select: { direction: true, body: true },
  });
  const turns: AssistantTurn[] = [];
  for (const r of rows.reverse()) {
    const text = historyText(r.body);
    if (!text) continue;
    const role = r.direction === 'INBOUND' ? 'user' : 'assistant';
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.text = `${last.text}\n${text}`;
    else turns.push({ role, text });
  }
  // The model's thread opens with the person (lib/assistantModel drops an opening reply too).
  while (turns.length && turns[0]!.role === 'assistant') turns.shift();
  // Their own unanswered lines go with the question, so the turns still alternate.
  const pending: string[] = [];
  while (turns.length && turns[turns.length - 1]!.role === 'user') pending.unshift(turns.pop()!.text);
  return { turns, pending };
}

/** Cut to `max` characters at a sentence or a word, never mid-word. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  if (sentence > max * 0.6) return cut.slice(0, sentence + 1).trim();
  const word = cut.lastIndexOf(' ');
  return `${(word > max * 0.6 ? cut.slice(0, word) : cut).trim()}…`;
}

/**
 * The model's words as a WhatsApp message: plain text (no markdown, no
 * tables), every app path written as the app's full address, the tool's
 * link added when the words give none, at most 900 characters in all.
 */
export function plainForWhatsApp(text: string, linkUrl: string | null, base: string = publicBaseUrl()): string {
  const whole = (url: string) => (url.startsWith('/') ? appLink(url) : url);
  let t = text.replace(/\r/g, '');
  t = t.replace(/!?\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => `${label}: ${whole(url)}`);
  t = t
    .split('\n')
    .filter((line) => !/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line))
    .map((line) => (/^\s*\|.*\|\s*$/.test(line) ? line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()).filter(Boolean).join(' — ') : line))
    .join('\n');
  t = t
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/(^|[^\w*])\*([^*\s][^*\n]*?)\*(?!\w)/g, '$1$2')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    // A bare in-app path ("go to /payroll") as the full address.
    .replace(/(^|[\s(])(\/[a-z][\w\-/]*(?:\?[\w=&%:.-]*)?)(?=[\s).,;!?]|$)/gim, (_m, pre: string, path: string) => `${pre}${appLink(path)}`)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const link = linkUrl ? whole(linkUrl) : null;
  const tail = link && !t.includes(base) ? `\n${link}` : '';
  if (!t) return link ?? '';
  return `${clip(t, WHATSAPP_MAX_CHARS - tail.length)}${tail}`;
}

/** Model answers the tenant's associates asked for today (company day) — the valve's count. */
export async function modelAnswersToday(db: Db, now: Date): Promise<number> {
  const dayStart = utcInstantOfLocalMidnight(orgDateKey(now), companyWorkweek().timezone);
  return db.whatsAppMessage.count({
    where: {
      tenantId: tenantIdForWrite(),
      direction: 'INBOUND',
      status: 'RECEIVED',
      createdAt: { gte: dayStart },
      OR: [{ hugo: { path: ['route'], equals: 'fast' } }, { hugo: { path: ['route'], equals: 'deep' } }],
    },
  });
}

/** Has this person already been told, this allowance period, that the thinking time is used up? */
async function allowanceToldBefore(db: Db, associateId: string, renewsAt: string, now: Date): Promise<boolean> {
  const n = await db.whatsAppMessage.count({
    where: {
      tenantId: tenantIdForWrite(),
      associateId,
      direction: 'INBOUND',
      createdAt: { gte: new Date(now.getTime() - 32 * 86_400_000) },
      AND: [{ hugo: { path: ['allowance', 'renewsAt'], equals: renewsAt } }, { hugo: { path: ['allowance', 'told'], equals: true } }],
    },
  });
  return n > 0;
}

/** On the audit log like the app's asks (routes/hugo): the route, never the words. */
function asked(user: { id: string; clientId: string | null }, intent: string, source: 'model' | 'rules', tier: HugoTier, tools: string[], extra: Record<string, unknown> = {}): void {
  enqueueAudit(
    { actorUserId: user.id, clientId: user.clientId ?? null, action: 'hugo.asked', entityType: 'Hugo', entityId: intent, metadata: { intent, tools, source, tier, channel: 'whatsapp', audience: 'associate', ...extra } },
    'hugo',
  );
}

const isWatch = (t: HugoTaskCreateInput) => t.kind.startsWith('WATCH_');

/** The person's registry on WhatsApp: their session as it is now, always as the associate they are here. */
async function registryOnWhatsApp(turn: WaTurn) {
  if (!turn.userId) return null;
  const reg = await registryForUser(turn.userId, { now: turn.now, text: turn.text, channel: 'whatsapp' });
  if (!reg || !reg.user.associateId || reg.user.associateId !== turn.associateId) return null;
  // WhatsApp is the associate's channel (the consent is an associate's): their own records, whatever else they do.
  const ctx = { ...reg.ctx, audience: 'associate' as const };
  const { mk, tools } = registryFor(reg.asker, reg.tenantId, turn.lang, reg.sitesNoun, turn.now, reg.name, ctx, turn.text);
  return { ...reg, ctx, mk, tools };
}

/**
 * Everything after the deterministic commands. Always answers: when Hugo's
 * brain has nothing to add, it is the registry's answer exactly as before.
 */
export async function answerOnWhatsApp(turn: WaTurn): Promise<HandledInbound> {
  const { db, now, lang, text } = turn;
  const reg = await registryOnWhatsApp(turn);
  // No account, a revoked role, the assistant switched off: the registry, as before.
  if (!reg) return turn.registry();
  const user = reg.user;
  const registry = async (state: HugoWaState, extra?: string): Promise<HandledInbound> => {
    await markInbound(db, turn.inboundId, state);
    const out = await turn.registry(extra);
    asked(user, out.intent, 'rules', 'instant', [], { route: state.route, ...(state.failed ? { failed: true } : {}), ...(state.valve ? { valve: true } : {}), ...(state.allowance ? { allowance: true } : {}) });
    return out;
  };

  // 1. Work to hand over — read as the app reads it (task intents are the app's; here the tap is a reply).
  const taskTurn = await hugoTaskTurn(text, user, { ...reg.ctx, channel: 'app' }, lang, now);
  if (taskTurn) return taskOnWhatsApp(turn, user, taskTurn);

  // 2. A plain question about their own records: the registry's answer, at once.
  if (instantIntent(text, reg.ctx, canList(reg.tools, lang))) return registry({ route: 'instant' });

  // 3. The model — when it is on and the tenant's valve has room.
  if (!modelAvailable()) return registry({ route: 'rules' });
  if (env.HUGO_WA_MODEL_TENANT_DAILY <= 0 || (await modelAnswersToday(db, now)) >= env.HUGO_WA_MODEL_TENANT_DAILY) return registry({ route: 'rules', valve: true });

  const tier = pickTier(text, { canPropose: false, canReport: false });
  // Counted before the call: answers asked for at the same moment still meet the valve.
  await markInbound(db, turn.inboundId, { route: tier });
  const { turns, pending } = await whatsappHistory(db, turn.associateId, turn.inboundId, now);
  const terms = reg.terms;
  // What the person told Hugo before ("What Hugo knows") — one Hugo across the app and WhatsApp; nothing when their memory is off.
  const memory = await memoryForChannel(user.id);
  let answer: Awaited<ReturnType<typeof answerWithModel>>;
  try {
    answer = await answerWithModel({
      text: [...pending, text].join('\n'),
      history: turns,
      page: null,
      // Their own payday, ride, shifts, documents, help articles, paystub and withholding — nothing else.
      tools: [...reg.tools, ...payTools(prisma, user)],
      identity: {
        name: reg.name,
        product: getBrandingSync().orgName || 'Alto People',
        audience: 'associate',
        roleLabel: roleLabelOf(user.role),
        lang,
        terms: { worker: terms.worker, workers: terms.workers, site: terms.site, sites: terms.sites, manager: terms.manager, managers: terms.managers },
        escalation: await escalationFor(reg.asker),
        canPropose: false,
      },
      now,
      tier,
      meter: { userId: user.id, purpose: 'whatsapp' },
      channel: 'whatsapp',
      memory,
    });
  } catch (err) {
    if (err instanceof HugoAllowanceError) {
      // Used up: the basics still answer, and the person hears why once a period.
      const renewsAt = err.renewsAt.toISOString();
      const told = await allowanceToldBefore(db, turn.associateId, renewsAt, now);
      return registry({ route: 'rules', allowance: { renewsAt, told: !told } }, told ? undefined : allowanceUsedLine(lang, err.renewsAt));
    }
    // The model is a convenience over the registry, never a dependency.
    console.warn('[whatsapp] model answer failed; answering from the registry:', err instanceof Error ? err.message : err);
    return registry({ route: tier, failed: true });
  }

  const reply = plainForWhatsApp(answer.reply, answer.linkUrl);
  if (!reply && !answer.handoff) return registry({ route: tier, failed: true });
  const trail = { intent: 'MODEL', source: 'model', tier, tools: answer.toolsUsed };
  asked(user, 'MODEL', 'model', tier, answer.toolsUsed, { route: tier, handoff: Boolean(answer.handoff) });
  if (answer.handoff) {
    // On WhatsApp the person asked here: their words go to a person at once, and the reply says so only when they did.
    const h = await turn.handoff(text);
    const line = h.conversationId ? WA_REPLY.handoff(lang, h.who) : WA_REPLY.handoffUnsent(lang);
    const said = await turn.say(reply ? `${reply}\n\n${line}` : line, 'HANDOFF', h.conversationId, { ...trail, handedOff: Boolean(h.conversationId) });
    return { intent: 'MODEL', reply: said.text, associateId: turn.associateId };
  }
  const said = await turn.say(reply, 'ANSWER', null, trail);
  return { intent: 'MODEL', reply: said.text, associateId: turn.associateId };
}

/** A task turn on WhatsApp: watches are offered for START; the rest point to the app. */
async function taskOnWhatsApp(turn: WaTurn, user: { id: string; clientId: string | null }, taskTurn: NonNullable<Awaited<ReturnType<typeof hugoTaskTurn>>>): Promise<HandledInbound> {
  const { db, now, lang } = turn;
  const intent = taskTurn.intent as Intent;
  const trail = { intent, source: 'rules', tier: 'instant' };
  const done = async (text: string, route: HugoWaState['route']): Promise<HandledInbound> => {
    await markInbound(db, turn.inboundId, { route });
    const said = await turn.say(text, 'ANSWER', null, trail);
    asked(user, intent, 'rules', 'instant', [], { route });
    return { intent, reply: said.text, associateId: turn.associateId };
  };

  if (taskTurn.intent === 'TASK_LIST') return done(`${taskTurn.reply}\n${WA_HUGO.seeTasks(lang, appLink('/?hugo=tasks'))}`, 'pointer');
  const watches = taskTurn.offers.filter((o) => isWatch(o.task));
  if (taskTurn.intent !== 'TASK_TELL_ME_WHEN') {
    // Finding cover moves a shift: it starts in the app, on the shift the person picks.
    if (!taskTurn.offers.length) return done(taskTurn.reply, 'pointer');
    const text = taskTurn.intent === 'TASK_FIND_COVER' ? WA_HUGO.coverInApp(lang, appLink('/scheduling?hugo=chat')) : WA_HUGO.taskInApp(lang, appLink('/?hugo=chat'));
    return done(text, 'pointer');
  }
  // Nothing to watch: the app's own words say so.
  if (!watches.length) return done(taskTurn.reply, 'pointer');

  const offerText =
    watches.length === 1
      ? WA_HUGO.offerOne(lang, watchThing(watches[0]!.task, watches[0]!.subject, lang), watchWhen(watches[0]!.task, lang))
      : WA_HUGO.offerPick(lang, watches.map((o: HugoTaskOffer, i) => `${i + 1}. ${watchThing(o.task, o.subject, lang)}`));
  const said = await turn.say(offerText, 'ANSWER', null, { ...trail, offers: watches.map((o) => o.task.kind) });
  // Only an offer the person actually received can be taken.
  if (said.sent && turn.inboundId) await recordOffer(db, turn.inboundId, turn.associateId, user.id, watches.map((o) => o.task), now);
  else await markInbound(db, turn.inboundId, { route: 'offer' });
  asked(user, intent, 'rules', 'instant', [], { route: 'offer', offers: watches.length });
  return { intent, reply: said.text, associateId: turn.associateId };
}

/**
 * START (EMPEZAR, BAŞLA) with an offer of theirs waiting: the reply is the
 * person's tap. Within 30 minutes it starts the task as them, through the
 * same start the app's button uses; later, it says the offer ran out. Null
 * when there is nothing of theirs to take — the word is then the opt-in it
 * always was.
 */
export async function takeOfferOnWhatsApp(turn: WaTurn): Promise<HandledInbound | null> {
  const { db, now, lang } = turn;
  const word = startReply(turn.text);
  if (!word || !turn.userId) return null;
  const row = await pendingOffer(db, turn.associateId, now);
  if (!row) return null;
  // Theirs, and still allowed: their session as it is now.
  const reg = await registryOnWhatsApp(turn);
  if (!reg || row.offer.userId !== reg.user.id) {
    await settleOffer(db, row, { state: 'VOID', at: now.toISOString() });
    return null;
  }
  const user = reg.user;
  const trail = { intent: 'TASK_START', source: 'rules', tier: 'instant' };
  const reply = async (text: string, extra: Record<string, unknown> = {}): Promise<HandledInbound> => {
    const said = await turn.say(text, 'ANSWER', null, { ...trail, ...extra });
    return { intent: 'TASK_START', reply: said.text, associateId: turn.associateId };
  };

  if (new Date(row.offer.expiresAt).getTime() <= now.getTime()) {
    await settleOffer(db, row, { state: 'EXPIRED', at: now.toISOString() });
    return reply(WA_HUGO.expired(lang), { offer: 'expired' });
  }
  const tasks = row.offer.tasks.filter(isWatch);
  if (tasks.length > 1 && word.pick === null) return reply(WA_HUGO.whichOne(lang, tasks.length), { offer: 'which' });
  const task = tasks.length === 1 && word.pick === null ? tasks[0] : word.pick !== null ? tasks[word.pick - 1] : undefined;
  if (!task) return reply(WA_HUGO.whichOne(lang, tasks.length), { offer: 'which' });

  // Taken once, even if START comes twice at the same moment.
  if (!(await settleOffer(db, row, { state: 'TAKEN', at: now.toISOString() }, 'task'))) return null;
  await markInbound(db, turn.inboundId, { route: 'task' });
  try {
    const { task: started, existing } = await startHugoTask(user, HugoTaskCreateInputSchema.parse(task), 'whatsapp', now);
    await db.whatsAppMessage.update({
      where: { id: row.id },
      data: { hugo: { ...row.state, route: 'task', offer: { ...row.offer, state: 'TAKEN', at: now.toISOString(), taskId: started.id } } as unknown as Prisma.InputJsonValue },
      select: { id: true },
    });
    asked(user, 'TASK_START', 'rules', 'instant', [], { route: 'task', kind: started.kind, existing });
    const thing = watchThing(task, started.subject, lang);
    const link = appLink(`/?hugo=task:${started.id}`);
    return reply(existing ? WA_HUGO.already(lang, thing, watchWhen(task, lang), link) : WA_HUGO.started(lang, thing, watchWhen(task, lang), link), { kind: started.kind, existing });
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    // Too many running: the offer waits again, so the person can stop one and reply once more.
    if (err.code === 'too_many_tasks') {
      await reopenOffer(db, row);
      return reply(WA_HUGO.tooMany(lang, appLink('/?hugo=tasks')), { refused: err.code });
    }
    // Anything else: this offer is done with.
    await db.whatsAppMessage.update({ where: { id: row.id }, data: { hugo: { ...row.state, offer: { ...row.offer, state: 'VOID', at: now.toISOString() } } as unknown as Prisma.InputJsonValue }, select: { id: true } });
    if (err.code === 'nothing_pending' || err.code === 'nothing_in_review') return reply(WA_HUGO.nothingLeft(lang), { refused: err.code });
    return reply(WA_HUGO.cantStart(lang, appLink('/?hugo=chat')), { refused: err.code });
  }
}
