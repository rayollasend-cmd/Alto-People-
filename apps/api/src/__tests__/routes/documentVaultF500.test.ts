import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { flushPendingNotifications } from '../../lib/notify.js';

/**
 * The document vault (F500 2026-10-22): the renewal tile counts documents
 * still good today that lapse within 30 days, the list opens on exactly
 * those, and HR can ask someone for a document they haven't uploaded.
 */

const DAY = 86_400_000;

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('the vault’s expiring count and list', () => {
  it('counts verified or in-review documents expiring within 30 days, and lists the same ones', async () => {
    const client = await createClient();
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Test' });
    const now = Date.now();
    let i = 0;
    const mk = (status: 'UPLOADED' | 'VERIFIED' | 'REJECTED' | 'EXPIRED', expiresInDays: number | null, deletedAt: Date | null = null) =>
      prisma.documentRecord.create({
        data: {
          associateId: ana.id,
          clientId: client.id,
          kind: 'ID',
          status,
          filename: `f${++i}.png`,
          mimeType: 'image/png',
          size: 1,
          s3Key: `s${i}.png`,
          expiresAt: expiresInDays === null ? null : new Date(now + expiresInDays * DAY),
          deletedAt,
        },
      });
    await mk('VERIFIED', 5); // counted
    await mk('UPLOADED', 29); // counted
    await mk('VERIFIED', 31); // outside the window
    await mk('VERIFIED', -2); // already lapsed — the Expired count's, not this one
    await mk('EXPIRED', 10); // already flagged expired
    await mk('REJECTED', 10); // never counted
    await mk('VERIFIED', null); // no expiry
    await mk('VERIFIED', 3, new Date()); // deleted

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(agent(), hr.email);
    const stats = await a.get('/documents/admin/stats');
    expect(stats.status).toBe(200);
    expect(stats.body.expiring30).toBe(2);
    const list = await a.get('/documents/admin?expiringWithin=30');
    expect(list.body.total).toBe(2);
    expect(list.body.documents.map((d: { filename: string }) => d.filename).sort()).toEqual(['f1.png', 'f2.png']);
  });
});

describe('POST /documents/admin/request', () => {
  it('asks the person for a document, linking to their documents page with the kind chosen', async () => {
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Test' });
    const { user: anaUser } = await createUser({ role: 'ASSOCIATE', associateId: ana.id });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(agent(), hr.email);
    const res = await a.post('/documents/admin/request').send({ associateId: ana.id, kind: 'SSN_CARD', note: 'For payroll setup.' });
    expect(res.status).toBe(202);
    await flushPendingNotifications();
    const bell = await prisma.notification.findFirst({ where: { recipientUserId: anaUser.id, category: 'documents', channel: 'IN_APP' } });
    expect(bell).toMatchObject({ subject: '[Action Required] Please upload your ssn card', linkUrl: '/documents?kind=SSN_CARD' });
    expect(bell!.body).toContain('For payroll setup.');
    await new Promise((r) => setTimeout(r, 100));
    expect(await prisma.auditLog.count({ where: { action: 'document.requested', entityId: ana.id } })).toBe(1);
  });

  it('refuses a person outside the caller’s reach, a kind that isn’t one, and a caller without the capability', async () => {
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Test' });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(agent(), hr.email);
    expect((await a.post('/documents/admin/request').send({ associateId: '00000000-0000-4000-8000-0000000000aa', kind: 'ID' })).status).toBe(404);
    expect((await a.post('/documents/admin/request').send({ associateId: ana.id, kind: 'NOPE' })).status).toBe(400);
    const { user: assoc } = await createUser({ role: 'ASSOCIATE', associateId: ana.id });
    expect((await (await loginAs(agent(), assoc.email)).post('/documents/admin/request').send({ associateId: ana.id, kind: 'ID' })).status).toBe(403);
  });
});
