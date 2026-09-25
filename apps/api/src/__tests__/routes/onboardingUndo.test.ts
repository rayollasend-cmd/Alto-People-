import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';

const sent = vi.hoisted(() => [] as Array<{ to: string | null; subject: string | null }>);
vi.mock('../../lib/notifications.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/notifications.js')>();
  return {
    ...real,
    send: vi.fn(async (input: Parameters<typeof real.send>[0]) => {
      sent.push({ to: input.recipient.email, subject: input.subject });
      return { externalRef: 'test', status: 'SENT' as const };
    }),
  };
});

import { createApp } from '../../app.js';
import { env } from '../../config/env.js';
import { deliverDueInvite } from '../../lib/inviteDelivery.js';
import { expireStaleInvites } from '../../lib/onboardingUndo.js';
import { runOnboardingPurgeSweep } from '../../lib/onboardingPurge.js';
import { getBlobStore } from '../../lib/blobStore.js';
import {
  DEFAULT_TEST_PASSWORD,
  createClient,
  createStandardTemplate,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * Taking things back: undo a hire, cancel a mistaken invite, hold an
 * invite a few seconds for an Undo, and invites nobody answered.
 */

const app = () => createApp();
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

beforeEach(async () => {
  await truncateAll();
  sent.length = 0;
});
afterEach(() => {
  (env as { RESEND_API_KEY?: string }).RESEND_API_KEY = '';
  (env as { RESEND_FROM?: string }).RESEND_FROM = '';
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`loginAs(${email}) failed: ${r.status}`);
  return a;
}

async function setup() {
  const client = await createClient('Walmart');
  const template = await createStandardTemplate();
  const { user: rec } = await createUser({ role: 'INTERNAL_RECRUITER' });
  const a = await loginAs(rec.email);
  return { a, rec, client, template };
}

/** A candidate hired through Recruiting, with the invite link from the dev stub. */
async function hire(s: Awaited<ReturnType<typeof setup>>, email = 'kim@example.com') {
  const c = await s.a.post('/recruiting/candidates').send({ firstName: 'Kim', lastName: 'Phan', email, position: 'Cashier' });
  await s.a.post(`/recruiting/candidates/${c.body.id}/advance`).send({ stage: 'OFFER' });
  const offer = await prisma.offer.create({
    data: { candidateId: c.body.id, clientId: s.client.id, jobTitle: 'Cashier', startDate: new Date('2026-10-05'), hourlyRate: 15, status: 'ACCEPTED', decidedAt: new Date() },
  });
  const h = await s.a.post(`/recruiting/candidates/${c.body.id}/hire`).send({ clientId: s.client.id, templateId: s.template.id, offerId: offer.id });
  if (h.status !== 200) throw new Error(`hire failed: ${h.status} ${JSON.stringify(h.body)}`);
  const token = (h.body.inviteUrl as string).split('/accept-invite/')[1]!;
  return { candidateId: c.body.id as string, applicationId: h.body.applicationId as string, associateId: h.body.hiredAssociateId as string, token, offerId: offer.id };
}

describe('undo a hire', () => {
  it('before they start: their onboarding is removed, the link dies, and they go back to Offer', async () => {
    const s = await setup();
    const h = await hire(s);
    const r = await s.a.post(`/recruiting/candidates/${h.candidateId}/undo-hire`).send({ reason: 'Hired the wrong Kim' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ stage: 'OFFER', hiredAssociateId: null, mode: 'removed' });

    expect(await prisma.associate.findUnique({ where: { id: h.associateId } })).toBeNull();
    expect(await prisma.application.findUnique({ where: { id: h.applicationId } })).toBeNull();
    expect((await request(app()).get(`/auth/invite/${h.token}`)).status).toBe(404);

    const [ev] = (await s.a.get(`/recruiting/candidates/${h.candidateId}/events`)).body.events;
    expect(ev).toMatchObject({ kind: 'HIRE_UNDONE', body: 'Hired the wrong Kim', fromStage: 'HIRED', toStage: 'OFFER' });
    // Their signed offer stands: they're ready to hire again — and can be.
    expect((await s.a.get('/recruiting/home')).body.waitingOnYou.readyToHire.map((o: { candidateId: string }) => o.candidateId)).toContain(h.candidateId);
    const again = await s.a.post(`/recruiting/candidates/${h.candidateId}/hire`).send({ clientId: s.client.id, templateId: s.template.id, offerId: h.offerId });
    expect(again.status).toBe(200);
  });

  it('not once they have started — that is a separation', async () => {
    const s = await setup();
    const h = await hire(s);
    await prisma.onboardingTask.updateMany({ where: { checklist: { applicationId: h.applicationId } }, data: { status: 'DONE', completedAt: new Date() } });
    const r = await s.a.post(`/recruiting/candidates/${h.candidateId}/undo-hire`).send({ reason: 'Oops' });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/already started their onboarding paperwork — end their employment with a separation/);
    expect(await prisma.associate.findUnique({ where: { id: h.associateId } })).not.toBeNull();
  });

  it('a rehire keeps their history: the invite is cancelled, not their record', async () => {
    const s = await setup();
    // Worked here before, and left.
    const past = await prisma.associate.create({ data: { firstName: 'Kim', lastName: 'Phan', email: 'kim@example.com', separatedAt: ago(200) } });
    await prisma.separation.create({ data: { associateId: past.id, reason: 'VOLUNTARY_OTHER_OPPORTUNITY', lastDayWorked: ago(200), completedAt: ago(199) } });
    const h = await hire(s);
    expect(h.associateId).toBe(past.id);
    const r = await s.a.post(`/recruiting/candidates/${h.candidateId}/undo-hire`).send({ reason: 'Client withdrew the role' });
    expect(r.body.mode).toBe('cancelled');
    const appRow = await prisma.application.findUniqueOrThrow({ where: { id: h.applicationId } });
    expect(appRow).toMatchObject({ status: 'CANCELLED', cancelReason: 'HIRE_UNDONE', cancelNote: 'Client withdrew the role' });
    const assoc = await prisma.associate.findUniqueOrThrow({ where: { id: past.id } });
    expect(assoc.separatedAt).not.toBeNull();
    expect((await prisma.user.findFirstOrThrow({ where: { associateId: past.id } })).status).toBe('DISABLED');
    expect((await request(app()).get(`/auth/invite/${h.token}`)).status).toBe(404);
  });

  it('the onboarding clean-up takes the hire back too — and keeps the signed offer letter', async () => {
    const s = await setup();
    const h = await hire(s);
    await getBlobStore().put(`offers/${h.offerId}-signed.pdf`, Buffer.from('%PDF-1.4 signed'), 'application/pdf');
    await prisma.offer.update({ where: { id: h.offerId }, data: { signedPdfKey: `offers/${h.offerId}-signed.pdf` } });
    await prisma.documentRecord.create({
      data: { associateId: h.associateId, clientId: s.client.id, kind: 'OFFER_LETTER', status: 'VERIFIED', s3Key: `offers/${h.offerId}-signed.pdf`, filename: 'offer.pdf', mimeType: 'application/pdf', size: 15 },
    });
    // Never accepted; well past the purge's three days.
    await prisma.inviteToken.updateMany({ data: { createdAt: ago(5) } });
    await prisma.user.updateMany({ where: { associateId: h.associateId }, data: { createdAt: ago(5) } });
    await runOnboardingPurgeSweep();
    expect(await prisma.associate.findUnique({ where: { id: h.associateId } })).toBeNull();
    const c = await prisma.candidate.findUniqueOrThrow({ where: { id: h.candidateId } });
    expect(c).toMatchObject({ stage: 'OFFER', hiredAssociateId: null });
    const ev = await prisma.candidateEvent.findFirstOrThrow({ where: { candidateId: h.candidateId, kind: 'HIRE_UNDONE' } });
    expect(ev.actorUserId).toBeNull();
    expect(ev.body).toMatch(/undone automatically/);
    expect(await getBlobStore().get(`offers/${h.offerId}-signed.pdf`)).not.toBeNull();
  });
});

describe('cancel an invite sent by mistake', () => {
  async function invite(s: Awaited<ReturnType<typeof setup>>, email: string, clientId = s.client.id) {
    const r = await s.a.post('/onboarding/applications').send({
      associateFirstName: 'Ana', associateLastName: 'Diaz', associateEmail: email, clientId, templateId: s.template.id,
    });
    if (r.status !== 201) throw new Error(`invite failed ${r.status} ${JSON.stringify(r.body)}`);
    return { id: r.body.id as string, token: (r.body.inviteUrl as string).split('/accept-invite/')[1]! };
  }

  it('removes a never-used invite without a "declined" email, and the address is free for the right one', async () => {
    const s = await setup();
    const inv = await invite(s, 'ana@example.com');
    sent.length = 0;
    const r = await s.a.post(`/onboarding/applications/${inv.id}/cancel`).send({ reason: 'WRONG_CLIENT' });
    expect(r.status).toBe(200);
    expect(r.body.mode).toBe('removed');
    expect(sent).toEqual([]);
    expect((await request(app()).get(`/auth/invite/${inv.token}`)).status).toBe(404);
    const target = await createClient('Target');
    expect((await invite(s, 'ana@example.com', target.id)).id).toBeTruthy();
  });

  it('a duplicate: cancelling one leaves the other invite working', async () => {
    const s = await setup();
    const first = await invite(s, 'ana@example.com');
    const second = await invite(s, 'ana@example.com');
    const r = await s.a.post(`/onboarding/applications/${second.id}/cancel`).send({ reason: 'DUPLICATE' });
    expect(r.body.mode).toBe('cancelled');
    expect((await prisma.application.findUniqueOrThrow({ where: { id: second.id } })).status).toBe('CANCELLED');
    expect((await request(app()).get(`/auth/invite/${first.token}`)).status).toBe(200);
    // Closed, not in the working set.
    const active = (await s.a.get('/onboarding/applications?status=ACTIVE')).body.applications.map((x: { id: string }) => x.id);
    expect(active).toEqual([first.id]);
    const closed = (await s.a.get('/onboarding/applications?status=ARCHIVED')).body.applications.map((x: { id: string }) => x.id);
    expect(closed).toEqual([second.id]);
  });

  it('someone who accepted is kept, cancelled and signed out — and can be reopened', async () => {
    const s = await setup();
    const inv = await invite(s, 'ana@example.com');
    expect((await request(app()).post('/auth/accept-invite').send({ token: inv.token, password: 'a-good-password-123' })).status).toBe(200);
    const r = await s.a.post(`/onboarding/applications/${inv.id}/cancel`).send({ reason: 'NOT_JOINING', note: 'Took another job' });
    expect(r.body.mode).toBe('cancelled');
    const user = await prisma.user.findFirstOrThrow({ where: { email: 'ana@example.com' } });
    expect(user.status).toBe('DISABLED');
    const re = await s.a.post(`/onboarding/applications/${inv.id}/reopen`);
    expect(re.status).toBe(200);
    expect((await prisma.application.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('DRAFT');
    expect((await prisma.user.findFirstOrThrow({ where: { email: 'ana@example.com' } })).status).toBe('ACTIVE');
  });

  it('a hire’s invite is undone from Recruiting, so the candidate goes back too', async () => {
    const s = await setup();
    const h = await hire(s);
    const r = await s.a.post(`/onboarding/applications/${h.applicationId}/cancel`).send({ reason: 'SENT_IN_ERROR' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('hired_in_recruiting');
  });

  it('an application already decided can’t be cancelled', async () => {
    const s = await setup();
    const inv = await invite(s, 'ana@example.com');
    await prisma.application.update({ where: { id: inv.id }, data: { status: 'APPROVED' } });
    expect((await s.a.post(`/onboarding/applications/${inv.id}/cancel`).send({ reason: 'OTHER' })).status).toBe(409);
  });
});

describe('the invite waits a few seconds for an Undo', () => {
  it('holds the email, sends it with a fresh link when the window passes — or never, if undone', async () => {
    (env as { RESEND_API_KEY?: string }).RESEND_API_KEY = 're_test';
    (env as { RESEND_FROM?: string }).RESEND_FROM = 'Alto <hr@alto.test>';
    const s = await setup();
    const r = await s.a.post('/onboarding/applications').send({
      associateFirstName: 'Ana', associateLastName: 'Diaz', associateEmail: 'ana@example.com', clientId: s.client.id, templateId: s.template.id,
    });
    expect(r.status).toBe(201);
    const dueAt = Date.parse(r.body.emailDueAt);
    expect(dueAt - Date.now()).toBeGreaterThan(15_000);
    expect(r.body.inviteUrl).toBeNull();
    // Nothing sent, no link exists yet.
    expect(sent.filter((m) => m.to === 'ana@example.com')).toEqual([]);
    expect(await prisma.inviteToken.count()).toBe(0);
    expect(await deliverDueInvite(r.body.id)).toBe(false);
    // Once the window has passed it goes, once.
    expect(await deliverDueInvite(r.body.id, new Date(dueAt + 1000))).toBe(true);
    expect(await deliverDueInvite(r.body.id, new Date(dueAt + 2000))).toBe(false);
    expect(sent.filter((m) => m.to === 'ana@example.com')).toHaveLength(1);
    expect(await prisma.inviteToken.count()).toBe(1);

    // Undone inside the window: never sent.
    const r2 = await s.a.post('/onboarding/applications').send({
      associateFirstName: 'Lee', associateLastName: 'Ray', associateEmail: 'lee@example.com', clientId: s.client.id, templateId: s.template.id,
    });
    await s.a.post(`/onboarding/applications/${r2.body.id}/cancel`).send({ reason: 'SENT_IN_ERROR' });
    expect(await deliverDueInvite(r2.body.id, new Date(Date.now() + 60_000))).toBe(false);
    expect(sent.filter((m) => m.to === 'lee@example.com')).toEqual([]);
  });
});

describe('invites nobody answered', () => {
  it('close after 14 days untouched — a rehire’s hire goes back to Offer', async () => {
    const s = await setup();
    const past = await prisma.associate.create({ data: { firstName: 'Kim', lastName: 'Phan', email: 'kim@example.com', separatedAt: ago(200) } });
    await prisma.separation.create({ data: { associateId: past.id, reason: 'VOLUNTARY_OTHER_OPPORTUNITY', lastDayWorked: ago(200), completedAt: ago(199) } });
    const h = await hire(s);
    await prisma.inviteToken.updateMany({ data: { createdAt: ago(20) } });
    await prisma.$executeRaw`UPDATE "Application" SET "invitedAt" = ${ago(20)}, "updatedAt" = ${ago(20)} WHERE id = ${h.applicationId}::uuid`;
    expect(await expireStaleInvites()).toBe(1);
    expect((await prisma.application.findUniqueOrThrow({ where: { id: h.applicationId } }))).toMatchObject({ status: 'CANCELLED', cancelReason: 'EXPIRED' });
    expect((await prisma.candidate.findUniqueOrThrow({ where: { id: h.candidateId } })).stage).toBe('OFFER');
    expect((await request(app()).get(`/auth/invite/${h.token}`)).status).toBe(404);
  });

  it('a recent reminder or link keeps an invite open', async () => {
    const s = await setup();
    const past = await prisma.associate.create({ data: { firstName: 'Kim', lastName: 'Phan', email: 'kim@example.com', separatedAt: ago(200) } });
    await prisma.separation.create({ data: { associateId: past.id, reason: 'VOLUNTARY_OTHER_OPPORTUNITY', lastDayWorked: ago(200), completedAt: ago(199) } });
    const h = await hire(s);
    await prisma.$executeRaw`UPDATE "Application" SET "invitedAt" = ${ago(20)}, "updatedAt" = ${ago(20)} WHERE id = ${h.applicationId}::uuid`;
    // The link was (re)sent 2 days ago.
    await prisma.inviteToken.updateMany({ data: { createdAt: ago(2) } });
    expect(await expireStaleInvites()).toBe(0);
  });
});
