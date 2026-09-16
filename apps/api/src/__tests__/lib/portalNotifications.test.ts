import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { runPortalCoverageAlertSweep } from '../../lib/portalCoverageAlert.js';
import { runPortalDigestSweep } from '../../lib/portalDigest.js';
import { runServiceReportMailSweep } from '../../lib/serviceReportMailer.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * What reaches a store, market and region manager: the short-staffing
 * alert (meaningful, scoped, once each, a roll-up above the store), the
 * morning note (honest subject, no markers, a region roll-up) and the
 * Saturday report (delivered once, mute-aware, catches up, region packs).
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const HOUR = 3_600_000;

async function seedStores() {
  const client = await createClient('Walmart');
  const storeA = (await prisma.location.findFirstOrThrow({ where: { clientId: client.id } }))!;
  await prisma.location.update({ where: { id: storeA.id }, data: { name: 'Front Beach 218' } });
  const storeB = await prisma.location.create({ data: { clientId: client.id, name: 'Destin 4411' } });
  const region = await prisma.region.create({ data: { name: 'Florida Panhandle' } });
  await prisma.location.updateMany({ where: { id: { in: [storeA.id, storeB.id] } }, data: { regionId: region.id } });
  const { user: managerA } = await createUser({ role: 'CLIENT_PORTAL', clientId: client.id });
  await prisma.user.update({ where: { id: managerA.id }, data: { locationId: storeA.id } });
  const { user: managerB } = await createUser({ role: 'CLIENT_PORTAL', clientId: client.id });
  await prisma.user.update({ where: { id: managerB.id }, data: { locationId: storeB.id } });
  const { user: market } = await createUser({ role: 'CLIENT_PORTAL', clientId: client.id });
  const { user: regional } = await createUser({ role: 'CLIENT_PORTAL', clientId: null });
  await prisma.user.update({ where: { id: regional.id }, data: { regionId: region.id } });
  const { user: supervisor } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id });
  return { client, storeA: { ...storeA, name: 'Front Beach 218' }, storeB, region, managerA, managerB, market, regional, supervisor };
}

/** A shift of `n` people starting at `start`; the first `punchedIn` clocked in. */
async function crew(opts: { clientId: string; locationId: string | null; start: Date; hours?: number; n: number; punchedIn: number; open?: number; ack?: boolean }) {
  const end = new Date(opts.start.getTime() + (opts.hours ?? 8) * HOUR);
  for (let i = 0; i < opts.n; i += 1) {
    const a = await createAssociate({ firstName: `P${i}`, lastName: `L${Math.random().toString(36).slice(2, 6)}` });
    await prisma.shift.create({
      data: {
        clientId: opts.clientId,
        locationId: opts.locationId,
        position: 'Stocker',
        startsAt: opts.start,
        endsAt: end,
        status: 'ASSIGNED',
        assignedAssociateId: a.id,
        publishedAt: new Date(opts.start.getTime() - 48 * HOUR),
        acknowledgedAt: opts.ack ? new Date(opts.start.getTime() - 24 * HOUR) : null,
      },
    });
    if (i < opts.punchedIn) {
      await prisma.timeEntry.create({
        data: { associateId: a.id, clientId: opts.clientId, locationId: opts.locationId, clockInAt: new Date(opts.start.getTime() + 60_000), status: 'ACTIVE' },
      });
    }
  }
  for (let i = 0; i < (opts.open ?? 0); i += 1) {
    await prisma.shift.create({
      data: { clientId: opts.clientId, locationId: opts.locationId, position: 'Stocker', startsAt: opts.start, endsAt: end, status: 'OPEN', publishedAt: new Date(opts.start.getTime() - 48 * HOUR) },
    });
  }
}

const alerts = (userId: string) =>
  prisma.notification.findMany({ where: { recipientUserId: userId, category: 'portal.coverage', channel: 'IN_APP' }, orderBy: { createdAt: 'asc' } });

describe('short-staffing alert', () => {
  it('rings only a meaningful shortfall, only the store, once each — with a roll-up above the store', async () => {
    const s = await seedStores();
    const now = new Date();
    // Store A: one late of twenty — under the 10% bar, silent.
    await crew({ clientId: s.client.id, locationId: s.storeA.id, start: new Date(now.getTime() - HOUR), n: 20, punchedIn: 19 });
    // Store A: a second shift nobody showed for — rings.
    await crew({ clientId: s.client.id, locationId: s.storeA.id, start: new Date(now.getTime() - 2 * HOUR), n: 4, punchedIn: 0 });

    const first = await runPortalCoverageAlertSweep(prisma, now);
    await flushPendingNotifications();
    expect(first.rung).toBeGreaterThan(0);

    const a = await alerts(s.managerA.id);
    expect(a).toHaveLength(1);
    expect(a[0]!.subject).toMatch(/^Front Beach 218: the .* shift is 4 short$/);
    expect(a[0]!.linkUrl).toContain('/portal/today?date=');
    expect(a[0]!.linkUrl).toContain('&wave=');
    expect(a[0]!.body).toContain("Alto's supervisors have been alerted too.");
    // Store B's manager hears nothing about store A.
    expect(await alerts(s.managerB.id)).toHaveLength(0);
    // The supervisor hears it, linked to the live floor.
    const sup = await alerts(s.supervisor.id);
    expect(sup).toHaveLength(1);
    expect(sup[0]!.linkUrl).toContain('/time-attendance?wave=');
    // Market and region accounts get one roll-up each.
    const mk = await alerts(s.market.id);
    expect(mk).toHaveLength(1);
    expect(mk[0]!.body).toContain('Front Beach 218');
    expect(await alerts(s.regional.id)).toHaveLength(1);
    expect((await alerts(s.regional.id))[0]!.linkUrl).toBe('/');

    // The same shift never rings twice.
    await runPortalCoverageAlertSweep(prisma, new Date(now.getTime() + 10 * 60_000));
    await flushPendingNotifications();
    expect(await alerts(s.managerA.id)).toHaveLength(1);
    expect(await alerts(s.market.id)).toHaveLength(1);

    // Two new short shifts, at both stores: store managers one each; the
    // market account ONE roll-up naming both stores.
    await crew({ clientId: s.client.id, locationId: s.storeB.id, start: new Date(now.getTime() - 3 * HOUR), n: 3, punchedIn: 0 });
    await crew({ clientId: s.client.id, locationId: s.storeA.id, start: new Date(now.getTime() - 4 * HOUR), n: 3, punchedIn: 1, open: 1 });
    await runPortalCoverageAlertSweep(prisma, new Date(now.getTime() + 20 * 60_000));
    await flushPendingNotifications();
    expect(await alerts(s.managerB.id)).toHaveLength(1);
    expect(await alerts(s.managerA.id)).toHaveLength(2);
    const mk2 = await alerts(s.market.id);
    expect(mk2).toHaveLength(2);
    expect(mk2[1]!.subject).toBe('2 shifts short across 2 stores');
    expect(mk2[1]!.body).toContain('Destin 4411');
    expect(mk2[1]!.body).toContain('Front Beach 218');
  });

  it("never rings a store manager for a shift with no store, and doesn't claim supervisors it doesn't have", async () => {
    const s = await seedStores();
    await prisma.user.update({ where: { id: s.supervisor.id }, data: { status: 'DISABLED' } });
    const now = new Date();
    await crew({ clientId: s.client.id, locationId: null, start: new Date(now.getTime() - HOUR), n: 2, punchedIn: 0 });
    await crew({ clientId: s.client.id, locationId: s.storeA.id, start: new Date(now.getTime() - 2 * HOUR), n: 2, punchedIn: 0 });
    await runPortalCoverageAlertSweep(prisma, now);
    await flushPendingNotifications();
    const a = await alerts(s.managerA.id);
    expect(a).toHaveLength(1);
    expect(a[0]!.body).not.toContain('supervisors');
    expect(await alerts(s.managerB.id)).toHaveLength(0);
    expect((await alerts(s.market.id))[0]!.subject).toBe('2 shifts short across 2 stores');
  });
});

describe('morning note', () => {
  // 11am in the org's zone today — after the 6am send hour, and on the
  // same org day as the rows notifyUser stamps with the real clock.
  const DAY_KEY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  const NOW = new Date(`${DAY_KEY}T15:00:00.000Z`);
  const at = (days: number, hourUtc: number) => new Date(new Date(`${DAY_KEY}T00:00:00.000Z`).getTime() + days * 24 * HOUR + hourUtc * HOUR);

  it('tells the truth in the subject, carries no markers, rolls up a region, and sends once a day', async () => {
    const s = await seedStores();
    // Today: two filled at store A. Tomorrow: one assigned, not confirmed.
    await crew({ clientId: s.client.id, locationId: s.storeA.id, start: at(0, 12), n: 2, punchedIn: 2, ack: true });
    await crew({ clientId: s.client.id, locationId: s.storeA.id, start: at(1, 12), n: 1, punchedIn: 0 });

    const r = await runPortalDigestSweep(prisma, NOW);
    await flushPendingNotifications();
    expect(r.sent).toBeGreaterThan(0);
    const note = await prisma.notification.findFirstOrThrow({ where: { recipientUserId: s.managerA.id, category: 'portal.digest', channel: 'IN_APP' } });
    expect(note.subject).toBe('Front Beach 218: staffed · 1 awaiting confirmation tomorrow');
    expect(note.body).not.toMatch(/\[\d{4}-\d{2}-\d{2}\]/);
    // Store B has nothing scheduled: its manager is not bothered.
    expect(await prisma.notification.count({ where: { recipientUserId: s.managerB.id, category: 'portal.digest' } })).toBe(0);
    // The region account gets one roll-up with a line per active store.
    const regional = await prisma.notification.findFirstOrThrow({ where: { recipientUserId: s.regional.id, category: 'portal.digest', channel: 'IN_APP' } });
    expect(regional.subject).toBe('Florida Panhandle: staffed · 1 awaiting confirmation tomorrow');
    expect(regional.body).toContain('Front Beach 218: today 2 scheduled');
    expect(regional.linkUrl).toBe('/');

    const again = await runPortalDigestSweep(prisma, new Date(NOW.getTime() + HOUR));
    await flushPendingNotifications();
    expect(again.sent).toBe(0);
  });
});

describe('Saturday service report', () => {
  // Saturday 11am in the org's zone; last week is Sep 12 – Sep 18.
  const SAT = new Date('2026-09-19T15:00:00.000Z');

  it('delivers once, honours a mute, packs a region, and catches up after a missed Saturday', async () => {
    const s = await seedStores();
    await crew({ clientId: s.client.id, locationId: s.storeA.id, start: new Date('2026-09-15T12:00:00.000Z'), n: 1, punchedIn: 1 });
    // Store B's manager muted reports.
    await prisma.notificationPreference.create({ data: { userId: s.managerB.id, category: 'store_reports', emailEnabled: false } });

    const r = await runServiceReportMailSweep(prisma, SAT);
    expect(r.sent).toBeGreaterThanOrEqual(3);
    const mail = await prisma.notification.findFirstOrThrow({ where: { recipientUserId: s.managerA.id, category: 'portal.service_report', channel: 'EMAIL' } });
    expect(mail.status).toBe('SENT');
    expect(mail.subject).toBe('Front Beach 218: your service report for Sep 12 – Sep 18');
    const bell = await prisma.notification.findFirstOrThrow({ where: { recipientUserId: s.managerA.id, category: 'portal.service_report', channel: 'IN_APP' } });
    expect(bell.body).not.toMatch(/\[\d{4}-\d{2}-\d{2}\]/);
    expect(bell.linkUrl).toBe('/portal/history?range=lastWeek');
    // Muted: the bell still has it, no email went out.
    expect(await prisma.notification.count({ where: { recipientUserId: s.managerB.id, category: 'portal.service_report', channel: 'EMAIL' } })).toBe(0);
    expect(await prisma.notification.count({ where: { recipientUserId: s.managerB.id, category: 'portal.service_report', channel: 'IN_APP' } })).toBe(1);
    // The region account: one note covering both stores.
    const regional = await prisma.notification.findFirstOrThrow({ where: { recipientUserId: s.regional.id, category: 'portal.service_report', channel: 'IN_APP' } });
    expect(regional.subject).toBe("Florida Panhandle: last week's service reports (Sep 12 – Sep 18)");
    expect(regional.body).toContain('for the 2 stores in Florida Panhandle');

    // Once per week.
    expect((await runServiceReportMailSweep(prisma, new Date(SAT.getTime() + HOUR))).sent).toBe(0);

    // A manager added after Saturday's run still gets it on Monday; Tuesday is too late.
    const { user: late } = await createUser({ role: 'CLIENT_PORTAL', clientId: s.client.id });
    await prisma.user.update({ where: { id: late.id }, data: { locationId: s.storeA.id } });
    expect((await runServiceReportMailSweep(prisma, new Date('2026-09-22T15:00:00.000Z'))).reason).toBe('not_saturday');
    const monday = await runServiceReportMailSweep(prisma, new Date('2026-09-21T15:00:00.000Z'));
    expect(monday.sent).toBe(1);
  });

  it('marks a suppressed address done instead of retrying it forever', async () => {
    const s = await seedStores();
    await prisma.emailSuppression.create({ data: { email: s.managerA.email.toLowerCase(), reason: 'BOUNCED' } });
    await runServiceReportMailSweep(prisma, SAT);
    expect(await prisma.notification.count({ where: { recipientUserId: s.managerA.id, category: 'portal.service_report', channel: 'IN_APP' } })).toBe(1);
    const email = await prisma.notification.findFirstOrThrow({ where: { recipientUserId: s.managerA.id, category: 'portal.service_report', channel: 'EMAIL' } });
    expect(email.status).toBe('FAILED');
  });
});
