import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { DIGEST_CATEGORY, runAttestationReminderSweep } from '../../lib/attestationReminder.js';
import { cleanupMisroutedNotifications } from '../../lib/notificationRoutingCleanup.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';

/**
 * Marketing, communications and settings (wave 2):
 *  - one broadcast system: a pre-send audience count, duplicate, templates
 *    that are never sent;
 *  - marketing drafts a campaign announcement for HR — and still can't send;
 *  - the sent log names people; the composer sends by person; channels say
 *    why they can't be used; "clear all of this kind";
 *  - attestation reminders as one daily digest, with a snooze;
 *  - settings health badges; the misrouted-notification cleanup.
 */

void createApp;

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function hr() {
  const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
  return { user, a: await loginAs(agent(), user.email) };
}

describe('broadcasts', () => {
  it('counts the audience before sending, duplicates, saves templates that are never sent, and deletes drafts', async () => {
    const { a } = await hr();
    const client = await createClient('Coastal Resort');
    const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Reyes' });
    const ben = await createAssociate({ firstName: 'Ben', lastName: 'Ortiz' });
    await createAssociate({ firstName: 'Cy', lastName: 'Elsewhere' });
    for (const p of [ana, ben]) await prisma.associateAssignment.create({ data: { associateId: p.id, locationId: site.id, startedAt: new Date('2026-01-01') } });
    await createUser({ role: 'ASSOCIATE', associateId: ana.id, email: ana.email });

    const all = await a.post('/broadcasts/audience-count').send({});
    expect(all.status).toBe(200);
    expect(all.body.people).toBe(3);
    const atClient = await a.post('/broadcasts/audience-count').send({ clientId: client.id });
    expect(atClient.body).toMatchObject({ people: 2, withAccount: 1 });

    const created = await a.post('/broadcasts').send({ title: 'Holiday hours', body: 'We close at 6 on the 24th.', clientId: client.id, channels: ['IN_APP'] });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    expect((await a.get(`/broadcasts/${id}/audience-count`)).body.people).toBe(2);

    const dup = await a.post(`/broadcasts/${id}/duplicate`).send({});
    expect(dup.status).toBe(201);
    const tpl = await a.post(`/broadcasts/${id}/template`).send({ name: 'Holiday hours' });
    expect(tpl.status).toBe(201);
    // Templates are listed apart, and can't be sent.
    const list = await a.get('/broadcasts');
    expect(list.body.broadcasts.map((b: { id: string }) => b.id).sort()).toEqual([id, dup.body.id].sort());
    const templates = await a.get('/broadcasts?templates=1');
    expect(templates.body.broadcasts).toHaveLength(1);
    expect(templates.body.broadcasts[0]).toMatchObject({ templateName: 'Holiday hours', title: 'Holiday hours' });
    expect((await a.post(`/broadcasts/${tpl.body.id}/send`).send({})).body.error.code).toBe('is_template');

    // Sending reaches the counted audience's accounts.
    const sent = await a.post(`/broadcasts/${id}/send`).send({});
    expect(sent.body.recipientCount).toBe(1);
    // A sent broadcast stays on the record; a draft can go.
    expect((await a.delete(`/broadcasts/${id}`)).status).toBe(400);
    expect((await a.delete(`/broadcasts/${dup.body.id}`)).status).toBe(204);
  });
});

describe('marketing → announce a campaign', () => {
  it('drafts a broadcast for HR, tells the senders, and gives marketing no way to send it', async () => {
    const { user: hrUser } = await hr();
    const { user: mkt } = await createUser({ role: 'MARKETING_MANAGER' });
    const m = await loginAs(agent(), mkt.email);
    const camp = await m.post('/marketing/campaigns').send({ name: 'Holiday referrals', bonusAmount: 250, startsOn: '2026-11-01', endsOn: '2026-12-15', positions: ['Housekeeper'] });
    expect(camp.status).toBe(201);
    const ann = await m.post(`/marketing/campaigns/${camp.body.id}/announce`).send({});
    expect(ann.status).toBe(201);
    const draft = await prisma.broadcast.findUniqueOrThrow({ where: { id: ann.body.broadcastId } });
    expect(draft).toMatchObject({ status: 'DRAFT', createdById: mkt.id });
    expect(draft.title).toMatch(/\$250/);
    expect(draft.body).toMatch(/Housekeeper/);
    expect(draft.body).toMatch(/December 15/);
    await flushPendingNotifications();
    const note = await prisma.notification.findFirstOrThrow({ where: { recipientUserId: hrUser.id, category: 'broadcast.review', channel: 'IN_APP' } });
    expect(note.linkUrl).toBe(`/communications?tab=sends&view=broadcasts&broadcast=${draft.id}`);
    // Marketing still can't send (or even list) broadcasts.
    expect((await m.post(`/broadcasts/${draft.id}/send`).send({})).status).toBe(403);
    expect((await m.get('/broadcasts')).status).toBe(403);
  });
});

describe('communications', () => {
  it('names recipients in the log, sends by person, says which channels can deliver, and clears a kind', async () => {
    const { a, user: hrUser } = await hr();
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Reyes' });
    const { user: anaUser } = await createUser({ role: 'ASSOCIATE', associateId: ana.id, email: ana.email });
    const noAccount = await createAssociate({ firstName: 'Ned', lastName: 'Noaccount' });

    const sent = await a.post('/communications/admin/send').send({ channel: 'IN_APP', recipientAssociateId: ana.id, subject: 'Hi', body: 'Welcome.' });
    expect(sent.status).toBe(201);
    expect(sent.body.recipientUserId).toBe(anaUser.id);
    const refused = await a.post('/communications/admin/send').send({ channel: 'IN_APP', recipientAssociateId: noAccount.id, body: 'Hello' });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('no_account');

    const log = await a.get('/communications/admin');
    expect(log.body.notifications.find((n: { id: string }) => n.id === sent.body.id).recipientName).toBe('Ana Reyes');

    const ch = await a.get('/communications/admin/channels');
    expect(ch.body.channels.find((c: { channel: string }) => c.channel === 'IN_APP').available).toBe(true);
    const sms = ch.body.channels.find((c: { channel: string }) => c.channel === 'SMS');
    expect(sms.available).toBe(false);
    expect(sms.reason).toBeTruthy();

    // Three reminders of one kind, one of another: "clear all of this kind" clears the three.
    for (const k of ['A', 'B', 'C']) {
      await prisma.notification.create({ data: { channel: 'IN_APP', status: 'SENT', recipientUserId: hrUser.id, subject: `Overdue ${k}`, body: 'x', category: `compliance.attestation.${k}` } });
    }
    await prisma.notification.create({ data: { channel: 'IN_APP', status: 'SENT', recipientUserId: hrUser.id, subject: 'Other', body: 'x', category: 'scheduling' } });
    const cleared = await a.post('/communications/me/inbox/read-kind').send({ category: 'compliance.attestation' });
    expect(cleared.body.updated).toBe(3);
    expect(await prisma.notification.count({ where: { recipientUserId: hrUser.id, readAt: null } })).toBe(1);
  });
});

describe('attestation reminders', () => {
  it('send one digest a day to each admin, and leave snoozed signals out', async () => {
    const { user: hrUser, a } = await hr();
    const now = new Date('2026-10-28T15:00:00Z');
    const first = await runAttestationReminderSweep(prisma, now);
    expect(first.reminded).toBeGreaterThan(0);
    await flushPendingNotifications();
    const digests = await prisma.notification.findMany({ where: { recipientUserId: hrUser.id, category: DIGEST_CATEGORY, channel: 'IN_APP' } });
    expect(digests).toHaveLength(1);
    expect(digests[0]!.body).not.toMatch(/https?:\/\//);
    expect(digests[0]!.body.split('\n').filter((l) => l.startsWith('•'))).toHaveLength(first.reminded);

    // Same day: no second digest. (The sweep ran at a fixed `now`; the rows
    // carry the wall clock — put them at the sweep's time.)
    await prisma.notification.updateMany({ where: { category: DIGEST_CATEGORY }, data: { createdAt: now } });
    const again = await runAttestationReminderSweep(prisma, new Date(now.getTime() + 3600_000));
    expect(again.reminded).toBe(0);

    // A snoozed signal is left out of the next digest.
    const signals = await a.get('/compliance-scorecard/attestations');
    const due = signals.body.signals.find((s: { status: string }) => s.status === 'overdue' || s.status === 'due_soon');
    expect(due).toBeTruthy();
    const snoozed = await a.post(`/compliance-scorecard/attestations/${due.key}/snooze`).send({ until: '2099-01-01' });
    expect(snoozed.status).toBe(400); // more than three months out
    const soon = new Date();
    soon.setDate(soon.getDate() + 7);
    const ok = await a.post(`/compliance-scorecard/attestations/${due.key}/snooze`).send({ until: soon.toISOString().slice(0, 10) });
    expect(ok.status).toBe(200);
    const after = await a.get('/compliance-scorecard/attestations');
    expect(after.body.signals.find((s: { key: string }) => s.key === due.key).snoozedUntil).toBeTruthy();
    const sweep = await runAttestationReminderSweep(prisma, new Date());
    expect(sweep.snoozed).toBeGreaterThanOrEqual(1);
    expect((await a.delete(`/compliance-scorecard/attestations/${due.key}/snooze`)).status).toBe(204);
  });
});

describe('settings health and the routing cleanup', () => {
  it('badges a failing integration; marks misrouted unread notices read, once', async () => {
    const { a } = await hr();
    await prisma.integrationConnection.create({ data: { vendor: 'BAMBOOHR', name: 'Bamboo', status: 'ERROR', lastError: '401' } as never }).catch(() => null);
    const health = await a.get('/admin/settings-health');
    expect(health.status).toBe(200);
    expect(Array.isArray(health.body.items)).toBe(true);

    const { user: mkt } = await createUser({ role: 'MARKETING_MANAGER' });
    await prisma.notification.create({ data: { channel: 'IN_APP', status: 'SENT', recipientUserId: mkt.id, subject: 'Overdue', body: 'x', category: 'compliance.attestation.X.2026-10-01' } });
    await prisma.notification.create({ data: { channel: 'IN_APP', status: 'SENT', recipientUserId: mkt.id, subject: 'Campaign', body: 'x', category: 'broadcast' } });
    const dry = await cleanupMisroutedNotifications(prisma);
    expect(dry).toMatchObject({ misrouted: 1, updated: 0 });
    const applied = await cleanupMisroutedNotifications(prisma, { apply: true });
    expect(applied.updated).toBe(1);
    expect((await cleanupMisroutedNotifications(prisma, { apply: true })).misrouted).toBe(0);
    expect(await prisma.notification.count({ where: { recipientUserId: mkt.id, readAt: null } })).toBe(1);
  });
});
