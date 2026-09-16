import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  notePortalReportDownload,
  notePortalSignIn,
  portalEngagementFor,
  portalEngagementOverview,
  runPortalEngagementDigest,
} from '../../lib/portalEngagement.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * Portal engagement: a report pull rings HR + Operations (bell only), the
 * first sign-in tells the Chairman too — once — and the Monday digest
 * carries last week's sign-ins and report pulls per account.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

// Monday 2026-09-21, 14:00 UTC = 10:00 ET — past the 7am send hour.
const MONDAY = new Date('2026-09-21T14:00:00.000Z');

async function seed() {
  const client = await createClient('Walmart 218');
  const store = await prisma.location.create({ data: { clientId: client.id, name: 'Front Beach 218', city: 'PCB', state: 'FL' } });
  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const { user: wfm } = await createUser({ role: 'OPERATIONS_MANAGER' });
  const { user: chair } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
  const { user: manager } = await createUser({ role: 'CLIENT_PORTAL', clientId: client.id });
  await prisma.user.update({ where: { id: manager.id }, data: { locationId: store.id } });
  return { client, store, hr, wfm, chair, manager };
}

const login = (userId: string, at: Date) =>
  prisma.auditLog.create({ data: { actorUserId: userId, action: 'auth.login', entityType: 'User', entityId: userId, createdAt: at } });
const pull = (userId: string, clientId: string, from: string, to: string, at: Date) =>
  prisma.auditLog.create({
    data: {
      actorUserId: userId,
      clientId,
      action: 'client.service_report_exported',
      entityType: 'Client',
      entityId: clientId,
      metadata: { from, to, via: 'portal' },
      createdAt: at,
    },
  });

describe('portal engagement', () => {
  it('a report pull rings HR and the Operations Manager with the span, never the Chairman', async () => {
    const s = await seed();
    await notePortalReportDownload({ userId: s.manager.id, fromKey: '2026-09-15', toKey: '2026-09-15', now: MONDAY });
    await flushPendingNotifications();
    const bells = await prisma.notification.findMany({ where: { category: 'portal.engagement', channel: 'IN_APP' } });
    expect(bells.map((b) => b.recipientUserId).sort()).toEqual([s.hr.id, s.wfm.id].sort());
    expect(bells[0]!.subject).toBe('Report pulled · Front Beach 218 (Walmart 218)');
    expect(bells[0]!.body).toContain(s.manager.email);
    expect(bells[0]!.body).toContain('Tuesday, September 15, 2026');
    expect(bells[0]!.linkUrl).toBe(`/clients/${s.client.id}?section=portal`);
    // Bell only: no email row for a download.
    expect(await prisma.notification.count({ where: { category: 'portal.engagement', channel: 'EMAIL' } })).toBe(0);
  });

  it('the first sign-in is a milestone for all three roles; later ones stay quiet', async () => {
    const s = await seed();
    await login(s.manager.id, new Date('2026-09-14T12:00:00.000Z'));
    await notePortalSignIn(s.manager.id);
    await flushPendingNotifications();
    const first = await prisma.notification.findMany({ where: { category: 'portal.engagement', channel: 'IN_APP' } });
    expect(first.map((b) => b.recipientUserId).sort()).toEqual([s.hr.id, s.wfm.id, s.chair.id].sort());
    expect(first[0]!.subject).toBe('Front Beach 218 (Walmart 218) is live');
    await login(s.manager.id, new Date('2026-09-15T12:00:00.000Z'));
    await notePortalSignIn(s.manager.id);
    await flushPendingNotifications();
    expect(await prisma.notification.count({ where: { category: 'portal.engagement', channel: 'IN_APP' } })).toBe(3);
    // An Alto staff sign-in is never a portal milestone.
    await login(s.hr.id, MONDAY);
    await notePortalSignIn(s.hr.id);
    await flushPendingNotifications();
    expect(await prisma.notification.count({ where: { category: 'portal.engagement', channel: 'IN_APP' } })).toBe(3);
  });

  it('reads engagement back off the audit log, per account', async () => {
    const s = await seed();
    await login(s.manager.id, new Date('2026-09-10T12:00:00.000Z'));
    await login(s.manager.id, new Date('2026-09-18T12:00:00.000Z'));
    await login(s.manager.id, new Date('2026-09-20T12:00:00.000Z'));
    await pull(s.manager.id, s.client.id, '2026-09-12', '2026-09-18', new Date('2026-09-19T15:00:00.000Z'));
    await pull(s.manager.id, s.client.id, '2026-09-15', '2026-09-15', new Date('2026-09-16T18:14:00.000Z'));
    const eng = (await portalEngagementFor([s.manager.id], MONDAY)).get(s.manager.id)!;
    expect(eng.lastSeenAt).toBe('2026-09-20T12:00:00.000Z');
    expect(eng.signIns7d).toBe(2);
    expect(eng.downloads.map((d) => `${d.from}..${d.to}`)).toEqual(['2026-09-12..2026-09-18', '2026-09-15..2026-09-15']);
    const overview = await portalEngagementOverview(prisma, MONDAY);
    expect(overview.totals).toEqual({ accounts: 1, active7d: 1, neverSignedIn: 0, downloads7d: 2 });
    expect(overview.accounts[0]!.scope).toBe('Front Beach 218 (Walmart 218)');
  });

  it('the Monday digest carries last week per account, once per recipient', async () => {
    const s = await seed();
    const { user: invited } = await createUser({ role: 'CLIENT_PORTAL', clientId: s.client.id, status: 'INVITED' });
    // Last org week: Sat 2026-09-12 → Fri 2026-09-18.
    await login(s.manager.id, new Date('2026-09-14T12:00:00.000Z'));
    await login(s.manager.id, new Date('2026-09-17T12:00:00.000Z'));
    await pull(s.manager.id, s.client.id, '2026-09-15', '2026-09-15', new Date('2026-09-16T18:14:00.000Z'));
    // Outside the week: not counted.
    await login(s.manager.id, new Date('2026-09-20T12:00:00.000Z'));

    expect(await runPortalEngagementDigest(prisma, new Date('2026-09-22T14:00:00.000Z'))).toMatchObject({ reason: 'not_monday' });
    const first = await runPortalEngagementDigest(prisma, MONDAY);
    expect(first).toEqual({ sent: 3, skipped: 0 });
    const rows = await prisma.notification.findMany({ where: { category: 'portal.engagement_digest', channel: 'IN_APP' } });
    expect(rows.map((r) => r.recipientUserId).sort()).toEqual([s.hr.id, s.wfm.id, s.chair.id].sort());
    const body = rows[0]!.body;
    expect(rows[0]!.subject).toBe('Portal engagement · week of 2026-09-12 – 2026-09-18');
    expect(body).toContain('1 of 2 portal accounts signed in last week; 1 report pulled.');
    expect(body).toContain(`Front Beach 218 (Walmart 218) · ${s.manager.email} — 2 sign-ins`);
    expect(body).toContain('reports: Tuesday, September 15, 2026 (pulled 2026-09-16');
    expect(body).toContain(`Walmart 218 (all stores) · ${invited.email} — invited`);
    expect(body).toContain('has not signed in yet');
    // Once per week.
    expect(await runPortalEngagementDigest(prisma, MONDAY)).toEqual({ sent: 0, skipped: 3 });
  });
});
