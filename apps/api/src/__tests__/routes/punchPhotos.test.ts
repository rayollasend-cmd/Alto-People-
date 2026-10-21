import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { generateDeviceToken, hashDeviceToken, hmacPin } from '../../lib/kioskAuth.js';
import { _resetKioskRateLimit } from '../../lib/kioskRateLimit.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';

/**
 * A photo at punch, required by rule: the company, a client, a store, or
 * one person (with a reason and an end date). The most specific rule wins.
 * Required and missing → refused, unless the camera is down (kept, flagged
 * for a supervisor) or the tablet runs an older screen (kept, flagged).
 * A required photo is kept even when the person declined face matching.
 */

const app = () => createApp();
const JPEG = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(600, 1)]).toString('base64');

beforeEach(async () => {
  await truncateAll();
  _resetKioskRateLimit();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function setup() {
  const client = await createClient('Coastal Resort');
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  const ana = await createAssociate({ firstName: 'Ana', lastName: 'Reyes' });
  await prisma.associateAssignment.create({ data: { associateId: ana.id, locationId: site.id, startedAt: new Date('2026-01-01') } });
  // Ana declined face matching: before this, no photo of her was ever kept.
  await prisma.associate.update({ where: { id: ana.id }, data: { faceConsentStatus: 'DECLINED' } });
  const pin = '4321';
  await prisma.kioskPin.create({ data: { clientId: client.id, associateId: ana.id, pinHmac: hmacPin(pin) } });
  const { plaintext, prefix } = generateDeviceToken();
  const device = await prisma.kioskDevice.create({
    data: { clientId: client.id, locationId: site.id, name: 'Front desk tablet', tokenHash: hashDeviceToken(plaintext), tokenPrefix: prefix, tokenExpiresAt: new Date(Date.now() + 90 * 86_400_000) },
  });
  const { user: hrUser } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const hr = await loginAs(agent(), hrUser.email);
  const punch = async (body: Record<string, unknown>) => {
    _resetKioskRateLimit();
    return request(app()).post('/kiosk/punch').send({ deviceToken: plaintext, pin, ...body });
  };
  const verify = async () => {
    _resetKioskRateLimit();
    return request(app()).post('/kiosk/verify-pin').send({ deviceToken: plaintext, pin });
  };
  return { client, site, ana, device, hr, hrUser, punch, verify };
}

describe('photo at punch — who it applies to', () => {
  it('nobody by default; a person-level rule needs a reason, tells the kiosk and the person, and the most specific rule wins', async () => {
    const s = await setup();
    expect((await s.verify()).body).toMatchObject({ photoRequired: false, photoNotice: null });

    // No reason, no rule.
    const bare = await s.hr.put(`/time/punch-photos/associates/${s.ana.id}`).send({ required: true });
    expect(bare.status).toBe(400);
    const set = await s.hr.put(`/time/punch-photos/associates/${s.ana.id}`).send({ required: true, reason: 'Two punches on the night shift that her supervisor didn’t see', endsOn: '2099-12-31' });
    expect(set.status).toBe(200);
    expect(set.body.rule).toMatchObject({ scope: 'ASSOCIATE', required: true, endsOn: '2099-12-31', label: 'Photo required for Ana Reyes' });
    const v = await s.verify();
    expect(v.body.photoRequired).toBe(true);
    expect(v.body.photoNotice).toMatch(/A photo is required at each of your punches through December 31/);
    // The kiosk never shows the reason.
    expect(JSON.stringify(v.body)).not.toMatch(/night shift/);

    // Company says required, the store says not, Ana's own rule says required: Ana's rule wins.
    await s.hr.put('/time/punch-photos/rules').send({ scope: 'COMPANY', required: true });
    await s.hr.put('/time/punch-photos/rules').send({ scope: 'SITE', siteId: s.site.id, required: false });
    expect((await s.verify()).body.photoRequired).toBe(true);
    // Her rule ends: the store's exemption applies.
    const end = await s.hr.delete(`/time/punch-photos/associates/${s.ana.id}`).send({ reason: 'Reviewed — no further issues' });
    expect(end.status).toBe(204);
    expect((await s.verify()).body.photoRequired).toBe(false);

    const record = await s.hr.get(`/time/punch-photos/associates/${s.ana.id}`);
    expect(record.body).toMatchObject({ required: false, decidedBy: { scope: 'SITE', required: false }, ownRule: null });
    expect(record.body.history[0]).toMatchObject({ scope: 'ASSOCIATE', endReason: 'Reviewed — no further issues' });

    await flushPendingAudits();
    expect(await prisma.auditLog.count({ where: { action: { startsWith: 'time.punch_photo.' } } })).toBe(4);
  });

  it('is told when a photo becomes required — never the reason', async () => {
    const s = await setup();
    const { user: anaUser } = await createUser({ role: 'ASSOCIATE', associateId: s.ana.id });
    await s.hr.put(`/time/punch-photos/associates/${s.ana.id}`).send({ required: true, reason: 'Suspected buddy punching' });
    await flushPendingNotifications();
    const note = await prisma.notification.findFirstOrThrow({ where: { recipientUserId: anaUser.id, channel: 'IN_APP' } });
    expect(note.subject).toBe('A photo is now taken at your punches');
    expect(note.body).not.toMatch(/buddy/);
  });

  it('only people who manage time — or a supervisor for their own people — set it', async () => {
    const s = await setup();
    const { user: driver } = await createUser({ role: 'DRIVER' });
    const d = await loginAs(agent(), driver.email);
    expect((await d.put(`/time/punch-photos/associates/${s.ana.id}`).send({ required: true, reason: 'No reason at all' })).status).toBe(403);
    expect((await d.put('/time/punch-photos/rules').send({ scope: 'COMPANY', required: true })).status).toBe(403);
  });
});

describe('photo at punch — at the kiosk', () => {
  it('refuses a required punch with no photo, keeps the photo even without face consent, and never refuses for a broken camera', async () => {
    const s = await setup();
    await s.hr.put(`/time/punch-photos/associates/${s.ana.id}`).send({ required: true, reason: 'Two unexplained punches last week' });

    // The kiosk sent no photo and its camera works: refused, and on the log.
    const refused = await s.punch({ photoPolicyAware: true });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('photo_required');
    expect(await prisma.kioskPunch.count({ where: { rejectReason: 'photo_required', associateId: s.ana.id } })).toBe(1);

    // With the photo: clocked in, and the photo kept although she declined face matching.
    const ok = await s.punch({ photoPolicyAware: true, selfie: JPEG });
    expect(ok.status).toBe(200);
    expect(ok.body.action).toBe('CLOCK_IN');
    const stored = await prisma.kioskPunch.findUniqueOrThrow({ where: { id: ok.body.punchId }, select: { selfie: true, faceDistance: true } });
    expect(stored.selfie).not.toBeNull();
    expect(stored.faceDistance).toBeNull();
    // No face template is ever made for her.
    expect(await prisma.kioskFaceReference.count({ where: { associateId: s.ana.id } })).toBe(0);

    // The camera won't start: the punch is kept (she worked), flagged for a supervisor, and admins hear about the camera.
    const broken = await s.punch({ photoPolicyAware: true, photoUnavailable: true });
    expect(broken.status).toBe(200);
    expect(broken.body.action).toBe('CLOCK_OUT');
    expect(await prisma.kioskPunch.findUniqueOrThrow({ where: { id: broken.body.punchId } })).toMatchObject({ anomalyKind: 'NO_PHOTO', reviewStatus: 'PENDING' });
    await flushPendingNotifications();
    const camera = await prisma.notification.findMany({ where: { recipientUserId: s.hrUser.id, channel: 'IN_APP', subject: { startsWith: 'Kiosk camera not working' } } });
    expect(camera).toHaveLength(1);
    // A second broken-camera punch the same day doesn't ring again.
    await s.punch({ photoPolicyAware: true, photoUnavailable: true });
    await flushPendingNotifications();
    expect(await prisma.notification.count({ where: { recipientUserId: s.hrUser.id, channel: 'IN_APP', subject: { startsWith: 'Kiosk camera not working' } } })).toBe(1);

    // A tablet still on the old screen: kept and flagged, so nobody's locked out before it reloads.
    const old = await s.punch({});
    expect(old.status).toBe(200);
    expect((await prisma.kioskPunch.findUniqueOrThrow({ where: { id: old.body.punchId } })).anomalyDetail).toMatch(/older kiosk screen/);

    // The punch log finds them, and her record counts them.
    const flagged = await s.hr.get('/kiosk-punches?photo=required_missing');
    expect(flagged.body.punches.map((p: { id: string }) => p.id)).toEqual(expect.arrayContaining([broken.body.punchId, old.body.punchId]));
    const rec = await s.hr.get(`/time/punch-photos/associates/${s.ana.id}`);
    expect(rec.body.last30Days).toEqual({ keptWithoutPhoto: 3, refusedWithoutPhoto: 1 });
    expect(rec.body.recentPunches.find((p: { id: string }) => p.id === ok.body.punchId)).toMatchObject({ hasPhoto: true, flagged: false });
  });

  it('without a rule nothing changes: no photo needed, and a declined person’s photo is still not kept', async () => {
    const s = await setup();
    const res = await s.punch({ photoPolicyAware: true, selfie: JPEG });
    expect(res.status).toBe(200);
    expect((await prisma.kioskPunch.findUniqueOrThrow({ where: { id: res.body.punchId }, select: { selfie: true } })).selfie).toBeNull();
    const none = await s.punch({ photoPolicyAware: true });
    expect(none.status).toBe(200);
  });
});
