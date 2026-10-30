import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createUser, prisma, truncateAll } from '../../../test/db.js';
import { builtInAgentId, ensureBuiltInAgents, resetAgentRateLimits } from '../../lib/agents.js';
import { catalogFixture, runCapabilityFixture, suspendCapability } from '../../lib/agentCapabilities.js';
import { DOCUMENT_CHASE, I9_SECTION2, chaseKey, chaseMessage, runDocumentChase, runSection2Clock } from '../../lib/complianceAgent.js';
import { addBusinessDays } from '../../lib/everifyReadiness.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { runExpirationDigest } from '../../lib/expirationDigest.js';
import { runWithTenant } from '../../lib/tenant.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { invalidateTenantProfile } from '../../lib/tenantProfile.js';
import { fmtDay } from '../../lib/humanDates.js';
import { dueWords } from '../../lib/roleDecisions.js';
import { pinMidweekNoon } from '../../../test/clock.js';

/**
 * Agent families step 4 — the Compliance agent: document.chase and
 * i9.section2 (docs/agent-families-investigation.md §4).
 *
 *   The chase: the person hears in their language at 30, 14 and 3 days,
 *   one message a day for everything due; never a waived or snoozed item,
 *   never what HR uploads; renewed, waived or gone closes it; at expiry it
 *   is on HR's desk. Section 2: a dated worklist on the verifier desk with
 *   the E-Verify reason, and HR hears once the day before and once when late.
 */

const DAY = 86_400_000;
const runTenant = <T,>(fn: () => Promise<T>) => runWithTenant(ALTO_TENANT_ID, 'job', fn);

beforeEach(async () => {
  await truncateAll();
  resetAgentRateLimits();
  invalidateTenantProfile();
});
afterAll(async () => {
  invalidateTenantProfile();
  await prisma.$disconnect();
});

async function world() {
  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
  await ensureBuiltInAgents(prisma, ALTO_TENANT_ID);
  const workerId = (await builtInAgentId(prisma, 'compliance-agent', ALTO_TENANT_ID))!;
  // It boots ONBOARDING; these cases exercise it as an owner would after certifying it.
  await prisma.worker.update({ where: { id: workerId }, data: { status: 'ACTIVE' } });
  const ana = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
  const { user: anaUser } = await createUser({ role: 'ASSOCIATE', email: ana.email, associateId: ana.id });
  await prisma.user.update({ where: { id: anaUser.id }, data: { language: 'es' } });
  return { hr, workerId, ana, anaUser };
}

const doc = (associateId: string, kind: 'ID' | 'DRUG_TEST_RESULT', expiresAt: Date) =>
  prisma.documentRecord.create({ data: { associateId, kind, filename: `${kind.toLowerCase()}.pdf`, mimeType: 'application/pdf', size: 1, status: 'VERIFIED', expiresAt } });

const chases = (associateId: string) => prisma.documentChase.findMany({ where: { associateId }, orderBy: { createdAt: 'asc' } });
const notices = (userId: string) => prisma.notification.findMany({ where: { recipientUserId: userId, category: 'documents.chase', channel: 'IN_APP' }, orderBy: { createdAt: 'asc' } });

async function decisions(email: string) {
  const res = await (await loginAs(agent(), email)).get('/me/decisions');
  expect(res.status).toBe(200);
  return (res.body.decisions ?? res.body.items ?? res.body) as Array<{ key: string; label: string; detail: string; linkUrl: string; severity: string }>;
}

describe('document.chase', () => {
  it('asks in their language at 30 and 14 days, once a day, and closes when the renewal is on file', async () => {
    const w = await world();
    const now = new Date();
    const id = await doc(w.ana.id, 'ID', new Date(now.getTime() + 20 * DAY));

    expect(await runDocumentChase(prisma, now)).toMatchObject({ messages: 1, chased: 1 });
    await flushPendingNotifications();
    const [first] = await notices(w.anaUser.id);
    // The link opens that document's renewal on the Documents page.
    expect(first).toMatchObject({ subject: 'Renueva tu identificación', linkUrl: `/documents?renew=${id.id}` });
    expect(first!.body).toMatch(/Sube el nuevo en la app, en Documentos/);
    expect((await chases(w.ana.id))[0]).toMatchObject({ stage: 1, kind: 'DOCUMENT' });

    // Same day: nothing more. Seven days on (13 left): the 14-day reminder.
    expect((await runDocumentChase(prisma, new Date(now.getTime() + 3_600_000))).messages).toBe(0);
    expect(await runDocumentChase(prisma, new Date(now.getTime() + 7 * DAY))).toMatchObject({ messages: 1 });
    expect((await chases(w.ana.id))[0]!.stage).toBe(2);

    // The renewal arrives: the chase closes as renewed, before expiry.
    await doc(w.ana.id, 'ID', new Date(now.getTime() + 400 * DAY));
    expect(await runDocumentChase(prisma, new Date(now.getTime() + 8 * DAY))).toMatchObject({ resolved: 1, messages: 0 });
    expect((await chases(w.ana.id))[0]).toMatchObject({ resolution: 'RENEWED' });

    await flushPendingAudits();
    expect(await prisma.auditLog.count({ where: { workerId: w.workerId, action: 'agent.document_chase.sent' } })).toBe(2);
    const sc = await (await loginAs(agent(), w.hr.email)).get(`/agents/${w.workerId}/capabilities/${DOCUMENT_CHASE}/scorecard`);
    expect(sc.status, JSON.stringify(sc.body)).toBe(200);
    expect(sc.body.metrics).toMatchObject({ itemsChased: 1, uploadedBeforeExpiry: 1, expiredAnyway: 0 });
  });

  it('never chases what is waived or snoozed on the scorecard, nor what HR uploads; everything due goes in one message', async () => {
    const w = await world();
    const now = new Date();
    const id = await doc(w.ana.id, 'ID', new Date(now.getTime() + 20 * DAY));
    await doc(w.ana.id, 'DRUG_TEST_RESULT', new Date(now.getTime() + 10 * DAY));
    await prisma.complianceActionState.create({ data: { actionKey: chaseKey('DOCUMENT', w.ana.id, id.expiresAt!), status: 'DONE' } });
    const authBy = new Date(`${new Date(now.getTime() + 10 * DAY).toISOString().slice(0, 10)}T00:00:00Z`);
    await prisma.i9Verification.create({ data: { associateId: w.ana.id, workAuthExpiresAt: authBy } });
    const vaxBy = new Date(`${new Date(now.getTime() + 5 * DAY).toISOString().slice(0, 10)}T00:00:00Z`);
    await prisma.vaccinationRecord.create({ data: { associateId: w.ana.id, kind: 'TB_TEST', administeredOn: new Date('2025-11-01'), expiresOn: vaxBy } });
    const snoozed = await prisma.complianceActionState.create({ data: { actionKey: chaseKey('VACCINATION', w.ana.id, vaxBy), status: 'SNOOZED', snoozedUntil: new Date(now.getTime() + 3 * DAY) } });

    expect(await runDocumentChase(prisma, now)).toMatchObject({ messages: 1, chased: 1 });
    expect((await chases(w.ana.id)).map((c) => c.kind)).toEqual(['I9_WORK_AUTH']);

    // The snooze lapses: the vaccination joins, in the next day's message.
    await prisma.complianceActionState.update({ where: { id: snoozed.id }, data: { snoozedUntil: new Date(now.getTime() - 1) } });
    expect(await runDocumentChase(prisma, new Date(now.getTime() + DAY))).toMatchObject({ messages: 1, chased: 1 });
    expect((await chases(w.ana.id)).map((c) => c.kind).sort()).toEqual(['I9_WORK_AUTH', 'VACCINATION']);
  });

  it('at expiry it is on the compliance desk; the person leaving takes it off', async () => {
    const w = await world();
    const now = new Date();
    await doc(w.ana.id, 'ID', new Date(now.getTime() - 2 * DAY));
    expect(await runDocumentChase(prisma, now)).toMatchObject({ escalated: 1, messages: 0 });
    const [c] = await chases(w.ana.id);
    const items = await decisions(w.hr.email);
    const item = items.find((d) => d.key === `compliance:expired:${c!.id}`);
    expect(item, JSON.stringify(items.map((d) => d.key))).toMatchObject({ severity: 'critical', linkUrl: `/people/${w.ana.id}?tab=documents` });
    expect(item!.label).toMatch(/^Ana Lopez: Id — id\.pdf expired /);

    await prisma.associate.update({ where: { id: w.ana.id }, data: { separatedAt: new Date() } });
    expect(await runDocumentChase(prisma, new Date(now.getTime() + 3_600_000))).toMatchObject({ resolved: 1 });
    expect((await chases(w.ana.id))[0]).toMatchObject({ resolution: 'LEFT' });
    expect((await decisions(w.hr.email)).some((d) => d.key.startsWith('compliance:expired:'))).toBe(false);
  });

  it('suspended: nothing is chased', async () => {
    const w = await world();
    await doc(w.ana.id, 'ID', new Date(Date.now() + 20 * DAY));
    await suspendCapability(prisma, w.workerId, DOCUMENT_CHASE, ALTO_TENANT_ID, w.hr.id, 'Checking the wording');
    expect(await runDocumentChase(prisma, new Date())).toMatchObject({ messages: 0, skipped: 'capability_off' });
    expect(await chases(w.ana.id)).toHaveLength(0);
  });

  it('speaks Turkish and English too', () => {
    const items = [{ wordKey: 'I9_WORK_AUTH', expiresAt: new Date('2026-11-02T00:00:00Z') }];
    expect(chaseMessage('tr', items).subject).toBe('çalışma izni yenilenmeli');
    expect(chaseMessage('en', items).body).toMatch(/^These expire soon:\n• work authorization: November 2\n/);
    expect(chaseMessage('en', [...items, { wordKey: 'ID', expiresAt: new Date('2026-11-03T00:00:00Z') }]).subject).toBe('2 documents to renew');
  });
});

describe('the expiration digest', () => {
  it('now lists what already expired (as its comment always promised), leaving out the waived', async () => {
    const w = await world();
    const now = new Date();
    await doc(w.ana.id, 'ID', new Date(now.getTime() - 2.5 * DAY));
    const bob = await createAssociate({ firstName: 'Bob', lastName: 'Waived' });
    const waived = await doc(bob.id, 'ID', new Date(now.getTime() - 3 * DAY));
    await prisma.complianceActionState.create({ data: { actionKey: chaseKey('DOCUMENT', bob.id, waived.expiresAt!), status: 'DONE' } });
    await runTenant(() => runExpirationDigest(now));
    await flushPendingNotifications();
    const digest = await prisma.notification.findFirst({ where: { recipientUserId: w.hr.id, category: 'compliance.expirations', channel: 'IN_APP' } });
    expect(digest?.subject).toBe('[Compliance] 1 item expired or expiring within 30 days');
    expect(digest?.body).toContain('Ana Lopez — Id — id.pdf: EXPIRED 2 days ago');
    expect(digest?.body).not.toContain('Bob');
  });
});

describe('Hugo, asked what to renew (routes to document.chase)', () => {
  it('an associate hears their own renewals in their language, linked to the first one; nothing due, he says so', async () => {
    const w = await world();
    const ana = await loginAs(agent(), w.anaUser.email);
    const me = await ana.get('/hugo');
    expect(me.body.can.map((c: { key: string }) => c.key)).toContain('RENEW');
    expect((await ana.post('/hugo/ask').send({ text: '¿Qué tengo que renovar?' })).body).toMatchObject({ intent: 'RENEW', reply: 'Nada tuyo vence en los próximos 30 días.' });
    const id = await doc(w.ana.id, 'ID', new Date(Date.now() + 20 * DAY));
    const asked = await ana.post('/hugo/ask').send({ text: '¿Qué tengo que renovar?' });
    expect(asked.body.intent).toBe('RENEW');
    expect(asked.body.reply).toMatch(/^Estos vencen pronto:\n• identificación: /);
    expect(asked.body.linkUrl).toBe(`/documents?renew=${id.id}`);
  });

  it('with the capability suspended he neither offers nor answers it', async () => {
    const w = await world();
    await suspendCapability(prisma, w.workerId, DOCUMENT_CHASE, ALTO_TENANT_ID, w.hr.id, 'Checking the wording');
    const ana = await loginAs(agent(), w.anaUser.email);
    expect((await ana.get('/hugo')).body.can.map((c: { key: string }) => c.key)).not.toContain('RENEW');
    expect((await ana.post('/hugo/ask').send({ text: 'What do I need to renew?' })).body.intent).toBe('HANDOFF');
  });
});

describe('i9.section2', () => {
  async function hire(firstName: string, start: Date, i9: { section1?: boolean; section2?: boolean } = { section1: true }) {
    const a = await createAssociate({ firstName, lastName: 'Hire' });
    await prisma.associate.update({ where: { id: a.id }, data: { hireDate: start } });
    const app = await prisma.application.create({ data: { associateId: a.id, onboardingTrack: 'STANDARD', status: 'APPROVED', startDate: start } });
    await prisma.i9Verification.create({ data: { associateId: a.id, ...(i9.section1 ? { section1CompletedAt: start } : {}), ...(i9.section2 ? { section2CompletedAt: start } : {}) } });
    return { ...a, applicationId: app.id };
  }
  const utcDay = (offset: number) => new Date(`${new Date(Date.now() + offset * DAY).toISOString().slice(0, 10)}T00:00:00Z`);

  it('the verifier desk gets a dated worklist, earliest first, with the E-Verify reason', async () => {
    // Midweek noon: from 5 PM Pacific the UTC day the hires are seeded on is
    // already tomorrow, and "late" read as "due today" (severity high).
    pinMidweekNoon();
    const w = await world();
    const recent = await hire('Eve', utcDay(-1));
    const early = await hire('Dan', utcDay(-6));
    await hire('Fay', utcDay(-4), { section1: true, section2: true });
    const items = (await decisions(w.hr.email)).filter((d) => d.key.startsWith('i9:section2'));
    expect(items.map((d) => d.key)).toEqual([`i9:section2:${early.id}`, `i9:section2:${recent.id}`]);
    const dueDan = addBusinessDays(utcDay(-6), 3).toISOString().slice(0, 10);
    expect(items[0]).toMatchObject({ severity: 'critical', label: `I-9 Section 2 for Dan Hire — ${dueWords(dueDan)}`, linkUrl: `/onboarding/applications/${early.applicationId}` });
    expect(items[0]!.detail).toMatch(/^E-Verify cannot open yet: .*no SSN on file/);
  });

  it('HR hears once the business day before, and once when it is late', async () => {
    const w = await world();
    const start = utcDay(-1);
    await hire('Eve', start);
    const due = addBusinessDays(start, 3);
    expect(await runSection2Clock(prisma, new Date(start.getTime() + 12 * 3_600_000))).toMatchObject({ pending: 1, dueTomorrow: 0, late: 0 });
    const eve = new Date(due.getTime() - DAY + 12 * 3_600_000);
    expect(await runSection2Clock(prisma, eve)).toMatchObject({ dueTomorrow: 1 });
    // The trail is the claim; the hourly cron is far apart, the test is not.
    await flushPendingAudits();
    expect(await runSection2Clock(prisma, new Date(eve.getTime() + 3_600_000))).toMatchObject({ dueTomorrow: 0 });
    expect(await runSection2Clock(prisma, new Date(due.getTime() + DAY + 12 * 3_600_000))).toMatchObject({ late: 1 });
    await flushPendingNotifications();
    const told = await prisma.notification.findMany({ where: { recipientUserId: w.hr.id, category: 'compliance.i9', channel: 'IN_APP' }, orderBy: { createdAt: 'asc' } });
    expect(told.map((n) => n.subject)).toEqual([`I-9 Section 2 due ${fmtDay(due, { weekday: true })}: Eve Hire`, 'I-9 Section 2 is late: Eve Hire']);
    expect(told.every((n) => !/\d{4}-\d{2}-\d{2}/.test(`${n.subject} ${n.body}`))).toBe(true);
  });

  it('suspended: the desk keeps the plain count it had before', async () => {
    const w = await world();
    await hire('Eve', utcDay(-1));
    await suspendCapability(prisma, w.workerId, I9_SECTION2, ALTO_TENANT_ID, w.hr.id, 'Checking the dates');
    const items = (await decisions(w.hr.email)).filter((d) => d.key.startsWith('i9:section2'));
    expect(items).toEqual([expect.objectContaining({ key: 'i9:section2', label: '1 I-9 Section 2 verification pending' })]);
  });
});

describe('the Compliance agent: certification', () => {
  it('both catalog fixtures run through the real reads, and the agent certifies from the page', async () => {
    const w = await world();
    for (const [key, name] of [
      [DOCUMENT_CHASE, 'Three people with IDs on file: only the one expiring soon with nothing newer is chased'],
      [I9_SECTION2, 'Three approved hires: the two without Section 2 are on the worklist, the earliest deadline first'],
    ] as const) {
      const r = await runCapabilityFixture(key, catalogFixture(key, name)!, new Date());
      expect(r, JSON.stringify(r)).toMatchObject({ passed: true, reason: null });
    }
    const run = await (await loginAs(agent(), w.hr.email)).post(`/agents/${w.workerId}/scenarios/run`).send({});
    expect(run.status, JSON.stringify(run.body)).toBe(200);
    // document.chase, i9.section2, incident.loop, coverage.credentials.
    expect(run.body).toMatchObject({ ran: 4, passed: 4 });
    expect(await prisma.documentRecord.count()).toBe(0);
    expect(await prisma.application.count()).toBe(0);
  });
});
