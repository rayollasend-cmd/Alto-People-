import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Invites go out by email with an .ics attached; capture who they go to.
const sent = vi.hoisted(() => [] as Array<{ to: string | null; subject: string | null; method: string | null }>);
vi.mock('../../lib/notifications.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/notifications.js')>();
  return {
    ...real,
    send: vi.fn(async (input: Parameters<typeof real.send>[0]) => {
      const a = input.attachments?.[0];
      sent.push({
        to: input.recipient.email,
        subject: input.subject,
        method: a ? (/method=(\w+)/.exec(a.contentType)?.[1] ?? null) : null,
      });
      return { externalRef: 'test', status: 'SENT' as const };
    }),
  };
});

import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * HR walk 9: an interview could only be assigned to "me". Now a panel of up
 * to three — a hiring manager, a recruiter, the client's store lead — each
 * on the record and each sent the invite; whoever comes off the panel gets
 * the cancellation. And the audit's Tier 3: removing candidates takes a list.
 */

beforeEach(async () => {
  await truncateAll();
  sent.length = 0;
});
afterAll(async () => {
  await prisma.$disconnect();
});

const inTwoDays = () => new Date(Date.now() + 2 * 86_400_000).toISOString();

async function setup() {
  const { user: rec } = await createUser({ role: 'INTERNAL_RECRUITER' });
  const a = await loginAs(agent(), rec.email);
  const c = await a.post('/recruiting/candidates').send({ firstName: 'Kim', lastName: 'Phan', email: 'kim.phan@example.com' });
  expect(c.status).toBe(201);
  return { a, rec, candidateId: c.body.id as string };
}

describe('interview panels', () => {
  it('books two interviewers, both on the record and both invited', async () => {
    const { a, candidateId } = await setup();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { user: ops } = await createUser({ role: 'OPERATIONS_MANAGER' });
    const r = await a.post('/interviews').send({ candidateId, interviewerUserIds: [hr.id, ops.id], scheduledFor: inTwoDays() });
    expect(r.status).toBe(201);
    expect(r.body.invited).toEqual({ candidate: true, interviewer: true });

    const row = await prisma.interview.findUniqueOrThrow({ where: { id: r.body.id }, include: { panel: true } });
    expect(row.interviewerUserId).toBe(hr.id);
    expect(row.panel.map((p) => p.userId).sort()).toEqual([hr.id, ops.id].sort());

    await vi.waitFor(() => expect(sent).toHaveLength(3));
    expect(sent.map((m) => m.to).sort()).toEqual(['kim.phan@example.com', hr.email, ops.email].sort());

    const list = await a.get(`/interviews?candidateId=${candidateId}`);
    expect(list.body.interviews[0].interviewers.map((i: { userId: string }) => i.userId).sort()).toEqual([hr.id, ops.id].sort());
    // The overlap check: one interviewer's interviews in a window.
    const mine = await a.get(`/interviews?interviewerUserId=${ops.id}&from=${new Date().toISOString()}&to=${new Date(Date.now() + 7 * 86_400_000).toISOString()}`);
    expect(mine.body.interviews).toHaveLength(1);
  });

  it('refuses a fourth interviewer and anyone who is not staff', async () => {
    const { a, candidateId } = await setup();
    const ids = await Promise.all(Array.from({ length: 4 }, () => createUser({ role: 'HR_ADMINISTRATOR' }).then((u) => u.user.id)));
    const four = await a.post('/interviews').send({ candidateId, interviewerUserIds: ids, scheduledFor: inTwoDays() });
    expect(four.status).toBe(400);
    const person = await createAssociate();
    const { user: assocUser } = await createUser({ role: 'ASSOCIATE', associateId: person.id });
    const notStaff = await a.post('/interviews').send({ candidateId, interviewerUserIds: [assocUser.id], scheduledFor: inTwoDays() });
    expect(notStaff.status).toBe(400);
    expect(await prisma.interview.count()).toBe(0);
  });

  it('a changed panel sends the cancellation only to who came off it', async () => {
    const { a, candidateId } = await setup();
    const { user: one } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { user: two } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { user: three } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const iv = await a.post('/interviews').send({ candidateId, interviewerUserIds: [one.id, two.id], scheduledFor: inTwoDays() });
    await vi.waitFor(() => expect(sent).toHaveLength(3));
    sent.length = 0;
    const r = await a.patch(`/interviews/${iv.body.id}`).send({ interviewerUserIds: [one.id, three.id] });
    expect(r.status).toBe(200);
    // Request to the candidate, one and three; a cancel to two only.
    await vi.waitFor(() => expect(sent).toHaveLength(4));
    const cancels = sent.filter((m) => m.method === 'CANCEL');
    expect(cancels.map((m) => m.to)).toEqual([two.email]);
    const row = await prisma.interview.findUniqueOrThrow({ where: { id: iv.body.id }, include: { panel: true } });
    expect(row.panel.map((p) => p.userId).sort()).toEqual([one.id, three.id].sort());
  });

  it('the picker lists hiring staff and the posting client’s portal users, never associates', async () => {
    const { a } = await setup();
    const client = await createClient('Coastal Resort');
    const other = await createClient('Elsewhere');
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { user: portal } = await createUser({ role: 'CLIENT_PORTAL', clientId: client.id });
    const { user: otherPortal } = await createUser({ role: 'CLIENT_PORTAL', clientId: other.id });
    const { user: fin } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const person = await createAssociate();
    const { user: assocUser } = await createUser({ role: 'ASSOCIATE', associateId: person.id });
    const posting = await prisma.jobPosting.create({ data: { clientId: client.id, title: 'Cashier', description: 'x', slug: 'cashier-coastal' } });
    const cand = await prisma.candidate.create({ data: { firstName: 'Lee', lastName: 'Ng', email: 'lee.ng@example.com', jobPostingId: posting.id } });

    const plain = await a.get('/recruiting/interviewers');
    expect(plain.status).toBe(200);
    const ids = plain.body.interviewers.map((i: { id: string }) => i.id);
    expect(ids).toContain(hr.id);
    expect(ids).not.toContain(assocUser.id);
    expect(ids).not.toContain(fin.id);
    expect(ids).not.toContain(portal.id);

    const forCand = await a.get(`/recruiting/interviewers?candidateId=${cand.id}`);
    const rows = forCand.body.interviewers as Array<{ id: string; clientName: string | null }>;
    expect(rows.find((r) => r.id === portal.id)?.clientName).toBe('Coastal Resort');
    expect(rows.map((r) => r.id)).not.toContain(otherPortal.id);
  });
});

describe('bulk candidate removal', () => {
  it('removes a list, skipping the hired one with the reason', async () => {
    const { a } = await setup();
    const mk = (n: string, stage: 'APPLIED' | 'HIRED' = 'APPLIED') =>
      prisma.candidate.create({ data: { firstName: n, lastName: 'X', email: `${n}@example.com`, stage } });
    const [c1, c2, hired] = await Promise.all([mk('one'), mk('two'), mk('three', 'HIRED')]);
    const r = await a.post('/recruiting/candidates/bulk-remove').send({ candidateIds: [c1.id, c2.id, hired.id], reason: 'Duplicate import' });
    expect(r.status).toBe(200);
    expect(r.body.removed).toBe(2);
    expect(r.body.skipped).toEqual([{ id: hired.id, reason: 'already hired' }]);
    const live = (await prisma.candidate.findMany({ where: { deletedAt: null }, select: { id: true } })).map((c) => c.id);
    expect(live).toContain(hired.id);
    expect(live).not.toContain(c1.id);
    expect(live).not.toContain(c2.id);
  });

  it('needs manage:recruiting', async () => {
    const { user: fin } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const f = await loginAs(agent(), fin.email);
    const c = await prisma.candidate.create({ data: { firstName: 'a', lastName: 'b', email: 'ab@example.com' } });
    const r = await f.post('/recruiting/candidates/bulk-remove').send({ candidateIds: [c.id] });
    expect(r.status).toBe(403);
  });
});
