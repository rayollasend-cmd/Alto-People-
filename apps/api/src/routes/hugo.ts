import { Router, type Request } from 'express';
import type { SessionUser } from '../types/express.js';
import { z } from 'zod';
import { HugoNoteSettingInputSchema, HugoSeenInputSchema, HugoTaskRespondInputSchema, HugoTaskStartSchema, ROLE_LABELS, termsIn, type HugoAskEvent, type HugoStep, type HugoSummary, type HugoTier, redactSensitiveNumbers } from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import { enqueueAudit } from '../lib/audit.js';
import { inProcessAgent, logBuiltInAgentAction } from '../lib/agents.js';
import { answerWithModel, modelAvailable, type AssistantPage } from '../lib/assistantModel.js';
import { payTools } from '../lib/payAssistantTools.js';
import { getBrandingSync } from '../lib/branding.js';
import { hugoAudienceOf } from '../lib/hugo.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { handoff } from '../lib/whatsappAssistant.js';
import { WA_REPLY } from '../lib/whatsappContent.js';
import { ActionError, actionTools, decideAction, type ActionContext } from '../lib/assistantActions.js';
import { hugoTaskTurn } from '../lib/hugoTaskChat.js';
import { instantIntent, pickTier } from '../lib/hugoRouting.js';
import { type Answer, type Asker, canList, contextFor, escalationFor, registryFor, rulesAnswer } from '../lib/hugoRegistry.js';
import { toHugoLang } from '../lib/hugoWorkCopy.js';
import { HugoAllowanceError, MICROS_PER_USD, allowanceStatus, allowanceUsedLine } from '../lib/hugoAllowance.js';
import { cancelHugoTask, getHugoTask, hugoTaskCounts, listHugoTasks, markHugoTasksSeen, respondToHugoTask, startHugoTask } from '../lib/hugoTasks.js';
import { hugoMemoryTurn, type HugoMemoryTurn } from '../lib/hugoMemory.js';
import { hugoMemoryRouter } from './hugoMemory.js';
import type { HugoTaskOffer } from '@alto-people/shared';
import { offerRecurringTool } from '../lib/hugoRecurringChat.js';
import { offerGoalTool } from '../lib/hugoGoalChat.js';
import { hugoActivityRouter } from './hugoActivity.js';
import { hugoRecurringRouter } from './hugoRecurring.js';
import { hugoAccountRouter } from './hugoAccount.js';
import { ensureHugoProfileOnSignIn, modelHistory, saveHugoReply, saveHugoTurns } from '../lib/hugoThread.js';
import { acceptHugoNote, countNewHugoNotes, dismissHugoNote, hugoNoteSettings, listHugoNotes, markHugoNotesSeen, setHugoNoteKind } from '../lib/hugoNotes.js';

/**
 * The assistant in the app (agent families step 3; docs/agent-families-investigation.md §4.5).
 *
 *   GET  /hugo          who it is and what it can do for this person, here
 *   POST /hugo/ask      { text, page?, history? } → { intent, reply, linkUrl, handoff?, source, tier }
 *   POST /hugo/ask/stream  the same, as it is made: one JSON line per step, the words, then the answer
 *   POST /hugo/handoff  { text } → passes an associate's question to a person
 *
 *   Hugo works for you (lib/hugoTasks, lib/hugoNotes) — the caller's own rows only:
 *   GET  /hugo/tasks                 open tasks and the last two weeks' finished ones
 *   POST /hugo/tasks                 { task, source } → start one (the person's tap)
 *   GET  /hugo/tasks/:id             one, with its trail
 *   POST /hugo/tasks/:id/cancel      stop; what Hugo started is withdrawn
 *   POST /hugo/tasks/:id/respond     { choice } → the answer to a NEEDS_YOU
 *   GET  /hugo/notes                 what Hugo noticed, still true
 *   POST /hugo/notes/:id/accept      the person's yes: a link, or a task started
 *   POST /hugo/notes/:id/dismiss
 *   GET  /hugo/notes/settings        which kinds of note are on
 *   PUT  /hugo/notes/settings        { kind, on }
 *   POST /hugo/seen                  { tasks?, notes? } → they looked
 *   GET  /hugo/summary               the badge: working, needs you, done unseen, new notes
 *
 *   What Hugo knows (routes/hugoMemory, lib/hugoMemory) — the facts a person told him, theirs to see and edit:
 *   GET/POST /hugo/memory, PATCH/DELETE /hugo/memory/:id, DELETE /hugo/memory (forget all), PUT /hugo/memory/settings
 *
 *   One registry (lib/hugo) answers on WhatsApp and here: an associate asks
 *   about their own payday, ride, schedule and documents; a desk asks about
 *   coverage and what the agents have waiting on it. Only what is on is
 *   offered. With a model key set, Claude answers with those same answers
 *   as its tools and knows the page the person is on (lib/assistantModel);
 *   without one, the registry answers alone. The quickest way that
 *   answers well is used (lib/hugoRouting): a tapped suggestion or a
 *   worker's plain question about their own records is the registry's
 *   answer at once, everyday questions go to a quick model, actions and
 *   numbers to the strongest. Either way the key into
 *   anyone's records is the session, never the request, and a question the
 *   assistant cannot answer is said so — an associate is OFFERED a hand-off
 *   to a person and confirms it; nothing is sent behind their back. Every
 *   answer is on the assistant's trail (the intent, the tools and the tier,
 *   never the words asked).
 */

export const hugoRouter = Router();

// What Hugo knows (routes/hugoMemory): the person's own facts — read, change, remove, switch off.
hugoRouter.use('/memory', hugoMemoryRouter);
// Everything Hugo did for the person (routes/hugoActivity), and changing when a recurring brief comes (routes/hugoRecurring).
hugoRouter.use('/activity', hugoActivityRouter);
hugoRouter.use('/recurring', hugoRecurringRouter);
// The person's own Hugo (routes/hugoAccount): their conversation on every device, their settings; the organization's spend.
hugoRouter.use(hugoAccountRouter);

const PageSchema = z
  .object({
    path: z.string().trim().min(1).max(300),
    title: z.string().trim().max(200).optional().nullable(),
    record: z
      .object({ type: z.string().trim().min(1).max(60), id: z.string().trim().min(1).max(80), name: z.string().trim().min(1).max(200) })
      .optional()
      .nullable(),
  })
  .optional()
  .nullable();

const AskSchema = z.object({
  text: z.string().trim().min(1).max(500),
  page: PageSchema,
  history: z
    .array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(2000) }))
    .max(20)
    .optional(),
});

const HandoffSchema = z.object({ text: z.string().trim().min(1).max(500) });

hugoRouter.get('/', requireAuth, async (req, res) => {
  const user = req.user! as Asker;
  const { tenantId, audience, ctx, lang, name, profile } = await contextFor(user);
  // Every account Hugo serves has its own Hugo (lib/hugoThread): made here, on the first call any signed-in app makes.
  await ensureHugoProfileOnSignIn(user.id);
  const sitesNoun = termsIn(profile, lang).sites.toLowerCase();
  const can = canList(registryFor(user, tenantId, lang, sitesNoun, new Date(), name, ctx).tools, lang, ctx);
  res.json({ name, audience, intro: WA_REPLY.appIntro(lang, name, can.map((c) => c.label.toLowerCase()), { tasks: can.some((c) => c.key.startsWith('TASK_')) }), can, model: modelAvailable() });
});

type AskBody = z.infer<typeof AskSchema>;

/** The step line for a tool: the kind of record it reads (the app words it, hugoPane.step.*). */
const STEP_OF: Record<string, HugoStep> = {
  SCHEDULE: 'schedule',
  DRIVER_NEXT_RUN: 'schedule',
  ACT_OPEN_SHIFTS: 'schedule',
  ACT_CREW_SHIFTS: 'schedule',
  PAYDAY: 'pay',
  PAYSTUB: 'pay',
  W4_CHECK: 'pay',
  RIDE: 'ride',
  DRIVER_RUN_RIDERS: 'ride',
  DRIVER_VAN_ISSUE: 'ride',
  RENEW: 'documents',
  DESK: 'desk',
  ACT_TIME_OFF_LIST: 'desk',
  ACT_TIMESHEET_LIST: 'desk',
  COVERAGE: 'coverage',
  HELP_CENTER: 'help',
  ACT_REPORT: 'report',
  ACT_FIND_PERSON: 'team',
  ESCALATE: 'person',
  MEMORY_REMEMBER: 'memory',
  MEMORY_FORGET: 'memory',
  OFFER_RECURRING: 'action',
  OFFER_GOAL: 'action',
};
export const stepOf = (key: string): HugoStep => STEP_OF[key] ?? (key.startsWith('ACT_') ? 'action' : 'records');

/**
 * One question, answered the quickest way that answers it well (lib/hugoRouting):
 * the registry outright, the quick model, or the strongest. `live` streams the
 * answer as it is made (POST /hugo/ask/stream); without it the whole answer
 * comes back at once (POST /hugo/ask).
 */
async function answerAsk(req: Request, body: AskBody, live?: { emit: (e: HugoAskEvent) => void; signal: AbortSignal }): Promise<Record<string, unknown>> {
  const user = req.user! as Asker;
  // An SSN or account number never reaches the model, a hand-off or a log
  // (the app stops them first; this is the backstop — shared/sensitiveText).
  const text = redactSensitiveNumbers(body.text);
  const page = body.page;
  // The conversation so far is the person's own, read on the server (lib/hugoThread modelHistory): a client's `history` is ignored.
  const { tenantId, audience, ctx, lang, name, profile } = await contextFor(user);
  const now = new Date();
  const terms = termsIn(profile, lang);
  const sitesNoun = terms.sites.toLowerCase();
  const { mk, tools } = registryFor(user, tenantId, lang, sitesNoun, now, name, ctx, text);

  // Work handed to Hugo is answered with a Start card, the same with or
  // without the model: what Hugo will do for someone is never a guess.
  const taskTurn = await hugoTaskTurn(text, req.user!, ctx, toHugoLang(user.language), now);
  if (taskTurn) {
    await logBuiltInAgentAction(prisma, 'whatsapp-assistant', { action: 'agent.app.reply', entityType: 'User', entityId: user.id, metadata: { intent: taskTurn.intent, tools: [], source: 'rules', tier: 'instant', channel: 'app', audience, lang, offers: taskTurn.offers.map((o) => o.task.kind) } });
    enqueueAudit({ actorUserId: user.id, clientId: user.clientId, action: 'hugo.asked', entityType: 'Hugo', entityId: taskTurn.intent, metadata: { intent: taskTurn.intent, tools: [], source: 'rules', tier: 'instant', channel: 'app', audience } }, 'hugo');
    const saved = await saveHugoTurns(user, { question: text, answer: { reply: taskTurn.reply, intent: taskTurn.intent }, askedAt: now });
    return { turns: saved, intent: taskTurn.intent, reply: taskTurn.reply, linkUrl: null, handoff: null, source: 'rules', tier: 'instant', actions: [], tables: [], offers: taskTurn.offers, view: taskTurn.view ?? null };
  }

  let intent = '';
  let out: Answer | null = null;
  let offer: { summary: string; who: string | null } | null = null;
  let source: 'model' | 'rules' = 'rules';
  let tier: HugoTier = 'instant';
  let toolsUsed: string[] = [];

  // A suggestion tapped, or a worker's plain question about their own records: the registry's answer, now.
  const quick = instantIntent(text, ctx, canList(tools, lang));
  const quickRun = quick ? mk(quick) : null;
  if (quick && quickRun) {
    live?.emit({ t: 'step', step: stepOf(quick) });
    intent = quick;
    out = await quickRun();
    offer = user.associateId ? (out.handoff ?? null) : null;
  }

  // What the model may propose (never do): confirmation cards and tables collected as it works.
  const acting: ActionContext = { req, user: req.user!, proposals: [], tables: [] };
  // Briefs on a schedule the model offers (lib/hugoRecurringChat): Start cards — nothing is set up until the tap.
  const recurringOffers: HugoTaskOffer[] = [];
  // A goal the model offers for an outcome that takes time (lib/hugoGoalChat): a Start card, nothing until the tap.
  const goalOffers: HugoTaskOffer[] = [];
  // What the person told Hugo before (lib/hugoMemory), when their memory is on: in the prompt, with remember/forget.
  let memory: HugoMemoryTurn | null = null;
  // The person's own allowance for Hugo's thinking (lib/hugoAllowance): used up, the registry answers and says until when.
  let allowance: { exhausted: true; renewsAt: string } | null = null;
  if (!out && modelAvailable()) {
    const left = await allowanceStatus(user.id, now);
    if (left.exhausted) allowance = { exhausted: true, renewsAt: left.renewsAt.toISOString() };
  }
  if (!out && modelAvailable() && !allowance) {
    source = 'model';
    const escalation = audience === 'associate' ? await escalationFor(user) : null;
    const actTools = actionTools(acting);
    const canPropose = actTools.some((t) => t.name.startsWith('propose_'));
    tier = pickTier(text, { canPropose, canReport: actTools.some((t) => t.key === 'ACT_REPORT') });
    memory = await hugoMemoryTurn(user, { name, lang: toHugoLang(user.language), now });
    try {
      const answer = await answerWithModel({
        text,
        history: await modelHistory(user.id, now),
        page: (page ?? null) as AssistantPage | null,
        // A worker's own paystub and withholding (lib/payAssistantTools) — their records only.
        tools: [...tools, ...actTools, ...payTools(prisma, user), ...(memory?.tools ?? []), offerRecurringTool(req.user!, recurringOffers, now), offerGoalTool(req.user!, goalOffers, now)],
        identity: {
          name,
          product: getBrandingSync().orgName || 'Alto People',
          audience,
          roleLabel: ROLE_LABELS[user.role] ?? user.role,
          lang,
          terms: { worker: terms.worker, workers: terms.workers, site: terms.site, sites: terms.sites, manager: terms.manager, managers: terms.managers },
          escalation,
          canPropose,
        },
        now,
        tier,
        meter: { userId: user.id, purpose: 'chat' },
        memory: memory?.memory,
        live: live && {
          onTool: (key) => live.emit({ t: 'step', step: stepOf(key) }),
          onText: (d) => live.emit({ t: 'text', d }),
          onClear: () => live.emit({ t: 'clear' }),
          signal: live.signal,
        },
      });
      intent = 'MODEL';
      toolsUsed = answer.toolsUsed;
      out = { reply: answer.reply || WA_REPLY.appIntro(lang, name, canList(tools, lang).map((c) => c.label.toLowerCase())), linkUrl: answer.linkUrl };
      offer = answer.handoff;
    } catch (err) {
      // The model is a convenience over the registry, never a dependency:
      // a timeout, an outage or a used-up allowance falls back to the rules path below.
      if (err instanceof HugoAllowanceError) allowance = { exhausted: true, renewsAt: err.renewsAt.toISOString() };
      else if (!live?.signal.aborted) console.warn('[assistant] model answer failed; answering from the registry:', err instanceof Error ? err.message : err);
      live?.emit({ t: 'clear' });
      source = 'rules';
      tier = 'instant';
      out = null;
    }
  }
  if (!out) ({ intent, out, offer } = await rulesAnswer(text, user, ctx, lang, name, mk, tools));
  if (allowance) out = { ...out, reply: `${out.reply}\n\n${allowanceUsedLine(toHugoLang(user.language), new Date(allowance.renewsAt))}` };
  // What this answer kept (the chip, with Undo) or forgot; the first time, Hugo says where it lives.
  const kept = memory ? await memory.finish(out.reply) : null;
  if (kept) out = { ...out, reply: kept.reply };

  // On the assistant's trail and the audit log: the intent, the tools and the tier, never the words.
  await logBuiltInAgentAction(prisma, 'whatsapp-assistant', { action: 'agent.app.reply', entityType: 'User', entityId: user.id, metadata: { intent, tools: toolsUsed, source, tier, channel: 'app', audience, lang } });
  enqueueAudit({ actorUserId: user.id, clientId: user.clientId, action: 'hugo.asked', entityType: 'Hugo', entityId: intent, metadata: { intent, tools: toolsUsed, source, tier, channel: 'app', audience } }, 'hugo');
  // Kept on the server (lib/hugoThread): the conversation follows the account to every device.
  const saved = await saveHugoTurns(user, { question: text, answer: { reply: out.reply, intent, linkUrl: out.linkUrl }, askedAt: now });
  return { turns: saved, intent, reply: out.reply, linkUrl: out.linkUrl, handoff: offer, source, tier, allowance, actions: acting.proposals, tables: acting.tables, offers: [...recurringOffers, ...goalOffers], view: null, ...kept?.fields };
}

/**
 * GET /hugo/allowance — where the person's own allowance for Hugo's thinking
 * stands: the share used, when it renews, and their class. The amounts in
 * dollars only for the office (staff); a worker sees the share.
 */
hugoRouter.get('/allowance', requireAuth, async (req, res) => {
  const user = req.user! as Asker;
  await contextFor(user);
  const s = await allowanceStatus(user.id);
  // Anything used shows as at least 1% — "0% used" after a few answers reads as broken.
  const usedPercent = s.capMicros ? Math.min(100, s.spentMicros > 0 ? Math.max(1, Math.round((s.spentMicros / s.capMicros) * 100)) : 0) : 100;
  res.json({
    on: modelAvailable(),
    allowanceClass: s.allowanceClass,
    usedPercent,
    exhausted: s.exhausted,
    periodStart: s.periodStart.toISOString(),
    renewsAt: s.renewsAt.toISOString(),
    ...(s.allowanceClass === 'staff' ? { spentUsd: s.spentMicros / MICROS_PER_USD, capUsd: s.capMicros / MICROS_PER_USD } : {}),
  });
});

hugoRouter.post('/ask', requireAuth, async (req, res) => {
  res.json(await answerAsk(req, AskSchema.parse(req.body)));
});

/**
 * POST /hugo/ask/stream — the same answer, shown as it is made: one JSON
 * object per line (HugoAskEvent: a step, words, a clear, then `done` with
 * the body /ask returns). The stream opens with its first line, so a
 * refusal before anything is said (no assistant here, switched off, a bad
 * body) is an ordinary JSON error with its status.
 */
hugoRouter.post('/ask/stream', requireAuth, async (req, res) => {
  const body = AskSchema.parse(req.body);
  const stop = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) stop.abort();
  });
  const emit = (e: HugoAskEvent) => {
    if (stop.signal.aborted) return;
    if (!res.headersSent) {
      res.status(200);
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      // no-transform: compression() passes it through unbuffered; the proxy is asked not to hold it either.
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
    }
    res.write(`${JSON.stringify(e)}\n`);
  };
  try {
    const answer = await answerAsk(req, body, { emit, signal: stop.signal });
    emit({ t: 'done', answer });
    res.end();
  } catch (err) {
    if (!res.headersSent) throw err;
    // Words already on the screen: say it failed in the stream itself.
    console.warn('[assistant] streamed answer failed:', err instanceof Error ? err.message : err);
    emit({ t: 'error', message: err instanceof HttpError ? err.message : 'The assistant could not answer.' });
    res.end();
  }
});

const ConfirmSchema = z.object({ token: z.string().min(10).max(400), decision: z.enum(['confirm', 'cancel']).default('confirm') });

/**
 * POST /hugo/confirm — the person's tap on a confirmation card. Runs the
 * proposed action once, as them, through the product's own route
 * (lib/assistantActions); a token is single-use, expires in ten minutes,
 * and is no use to anyone but the person it was made for.
 */
hugoRouter.post('/confirm', requireAuth, async (req, res) => {
  const { token, decision } = ConfirmSchema.parse(req.body ?? {});
  try {
    const result = await decideAction(req, token, decision);
    await logBuiltInAgentAction(prisma, 'whatsapp-assistant', { action: 'agent.app.action', entityType: 'User', entityId: req.user!.id, metadata: { decision, status: result.status } });
    res.json(result);
  } catch (err) {
    if (err instanceof ActionError) throw new HttpError(err.status, err.code, err.message);
    throw err;
  }
});

/** The confirmed hand-off: the associate's question, as a thread with their supervisor. */
hugoRouter.post('/handoff', requireAuth, async (req, res) => {
  const user = req.user! as Asker;
  const text = redactSensitiveNumbers(HandoffSchema.parse(req.body).text);
  const { lang, name } = await contextFor(user);
  if (!user.associateId) throw new HttpError(403, 'no_handoff', 'Only a worker\'s question can be passed to their supervisor.');
  const hand = await handoff(prisma, user.associateId, user.id, text, new Date(), name);
  await logBuiltInAgentAction(prisma, 'whatsapp-assistant', { action: 'agent.app.handoff', entityType: 'User', entityId: user.id, metadata: { channel: 'app', sent: Boolean(hand.conversationId) } });
  const reply = hand.conversationId ? WA_REPLY.handoff(lang, hand.who) : WA_REPLY.handoffUnsent(lang);
  const linkUrl = hand.conversationId ? `/messages/${hand.conversationId}` : hand.conversationId === null ? null : '/messages';
  // The confirmation is part of the conversation, on every device (lib/hugoThread).
  const turn = await saveHugoReply(user, { text: reply, intent: 'HANDOFF', linkUrl });
  res.json({ reply, linkUrl, sent: Boolean(hand.conversationId), turn });
});

/* ------------------------------------------------------- Hugo works for you */

const IdParam = z.object({ id: z.string().uuid() });

/** The work Hugo does for this person, here: the assistant on, and someone it serves. */
async function worker(req: Express.Request): Promise<SessionUser> {
  await contextFor(req.user! as Asker);
  return req.user!;
}

hugoRouter.get('/tasks', requireAuth, async (req, res) => {
  const user = await worker(req);
  res.json({ tasks: await listHugoTasks(user.id) });
});

hugoRouter.post('/tasks', requireAuth, async (req, res) => {
  const user = await worker(req);
  const { task, source } = HugoTaskStartSchema.parse(req.body ?? {});
  const out = await startHugoTask(user, task, source);
  res.status(out.existing ? 200 : 201).json(out);
});

hugoRouter.get('/tasks/:id', requireAuth, async (req, res) => {
  const user = await worker(req);
  const { id } = IdParam.parse(req.params);
  res.json({ task: await getHugoTask(user.id, id) });
});

hugoRouter.post('/tasks/:id/cancel', requireAuth, async (req, res) => {
  const user = await worker(req);
  const { id } = IdParam.parse(req.params);
  res.json({ task: await cancelHugoTask(user, id) });
});

hugoRouter.post('/tasks/:id/respond', requireAuth, async (req, res) => {
  const user = await worker(req);
  const { id } = IdParam.parse(req.params);
  const { choice } = HugoTaskRespondInputSchema.parse(req.body ?? {});
  // The request itself rides along: an approved goal step runs through it, as the person (lib/hugoGoals).
  res.json({ task: await respondToHugoTask(user, id, choice, new Date(), req) });
});

hugoRouter.get('/notes', requireAuth, async (req, res) => {
  const user = await worker(req);
  res.json({ notes: await listHugoNotes(user.id) });
});

hugoRouter.get('/notes/settings', requireAuth, async (req, res) => {
  const user = await worker(req);
  res.json(await hugoNoteSettings(user));
});

hugoRouter.put('/notes/settings', requireAuth, async (req, res) => {
  const user = await worker(req);
  const { kind, on } = HugoNoteSettingInputSchema.parse(req.body ?? {});
  res.json(await setHugoNoteKind(user, kind, on));
});

hugoRouter.post('/notes/:id/accept', requireAuth, async (req, res) => {
  const user = await worker(req);
  const { id } = IdParam.parse(req.params);
  res.json(await acceptHugoNote(user, id));
});

hugoRouter.post('/notes/:id/dismiss', requireAuth, async (req, res) => {
  const user = await worker(req);
  const { id } = IdParam.parse(req.params);
  res.json({ note: await dismissHugoNote(user, id) });
});

hugoRouter.post('/seen', requireAuth, async (req, res) => {
  const user = await worker(req);
  const { tasks, notes } = HugoSeenInputSchema.parse(req.body ?? {});
  const [t, n] = await Promise.all([markHugoTasksSeen(user.id, tasks ?? []), markHugoNotesSeen(user.id, notes ?? [])]);
  res.json({ tasks: t, notes: n });
});

/**
 * The badge. Polled by every signed-in screen, so it answers zeros — not
 * an error — for someone the assistant doesn't serve or while it is off.
 */
hugoRouter.get('/summary', requireAuth, async (req, res) => {
  const user = req.user!;
  const zero: HugoSummary = { working: 0, needsYou: 0, unseenDone: 0, newNotes: 0 };
  if (!hugoAudienceOf(user)) return void res.json(zero);
  if (!(await inProcessAgent(prisma, 'whatsapp-assistant', tenantIdForWrite()))) return void res.json(zero);
  const [tasks, newNotes] = await Promise.all([hugoTaskCounts(user.id), countNewHugoNotes(user.id)]);
  const out: HugoSummary = { ...tasks, newNotes };
  res.json(out);
});
