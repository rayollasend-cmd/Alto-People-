import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createAssociate, createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';

/**
 * The HR case desk's counts (F500 2026-10-22): Open · Past SLA · Unassigned ·
 * Median first reply, and the queue filters behind the first three.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('GET /hr-cases-summary and the queue filters behind it', () => {
  it('counts open, unassigned, past SLA and the median first reply', async () => {
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Reyes' });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const now = Date.now();
    const mk = (data: { status?: 'OPEN' | 'IN_PROGRESS' | 'WAITING_ASSOCIATE' | 'RESOLVED' | 'CLOSED'; assignedToId?: string | null; dueAt?: Date | null; createdAt?: Date; subject: string }) =>
      prisma.hrCase.create({ data: { associateId: ana.id, category: 'OTHER', description: 'x', status: data.status ?? 'OPEN', assignedToId: data.assignedToId ?? null, dueAt: data.dueAt ?? null, createdAt: data.createdAt ?? new Date(now), subject: data.subject } });
    // Open set: OPEN unassigned past due; IN_PROGRESS assigned; WAITING unassigned.
    const a = await mk({ subject: 'A', dueAt: new Date(now - HOUR), createdAt: new Date(now - 10 * HOUR) });
    const b = await mk({ subject: 'B', status: 'IN_PROGRESS', assignedToId: hr.id, createdAt: new Date(now - 5 * DAY) });
    await mk({ subject: 'C', status: 'WAITING_ASSOCIATE', createdAt: new Date(now - 2 * DAY) });
    // Resolved, unassigned: not open, not unassigned. Filed 200 days ago: outside the reply window.
    const d = await mk({ subject: 'D', status: 'RESOLVED', createdAt: new Date(now - 3 * DAY) });
    const old = await mk({ subject: 'Old', status: 'CLOSED', createdAt: new Date(now - 200 * DAY) });

    // First replies: A after 2 h, B after 4 h, D after 9 h (median 4); C has
    // only an internal note and the associate's own comment — no reply yet.
    const reply = (caseId: string, at: number, extra: { internalNote?: boolean; authorAssociateId?: string } = {}) =>
      prisma.hrCaseComment.create({ data: { caseId, body: 'hi', createdAt: new Date(at), internalNote: extra.internalNote ?? false, authorUserId: extra.authorAssociateId ? null : hr.id, authorAssociateId: extra.authorAssociateId ?? null } });
    await reply(a.id, now - 8 * HOUR);
    await reply(a.id, now - 7 * HOUR); // a second reply doesn't move the first
    await reply(b.id, now - 5 * DAY + 4 * HOUR);
    await reply(d.id, now - 3 * DAY + 9 * HOUR);
    const c = await prisma.hrCase.findFirstOrThrow({ where: { subject: 'C' } });
    await reply(c.id, now - 2 * DAY + HOUR, { internalNote: true });
    await reply(c.id, now - 2 * DAY + 30 * 60_000, { authorAssociateId: ana.id });
    await reply(old.id, now - 199 * DAY);

    const http = await loginAs(agent(), hr.email);
    const res = await http.get('/hr-cases-summary');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ openTotal: 3, unassigned: 2, sla: { breached: 1 } });
    expect(res.body.firstReply).toEqual({ medianHours: 4, replied: 3, filed: 4, days: 90 });

    const open = await http.get('/hr-cases?state=open');
    expect(open.body.cases.map((x: { subject: string }) => x.subject).sort()).toEqual(['A', 'B', 'C']);
    const nobody = await http.get('/hr-cases?state=open&unassigned=true');
    expect(nobody.body.cases.map((x: { subject: string }) => x.subject).sort()).toEqual(['A', 'C']);
    expect(nobody.body.total).toBe(2);
  });

  it('has no median when nothing has been answered', async () => {
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Reyes' });
    await prisma.hrCase.create({ data: { associateId: ana.id, category: 'OTHER', subject: 'A', description: 'x' } });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const res = await (await loginAs(agent(), hr.email)).get('/hr-cases-summary');
    expect(res.body.firstReply).toEqual({ medianHours: null, replied: 0, filed: 1, days: 90 });
  });
});
