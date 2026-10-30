import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Hugo on WhatsApp has the app's brain (lib/hugoWhatsapp) and keeps every
 * WhatsApp rule: the commands stay deterministic, a plain question about
 * the person's own records is the registry's answer at once, anything else
 * goes to the model with their own tools and the thread's last day, plain
 * text with the AI disclosure line; the registry answers whenever the model
 * can't. Work to hand over is offered with "Reply START", and START is the
 * person's tap. The model is scripted here (no SDK call).
 */

type Ask = {
  text: string;
  history: Array<{ role: string; text: string }>;
  page: unknown;
  tools: Array<{ key: string }>;
  identity: { audience: string; lang: string; escalation: unknown; canPropose?: boolean };
  tier?: string;
  meter: { userId: string; purpose: string };
  channel?: string;
};
const model = vi.hoisted(() => ({
  available: true,
  behave: 'answer' as 'answer' | 'escalate' | 'fail' | 'allowance' | 'markdown' | 'long',
  asks: [] as Ask[],
}));
vi.mock('../../lib/assistantModel.js', async (orig) => {
  const real = await orig<typeof import('../../lib/assistantModel.js')>();
  return {
    ...real,
    modelAvailable: () => model.available,
    answerWithModel: vi.fn(async (input: Ask) => {
      model.asks.push(input);
      if (model.behave === 'fail') throw new Error('upstream overloaded');
      if (model.behave === 'allowance') {
        const { HugoAllowanceError } = await import('../../lib/hugoAllowance.js');
        throw new HugoAllowanceError(new Date('2026-12-01T08:00:00Z'));
      }
      if (model.behave === 'escalate') return { reply: "I can't see that from here.", linkUrl: null, toolsUsed: [], handoff: { summary: 'Address change', who: null } };
      if (model.behave === 'markdown') {
        return {
          reply: '## Your paystub\n**Gross** was $400.\n- Regular: 20 h\n| Tax | Amount |\n|---|---|\n| Federal | $30 |\nSee [your pay](/payroll) or go to /time-off.',
          linkUrl: '/payroll?item=abc',
          toolsUsed: ['PAYSTUB'],
          handoff: null,
        };
      }
      if (model.behave === 'long') return { reply: `${'Your overtime is on the next check. '.repeat(40)}`, linkUrl: null, toolsUsed: [], handoff: null };
      return { reply: 'Your overtime from last week is on the next check.', linkUrl: null, toolsUsed: ['PAYSTUB'], handoff: null };
    }),
  };
});

import { env } from '../../config/env.js';
import { ensureBuiltInAgents } from '../../lib/agents.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { sweepHugoTasks } from '../../lib/hugoTasks.js';
import { historyText, plainForWhatsApp } from '../../lib/hugoWhatsapp.js';
import { startReply } from '../../lib/hugoWhatsappOffers.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { ALTO_TENANT_ID, runWithTenant } from '../../lib/tenant.js';
import { setWhatsAppSenderForTests, type WaPayload } from '../../lib/whatsapp.js';
import { handleInbound } from '../../lib/whatsappAssistant.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

const H = 3_600_000;
const savedValve = env.HUGO_WA_MODEL_TENANT_DAILY;
let sent: WaPayload[] = [];
let n = 0;

beforeEach(async () => {
  await truncateAll();
  sent = [];
  model.available = true;
  model.behave = 'answer';
  model.asks = [];
  setWhatsAppSenderForTests(async (payload) => {
    sent.push(payload);
    return { id: `wamid.out.${++n}` };
  });
});
afterEach(() => {
  setWhatsAppSenderForTests(null);
  Object.assign(env, { HUGO_WA_MODEL_TENANT_DAILY: savedValve });
});
afterAll(async () => {
  await prisma.$disconnect();
});

const ANA = '18505550101';
const BO = '18505550202';
const CY = '18505550303';

/** A store with Ana and Bo placed (a supervisor there), Cy placed nowhere; all three opted in; Hugo on. */
async function world() {
  await createUser({ role: 'HR_ADMINISTRATOR', email: 'owner@example.com' });
  await ensureBuiltInAgents(prisma, ALTO_TENANT_ID);
  const client = await createClient('Coastal Resort');
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id });
  const person = async (firstName: string, phone: string, placed: boolean) => {
    const a = await createAssociate({ firstName, lastName: 'Test' });
    if (placed) await prisma.associateAssignment.create({ data: { associateId: a.id, locationId: site.id, startedAt: new Date('2026-01-01') } });
    const { user } = await createUser({ role: 'ASSOCIATE', associateId: a.id });
    await prisma.whatsAppConsent.create({ data: { associateId: a.id, phone, status: 'OPTED_IN', source: 'app', lastInboundAt: new Date() } });
    return { associate: a, user };
  };
  return { client, site, sup, ana: await person('Ana', ANA, true), bo: await person('Bo', BO, true), cy: await person('Cy', CY, false) };
}

const ask = (from: string, text: string, now?: Date) => handleInbound({ from, waMessageId: `wamid.in.${++n}`, text }, prisma, now);
const inboundRow = (associateId: string) => prisma.whatsAppMessage.findFirstOrThrow({ where: { associateId, direction: 'INBOUND' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
const hugoOf = async (associateId: string) => (await inboundRow(associateId)).hugo as Record<string, unknown> & { route?: string; offer?: Record<string, unknown> };

describe('what must stay deterministic does — the model is never asked', () => {
  it('unknown number, call-out, the YES to the Workforce agent, STOP / START, a language, who he is', async () => {
    const w = await world();
    // An unknown number: no reply, nothing sent (the webhook files no record for it — whatsapp.test).
    expect(await ask('18505559999', 'why was my check short?')).toMatchObject({ reply: null, associateId: null });
    expect(sent).toEqual([]);

    // A call-out, and the YES that confirms it.
    const startsAt = new Date(Date.now() + 20 * H);
    await prisma.shift.create({ data: { clientId: w.client.id, locationId: w.site.id, position: 'Server', startsAt, endsAt: new Date(startsAt.getTime() + 8 * H), status: 'ASSIGNED', assignedAssociateId: w.ana.associate.id, publishedAt: new Date() } });
    expect((await ask(ANA, "I'm sick and can't come in")).intent).toBe('CALL_OUT');
    expect((await ask(ANA, 'yes')).intent).toBe('CALL_OUT');
    expect(await prisma.callOut.count({ where: { associateId: w.ana.associate.id } })).toBe(1);

    // Bo's YES answers the Workforce agent's "are you coming?".
    const boShift = await prisma.shift.create({ data: { clientId: w.client.id, locationId: w.site.id, position: 'Cook', startsAt, endsAt: new Date(startsAt.getTime() + 8 * H), status: 'ASSIGNED', assignedAssociateId: w.bo.associate.id, publishedAt: new Date() } });
    const agent = await prisma.agentProfile.findFirstOrThrow({ where: { builtInKey: 'whatsapp-assistant' } });
    await prisma.attendanceConfirmation.create({ data: { shiftId: boShift.id, associateId: w.bo.associate.id, workerId: agent.workerId, channel: 'WHATSAPP', sentAt: new Date(), cutoffAt: new Date(startsAt.getTime() - 12 * H) } });
    expect((await ask(BO, 'yes')).intent).toBe('CONFIRM_YES');

    expect((await ask(CY, 'who are you?')).intent).toBe('WHO');
    expect((await ask(CY, 'Español')).intent).toBe('LANGUAGE');
    expect((await ask(CY, 'BAJA')).intent).toBe('OPT_OUT');
    expect((await prisma.whatsAppConsent.findUniqueOrThrow({ where: { associateId: w.cy.associate.id } })).status).toBe('OPTED_OUT');
    expect((await ask(CY, 'ALTA')).intent).toBe('OPT_IN');
    expect((await prisma.whatsAppConsent.findUniqueOrThrow({ where: { associateId: w.cy.associate.id } })).status).toBe('OPTED_IN');

    expect(model.asks).toEqual([]);
  });

  it('opted out, a question is still recorded but nothing is asked of the model', async () => {
    const w = await world();
    await prisma.whatsAppConsent.update({ where: { associateId: w.ana.associate.id }, data: { status: 'OPTED_OUT' } });
    await ask(ANA, 'why was my paycheck short this week?');
    expect(model.asks).toEqual([]);
    expect(sent).toEqual([]);
  });
});

describe('the quickest way that answers well', () => {
  it('a plain question about their own records is the registry’s answer at once', async () => {
    const w = await world();
    const r = await ask(ANA, "what's my schedule?");
    expect(r.intent).toBe('SCHEDULE');
    expect(r.reply).toContain('Nothing is on your schedule yet');
    expect(model.asks).toEqual([]);
    expect(await hugoOf(w.ana.associate.id)).toEqual({ route: 'instant' });
  });

  it('a judgment question goes to the quick model with their own tools, the day’s thread and the WhatsApp rules', async () => {
    const w = await world();
    const now = Date.now();
    const row = (associateId: string, direction: 'INBOUND' | 'OUTBOUND', body: string, minsAgo: number, status: 'SENT' | 'RECEIVED' | 'FAILED' = direction === 'INBOUND' ? 'RECEIVED' : 'SENT') =>
      prisma.whatsAppMessage.create({ data: { associateId, phone: ANA, direction, kind: direction === 'INBOUND' ? 'QUESTION' : 'ANSWER', body, status, createdAt: new Date(now - minsAgo * 60_000) } });
    await row(w.ana.associate.id, 'INBOUND', 'from yesterday morning', 30 * 60);
    await row(w.ana.associate.id, 'INBOUND', 'q1', 100);
    await row(w.ana.associate.id, 'OUTBOUND', 'a1', 95);
    await row(w.ana.associate.id, 'INBOUND', 'q2', 90);
    await row(w.ana.associate.id, 'OUTBOUND', 'a2', 85);
    await row(w.ana.associate.id, 'INBOUND', 'q3', 80);
    await row(w.ana.associate.id, 'OUTBOUND', 'a3\n\nSent by Hugo, an AI agent — Pat Owner answers for it.', 75);
    await row(w.ana.associate.id, 'INBOUND', 'q4 my ssn is 123-45-6789', 70);
    await row(w.ana.associate.id, 'OUTBOUND', 'a4', 65);
    await row(w.ana.associate.id, 'INBOUND', 'q5', 60);
    await row(w.ana.associate.id, 'OUTBOUND', 'Tu próximo pago es el viernes.\n\nEnviado por Hugo, un agente de IA — tu supervisor responde por él.', 58);
    await row(w.ana.associate.id, 'OUTBOUND', 'a5 never delivered', 55, 'FAILED');
    await row(w.ana.associate.id, 'OUTBOUND', 'a5', 50);
    await row(w.bo.associate.id, 'INBOUND', 'bo private', 40);

    const r = await ask(ANA, 'why was my paycheck short this week?');
    expect(r.intent).toBe('MODEL');
    expect(model.asks).toHaveLength(1);
    const a = model.asks[0]!;
    expect(a).toMatchObject({ tier: 'fast', channel: 'whatsapp', page: null, meter: { userId: w.ana.user.id, purpose: 'whatsapp' } });
    expect(a.identity).toMatchObject({ audience: 'associate', lang: 'en', canPropose: false });
    expect(a.identity.escalation).not.toBeNull();
    const keys = a.tools.map((t) => t.key);
    expect(keys).toEqual(expect.arrayContaining(['PAYDAY', 'SCHEDULE', 'PAYSTUB', 'W4_CHECK']));
    expect(keys.some((k) => k === 'DESK' || k === 'COVERAGE' || k.startsWith('ACT_'))).toBe(false);
    // The last 8 within 24 hours (a2 … a5), oldest first, opening with the person, one side's run as one turn;
    // no disclosure line, no SSN, nobody else's, no failed send, nothing older than a day.
    expect(a.history).toEqual([
      { role: 'user', text: 'q3' },
      { role: 'assistant', text: 'a3' },
      { role: 'user', text: 'q4 my ssn is [number removed]' },
      { role: 'assistant', text: 'a4' },
      { role: 'user', text: 'q5' },
      { role: 'assistant', text: 'Tu próximo pago es el viernes.\na5' },
    ]);
    expect(a.text).toBe('why was my paycheck short this week?');

    // The reply carries the AI disclosure, and the trail says MODEL and the tier — never the words.
    expect(r.reply).toMatch(/^Your overtime from last week is on the next check\.\n\nSent by .+, an AI agent — .+ answers for it\.$/);
    expect(sent[sent.length - 1]).toMatchObject({ to: ANA, text: r.reply });
    expect(await hugoOf(w.ana.associate.id)).toEqual({ route: 'fast' });
    await flushPendingAudits();
    const trail = await prisma.auditLog.findFirstOrThrow({ where: { action: 'agent.whatsapp.reply' }, orderBy: { createdAt: 'desc' } });
    expect(trail.metadata).toMatchObject({ intent: 'MODEL', tier: 'fast', source: 'model', kind: 'ANSWER', tools: ['PAYSTUB'] });
    const asked = await prisma.auditLog.findFirstOrThrow({ where: { action: 'hugo.asked' } });
    expect(asked).toMatchObject({ actorUserId: w.ana.user.id, entityId: 'MODEL', metadata: expect.objectContaining({ channel: 'whatsapp', tier: 'fast', source: 'model' }) });
    const all = JSON.stringify(await prisma.auditLog.findMany({ select: { metadata: true } }));
    expect(all).not.toContain('paycheck short');
  });

  it('several questions at once, or a long story, go to the strong model', async () => {
    await world();
    await ask(ANA, 'Was I paid for Saturday? And why is my overtime missing?');
    expect(model.asks.map((a) => a.tier)).toEqual(['deep']);
  });

  it('an SSN or account number never reaches the model', async () => {
    await world();
    await ask(ANA, 'my ssn is 123-45-6789, why is my pay wrong?');
    expect(model.asks[0]!.text).toBe('my ssn is [number removed], why is my pay wrong?');
    expect(JSON.stringify(model.asks)).not.toContain('6789');
  });

  it('the model’s words go out as plain WhatsApp text, links in full, at most 900 characters', async () => {
    await world();
    model.behave = 'markdown';
    const r = await ask(ANA, 'why does my paystub look like this?');
    const base = env.APP_BASE_URL.replace(/\/+$/, '');
    const body = r.reply!.split('\n\nSent by')[0]!;
    expect(body).not.toMatch(/[*#`|]|\]\(/);
    expect(body).toContain('Gross was $400.');
    expect(body).toContain('• Regular: 20 h');
    expect(body).toContain('Federal — $30');
    expect(body).toContain(`your pay: ${base}/payroll`);
    expect(body).toContain(`go to ${base}/time-off.`);

    model.behave = 'long';
    const long = await ask(ANA, 'why is my overtime always late?');
    const words = long.reply!.split('\n\nSent by')[0]!;
    expect(words.length).toBeLessThanOrEqual(900);
    expect(words.endsWith('.')).toBe(true);
  });
});

describe('a person, when the model can’t help', () => {
  it('escalate_to_person hands the question to their supervisor at once, and says so', async () => {
    const w = await world();
    model.behave = 'escalate';
    const r = await ask(ANA, 'can my address be changed to 12 Palm St?');
    expect(r.intent).toBe('MODEL');
    expect(r.reply).toContain("I can't see that from here.");
    expect(r.reply).toContain('I have passed this to');
    const out = await prisma.whatsAppMessage.findFirstOrThrow({ where: { associateId: w.ana.associate.id, direction: 'OUTBOUND' }, orderBy: { createdAt: 'desc' } });
    expect(out.kind).toBe('HANDOFF');
    expect(out.conversationId).not.toBeNull();
    const msg = await prisma.message.findFirstOrThrow({ where: { conversationId: out.conversationId! } });
    expect(msg).toMatchObject({ body: '[WhatsApp] can my address be changed to 12 Palm St?', senderId: w.ana.user.id });
  });

  it('…and says it could not when nobody was reached', async () => {
    await world();
    model.behave = 'escalate';
    const r = await ask(CY, 'can my address be changed?');
    expect(r.reply).toContain("I couldn't reach your");
    expect(r.reply).not.toContain('I have passed this');
    expect(await prisma.message.count()).toBe(0);
  });
});

describe('the registry, whenever the model can’t answer', () => {
  it('no key: the registry exactly as before (a question it can’t answer goes to a person)', async () => {
    const w = await world();
    model.available = false;
    const r = await ask(ANA, 'can my address be changed to 12 Palm St?');
    expect(r.intent).toBe('HANDOFF');
    expect(r.reply).toContain('I have passed this to');
    expect(model.asks).toEqual([]);
    expect(await hugoOf(w.ana.associate.id)).toEqual({ route: 'rules' });
  });

  it('the tenant’s daily valve: past it, the registry; 0 turns the model off', async () => {
    const w = await world();
    Object.assign(env, { HUGO_WA_MODEL_TENANT_DAILY: 1 });
    expect((await ask(ANA, 'why was my paycheck short?')).intent).toBe('MODEL');
    const second = await ask(BO, 'why is my schedule wrong this week?');
    expect(second.intent).toBe('SCHEDULE');
    expect(model.asks).toHaveLength(1);
    expect(await hugoOf(w.bo.associate.id)).toEqual({ route: 'rules', valve: true });
    Object.assign(env, { HUGO_WA_MODEL_TENANT_DAILY: 0 });
    await ask(CY, 'why is my schedule wrong?');
    expect(model.asks).toHaveLength(1);
  });

  it('a model failure: the registry', async () => {
    const w = await world();
    model.behave = 'fail';
    const r = await ask(ANA, 'why is my schedule wrong this week?');
    expect(r.intent).toBe('SCHEDULE');
    expect(r.reply).toContain('Nothing is on your schedule yet');
    expect(await hugoOf(w.ana.associate.id)).toEqual({ route: 'fast', failed: true });
  });

  it('the person’s allowance used up: the registry, and why — once a period', async () => {
    const w = await world();
    model.behave = 'allowance';
    const first = await ask(ANA, 'why is my schedule wrong this week?');
    expect(first.intent).toBe('SCHEDULE');
    expect(first.reply).toContain('Nothing is on your schedule yet');
    expect(first.reply).toContain("I've used up this month's thinking time");
    expect(await hugoOf(w.ana.associate.id)).toEqual({ route: 'rules', allowance: { renewsAt: '2026-12-01T08:00:00.000Z', told: true } });
    const again = await ask(ANA, 'why is my schedule so short?');
    expect(again.reply).not.toContain('thinking time');
    // Bo has his own allowance and hears it himself.
    expect((await ask(BO, 'why is my schedule wrong?')).reply).toContain('thinking time');
  });
});

describe('work handed over on WhatsApp: START is the tap', () => {
  it('offers a watch, takes START from the person it was offered to, and runs it as them', async () => {
    const w = await world();
    const offer = await ask(ANA, 'tell me when I get paid');
    expect(offer.intent).toBe('TASK_TELL_ME_WHEN');
    expect(offer.reply).toContain('your next paycheck');
    expect(offer.reply).toContain('Reply START within 30 minutes');
    expect(model.asks).toEqual([]);
    const pending = (await hugoOf(w.ana.associate.id)).offer!;
    expect(pending).toMatchObject({ userId: w.ana.user.id, state: 'PENDING', tasks: [{ kind: 'WATCH_PAYCHECK' }] });

    // Someone else's START is their own opt-in, nothing more.
    expect((await ask(BO, 'START')).intent).toBe('OPT_IN');
    expect(await prisma.hugoTask.count()).toBe(0);

    const started = await ask(ANA, 'START');
    expect(started.intent).toBe('TASK_START');
    expect(started.reply).toContain("I'll tell you here and in the app when it's paid");
    expect(started.reply).toContain('?hugo=task:');
    const task = await prisma.hugoTask.findFirstOrThrow({ where: { userId: w.ana.user.id } });
    expect(task).toMatchObject({ kind: 'WATCH_PAYCHECK', source: 'whatsapp' });
    const offerRow = await prisma.whatsAppMessage.findFirstOrThrow({ where: { associateId: w.ana.associate.id, hugo: { path: ['offer', 'state'], equals: 'TAKEN' } } });
    expect((offerRow.hugo as { offer: { taskId: string } }).offer.taskId).toBe(task.id);
    expect((await prisma.whatsAppConsent.findUniqueOrThrow({ where: { associateId: w.ana.associate.id } })).status).toBe('OPTED_IN');
    await flushPendingAudits();
    expect(await prisma.auditLog.count({ where: { action: 'hugo.task_started', metadata: { path: ['source'], equals: 'whatsapp' } } })).toBe(1);

    // Taken once: START again is the opt-in it always was.
    expect((await ask(ANA, 'START')).intent).toBe('OPT_IN');
    expect(await prisma.hugoTask.count()).toBe(1);

    // When it's paid, the news comes back here as well as in the app.
    const run = await prisma.payrollRun.create({ data: { periodStart: new Date('2026-10-03'), periodEnd: new Date('2026-10-16'), status: 'DISBURSED', totalGross: 800, totalTax: 0, totalNet: 800, totalEmployerTax: 0 } });
    await prisma.payrollItem.create({ data: { payrollRunId: run.id, associateId: w.ana.associate.id, hoursWorked: 40, hourlyRate: 20, grossPay: 800, federalWithholding: 0, netPay: 800, status: 'DISBURSED', disbursedAt: new Date() } });
    const before = sent.length;
    await runWithTenant(ALTO_TENANT_ID, 'job', () => sweepHugoTasks(new Date(Date.now() + 16 * 60_000)));
    await flushPendingNotifications();
    expect((await prisma.hugoTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('DONE');
    const news = sent.slice(before).filter((p) => p.to === ANA);
    expect(news).toHaveLength(1);
    const newsRow = await prisma.whatsAppMessage.findFirstOrThrow({ where: { associateId: w.ana.associate.id, category: 'hugo_task_done' } });
    expect(newsRow.body).toMatch(/an AI agent/);
  });

  it('a watch started in the app keeps its news to the app', async () => {
    const w = await world();
    const { startHugoTask } = await import('../../lib/hugoTasks.js');
    const { sessionUserById } = await import('../../middleware/auth.js');
    const me = (await sessionUserById(w.bo.user.id))!;
    await runWithTenant(ALTO_TENANT_ID, 'default', () => startHugoTask(me, { kind: 'WATCH_PAYCHECK' }, 'panel'));
    const run = await prisma.payrollRun.create({ data: { periodStart: new Date('2026-10-03'), periodEnd: new Date('2026-10-16'), status: 'DISBURSED', totalGross: 800, totalTax: 0, totalNet: 800, totalEmployerTax: 0 } });
    await prisma.payrollItem.create({ data: { payrollRunId: run.id, associateId: w.bo.associate.id, hoursWorked: 40, hourlyRate: 20, grossPay: 800, federalWithholding: 0, netPay: 800, status: 'DISBURSED', disbursedAt: new Date() } });
    await runWithTenant(ALTO_TENANT_ID, 'job', () => sweepHugoTasks(new Date(Date.now() + 16 * 60_000)));
    await flushPendingNotifications();
    expect(sent.filter((p) => p.to === BO)).toEqual([]);
  });

  it('START after 30 minutes starts nothing and says so', async () => {
    const w = await world();
    await ask(ANA, 'tell me when I get paid');
    const late = await ask(ANA, 'START', new Date(Date.now() + 31 * 60_000));
    expect(late.intent).toBe('TASK_START');
    expect(late.reply).toContain('more than 30 minutes ago');
    expect(await prisma.hugoTask.count()).toBe(0);
    expect(await prisma.whatsAppMessage.count({ where: { associateId: w.ana.associate.id, hugo: { path: ['offer', 'state'], equals: 'EXPIRED' } } })).toBe(1);
  });

  it('STOP / BAJA / DUR still mean opt-out, and set the offer aside', async () => {
    const w = await world();
    await ask(ANA, 'avísame cuando me paguen');
    expect((await ask(ANA, 'BAJA')).intent).toBe('OPT_OUT');
    expect((await prisma.whatsAppConsent.findUniqueOrThrow({ where: { associateId: w.ana.associate.id } })).status).toBe('OPTED_OUT');
    expect(await prisma.whatsAppMessage.count({ where: { hugo: { path: ['offer', 'state'], equals: 'VOID' } } })).toBe(1);
    // Back on with EMPEZAR: an opt-in, not the offer.
    expect((await ask(ANA, 'EMPEZAR')).intent).toBe('OPT_IN');
    expect(await prisma.hugoTask.count()).toBe(0);
  });

  it('several on offer: numbered, picked by number, in the person’s language', async () => {
    const w = await world();
    await prisma.user.update({ where: { id: w.ana.user.id }, data: { language: 'es' } });
    await prisma.timeOffRequest.create({ data: { associateId: w.ana.associate.id, category: 'PTO', startDate: new Date('2026-12-01'), endDate: new Date('2026-12-02'), requestedMinutes: 960 } });
    const offer = await ask(ANA, 'avísame cuando haya novedades');
    expect(offer.reply).toContain('1. tu solicitud de tiempo libre');
    expect(offer.reply).toContain('Responde EMPEZAR y su número');
    const which = await ask(ANA, 'empezar');
    expect(which.intent).toBe('TASK_START');
    expect(which.reply).toContain('¿Cuál?');
    expect(await prisma.hugoTask.count()).toBe(0);
    const one = await ask(ANA, 'EMPEZAR 1');
    expect(one.reply).toContain('Listo: estoy pendiente de tu solicitud de tiempo libre');
    expect((await prisma.hugoTask.findFirstOrThrow({ where: { userId: w.ana.user.id } })).kind).toBe('WATCH_TIME_OFF');
  });

  it('finding cover changes a schedule: it starts in the app', async () => {
    const w = await world();
    const startsAt = new Date(Date.now() + 48 * H);
    await prisma.shift.create({ data: { clientId: w.client.id, locationId: w.site.id, position: 'Server', startsAt, endsAt: new Date(startsAt.getTime() + 8 * H), status: 'ASSIGNED', assignedAssociateId: w.ana.associate.id, publishedAt: new Date() } });
    const r = await ask(ANA, 'find someone to cover my shift');
    expect(r.intent).toBe('TASK_FIND_COVER');
    expect(r.reply).toContain('That starts in the app');
    expect(r.reply).toContain('/scheduling?hugo=chat');
    expect(await hugoOf(w.ana.associate.id)).toEqual({ route: 'pointer' });
    expect((await ask(ANA, 'START')).intent).toBe('OPT_IN');
    expect(await prisma.hugoTask.count()).toBe(0);
  });
});

describe('the helpers', () => {
  it('START words: the whole message, with or without a number', () => {
    expect(startReply('START')).toEqual({ pick: null });
    expect(startReply('start 2')).toEqual({ pick: 2 });
    expect(startReply('Başla #1')).toEqual({ pick: 1 });
    expect(startReply('Empezar.')).toEqual({ pick: null });
    expect(startReply('start sending me updates')).toBeNull();
    expect(startReply('STOP')).toBeNull();
  });

  it('a thread line loses its disclosure and any SSN', () => {
    expect(historyText('Done.\n\nSent by Hugo, an AI agent — Pat answers for it.')).toBe('Done.');
    expect(historyText('Listo.\n\nHugo tarafından gönderildi; bir yapay zeka ajanıdır — ondan Pat sorumludur.')).toBe('Listo.');
    expect(historyText('ssn 123-45-6789')).toBe('ssn [number removed]');
  });

  it('plain text keeps a full link once, and adds the tool’s when none is given', () => {
    const base = 'https://people.example.com';
    expect(plainForWhatsApp('Your next payday is Friday.', '/payroll', base)).toBe(`Your next payday is Friday.\n${env.APP_BASE_URL.replace(/\/+$/, '')}/payroll`);
    expect(plainForWhatsApp(`See ${base}/payroll.`, '/payroll', base)).toBe(`See ${base}/payroll.`);
    expect(plainForWhatsApp('', '/payroll', base)).toContain('/payroll');
  });
});
