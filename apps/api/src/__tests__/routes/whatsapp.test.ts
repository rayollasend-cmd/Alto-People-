import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../../config/env.js';
import { setWhatsAppSenderForTests, signWhatsAppBody, type WaPayload } from '../../lib/whatsapp.js';
import { detectIntent, handleInbound } from '../../lib/whatsappAssistant.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * WhatsApp (Brief 1C-4 acceptance).
 *
 *   1. An associate who opted in gets a schedule change on WhatsApp, in
 *      Spanish, as the registered template — the moment the shift lands.
 *   2. The assistant answers payday, ride and schedule from the person's
 *      own data, never anyone else's, and hands the rest to a supervisor
 *      as a thread in the app.
 *   3. STOP opts out in one message and is recorded; START brings it back.
 *   4. Receipts come in by signed webhook and land on the record.
 */

const SECRET = 'test-app-secret';
const saved = { token: env.WHATSAPP_APP_SECRET, verify: env.WHATSAPP_VERIFY_TOKEN };
let sent: WaPayload[] = [];
let counter = 0;

beforeEach(async () => {
  await truncateAll();
  sent = [];
  setWhatsAppSenderForTests(async (payload) => {
    sent.push(payload);
    return { id: `wamid.${++counter}` };
  });
  Object.assign(env, { WHATSAPP_APP_SECRET: SECRET, WHATSAPP_VERIFY_TOKEN: 'verify-me-please' });
});
afterEach(() => {
  setWhatsAppSenderForTests(null);
  Object.assign(env, { WHATSAPP_APP_SECRET: saved.token, WHATSAPP_VERIFY_TOKEN: saved.verify });
});
afterAll(async () => {
  await prisma.$disconnect();
});

const HOUR = 3_600_000;

async function world() {
  const client = await createClient('Coastal Resort');
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id });

  const maria = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
  await prisma.associate.update({ where: { id: maria.id }, data: { phone: '(850) 555-0101' } });
  await prisma.associateAssignment.create({ data: { associateId: maria.id, locationId: site.id, startedAt: new Date('2026-01-01') } });
  const { user: mariaUser } = await createUser({ role: 'ASSOCIATE', associateId: maria.id });
  await prisma.user.update({ where: { id: mariaUser.id }, data: { language: 'es' } });

  const bo = await createAssociate({ firstName: 'Bo', lastName: 'Chen' });
  await prisma.associate.update({ where: { id: bo.id }, data: { phone: '+1 850 555 0202' } });
  await prisma.associateAssignment.create({ data: { associateId: bo.id, locationId: site.id, startedAt: new Date('2026-01-01') } });
  const { user: boUser } = await createUser({ role: 'ASSOCIATE', associateId: bo.id });

  return { client, site, hr, sup, maria, mariaUser, bo, boUser };
}

async function webhook(body: object, opts: { badSignature?: boolean } = {}) {
  const raw = JSON.stringify(body);
  const res = await agent()
    .post('/whatsapp/webhook')
    .set('content-type', 'application/json')
    .set('x-hub-signature-256', opts.badSignature ? 'sha256=deadbeef' : signWhatsAppBody(raw, SECRET))
    .send(raw);
  // The webhook answers 200 first and works after; wait for the work.
  await flushPendingNotifications();
  return res;
}

const inbound = (from: string, text: string, id = `wamid.in.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`) => ({
  entry: [{ changes: [{ value: { messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }],
});

describe('consent and the schedule change', () => {
  it('opts in with the number on file, then a new shift arrives as the Spanish template', async () => {
    const w = await world();
    const maria = await loginAs(agent(), w.mariaUser.email);

    const before = await maria.get('/whatsapp/me');
    expect(before.body).toMatchObject({ phoneOnFile: '(850) 555-0101', consent: null });
    const on = await maria.post('/whatsapp/me/consent').send({ optIn: true });
    expect(on.status).toBe(200);
    expect(on.body.consent).toMatchObject({ status: 'OPTED_IN', phone: '18505550101' });

    // HR puts a shift on her schedule.
    const hr = await loginAs(agent(), w.hr.email);
    const startsAt = new Date(Date.now() + 48 * HOUR);
    const shift = await prisma.shift.create({
      data: { clientId: w.client.id, locationId: w.site.id, position: 'Server', startsAt, endsAt: new Date(startsAt.getTime() + 8 * HOUR), status: 'OPEN', publishedAt: new Date() },
    });
    const assigned = await hr.post(`/scheduling/shifts/${shift.id}/assign`).send({ associateId: w.maria.id });
    expect(assigned.status).toBe(200);
    await flushPendingNotifications();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: '18505550101', template: { name: 'alto_shift_assigned_v2', language: 'es' } });
    expect(sent[0]!.template!.params[0]).toBe('Server');
    const row = await prisma.whatsAppMessage.findFirstOrThrow({ where: { associateId: w.maria.id, direction: 'OUTBOUND' } });
    expect(row).toMatchObject({ templateName: 'alto_shift_assigned_v2', language: 'es', status: 'SENT', waMessageId: 'wamid.1', category: 'shift_assigned' });
    expect(row.body).toContain('Nuevo turno: Server en');
    expect(row.body).toContain('Ahí estaré');
    // The communications record carries the delivery too.
    const note = await prisma.notification.findFirstOrThrow({ where: { id: row.notificationId! } });
    expect(note).toMatchObject({ channel: 'WHATSAPP', status: 'SENT', recipientPhone: '18505550101' });

    // Bo never opted in: nothing goes to WhatsApp for him.
    const boShift = await prisma.shift.create({
      data: { clientId: w.client.id, locationId: w.site.id, position: 'Server', startsAt: new Date(startsAt.getTime() + 24 * HOUR), endsAt: new Date(startsAt.getTime() + 32 * HOUR), status: 'OPEN', publishedAt: new Date() },
    });
    await hr.post(`/scheduling/shifts/${boShift.id}/assign`).send({ associateId: w.bo.id });
    await flushPendingNotifications();
    expect(sent).toHaveLength(1);
  });

  it('refuses a number that is not a phone, and an account with no associate', async () => {
    const w = await world();
    const maria = await loginAs(agent(), w.mariaUser.email);
    expect((await maria.post('/whatsapp/me/consent').send({ optIn: true, phone: '12' })).body.error.code).toBe('phone_invalid');
    const hr = await loginAs(agent(), w.hr.email);
    expect((await hr.post('/whatsapp/me/consent').send({ optIn: true, phone: '8505550199' })).status).toBe(403);
  });
});

describe('receipts', () => {
  it('verifies the handshake and the signature, and moves the record forward but never back', async () => {
    const w = await world();
    const maria = await loginAs(agent(), w.mariaUser.email);
    await maria.post('/whatsapp/me/consent').send({ optIn: true });
    const hr = await loginAs(agent(), w.hr.email);
    const startsAt = new Date(Date.now() + 48 * HOUR);
    const shift = await prisma.shift.create({
      data: { clientId: w.client.id, locationId: w.site.id, position: 'Server', startsAt, endsAt: new Date(startsAt.getTime() + 8 * HOUR), status: 'OPEN', publishedAt: new Date() },
    });
    await hr.post(`/scheduling/shifts/${shift.id}/assign`).send({ associateId: w.maria.id });
    await flushPendingNotifications();
    const row = await prisma.whatsAppMessage.findFirstOrThrow({ where: { associateId: w.maria.id } });

    const verify = await agent().get('/whatsapp/webhook').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-me-please', 'hub.challenge': '12345' });
    expect(verify.status).toBe(200);
    expect(verify.text).toBe('12345');
    expect((await agent().get('/whatsapp/webhook').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '1' })).status).toBe(403);

    const status = (s: string, ts: number) => ({ entry: [{ changes: [{ value: { statuses: [{ id: row.waMessageId, status: s, timestamp: String(ts) }] } }] }] });
    expect((await webhook(status('delivered', 1700000000), { badSignature: true })).status).toBe(401);
    expect((await webhook(status('read', 1700000100))).status).toBe(200);
    expect((await prisma.whatsAppMessage.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('READ');
    // A late "delivered" after "read" does not regress it.
    await webhook(status('delivered', 1700000000));
    const after = await prisma.whatsAppMessage.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('READ');
    expect(after.statusAt?.toISOString()).toBe(new Date(1700000100 * 1000).toISOString());
    const note = await prisma.notification.findUniqueOrThrow({ where: { id: row.notificationId! } });
    expect(note.status).toBe('READ');
    expect(note.readAt).not.toBeNull();

    await webhook(status('failed', 1700000200));
    expect((await prisma.whatsAppMessage.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('FAILED');
  });
});

describe('the assistant', () => {
  it('reads intent in three languages', () => {
    expect(detectIntent('When is payday?').intent).toBe('PAYDAY');
    expect(detectIntent('¿Cuándo me pagan?').intent).toBe('PAYDAY');
    expect(detectIntent('Maaş ne zaman?').intent).toBe('PAYDAY');
    expect(detectIntent('What time is my ride').intent).toBe('RIDE');
    expect(detectIntent('a que hora pasa la camioneta').intent).toBe('RIDE');
    expect(detectIntent('Servis kaçta?').intent).toBe('RIDE');
    expect(detectIntent("What's my schedule?").intent).toBe('SCHEDULE');
    expect(detectIntent('mi horario de esta semana').intent).toBe('SCHEDULE');
    expect(detectIntent('STOP').intent).toBe('OPT_OUT');
    expect(detectIntent('baja').intent).toBe('OPT_OUT');
    expect(detectIntent('Dur').intent).toBe('OPT_OUT');
    expect(detectIntent('START').intent).toBe('OPT_IN');
    expect(detectIntent('Español')).toEqual({ intent: 'LANGUAGE', lang: 'es' });
    expect(detectIntent('Can I change my address?').intent).toBe('HANDOFF');
  });

  it('answers payday, ride and schedule from the person’s own data only, and hands the rest to a supervisor', async () => {
    const w = await world();
    await prisma.payrollSchedule.create({ data: { name: 'Weekly', clientId: w.client.id, frequency: 'WEEKLY', anchorDate: new Date('2026-01-05'), payDateOffsetDays: 5 } });
    const maria = await loginAs(agent(), w.mariaUser.email);
    await maria.post('/whatsapp/me/consent').send({ optIn: true });
    const bo = await loginAs(agent(), w.boUser.email);
    await bo.post('/whatsapp/me/consent').send({ optIn: true });

    const now = new Date();
    const mariaShift = await prisma.shift.create({
      data: { clientId: w.client.id, locationId: w.site.id, position: 'Server', startsAt: new Date(now.getTime() + 30 * HOUR), endsAt: new Date(now.getTime() + 38 * HOUR), status: 'ASSIGNED', assignedAssociateId: w.maria.id, publishedAt: now },
    });
    await prisma.shift.create({
      data: { clientId: w.client.id, locationId: w.site.id, position: 'Dishwasher', startsAt: new Date(now.getTime() + 30 * HOUR), endsAt: new Date(now.getTime() + 38 * HOUR), status: 'ASSIGNED', assignedAssociateId: w.bo.id, publishedAt: now },
    });
    await prisma.ride.create({
      data: {
        associateId: w.maria.id,
        direction: 'TO_WORK',
        locationId: w.site.id,
        address: '12 Palm St',
        targetAt: new Date(now.getTime() + 29 * HOUR),
        serviceDate: new Date(now.getTime() + 29 * HOUR).toISOString().slice(0, 10),
        status: 'REQUESTED',
        fareCents: 0,
        noShowFeeCents: 0,
        createdById: w.mariaUser.id,
      },
    });

    // Payday, in Spanish.
    const pay = await webhook(inbound('18505550101', '¿Cuándo me pagan?'));
    expect(pay.status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    const payRow = await prisma.whatsAppMessage.findFirst({ where: { associateId: w.maria.id, kind: 'ANSWER' }, orderBy: { createdAt: 'desc' } });
    expect(payRow?.body).toContain('Tu próximo día de pago es');
    expect(payRow?.language).toBe('es');
    expect(sent[sent.length - 1]).toMatchObject({ to: '18505550101', text: expect.stringContaining('día de pago') });

    // The ride.
    await webhook(inbound('18505550101', 'a qué hora pasa la van?'));
    await new Promise((r) => setTimeout(r, 300));
    const rideRow = await prisma.whatsAppMessage.findFirst({ where: { associateId: w.maria.id, kind: 'ANSWER' }, orderBy: { createdAt: 'desc' } });
    expect(rideRow?.body).toContain('Tu próximo viaje');
    expect(rideRow?.body).toContain('12 Palm St');
    expect(rideRow?.body).toContain('se asignará una van');

    // The schedule — hers, not Bo's.
    await webhook(inbound('18505550101', 'mi horario'));
    await new Promise((r) => setTimeout(r, 300));
    const schedRow = await prisma.whatsAppMessage.findFirst({ where: { associateId: w.maria.id, kind: 'ANSWER' }, orderBy: { createdAt: 'desc' } });
    expect(schedRow?.body).toContain('Tus próximos turnos');
    expect(schedRow?.body).toContain('Server');
    expect(schedRow?.body).not.toContain('Dishwasher');
    expect(schedRow?.replyToId).not.toBeNull();

    // Bo asks in English and gets only his own.
    await webhook(inbound('18505550202', 'what is my schedule'));
    await new Promise((r) => setTimeout(r, 300));
    const boRow = await prisma.whatsAppMessage.findFirst({ where: { associateId: w.bo.id, kind: 'ANSWER' }, orderBy: { createdAt: 'desc' } });
    expect(boRow?.body).toContain('Your next shifts');
    expect(boRow?.body).toContain('Dishwasher');
    expect(boRow?.body).not.toContain('Server');
    expect(boRow?.language).toBe('en');

    // An unknown number gets no data and no reply — and, with no tenant to
    // file it under (Brief 2-1 §9.4), no record either.
    const sentBefore = sent.length;
    await webhook(inbound('18505559999', 'what is my schedule'));
    await new Promise((r) => setTimeout(r, 300));
    expect(sent).toHaveLength(sentBefore);
    expect(await prisma.whatsAppMessage.count({ where: { phone: '18505559999' } })).toBe(0);

    // Everything else goes to a supervisor as a thread in the app.
    await webhook(inbound('18505550101', 'Can I change my address?'));
    await new Promise((r) => setTimeout(r, 400));
    const handoff = await prisma.whatsAppMessage.findFirst({ where: { associateId: w.maria.id, kind: 'HANDOFF' } });
    expect(handoff?.body).toContain('Se lo pasé a');
    expect(handoff?.conversationId).not.toBeNull();
    const msg = await prisma.message.findFirst({ where: { conversationId: handoff!.conversationId! } });
    expect(msg?.body).toBe('[WhatsApp] Can I change my address?');
    expect(msg?.senderId).toBe(w.mariaUser.id);
    const parts = await prisma.conversationParticipant.findMany({ where: { conversationId: handoff!.conversationId! } });
    expect(parts.map((p) => p.userId).sort()).toEqual([w.mariaUser.id, w.sup.id].sort());

    // Every question is on the record, and a replayed webhook is a no-op.
    const id = 'wamid.in.replay';
    await webhook(inbound('18505550101', 'mi horario', id));
    await webhook(inbound('18505550101', 'mi horario', id));
    await new Promise((r) => setTimeout(r, 300));
    expect(await prisma.whatsAppMessage.count({ where: { waMessageId: id } })).toBe(1);
    expect(await prisma.whatsAppMessage.count({ where: { associateId: w.maria.id, direction: 'INBOUND' } })).toBe(5);
    expect(mariaShift.id).toBeTruthy();
  });

  it('STOP opts out in one message and is recorded; START brings it back', async () => {
    const w = await world();
    const maria = await loginAs(agent(), w.mariaUser.email);
    await maria.post('/whatsapp/me/consent').send({ optIn: true });

    const out = await handleInbound({ from: '18505550101', waMessageId: 'wamid.stop', text: 'STOP' }, prisma);
    expect(out.intent).toBe('OPT_OUT');
    const consent = await prisma.whatsAppConsent.findUniqueOrThrow({ where: { associateId: w.maria.id } });
    expect(consent.status).toBe('OPTED_OUT');
    expect(consent.optedOutAt).not.toBeNull();
    expect(consent.source).toBe('reply');
    // One confirmation went out; after that, nothing.
    expect(sent[sent.length - 1]!.text).toContain('Ya no recibirás');
    const n = sent.length;
    const hr = await loginAs(agent(), w.hr.email);
    const startsAt = new Date(Date.now() + 48 * HOUR);
    const shift = await prisma.shift.create({
      data: { clientId: w.client.id, locationId: w.site.id, position: 'Server', startsAt, endsAt: new Date(startsAt.getTime() + 8 * HOUR), status: 'OPEN', publishedAt: new Date() },
    });
    await hr.post(`/scheduling/shifts/${shift.id}/assign`).send({ associateId: w.maria.id });
    await flushPendingNotifications();
    expect(sent).toHaveLength(n);
    expect((await maria.get('/whatsapp/me')).body.consent.status).toBe('OPTED_OUT');

    const back = await handleInbound({ from: '18505550101', waMessageId: 'wamid.start', text: 'ALTA' }, prisma);
    expect(back.intent).toBe('OPT_IN');
    expect((await prisma.whatsAppConsent.findUniqueOrThrow({ where: { associateId: w.maria.id } })).status).toBe('OPTED_IN');
  });

  it('the admin record is behind the communications capability and masks the number', async () => {
    const w = await world();
    const maria = await loginAs(agent(), w.mariaUser.email);
    await maria.post('/whatsapp/me/consent').send({ optIn: true });
    await handleInbound({ from: '18505550101', waMessageId: 'wamid.q', text: 'hola, mi horario?' }, prisma);
    expect((await maria.get('/whatsapp/admin/messages')).status).toBe(403);
    const hr = await loginAs(agent(), w.hr.email);
    const overview = await hr.get('/whatsapp/admin/overview');
    expect(overview.status).toBe(200);
    expect(overview.body.consent).toEqual({ optedIn: 1, optedOut: 0 });
    expect(overview.body.templates.map((t: { metaName: string }) => t.metaName)).toContain('alto_shift_assigned_v2');
    const list = await hr.get(`/whatsapp/admin/messages?associateId=${w.maria.id}`);
    expect(list.body.messages[0].phone).toBe('…0101');
    expect(list.body.messages.map((m: { kind: string }) => m.kind).sort()).toEqual(['ANSWER', 'QUESTION']);
  });
});

describe('Hugo', () => {
  it('says who and what he is, by the name the tenant chose, and introduces himself on the first message', async () => {
    const w = await world();
    expect(detectIntent('who are you?').intent).toBe('WHO');
    expect(detectIntent('eres un robot').intent).toBe('WHO');
    expect(detectIntent('sen kimsin').intent).toBe('WHO');
    const hr = await loginAs(agent(), w.hr.email);
    expect((await hr.patch('/admin/org/settings').send({ assistantName: 'Coco' })).status).toBe(200);
    const maria = await loginAs(agent(), w.mariaUser.email);
    await maria.post('/whatsapp/me/consent').send({ optIn: true });
    const first = await handleInbound({ from: '18505550101', waMessageId: 'wamid.hello', text: 'ALTA' }, prisma);
    expect(first.reply).toContain('Coco');
    expect(first.reply).toContain('Alto People');
    expect(first.reply).toMatch(/inteligencia artificial|AI assistant/);
    const who = await handleInbound({ from: '18505550101', waMessageId: 'wamid.who', text: '¿quién eres?' }, prisma);
    expect(who.intent).toBe('WHO');
    expect(who.reply).toContain('Coco');
    expect(who.reply).toContain('Alto People');
    expect(who.reply).toContain('No soy una persona');
    await hr.patch('/admin/org/settings').send({ assistantName: 'Hugo' });
  });
});

describe('the webhook resolves each item\'s tenant (Brief 2-1 §9.4)', () => {
  const T2 = '22222222-2222-4222-8222-222222222222';

  it('receipts for two tenants in one body each land on their own row; an unknown receipt is dropped', async () => {
    await prisma.tenant.create({ data: { id: T2, slug: 'tenant-two', name: 'Tenant Two' } });
    const one = await createAssociate({ firstName: 'Ana', lastName: 'One' });
    const two = await createAssociate({ firstName: 'Tom', lastName: 'Two' });
    await prisma.associate.update({ where: { id: two.id }, data: { tenantId: T2 } });
    const mine = await prisma.whatsAppMessage.create({ data: { associateId: one.id, phone: '18505550111', direction: 'OUTBOUND', kind: 'TEMPLATE', waMessageId: 'wamid.t1', body: 'Shift reminder', status: 'SENT' } });
    const theirs = await prisma.whatsAppMessage.create({ data: { tenantId: T2, associateId: two.id, phone: '18505550222', direction: 'OUTBOUND', kind: 'TEMPLATE', waMessageId: 'wamid.t2', body: 'Shift reminder', status: 'SENT' } });
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await webhook({
      entry: [{ changes: [{ value: { statuses: [
        { id: 'wamid.t1', status: 'delivered', timestamp: ts },
        { id: 'wamid.t2', status: 'read', timestamp: ts },
        { id: 'wamid.nobody', status: 'read', timestamp: ts },
      ] } }] }],
    });
    expect(res.status).toBe(200);
    expect((await prisma.whatsAppMessage.findUniqueOrThrow({ where: { id: mine.id } })).status).toBe('DELIVERED');
    expect((await prisma.whatsAppMessage.findUniqueOrThrow({ where: { id: theirs.id } })).status).toBe('READ');
    expect(await prisma.whatsAppMessage.count()).toBe(2);
  });

  it('an inbound message from a second tenant\'s number is recorded under that tenant', async () => {
    await prisma.tenant.create({ data: { id: T2, slug: 'tenant-two', name: 'Tenant Two' } });
    const two = await createAssociate({ firstName: 'Tom', lastName: 'Two' });
    await prisma.associate.update({ where: { id: two.id }, data: { tenantId: T2 } });
    await prisma.whatsAppConsent.create({ data: { tenantId: T2, associateId: two.id, phone: '18505550222', status: 'OPTED_IN', source: 'app', optedInAt: new Date() } });
    await webhook(inbound('18505550222', 'hola', 'wamid.in.t2'));
    const row = await prisma.whatsAppMessage.findUniqueOrThrow({ where: { waMessageId: 'wamid.in.t2' } });
    expect(row).toMatchObject({ tenantId: T2, associateId: two.id, direction: 'INBOUND' });
    expect((await prisma.whatsAppConsent.findUniqueOrThrow({ where: { associateId: two.id } })).lastInboundAt).not.toBeNull();
  });
});
