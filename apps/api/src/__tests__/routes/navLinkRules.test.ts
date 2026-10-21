import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { flushPendingNotifications } from '../../lib/notify.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';

/**
 * The navigation layer's rules: a link a person gets is one they can open,
 * at the moment it is worth opening; a job profile move that changes pay
 * rules goes to a second person; the bell marks one group read at once.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const soon = (min: number) => new Date(Date.now() + min * 60_000);

describe('swap notices', () => {
  it('tells supervisors about a swap with the shift while it waits on the coworker, and with the queue once accepted', async () => {
    const client = await createClient('Coastal Resort');
    const requester = await createAssociate({ firstName: 'Rae', lastName: 'Quest' });
    const counter = await createAssociate({ firstName: 'Cole', lastName: 'Ter' });
    const { user: uReq } = await createUser({ role: 'ASSOCIATE', email: requester.email, associateId: requester.id });
    const { user: uCounter } = await createUser({ role: 'ASSOCIATE', email: counter.email, associateId: counter.id });
    const { user: lead } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id });
    const shift = await prisma.shift.create({
      data: { clientId: client.id, position: 'Server', startsAt: soon(24 * 60), endsAt: soon(24 * 60 + 480), assignedAssociateId: requester.id, status: 'ASSIGNED' },
    });

    const a = await loginAs(agent(), uReq.email);
    const created = await a.post('/scheduling/swap-requests').send({ shiftId: shift.id, counterpartyAssociateId: counter.id });
    expect(created.status).toBe(201);
    await flushPendingNotifications();
    const first = await prisma.notification.findFirstOrThrow({ where: { recipientUserId: lead.id, channel: 'IN_APP' }, orderBy: { createdAt: 'asc' } });
    expect(first.linkUrl).toBe(`/scheduling?shift=${shift.id}`);

    const c = await loginAs(agent(), uCounter.email);
    expect((await c.post(`/scheduling/swap-requests/${created.body.id}/peer-accept`)).status).toBe(200);
    await flushPendingNotifications();
    const ready = await prisma.notification.findFirstOrThrow({ where: { recipientUserId: lead.id, channel: 'IN_APP', subject: { startsWith: 'Swap ready to approve' } } });
    expect(ready.linkUrl).toBe(`/approvals?tab=swaps&swap=${created.body.id}`);
  });
});

describe('job profile, set in place', () => {
  it('a move that changes overtime exemption is refused as an org edit — it is a promotion', async () => {
    const person = await createAssociate({ firstName: 'Pat', lastName: 'Hourly' });
    const hourly = await prisma.jobProfile.create({ data: { code: 'SRV', title: 'Server', isExempt: false } });
    const hourly2 = await prisma.jobProfile.create({ data: { code: 'HST', title: 'Host', isExempt: false } });
    const exempt = await prisma.jobProfile.create({ data: { code: 'MGR', title: 'Restaurant manager', isExempt: true } });
    await prisma.associate.update({ where: { id: person.id }, data: { jobProfileId: hourly.id } });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(agent(), hr.email);

    const lateral = await a.put(`/org/associates/${person.id}/org`).send({ jobProfileId: hourly2.id });
    expect(lateral.status).toBe(200);
    const up = await a.put(`/org/associates/${person.id}/org`).send({ jobProfileId: exempt.id });
    expect(up.status).toBe(409);
    expect(up.body.error.code).toBe('job_profile_needs_approval');
    expect((await prisma.associate.findUniqueOrThrow({ where: { id: person.id } })).jobProfileId).toBe(hourly2.id);
  });
});

describe('the bell', () => {
  it('marks just the named notifications read — and only the caller’s own', async () => {
    const { user: me } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { user: other } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const mk = (recipientUserId: string) => prisma.notification.create({ data: { channel: 'IN_APP', status: 'SENT', recipientUserId, subject: 'x', body: 'x', category: 'scheduling', sentAt: new Date() } });
    const [n1, n2, n3, theirs] = await Promise.all([mk(me.id), mk(me.id), mk(me.id), mk(other.id)]);
    const a = await loginAs(agent(), me.email);
    const r = await a.post('/communications/me/inbox/read-all').send({ ids: [n1.id, n2.id, theirs.id] });
    expect(r.body.updated).toBe(2);
    const read = await prisma.notification.findMany({ where: { readAt: { not: null } }, select: { id: true } });
    expect(read.map((x) => x.id).sort()).toEqual([n1.id, n2.id].sort());
    expect(n3.readAt).toBeNull();
  });
});
