import { ROLE_LABELS, can, termsIn, type Role } from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { sessionUserById } from '../middleware/auth.js';
import type { SessionUser } from '../types/express.js';
import { internalSites } from './scope.js';
import { inProcessAgent } from './agents.js';
import { pendingDeskApprovals, pendingDeskShiftFills, runningCapabilityKeys } from './agentCapabilities.js';
import type { AssistantTool } from './assistantModel.js';
import { getBrandingSync } from './branding.js';
import { computeCoverageForecast } from './coverageForecast.js';
import { answerRenewals } from './complianceAgent.js';
import { HUGO_INTENTS, detectHugoIntent, hugoAudienceOf, intentsFor, type HugoAudience, type HugoChannel, type HugoContext, type HugoIntent, type HugoIntentKey } from './hugo.js';
import { tenantIdForWrite } from './tenant.js';
import { loadTenantProfile } from './tenantProfile.js';
import { placedClientIds } from './openShiftEligibility.js';
import { answerPayday, answerRide, answerSchedule } from './whatsappAssistant.js';
import { answerDriverNextRun, answerDriverRiders, answerDriverVanIssue } from './transportHugo.js';
import { helpCenterReply, helpCenterToolText, searchHelpCenter } from './helpCenterSearch.js';
import { WA_REPLY, toWaLang, type WaLang } from './whatsappContent.js';

/**
 * Hugo's registry for one person (lib/hugo has the intents and their words):
 * the runner per intent — the person's own payday, ride, shifts, documents;
 * a desk's coverage and what waits on it — and the same answers as the
 * tools a model may call. One place, used by the app's chat (routes/hugo),
 * and by work that runs without a request: goals, recurring briefs and
 * WhatsApp read through registryForUser, with the person's reach as it is now.
 */

export interface Asker {
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
export async function reachSiteIds(user: Asker, tenantId: string): Promise<string[] | null> {
  const sites = internalSites(user as unknown as SessionUser);
  if (!sites) return null;
  const rows = await prisma.site.findMany({ where: { AND: [{ tenantId }, sites] }, select: { id: true } });
  return rows.map((r) => r.id);
}

export interface Answer {
  reply: string;
  linkUrl: string | null;
  /** An offer to pass the question to a person, which they confirm (POST /hugo/handoff). */
  handoff?: { summary: string; who: string | null };
}

export async function contextFor(user: Asker, channel: HugoChannel = 'app'): Promise<{ tenantId: string; audience: HugoAudience; ctx: HugoContext; lang: WaLang; name: string; profile: Awaited<ReturnType<typeof loadTenantProfile>> }> {
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
  const ctx: HugoContext = { channel, audience, moduleOn: (m) => profile.modules[m], capabilityOn: (k) => running.has(k) };
  return { tenantId, audience, ctx, lang: toWaLang(user.language), name, profile };
}

/**
 * The chips under the intro: one per tool the assistant can actually call
 * for this person right now. Derived from the tool list — the same list
 * the model is handed — not from the intent table, so a chip can never
 * offer a question the registry has no runner for (a module off, a
 * capability paused, an intent added without an answer here).
 */
export function canList(tools: AssistantTool[], lang: WaLang, ctx?: HugoContext) {
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
export function registryFor(user: Asker, tenantId: string, lang: WaLang, sitesNoun: string, now: Date, name: string, ctx: HugoContext, text = '') {
  const mk = (k: HugoIntentKey) => answerFor(k, user, tenantId, lang, sitesNoun, now, name, ctx, text);
  return { mk, tools: toolsFor(intentsFor(ctx), mk) };
}

export type Runner = (args?: Record<string, unknown>) => Promise<Answer>;

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
export function handoffOffer(lang: WaLang, who: string | null): string {
  const lead = lang === 'es' ? 'Eso no lo puedo resolver aquí.' : lang === 'tr' ? 'Bunu burada çözemiyorum.' : "I can't sort that out here.";
  return `${lead} ${passQuestion(lang, who)}`;
}

/** "Want me to pass it to …?" — the question half of an offer. */
export function passQuestion(lang: WaLang, who: string | null): string {
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
export async function escalationFor(user: Asker): Promise<{ who: string | null } | null> {
  if (!user.associateId) return null;
  const clientIds = await placedClientIds(user.associateId, prisma);
  if (!clientIds.length) return { who: null };
  const sup = await prisma.user.findFirst({
    where: { role: 'SHIFT_SUPERVISOR', clientId: clientIds[0], status: 'ACTIVE', deletedAt: null },
    select: { associate: { select: { firstName: true, lastName: true } } },
  });
  return { who: sup?.associate ? `${sup.associate.firstName} ${sup.associate.lastName}`.trim() : null };
}

/** A question, as opposed to a statement: ends in "?" or opens with a question word. */
export function looksLikeQuestion(text: string): boolean {
  const t = text.trim().toLowerCase();
  return t.endsWith('?') || /^(how|what|where|when|why|which|who|can|could|do|does|is|are|should|am|may|cuando|como|donde|que|cual|puedo|nasil|nerede|ne zaman|hangi)\b/.test(t);
}

/** The registry alone: the first intent the words reach, or the channel's fallback. */
export async function rulesAnswer(
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


/**
 * The registry for a person outside a request (background work, WhatsApp):
 * their session as it is now — a revoked role or a switched-off assistant
 * answers null, so the work stops rather than reading past it. Runs inside
 * the person's tenant (runWithTenant) like every background step.
 */
export async function registryForUser(userId: string, opts: { now?: Date; text?: string; channel?: HugoChannel } = {}) {
  const user = await sessionUserById(userId);
  if (!user) return null;
  const asker = user as unknown as Asker;
  let context: Awaited<ReturnType<typeof contextFor>>;
  try {
    context = await contextFor(asker, opts.channel ?? 'app');
  } catch (err) {
    if (err instanceof HttpError) return null;
    throw err;
  }
  const now = opts.now ?? new Date();
  const terms = termsIn(context.profile, context.lang);
  const sitesNoun = terms.sites.toLowerCase();
  return { user, asker, ...context, terms, sitesNoun, now, ...registryFor(asker, context.tenantId, context.lang, sitesNoun, now, context.name, context.ctx, opts.text ?? '') };
}

/** The role's label, for a model told who is asking. */
export const roleLabelOf = (role: Role): string => ROLE_LABELS[role] ?? role;
