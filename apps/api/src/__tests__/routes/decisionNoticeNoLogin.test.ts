import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The provider call, controlled: a real send, the development stub, or a refusal.
const mode = vi.hoisted(() => ({ value: 'sent' as 'sent' | 'stub' | 'fail', sent: [] as Array<{ to: string | null; subject: string | null }> }));
vi.mock('../../lib/notifications.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/notifications.js')>();
  return {
    ...real,
    send: vi.fn(async (input: Parameters<typeof real.send>[0]) => {
      if (mode.value === 'fail') throw new Error('Resend 422: invalid recipient');
      mode.sent.push({ to: input.recipient.email, subject: input.subject });
      return mode.value === 'stub' ? { externalRef: 'STUB-EMAIL-abc', providerMessageId: null } : { externalRef: 're_123', providerMessageId: 're_123' };
    }),
  };
});

import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createUser, prisma, truncateAll } from '../../../test/db.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';

/**
 * Decision notices to an applicant with no login (audit Tier 3, wave 2):
 * the notice goes to the email on their application or candidate record,
 * the send is its own Notification row with the provider's real outcome,
 * and the record is stamped only when the email actually went out.
 */

beforeEach(async () => {
  await truncateAll();
  mode.value = 'sent';
  mode.sent.length = 0;
});
afterAll(async () => {
  await prisma.$disconnect();
});

const WORKER = '00000000-0000-4000-8000-00000000a6e7';
const decision = (data: { subjectAssociateId?: string; subjectRef?: string }) =>
  prisma.automatedDecisionRecord.create({
    data: { tenantId: ALTO_TENANT_ID, workerId: WORKER, capabilityKey: 'shift.fill', decisionType: 'HIRING', outcome: 'ADVERSE', summary: 'Not advanced to interview.', humanDecidedAt: new Date(), ...data },
  });

async function hr() {
  const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
  return loginAs(agent(), user.email);
}

describe('a decision notice to a subject with no login', () => {
  it('is emailed to the address on their application and recorded as sent', async () => {
    const applicant = await createAssociate({ firstName: 'Ivy', lastName: 'Applicant', email: 'ivy.applicant@example.com' });
    const row = await decision({ subjectAssociateId: applicant.id });
    const a = await hr();
    const r = await a.post(`/agents/decisions/${row.id}/events`).send({ event: 'notice_given' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ delivered: true, delivery: { channel: 'EMAIL', status: 'SENT', to: 'ivy.applicant@example.com' } });
    expect(mode.sent).toEqual([{ to: 'ivy.applicant@example.com', subject: 'A decision about you involved an automated system' }]);
    const note = await prisma.notification.findUniqueOrThrow({ where: { id: r.body.delivery.notificationId } });
    expect(note).toMatchObject({ channel: 'EMAIL', status: 'SENT', recipientEmail: 'ivy.applicant@example.com', externalRef: 're_123', category: 'mandatory_notice' });
    expect(await prisma.automatedDecisionRecord.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ noticeChannel: 'EMAIL' });
  });

  it('a candidate named by reference is reached at the candidate’s email', async () => {
    const c = await prisma.candidate.create({ data: { firstName: 'Cam', lastName: 'Didate', email: 'cam@example.com' } });
    const row = await decision({ subjectRef: `candidate:${c.id}` });
    const a = await hr();
    const r = await a.post(`/agents/decisions/${row.id}/events`).send({ event: 'explanation_sent' });
    expect(r.status).toBe(200);
    expect(r.body.delivery).toMatchObject({ status: 'SENT', to: 'cam@example.com' });
    expect(mode.sent[0]!.subject).toBe('How a decision about you was made');
  });

  it('when email is not set up or refuses, nothing is stamped and the send says why', async () => {
    const applicant = await createAssociate({ email: 'nope@example.com' });
    const row = await decision({ subjectAssociateId: applicant.id });
    const a = await hr();

    mode.value = 'stub';
    const stub = await a.post(`/agents/decisions/${row.id}/events`).send({ event: 'notice_given' });
    expect(stub.status).toBe(409);
    expect(stub.body.error.code).toBe('notice_not_sent');
    expect(stub.body.error.details.delivery).toMatchObject({ status: 'NOT_CONFIGURED', to: 'nope@example.com' });
    expect((await prisma.automatedDecisionRecord.findUniqueOrThrow({ where: { id: row.id } })).noticeGivenAt).toBeNull();

    mode.value = 'fail';
    const failed = await a.post(`/agents/decisions/${row.id}/events`).send({ event: 'notice_given' });
    expect(failed.status).toBe(409);
    expect(failed.body.error.details.delivery.status).toBe('FAILED');
    const rows = await prisma.notification.findMany({ where: { recipientEmail: 'nope@example.com' }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((n) => n.status)).toEqual(['NOT_CONFIGURED', 'FAILED']);
    expect(rows.every((n) => n.sentAt === null)).toBe(true);

    // Given on paper instead: recorded by hand, not claimed as delivered.
    const paper = await a.post(`/agents/decisions/${row.id}/events`).send({ event: 'notice_given', channel: 'PAPER' });
    expect(paper.status).toBe(200);
    expect(paper.body).toMatchObject({ delivered: false, delivery: { status: 'BY_HAND', channel: 'PAPER' } });
  });

  it('with no address anywhere, it says so', async () => {
    const row = await decision({ subjectRef: 'walk-in applicant #12' });
    const a = await hr();
    const r = await a.post(`/agents/decisions/${row.id}/events`).send({ event: 'notice_given' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('no_address');
    expect(mode.sent).toHaveLength(0);
  });
});
