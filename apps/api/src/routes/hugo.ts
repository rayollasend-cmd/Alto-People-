import { Router } from 'express';
import { z } from 'zod';
import { hasCapability, termsIn, type Role } from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import { enqueueAudit } from '../lib/audit.js';
import { inProcessAgent, logBuiltInAgentAction } from '../lib/agents.js';
import { pendingDeskApprovals, pendingDeskShiftFills, runningCapabilityKeys } from '../lib/agentCapabilities.js';
import { getBrandingSync } from '../lib/branding.js';
import { computeCoverageForecast } from '../lib/coverageForecast.js';
import { detectHugoIntent, hugoAudienceOf, intentsFor, type HugoAudience, type HugoContext, type HugoIntentKey } from '../lib/hugo.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { loadTenantProfile } from '../lib/tenantProfile.js';
import { answerPayday, answerRide, answerSchedule, handoff } from '../lib/whatsappAssistant.js';
import { WA_REPLY, toWaLang, type WaLang } from '../lib/whatsappContent.js';

/**
 * Hugo in the app (agent families step 3; docs/agent-families-investigation.md §4.5).
 *
 *   GET  /hugo      who he is and what he can do for this person, here
 *   POST /hugo/ask  { text } → { intent, reply, linkUrl }
 *
 *   The same registry as WhatsApp (lib/hugo): an associate asks about their
 *   own payday, ride and schedule, a desk asks about coverage (the Workforce
 *   agent's coverage.forecast, clamped to the desk's own sites) and what the
 *   agents have waiting on it. Only what is on is offered: a module off or a
 *   capability suspended leaves the intent out of the help text and out of
 *   reach. The key into anyone's records is the session, never the request.
 *   Every answer is on Hugo's trail (the intent, never the words asked).
 */

export const hugoRouter = Router();

const AskSchema = z.object({ text: z.string().trim().min(1).max(500) });

interface Asker {
  id: string;
  role: Role;
  associateId: string | null;
  clientId: string | null;
  locationId?: string | null;
  language?: string | null;
}

async function contextFor(user: Asker): Promise<{ tenantId: string; audience: HugoAudience; ctx: HugoContext; lang: WaLang; name: string; profile: Awaited<ReturnType<typeof loadTenantProfile>> }> {
  const audience = hugoAudienceOf(user);
  if (!audience) throw new HttpError(403, 'no_hugo', 'Hugo has nothing for this account.');
  const tenantId = tenantIdForWrite();
  // Hugo is an agent too: his own record suspended, or every agent stopped, and he is silent.
  if (!(await inProcessAgent(prisma, 'whatsapp-assistant', tenantId))) {
    throw new HttpError(409, 'hugo_off', 'The assistant is switched off for now.');
  }
  const profile = await loadTenantProfile(tenantId);
  const running = await runningCapabilityKeys(prisma, tenantId);
  const ctx: HugoContext = { channel: 'app', audience, moduleOn: (m) => profile.modules[m], capabilityOn: (k) => running.has(k) };
  return { tenantId, audience, ctx, lang: toWaLang(user.language), name: getBrandingSync().assistantName, profile };
}

function canList(ctx: HugoContext, lang: WaLang) {
  return intentsFor(ctx)
    .filter((i) => i.help)
    .map((i) => ({ key: i.key, label: i.help![lang].label, example: i.help![lang].example }));
}

const dayLabel = (ymd: string, lang: WaLang) =>
  new Intl.DateTimeFormat(lang === 'es' ? 'es-US' : lang === 'tr' ? 'tr-TR' : 'en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(`${ymd}T12:00:00Z`));

/** coverage.forecast, on request: computed now, clamped to the desk's sites. */
async function answerCoverage(user: Asker, tenantId: string, lang: WaLang, sitesNoun: string, now: Date): Promise<{ reply: string; linkUrl: string | null }> {
  const admin = hasCapability(user.role, 'manage:org');
  const forecast = await computeCoverageForecast(prisma, now, {
    tenantId,
    locationIds: !admin && user.locationId ? [user.locationId] : null,
    clientId: !admin && !user.locationId ? user.clientId : null,
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
async function answerDesk(user: Asker, tenantId: string, lang: WaLang): Promise<{ reply: string; linkUrl: string | null }> {
  const lines: string[] = [];
  let n = 0;
  if (hasCapability(user.role, 'manage:scheduling')) {
    const fills = await pendingDeskShiftFills(prisma, tenantId, { clientId: user.clientId, locationId: user.locationId ?? null });
    n += fills.length;
    lines.push(...fills.slice(0, 4).map((f) => `• ${f.summary}`));
  }
  if (hasCapability(user.role, 'manage:onboarding')) {
    const cases = await pendingDeskApprovals(prisma, tenantId, 'CASE_OPEN');
    n += cases;
  }
  if (!n) return { reply: WA_REPLY.deskNothing(lang), linkUrl: null };
  return { reply: WA_REPLY.deskWaiting(lang, n, lines), linkUrl: '/' };
}

hugoRouter.get('/', requireAuth, async (req, res) => {
  const user = req.user! as Asker;
  const { audience, ctx, lang, name } = await contextFor(user);
  const can = canList(ctx, lang);
  res.json({ name, audience, intro: WA_REPLY.appIntro(lang, name, can.map((c) => c.label.toLowerCase())), can });
});

hugoRouter.post('/ask', requireAuth, async (req, res) => {
  const user = req.user! as Asker;
  const { text } = AskSchema.parse(req.body);
  const { tenantId, audience, ctx, lang, name, profile } = await contextFor(user);
  const now = new Date();
  const { intent } = detectHugoIntent(text, ctx);
  const sitesNoun = termsIn(profile, lang).sites.toLowerCase();
  let out: { reply: string; linkUrl: string | null };
  switch (intent as HugoIntentKey) {
    case 'WHO':
      out = { reply: WA_REPLY.whoAmI(lang, name), linkUrl: null };
      break;
    case 'COVERAGE':
      out = await answerCoverage(user, tenantId, lang, sitesNoun, now);
      break;
    case 'DESK':
      out = await answerDesk(user, tenantId, lang);
      break;
    case 'PAYDAY':
      out = { reply: await answerPayday(user.associateId!, lang, now), linkUrl: null };
      break;
    case 'RIDE':
      out = { reply: await answerRide(prisma, user.associateId!, lang, now), linkUrl: null };
      break;
    case 'SCHEDULE':
      out = { reply: await answerSchedule(prisma, user.associateId!, lang, now), linkUrl: '/scheduling' };
      break;
    case 'HANDOFF': {
      // An associate's question Hugo cannot answer goes to a person, as on WhatsApp.
      const hand = user.associateId ? await handoff(prisma, user.associateId, user.id, text, now, 'Hugo') : { conversationId: null, who: null };
      out = { reply: WA_REPLY.handoff(lang, hand.who), linkUrl: hand.conversationId ? '/messages' : null };
      break;
    }
    default:
      out = { reply: WA_REPLY.appIntro(lang, name, canList(ctx, lang).map((c) => c.label.toLowerCase())), linkUrl: null };
  }
  // On Hugo's trail and the audit log: the intent and who asked, never the words.
  await logBuiltInAgentAction(prisma, 'whatsapp-assistant', { action: 'agent.app.reply', entityType: 'User', entityId: user.id, metadata: { intent, channel: 'app', audience, lang } });
  enqueueAudit({ actorUserId: user.id, clientId: user.clientId, action: 'hugo.asked', entityType: 'Hugo', entityId: intent, metadata: { intent, channel: 'app', audience } }, 'hugo');
  res.json({ intent, reply: out.reply, linkUrl: out.linkUrl });
});
