import { Router } from 'express';
import { internalSites } from '../lib/scope.js';
import type { SessionUser } from '../types/express.js';
import { z } from 'zod';
import { HugoNoteSettingInputSchema, HugoSeenInputSchema, HugoTaskRespondInputSchema, HugoTaskStartSchema, ROLE_LABELS, termsIn, type HugoSummary, type Role, can, redactSensitiveNumbers } from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import { enqueueAudit } from '../lib/audit.js';
import { inProcessAgent, logBuiltInAgentAction } from '../lib/agents.js';
import { pendingDeskApprovals, pendingDeskShiftFills, runningCapabilityKeys } from '../lib/agentCapabilities.js';
import { answerWithModel, modelAvailable, type AssistantPage, type AssistantTool } from '../lib/assistantModel.js';
import { payTools } from '../lib/payAssistantTools.js';
import { getBrandingSync } from '../lib/branding.js';
import { computeCoverageForecast } from '../lib/coverageForecast.js';
import { answerRenewals } from '../lib/complianceAgent.js';
import { HUGO_INTENTS, detectHugoIntent, hugoAudienceOf, intentsFor, type HugoAudience, type HugoContext, type HugoIntent, type HugoIntentKey } from '../lib/hugo.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { loadTenantProfile } from '../lib/tenantProfile.js';
import { placedClientIds } from '../lib/openShiftEligibility.js';
import { answerPayday, answerRide, answerSchedule, handoff } from '../lib/whatsappAssistant.js';
import { answerDriverNextRun, answerDriverRiders, answerDriverVanIssue } from '../lib/transportHugo.js';
import { helpCenterReply, helpCenterToolText, searchHelpCenter } from '../lib/helpCenterSearch.js';
import { WA_REPLY, toWaLang, type WaLang } from '../lib/whatsappContent.js';
import { ActionError, actionTools, decideAction, type ActionContext } from '../lib/assistantActions.js';
import { hugoTaskTurn } from '../lib/hugoTaskChat.js';
import { toHugoLang } from '../lib/hugoWorkCopy.js';
import { cancelHugoTask, getHugoTask, hugoTaskCounts, listHugoTasks, markHugoTasksSeen, respondToHugoTask, startHugoTask } from '../lib/hugoTasks.js';
import { acceptHugoNote, countNewHugoNotes, dismissHugoNote, hugoNoteSettings, listHugoNotes, markHugoNotesSeen, setHugoNoteKind } from '../lib/hugoNotes.js';

/**
 * The assistant in the app (agent families step 3; docs/agent-families-investigation.md §4.5).
 *
 *   GET  /hugo          who it is and what it can do for this person, here
 *   POST /hugo/ask      { text, page?, history? } → { intent, reply, linkUrl, handoff?, source }
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
 *   One registry (lib/hugo) answers on WhatsApp and here: an associate asks
 *   about their own payday, ride, schedule and documents; a desk asks about
 *   coverage and what the agents have waiting on it. Only what is on is
 *   offered. With a model key set, Claude answers with those same answers
 *   as its tools and knows the page the person is on (lib/assistantModel);
 *   without one, the registry answers alone. Either way the key into
 *   anyone's records is the session, never the request, and a question the
 *   assistant cannot answer is said so — an associate is OFFERED a hand-off
 *   to a person and confirms it; nothing is sent behind their back. Every
 *   answer is on the assistant's trail (the intent and the tools, never the
 *   words asked).
 */

export const hugoRouter = Router();

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

interface Asker {
  id: string;
  role: Role;
  associateId: string | null;
  clientId: string | null;
  locationId?: string | null;
  language?: string | null;
  /** Access pack: an office account narrowed to sites/regions (lib/scope.internalSites). */
  scopeSiteIds?: string[];
  scopeRegionIds?: string[];
}

/** The sites a site/region-bound office account reaches, or null when it isn't bound. */
async function reachSiteIds(user: Asker, tenantId: string): Promise<string[] | null> {
  const sites = internalSites(user as unknown as SessionUser);
  if (!sites) return null;
  const rows = await prisma.site.findMany({ where: { AND: [{ tenantId }, sites] }, select: { id: true } });
  return rows.map((r) => r.id);
}

interface Answer {
  reply: string;
  linkUrl: string | null;
  /** An offer to pass the question to a person, which they confirm (POST /hugo/handoff). */
  handoff?: { summary: string; who: string | null };
}

async function contextFor(user: Asker): Promise<{ tenantId: string; audience: HugoAudience; ctx: HugoContext; lang: WaLang; name: string; profile: Awaited<ReturnType<typeof loadTenantProfile>> }> {
  const audience = hugoAudienceOf(user);
  const name = getBrandingSync().assistantName;
  if (!audience) throw new HttpError(403, 'no_hugo', `${name} has nothing for this account.`);
  const tenantId = tenantIdForWrite();
  // The assistant is an agent too: its own record suspended, or every agent stopped, and it is silent.
  if (!(await inProcessAgent(prisma, 'whatsapp-assistant', tenantId))) {
    throw new HttpError(409, 'hugo_off', 'The assistant is switched off for now.');
  }
  const profile = await loadTenantProfile(tenantId);
  const running = await runningCapabilityKeys(prisma, tenantId);
  const ctx: HugoContext = { channel: 'app', audience, moduleOn: (m) => profile.modules[m], capabilityOn: (k) => running.has(k) };
  return { tenantId, audience, ctx, lang: toWaLang(user.language), name, profile };
}

/**
 * The chips under the intro: one per tool the assistant can actually call
 * for this person right now. Derived from the tool list — the same list
 * the model is handed — not from the intent table, so a chip can never
 * offer a question the registry has no runner for (a module off, a
 * capability paused, an intent added without an answer here).
 */
function canList(tools: AssistantTool[], lang: WaLang, ctx?: HugoContext) {
  const fromTools = tools.flatMap((tool) => {
    const i = HUGO_INTENTS.find((x) => x.key === tool.key);
    return i?.help ? [{ key: i.key, label: i.help[lang].label, example: i.help[lang].example }] : [];
  });
  // Work to hand Hugo (lib/hugoTaskChat) has no tool — the chat answers it with a Start card.
  const tasks = ctx
    ? intentsFor(ctx).flatMap((i) => (i.key.startsWith('TASK_') && i.help ? [{ key: i.key, label: i.help[lang].label, example: i.help[lang].example }] : []))
    : [];
  return [...tasks, ...fromTools];
}

/** The registry for one person, in one place: the runner per intent and the tools the model may call. */
function registryFor(user: Asker, tenantId: string, lang: WaLang, sitesNoun: string, now: Date, name: string, ctx: HugoContext, text = '') {
  const mk = (k: HugoIntentKey) => answerFor(k, user, tenantId, lang, sitesNoun, now, name, ctx, text);
  return { mk, tools: toolsFor(intentsFor(ctx), mk) };
}

type Runner = (args?: Record<string, unknown>) => Promise<Answer>;

const dayLabel = (ymd: string, lang: WaLang) =>
  new Intl.DateTimeFormat(lang === 'es' ? 'es-US' : lang === 'tr' ? 'tr-TR' : 'en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(`${ymd}T12:00:00Z`));

/** coverage.forecast, on request: computed now, clamped to the desk's sites. */
async function answerCoverage(user: Asker, tenantId: string, lang: WaLang, sitesNoun: string, now: Date): Promise<Answer> {
  const admin = can(user, 'manage:org');
  // A site/region-bound office account — even one holding manage:org — sees its own sites.
  const reach = await reachSiteIds(user, tenantId);
  const forecast = await computeCoverageForecast(prisma, now, {
    tenantId,
    locationIds: reach ?? (!admin && user.locationId ? [user.locationId] : null),
    clientId: !reach && !admin && !user.locationId ? user.clientId : null,
  });
  if (!forecast.length) return { reply: WA_REPLY.coverageNoTargets(lang, sitesNoun), linkUrl: null };
  const short = forecast
    .flatMap((s) => s.days.filter((d) => d.leadDays < 7 && d.gap > 0).map((d) => ({ s, d })))
    .sort((a, b) => a.d.date.localeCompare(b.d.date) || b.d.gap - a.d.gap);
  if (!short.length) return { reply: WA_REPLY.coverageAllCovered(lang, sitesNoun), linkUrl: null };
  const places = new Set(short.map((x) => x.s.locationId)).size;
  const lines = short.slice(0, 4).map((x) => WA_REPLY.coverageLine(lang, x.s.name, dayLabel(x.d.date, lang), x.d.gap, x.d.bench));
  const first = short[0]!;
  return { reply: WA_REPLY.coverageShort(lang, short.length, places, sitesNoun, lines), linkUrl: `/scheduling?week=${first.d.date}&location=${first.s.locationId}` };
}

/** What the agents have waiting on this desk (the same bounds as the decision queue). */
async function answerDesk(user: Asker, tenantId: string, lang: WaLang): Promise<Answer> {
  const lines: string[] = [];
  let n = 0;
  if (can(user, 'manage:scheduling')) {
    // A site/region-bound office account counts the fills at its own sites, never the whole tenant.
    const reach = await reachSiteIds(user, tenantId);
    const all = await pendingDeskShiftFills(prisma, tenantId, { clientId: user.clientId, locationId: user.locationId ?? null });
    const fills = reach ? all.filter((f) => f.shift?.locationId && reach.includes(f.shift.locationId)) : all;
    n += fills.length;
    lines.push(...fills.slice(0, 4).map((f) => `• ${f.summary}`));
  }
  if (can(user, 'manage:onboarding')) {
    const cases = await pendingDeskApprovals(prisma, tenantId, 'CASE_OPEN');
    n += cases;
  }
  if (!n) return { reply: WA_REPLY.deskNothing(lang), linkUrl: null };
  return { reply: WA_REPLY.deskWaiting(lang, n, lines), linkUrl: '/approvals?tab=proposals' };
}

/** The registry's answer for one intent — the rules path, and the model's tools. */
function answerFor(intent: HugoIntentKey, user: Asker, tenantId: string, lang: WaLang, sitesNoun: string, now: Date, name: string, ctx: HugoContext, text = ''): Runner | null {
  switch (intent) {
    case 'HELP_CENTER':
      // The question's own words are the search; the model may narrow them.
      // Called with args it is the model's tool (every hit, for quoting);
      // without, the rules path (the best article, in the person's language).
      return async (args) => {
        const q = typeof args?.query === 'string' && args.query.trim() ? args.query : text;
        const hits = await searchHelpCenter(q, { clientId: user.clientId });
        const linkUrl = hits[0] ? `/help-center?article=${hits[0].slug}` : null;
        return args ? { reply: helpCenterToolText(hits), linkUrl } : { ...helpCenterReply(lang, hits), linkUrl };
      };
    case 'WHO':
      return async () => ({ reply: WA_REPLY.whoAmI(lang, name), linkUrl: null });
    case 'HELP':
      return async () => ({ reply: WA_REPLY.appIntro(lang, name, canList(registryFor(user, tenantId, lang, sitesNoun, now, name, ctx).tools, lang).map((c) => c.label.toLowerCase())), linkUrl: null });
    case 'COVERAGE':
      return () => answerCoverage(user, tenantId, lang, sitesNoun, now);
    case 'DESK':
      return () => answerDesk(user, tenantId, lang);
    case 'RENEW':
      return () => answerRenewals(prisma, tenantId, user.associateId!, lang, now);
    case 'PAYDAY':
      return async () => {
        const pay = await answerPayday(user.associateId!, lang, now);
        if (pay.scheduled) return { reply: pay.text, linkUrl: '/payroll' };
        // Nobody can answer this but a person: offer one; nothing is sent until they confirm.
        const esc = await escalationFor(user);
        return { reply: `${pay.text} ${passQuestion(lang, esc?.who ?? null)}`, linkUrl: null, handoff: { summary: NO_SCHEDULE_SUMMARY[lang], who: esc?.who ?? null } };
      };
    case 'RIDE':
      return async () => ({ reply: await answerRide(prisma, user.associateId!, lang, now), linkUrl: '/rides' });
    case 'SCHEDULE':
      return async () => ({ reply: await answerSchedule(prisma, user.associateId!, lang, now), linkUrl: '/scheduling' });
    // The driver's own (lib/transportHugo, floor walk 19).
    case 'DRIVER_NEXT_RUN':
      return async () => ({ reply: await answerDriverNextRun(prisma, user.id, lang, now), linkUrl: '/' });
    case 'DRIVER_RUN_RIDERS':
      return async () => ({ reply: await answerDriverRiders(prisma, user.id, lang, now), linkUrl: '/' });
    case 'DRIVER_VAN_ISSUE':
      return async () => ({ reply: answerDriverVanIssue(lang), linkUrl: '/?report=van' });
    default:
      return null;
  }
}

/** What the model may call: the registry's answers open to this person, as tools. */
function toolsFor(open: HugoIntent[], mk: (k: HugoIntentKey) => Runner | null): AssistantTool[] {
  const describe: Partial<Record<HugoIntentKey, [string, string]>> = {
    HELP_CENTER: ['search_help_center', "Search the organization's published help-center articles (policies, how-tos, benefits, time off, conduct). Returns the best matches with an excerpt and a link. Use it for any question about a policy or how something works here, and quote the article."],
    DESK: ['whats_waiting_on_my_desk', "What the agents have waiting on the person's desk: proposals and decisions to make, with a count."],
    COVERAGE: ['coverage_next_7_days', "Where the person's sites are short of people over the next seven days, with the gap per day."],
    RENEW: ['my_documents_to_renew', "The person's own documents that expire soon and what to renew."],
    PAYDAY: ['my_next_payday', "The person's next payday and the pay period it covers."],
    RIDE: ['my_next_ride', "The person's next van ride: when and where the pickup is."],
    SCHEDULE: ['my_next_shifts', "The person's next shifts: days, times and sites."],
    DRIVER_NEXT_RUN: ['my_next_run', "The driver's next van run (or the one on the road): when it leaves, the van, how many riders, which store."],
    DRIVER_RUN_RIDERS: ['riders_on_my_run', "Who is on the driver's next run, in pickup order, with each stop and who is already on board."],
    DRIVER_VAN_ISSUE: ['how_to_report_van_issue', 'How a driver reports a van problem and takes the van off the road from the app.'],
  };
  const out: AssistantTool[] = [];
  for (const i of open) {
    const d = describe[i.key];
    const run = mk(i.key);
    if (!d || !run) continue;
    out.push({
      key: i.key,
      name: d[0],
      description: d[1],
      ...(i.key === 'HELP_CENTER' ? { input: { properties: { query: { type: 'string', description: 'What to search for, in a few words.' } }, required: ['query'] } } : {}),
      run,
    });
  }
  return out;
}

/** The offer, in the person's language: nothing is sent until they confirm. */
function handoffOffer(lang: WaLang, who: string | null): string {
  const lead = lang === 'es' ? 'Eso no lo puedo resolver aquí.' : lang === 'tr' ? 'Bunu burada çözemiyorum.' : "I can't sort that out here.";
  return `${lead} ${passQuestion(lang, who)}`;
}

/** "Want me to pass it to …?" — the question half of an offer. */
function passQuestion(lang: WaLang, who: string | null): string {
  if (lang === 'es') return who ? `¿Quieres que se lo pase a ${who}?` : '¿Quieres que se lo pase a tu supervisor?';
  if (lang === 'tr') return who ? `${who} adlı kişiye iletmemi ister misin?` : 'Yöneticine iletmemi ister misin?';
  return who ? `Want me to pass it to ${who}?` : 'Want me to pass it to your supervisor?';
}

/** What reaches the supervisor when someone on no pay schedule confirms the offer. */
const NO_SCHEDULE_SUMMARY: Record<WaLang, string> = {
  en: 'There is no pay schedule on my record. When is my next payday?',
  es: 'No hay un calendario de pago en mi registro. ¿Cuándo es mi próximo día de pago?',
  tr: 'Kaydımda ödeme takvimi yok. Bir sonraki maaş günüm ne zaman?',
};

/** Who an associate's question would go to — their supervisor at their client, by name when there is one. */
async function escalationFor(user: Asker): Promise<{ who: string | null } | null> {
  if (!user.associateId) return null;
  const clientIds = await placedClientIds(user.associateId, prisma);
  if (!clientIds.length) return { who: null };
  const sup = await prisma.user.findFirst({
    where: { role: 'SHIFT_SUPERVISOR', clientId: clientIds[0], status: 'ACTIVE', deletedAt: null },
    select: { associate: { select: { firstName: true, lastName: true } } },
  });
  return { who: sup?.associate ? `${sup.associate.firstName} ${sup.associate.lastName}`.trim() : null };
}

hugoRouter.get('/', requireAuth, async (req, res) => {
  const user = req.user! as Asker;
  const { tenantId, audience, ctx, lang, name, profile } = await contextFor(user);
  const sitesNoun = termsIn(profile, lang).sites.toLowerCase();
  const can = canList(registryFor(user, tenantId, lang, sitesNoun, new Date(), name, ctx).tools, lang, ctx);
  res.json({ name, audience, intro: WA_REPLY.appIntro(lang, name, can.map((c) => c.label.toLowerCase()), { tasks: can.some((c) => c.key.startsWith('TASK_')) }), can, model: modelAvailable() });
});

hugoRouter.post('/ask', requireAuth, async (req, res) => {
  const user = req.user! as Asker;
  const parsed = AskSchema.parse(req.body);
  // An SSN or account number never reaches the model, a hand-off or a log
  // (the app stops them first; this is the backstop — shared/sensitiveText).
  const text = redactSensitiveNumbers(parsed.text);
  const page = parsed.page;
  const history = parsed.history?.map((h) => ({ ...h, text: redactSensitiveNumbers(h.text) }));
  const { tenantId, audience, ctx, lang, name, profile } = await contextFor(user);
  const now = new Date();
  const terms = termsIn(profile, lang);
  const sitesNoun = terms.sites.toLowerCase();
  const { mk, tools } = registryFor(user, tenantId, lang, sitesNoun, now, name, ctx, text);

  // Work handed to Hugo is answered with a Start card, the same with or
  // without the model: what Hugo will do for someone is never a guess.
  const taskTurn = await hugoTaskTurn(text, req.user!, ctx, toHugoLang(user.language), now);
  if (taskTurn) {
    await logBuiltInAgentAction(prisma, 'whatsapp-assistant', { action: 'agent.app.reply', entityType: 'User', entityId: user.id, metadata: { intent: taskTurn.intent, tools: [], source: 'rules', channel: 'app', audience, lang, offers: taskTurn.offers.map((o) => o.task.kind) } });
    enqueueAudit({ actorUserId: user.id, clientId: user.clientId, action: 'hugo.asked', entityType: 'Hugo', entityId: taskTurn.intent, metadata: { intent: taskTurn.intent, tools: [], source: 'rules', channel: 'app', audience } }, 'hugo');
    res.json({ intent: taskTurn.intent, reply: taskTurn.reply, linkUrl: null, handoff: null, source: 'rules', actions: [], tables: [], offers: taskTurn.offers, view: taskTurn.view ?? null });
    return;
  }

  let intent: string;
  let out: Answer;
  let offer: { summary: string; who: string | null } | null;
  let source: 'model' | 'rules' = 'rules';
  let toolsUsed: string[] = [];

  // What the model may propose (never do): confirmation cards and tables collected as it works.
  const acting: ActionContext = { req, user: req.user!, proposals: [], tables: [] };
  if (modelAvailable()) {
    source = 'model';
    const escalation = audience === 'associate' ? await escalationFor(user) : null;
    const actTools = actionTools(acting);
    try {
      const answer = await answerWithModel({
        text,
        history: history ?? [],
        page: (page ?? null) as AssistantPage | null,
        // A worker's own paystub and withholding (lib/payAssistantTools) — their records only.
        tools: [...tools, ...actTools, ...payTools(prisma, user)],
        identity: {
          name,
          product: getBrandingSync().orgName || 'Alto People',
          audience,
          roleLabel: ROLE_LABELS[user.role] ?? user.role,
          lang,
          terms: { worker: terms.worker, workers: terms.workers, site: terms.site, sites: terms.sites, manager: terms.manager, managers: terms.managers },
          escalation,
          canPropose: actTools.some((t) => t.name.startsWith('propose_')),
        },
        now,
      });
      intent = 'MODEL';
      toolsUsed = answer.toolsUsed;
      out = { reply: answer.reply || WA_REPLY.appIntro(lang, name, canList(tools, lang).map((c) => c.label.toLowerCase())), linkUrl: answer.linkUrl };
      offer = answer.handoff;
    } catch (err) {
      // The model is a convenience over the registry, never a dependency:
      // a timeout or an outage falls back to the rules path below.
      console.warn('[assistant] model answer failed; answering from the registry:', err instanceof Error ? err.message : err);
      source = 'rules';
      ({ intent, out, offer } = await rulesAnswer(text, user, ctx, lang, name, mk, tools));
    }
  } else {
    ({ intent, out, offer } = await rulesAnswer(text, user, ctx, lang, name, mk, tools));
  }

  // On the assistant's trail and the audit log: the intent and the tools, never the words.
  await logBuiltInAgentAction(prisma, 'whatsapp-assistant', { action: 'agent.app.reply', entityType: 'User', entityId: user.id, metadata: { intent, tools: toolsUsed, source, channel: 'app', audience, lang } });
  enqueueAudit({ actorUserId: user.id, clientId: user.clientId, action: 'hugo.asked', entityType: 'Hugo', entityId: intent, metadata: { intent, tools: toolsUsed, source, channel: 'app', audience } }, 'hugo');
  res.json({ intent, reply: out.reply, linkUrl: out.linkUrl, handoff: offer, source, actions: acting.proposals, tables: acting.tables, offers: [], view: null });
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

/** A question, as opposed to a statement: ends in "?" or opens with a question word. */
function looksLikeQuestion(text: string): boolean {
  const t = text.trim().toLowerCase();
  return t.endsWith('?') || /^(how|what|where|when|why|which|who|can|could|do|does|is|are|should|am|may|cuando|como|donde|que|cual|puedo|nasil|nerede|ne zaman|hangi)\b/.test(t);
}

/** The registry alone: the first intent the words reach, or the channel's fallback. */
async function rulesAnswer(
  text: string,
  user: Asker,
  ctx: HugoContext,
  lang: WaLang,
  name: string,
  mk: (k: HugoIntentKey) => Runner | null,
  tools: AssistantTool[],
): Promise<{ intent: string; out: Answer; offer: { summary: string; who: string | null } | null }> {
  const { intent } = detectHugoIntent(text, ctx);
  if ((intent === 'HANDOFF' && looksLikeQuestion(text)) || intent === 'HELP') {
    // Nothing in the registry covers a QUESTION: the help center may. A
    // published article that matches answers before anyone is bothered. A
    // problem stated plainly ("my badge broke") still goes to a person.
    if (mk('HELP_CENTER')) {
      const hits = await searchHelpCenter(text, { clientId: user.clientId });
      if (hits.length > 0) return { intent: 'HELP_CENTER', out: { ...helpCenterReply(lang, hits), linkUrl: `/help-center?article=${hits[0]!.slug}` }, offer: null };
    }
  }
  if (intent === 'HANDOFF') {
    // Nothing covers it. An associate is offered a person and confirms;
    // the question is not sent anywhere yet.
    const esc = await escalationFor(user);
    return {
      intent,
      out: { reply: handoffOffer(lang, esc?.who ?? null), linkUrl: null },
      offer: user.associateId ? { summary: text, who: esc?.who ?? null } : null,
    };
  }
  const run = mk(intent as HugoIntentKey);
  const out: Answer = run ? await run() : { reply: WA_REPLY.appIntro(lang, name, canList(tools, lang).map((c) => c.label.toLowerCase())), linkUrl: null };
  return { intent, out, offer: user.associateId ? (out.handoff ?? null) : null };
}

/** The confirmed hand-off: the associate's question, as a thread with their supervisor. */
hugoRouter.post('/handoff', requireAuth, async (req, res) => {
  const user = req.user! as Asker;
  const text = redactSensitiveNumbers(HandoffSchema.parse(req.body).text);
  const { lang, name } = await contextFor(user);
  if (!user.associateId) throw new HttpError(403, 'no_handoff', 'Only a worker\'s question can be passed to their supervisor.');
  const hand = await handoff(prisma, user.associateId, user.id, text, new Date(), name);
  await logBuiltInAgentAction(prisma, 'whatsapp-assistant', { action: 'agent.app.handoff', entityType: 'User', entityId: user.id, metadata: { channel: 'app', sent: Boolean(hand.conversationId) } });
  res.json({ reply: hand.conversationId ? WA_REPLY.handoff(lang, hand.who) : WA_REPLY.handoffUnsent(lang), linkUrl: hand.conversationId ? `/messages/${hand.conversationId}` : hand.conversationId === null ? null : '/messages', sent: Boolean(hand.conversationId) });
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
  res.json({ task: await respondToHugoTask(user, id, choice) });
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
