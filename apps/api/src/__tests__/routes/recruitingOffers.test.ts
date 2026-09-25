import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';

// The offer email carries the candidate's private signing link; capture it.
const sent = vi.hoisted(() => [] as Array<{ to: string | null; subject: string | null; body: string }>);
vi.mock('../../lib/notifications.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/notifications.js')>();
  return {
    ...real,
    send: vi.fn(async (input: Parameters<typeof real.send>[0]) => {
      sent.push({ to: input.recipient.email, subject: input.subject, body: input.body });
      return { externalRef: 'test', status: 'SENT' as const };
    }),
  };
});

import { createApp } from '../../app.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import {
  DEFAULT_TEST_PASSWORD,
  createClient,
  createStandardTemplate,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * Offers that are approved, written from a template, and signed.
 *
 * An offer was a record and a plain-text email: nothing checked its pay
 * against the client's band, the candidate "accepted" by replying and a
 * recruiter clicking Accepted for them, and nothing was signed.
 */

const app = () => createApp();
beforeEach(async () => {
  await truncateAll();
  sent.length = 0;
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
  // The client's band for cashiers: $14–$17 an hour.
  await prisma.compBand.create({
    data: { clientId: client.id, name: 'Cashier', payType: 'HOURLY', minAmount: 14, midAmount: 15.5, maxAmount: 17 },
  });
  const { user: rec } = await createUser({ role: 'INTERNAL_RECRUITER' });
  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const a = await loginAs(rec.email);
  const c = await a.post('/recruiting/candidates').send({
    firstName: 'Kim', lastName: 'Phan', email: 'kim.phan@example.com', position: 'Cashier',
  });
  return { a, rec, hr, client, candidateId: c.body.id as string };
}

function offerBody(candidateId: string, clientId: string, hourlyRate: number) {
  return { candidateId, clientId, jobTitle: 'Cashier', startDate: '2026-10-05', hourlyRate };
}

/** The raw token from the link in the offer email. */
function linkToken(): string {
  const m = sent.map((x) => x.body).join('\n').match(/\/offer\/([A-Za-z0-9_-]+)/);
  if (!m) throw new Error('no offer link was emailed');
  return m[1]!;
}

describe('pay outside the band needs someone else\'s approval', () => {
  it('an offer inside the band is ready to send', async () => {
    const { a, client, candidateId } = await setup();
    const r = await a.post('/offers').send(offerBody(candidateId, client.id, 15.5));
    expect(r.body).toMatchObject({ status: 'DRAFT', approvalNote: null });
  });

  it('is held, can\'t be sent, and can\'t be approved by whoever drafted it', async () => {
    const { a, hr, client, candidateId } = await setup();
    const r = await a.post('/offers').send(offerBody(candidateId, client.id, 19));
    expect(r.body.status).toBe('PENDING_APPROVAL');
    expect(r.body.approvalNote).toBe('$19.00/hr is above the Cashier band ($14.00–$17.00/hr).');

    expect((await a.post(`/offers/${r.body.id}/send`)).body.error.code).toBe('needs_approval');
    // The recruiter holds manage:comp too — still not their call.
    expect((await a.post(`/offers/${r.body.id}/approve`)).body.error.code).toBe('own_offer');

    // HR heard about it.
    await flushPendingNotifications();
    const bell = await prisma.notification.findFirst({ where: { recipientUserId: hr.id, subject: 'An offer needs your approval' } });
    expect(bell?.body).toContain('$19.00/hr is above the Cashier band');

    const hrA = await loginAs(hr.email);
    expect((await hrA.post(`/offers/${r.body.id}/approve`)).status).toBe(200);
    expect((await a.post(`/offers/${r.body.id}/send`)).status).toBe(200);

    const kinds = (await a.get(`/recruiting/candidates/${candidateId}/events`)).body.events.map((e: { kind: string }) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['OFFER_APPROVAL_REQUESTED', 'OFFER_APPROVED', 'OFFER_SENT']));
  });

  it('a declined approval withdraws it, with the reason', async () => {
    const { a, hr, client, candidateId } = await setup();
    const r = await a.post('/offers').send(offerBody(candidateId, client.id, 12));
    expect(r.body.approvalNote).toMatch(/below the Cashier band/);
    const hrA = await loginAs(hr.email);
    expect((await hrA.post(`/offers/${r.body.id}/decline-approval`).send({})).status).toBe(400);
    await hrA.post(`/offers/${r.body.id}/decline-approval`).send({ reason: 'Below minimum wage for the store.' });
    const [o] = (await a.get(`/offers?candidateId=${candidateId}`)).body.offers;
    expect(o).toMatchObject({ status: 'WITHDRAWN', approvalDeclinedReason: 'Below minimum wage for the store.' });
  });
});

describe('the letter, from a template', () => {
  it('merges the candidate, the job, the pay and the client — and names what it could not fill', async () => {
    const { a, client, candidateId } = await setup();
    const t = await prisma.documentTemplate.create({ data: { name: 'Standard offer', kind: 'OFFER_LETTER' } });
    const v = await prisma.documentTemplateVersion.create({
      data: {
        templateId: t.id,
        version: 1,
        body: 'Dear {{associate.firstName}}, we offer you {{offer.jobTitle}} at {{client.name}} for {{offer.pay}}, starting {{offer.startDate}}. {{offer.parking}}',
        publishedAt: new Date(),
      },
    });
    await prisma.documentTemplate.update({ where: { id: t.id }, data: { currentVersionId: v.id } });

    const r = await a.post('/offers/letter-preview').send(offerBody(candidateId, client.id, 15.5));
    expect(r.status).toBe(200);
    expect(r.body.body).toBe(
      'Dear Kim, we offer you Cashier at Walmart for $15.50 per hour, starting Monday, October 5, 2026. ',
    );
    expect(r.body.unresolvedTokens).toEqual(['offer.parking']);
  });

  it('says so when there is no template to write from', async () => {
    const { a, client, candidateId } = await setup();
    const r = await a.post('/offers/letter-preview').send(offerBody(candidateId, client.id, 15.5));
    expect(r.body.error.code).toBe('no_template');
  });
});

describe('the candidate reads and signs it', () => {
  async function sentOffer() {
    const s = await setup();
    const o = await s.a.post('/offers').send({ ...offerBody(s.candidateId, s.client.id, 15.5), letterBody: 'Welcome aboard.' });
    await s.a.post(`/offers/${o.body.id}/send`);
    await vi.waitFor(() => expect(sent.some((x) => x.to === 'kim.phan@example.com')).toBe(true));
    return { ...s, offerId: o.body.id as string, token: linkToken() };
  }

  it('signing accepts it, keeps a signed PDF, and retires the link', async () => {
    const { a, rec, offerId, token, candidateId } = await sentOffer();
    const pub = request(app());
    const view = await pub.get(`/offer-letters/${token}`);
    expect(view.body).toMatchObject({ candidateFirstName: 'Kim', jobTitle: 'Cashier', pay: '$15.50 per hour', status: 'SENT', letterBody: 'Welcome aboard.' });

    expect((await pub.post(`/offer-letters/${token}/accept`).send({ typedName: 'Kim Phan' })).status).toBe(400); // must agree
    const ok = await pub.post(`/offer-letters/${token}/accept`).send({ typedName: 'Kim Phan', agree: true });
    expect(ok.status).toBe(200);

    const [o] = (await a.get(`/offers?candidateId=${candidateId}`)).body.offers;
    expect(o).toMatchObject({ status: 'ACCEPTED', signedName: 'Kim Phan', hasSignedPdf: true });
    const pdf = await a.get(`/offers/${offerId}/signed.pdf`).buffer(true);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.body.subarray(0, 4).toString()).toBe('%PDF');

    // One use.
    expect((await pub.get(`/offer-letters/${token}`)).status).toBe(404);
    const events = (await a.get(`/recruiting/candidates/${candidateId}/events`)).body.events;
    expect(events[0]).toMatchObject({ kind: 'OFFER_DECIDED', body: 'Accepted: Cashier — e-signed by Kim Phan', actorName: null });
    await flushPendingNotifications();
    // The bell (an email copy may ride along, per their preferences).
    expect(await prisma.notification.count({ where: { recipientUserId: rec.id, channel: 'IN_APP', subject: 'Offer accepted and signed' } })).toBe(1);
  });

  it('the signed letter is filed with their paperwork when they are hired', async () => {
    const { a, offerId, token, candidateId, client } = await sentOffer();
    await request(app()).post(`/offer-letters/${token}/accept`).send({ typedName: 'Kim Phan', agree: true });
    const hire = await a
      .post(`/recruiting/candidates/${candidateId}/hire`)
      .send({ clientId: client.id, templateId: (await createStandardTemplate()).id, offerId });
    expect(hire.status).toBe(200);
    const doc = await prisma.documentRecord.findFirstOrThrow({ where: { associateId: hire.body.hiredAssociateId, kind: 'OFFER_LETTER' } });
    expect(doc.status).toBe('VERIFIED');
    expect(doc.size).toBeGreaterThan(0);
  });

  it('can be declined from the link, with a reason', async () => {
    const { a, token, candidateId } = await sentOffer();
    await request(app()).post(`/offer-letters/${token}/decline`).send({ reason: 'Took a job closer to home.' });
    const [o] = (await a.get(`/offers?candidateId=${candidateId}`)).body.offers;
    expect(o).toMatchObject({ status: 'DECLINED', declineReason: 'Took a job closer to home.' });
  });

  it('an expired link says so and can\'t be signed', async () => {
    const { offerId, token } = await sentOffer();
    await prisma.offer.update({ where: { id: offerId }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    const r = await request(app()).post(`/offer-letters/${token}/accept`).send({ typedName: 'Kim Phan', agree: true });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toBe('This offer has expired.');
    expect((await prisma.offer.findUniqueOrThrow({ where: { id: offerId } })).status).toBe('EXPIRED');
  });

  it('a made-up link is a 404', async () => {
    expect((await request(app()).get('/offer-letters/not-a-real-token')).status).toBe(404);
  });
});
