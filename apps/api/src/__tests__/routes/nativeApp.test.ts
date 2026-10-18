import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import forge from 'node-forge';
import jwt from 'jsonwebtoken';
import { inflateRawSync } from 'node:zlib';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createApp } from '../../app.js';
import { env } from '../../config/env.js';
import { generateDeviceToken, hashDeviceToken, hmacPin } from '../../lib/kioskAuth.js';
import { _resetKioskRateLimit } from '../../lib/kioskRateLimit.js';
import { signBadgeToken, verifyBadgeToken } from '../../lib/badgeToken.js';
import { setNativeTransportsForTests, type NativeTransports } from '../../lib/nativePush.js';
import { sendPushToUser } from '../../lib/webPush.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * The native apps' server side: phones and their push tokens, the Keychain
 * credential that re-opens a lost session, the system-browser sign-in
 * handoff, native push through the one push funnel, the Wallet badge, and
 * a badge (NFC tag / Wallet QR) clocking someone in at the kiosk.
 */

const app = () => createApp();
// Unique per test: the login limiter counts sign-ins per address across the file.
const mail = (who: string) => `${who}-${Math.random().toString(36).slice(2, 8)}@example.com`;

beforeEach(async () => {
  await truncateAll();
  _resetKioskRateLimit();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`login failed: ${r.status}`);
  return a;
}

/** Read one file out of a STORE-method ZIP (what storeZip writes). */
function unzip(buf: Buffer): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  let i = 0;
  while (buf.readUInt32LE(i) === 0x04034b50) {
    const method = buf.readUInt16LE(i + 8);
    const size = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extra = buf.readUInt16LE(i + 28);
    const name = buf.subarray(i + 30, i + 30 + nameLen).toString();
    const start = i + 30 + nameLen + extra;
    const raw = buf.subarray(start, start + size);
    out[name] = method === 0 ? Buffer.from(raw) : inflateRawSync(raw);
    i = start + size;
  }
  return out;
}

describe('phones', () => {
  it('registers a phone with a credential, updates the same row, lists and revokes it', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE', email: mail('ana') });
    const a = await loginAs(user.email);

    const reg = await a.post('/devices').send({ platform: 'IOS', pushToken: 'apns-token-aaaaaaaa', deviceModel: 'iPhone 17', appVersion: '1.0.0', credential: true });
    expect(reg.status).toBe(201);
    expect(reg.body.credential).toMatch(/^altodev1\./);
    const deviceId = reg.body.deviceId as string;

    // Re-registering from the Keychain id updates, never duplicates.
    const again = await a.post('/devices').send({ deviceId, platform: 'IOS', pushToken: 'apns-token-bbbbbbbb' });
    expect(again.status).toBe(200);
    expect(await prisma.nativeDevice.count()).toBe(1);

    const list = await a.get('/devices').set('x-alto-device', deviceId);
    expect(list.body.devices).toHaveLength(1);
    expect(list.body.devices[0]).toMatchObject({ platform: 'IOS', notifications: true, current: true, deviceModel: 'iPhone 17' });

    expect((await a.patch(`/devices/${deviceId}`).send({ biometricLock: true })).body.device.biometricLock).toBe(true);
    expect((await a.delete(`/devices/${deviceId}`)).status).toBe(204);
    const row = await prisma.nativeDevice.findUniqueOrThrow({ where: { id: deviceId } });
    expect(row.revokedAt).not.toBeNull();
    expect(row.pushToken).toBeNull();
    expect(row.credentialHash).toBeNull();
  });

  it('a push token that moves to another person’s account leaves the old row', async () => {
    const { user: one } = await createUser({ role: 'ASSOCIATE', email: mail('one') });
    const { user: two } = await createUser({ role: 'ASSOCIATE', email: mail('two') });
    await (await loginAs(one.email)).post('/devices').send({ platform: 'ANDROID', pushToken: 'fcm-token-shared-phone' });
    await (await loginAs(two.email)).post('/devices').send({ platform: 'ANDROID', pushToken: 'fcm-token-shared-phone' });
    const rows = await prisma.nativeDevice.findMany({ orderBy: { createdAt: 'asc' } });
    expect(rows[0]!.userId).toBe(one.id);
    expect(rows[0]!.revokedAt).not.toBeNull();
    expect(rows[1]!).toMatchObject({ userId: two.id, pushToken: 'fcm-token-shared-phone', revokedAt: null });
  });

  it('signing out on the phone ends its push and its credential', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE', email: mail('ana') });
    const a = await loginAs(user.email);
    const reg = await a.post('/devices').send({ platform: 'IOS', pushToken: 'apns-token-cccccccc', credential: true });
    expect((await a.post('/auth/logout').set('x-alto-device', reg.body.deviceId)).status).toBe(204);
    const row = await prisma.nativeDevice.findUniqueOrThrow({ where: { id: reg.body.deviceId } });
    expect(row.revokedAt).not.toBeNull();
  });
});

describe('re-opening a session from the Keychain', () => {
  it('a credential works once, rotates, and dies with a password change', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE', email: mail('ana') });
    const a = await loginAs(user.email);
    const { credential } = (await a.post('/devices').send({ platform: 'IOS', credential: true })).body as { credential: string };

    const fresh = request.agent(app());
    const opened = await fresh.post('/auth/device-session').send({ credential });
    expect(opened.status).toBe(200);
    expect(opened.body.credential).not.toBe(credential);
    expect((await fresh.get('/auth/me')).status).toBe(200);

    // The old one was spent.
    expect((await request(app()).post('/auth/device-session').send({ credential })).status).toBe(401);

    // Sessions ended (password change bumps tokenVersion): the new one is dead too.
    await prisma.user.update({ where: { id: user.id }, data: { tokenVersion: { increment: 1 } } });
    expect((await request(app()).post('/auth/device-session').send({ credential: opened.body.credential })).status).toBe(401);
  });

  it('refuses garbage and an expired credential', async () => {
    expect((await request(app()).post('/auth/device-session').send({ credential: 'altodev1.not-a-uuid.xxxxxxxxxxxxxxxx' })).status).toBe(401);
    const { user } = await createUser({ role: 'ASSOCIATE', email: mail('ana') });
    const a = await loginAs(user.email);
    const reg = (await a.post('/devices').send({ platform: 'ANDROID', credential: true })).body as { deviceId: string; credential: string };
    await prisma.nativeDevice.update({ where: { id: reg.deviceId }, data: { credentialExpiresAt: new Date(Date.now() - 1000) } });
    expect((await request(app()).post('/auth/device-session').send({ credential: reg.credential })).status).toBe(401);
  });
});

describe('system-browser sign-in → the app', () => {
  it('a two-minute code signs the app in once', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR', email: mail('hr') });
    const browser = await loginAs(user.email);
    const handoff = await browser.post('/auth/native-handoff');
    expect(handoff.status).toBe(200);
    expect(handoff.body.returnUrl).toMatch(/^altopeople:\/\/auth\/complete\?code=/);

    const appView = request.agent(app());
    const ex = await appView.get(`/auth/native-exchange?code=${handoff.body.code}`);
    expect(ex.status).toBe(302);
    expect(ex.headers.location).toBe('/');
    expect((await appView.get('/auth/me')).status).toBe(200);

    const replay = await request(app()).get(`/auth/native-exchange?code=${handoff.body.code}`);
    expect(replay.headers.location).toBe('/login?error=handoff_expired');
  });
});

describe('native push', () => {
  let prev: NativeTransports;
  afterEach(() => {
    setNativeTransportsForTests({ ...prev, force: false });
  });

  it('every phone with notifications gets it; a token the service says is gone is cleared', async () => {
    const calls: Array<[string, string, string]> = [];
    prev = setNativeTransportsForTests({
      force: true,
      apns: async (token, msg) => {
        calls.push(['ios', token, msg.title]);
        return 'sent';
      },
      fcm: async (token) => {
        calls.push(['android', token, '']);
        return 'gone';
      },
    });
    const { user } = await createUser({ role: 'ASSOCIATE', email: mail('ana') });
    await prisma.nativeDevice.createMany({
      data: [
        { userId: user.id, platform: 'IOS', pushToken: 'ios-token-1' },
        { userId: user.id, platform: 'ANDROID', pushToken: 'fcm-token-1' },
        { userId: user.id, platform: 'IOS', pushToken: null },
        { userId: user.id, platform: 'IOS', pushToken: 'ios-revoked', revokedAt: new Date() },
      ],
    });
    await sendPushToUser(user.id, { title: 'Your shift moved', body: 'Now 9:00', url: '/me' });
    expect(calls.sort()).toEqual([
      ['android', 'fcm-token-1', ''],
      ['ios', 'ios-token-1', 'Your shift moved'],
    ]);
    const android = await prisma.nativeDevice.findFirstOrThrow({ where: { platform: 'ANDROID' } });
    expect(android.pushToken).toBeNull();
  });

  it('with no APNs / FCM configured, nothing is sent', async () => {
    let called = false;
    prev = setNativeTransportsForTests({
      apns: async () => {
        called = true;
        return 'sent';
      },
    });
    const { user } = await createUser({ role: 'ASSOCIATE', email: mail('ana') });
    await prisma.nativeDevice.create({ data: { userId: user.id, platform: 'IOS', pushToken: 'ios-token-2' } });
    await sendPushToUser(user.id, { title: 'x', body: 'y' });
    expect(called).toBe(false);
  });
});

/* ----- The badge -------------------------------------------------------- */

async function associateWithNumber() {
  const client = await createClient('Coastal');
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  const associate = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
  await prisma.associateAssignment.create({ data: { associateId: associate.id, locationId: site.id, startedAt: new Date() } });
  const pin = await prisma.kioskPin.create({ data: { clientId: client.id, associateId: associate.id, pinHmac: hmacPin('4321') } });
  const { user } = await createUser({ role: 'ASSOCIATE', associateId: associate.id, email: mail('ana') });
  const { plaintext, prefix } = generateDeviceToken();
  await prisma.kioskDevice.create({
    data: {
      clientId: client.id,
      locationId: site.id,
      name: 'Front desk',
      tokenHash: hashDeviceToken(plaintext),
      tokenPrefix: prefix,
      tokenExpiresAt: new Date(Date.now() + 90 * 86_400_000),
    },
  });
  return { client, site, associate, pin, user, deviceToken: plaintext };
}

/** A throwaway signing chain (self-signed "pass" cert + "WWDR"). */
function testPassCerts() {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = new Date(Date.now() + 86_400_000);
  const attrs = [{ name: 'commonName', value: 'Pass Type ID: pass.test' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { cert: forge.pki.certificateToPem(cert), key: forge.pki.privateKeyToPem(keys.privateKey) };
}

describe('the worker’s Wallet badge', () => {
  const saved: Record<string, unknown> = {};
  const set = (k: string, v: unknown) => {
    saved[k] = (env as Record<string, unknown>)[k];
    (env as Record<string, unknown>)[k] = v;
  };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) (env as Record<string, unknown>)[k] = v;
  });

  it('shows the badge, says which wallets are set up, and the QR is a valid credential', async () => {
    const f = await associateWithNumber();
    const a = await loginAs(f.user.email);
    const res = await a.get('/me/wallet/badge');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ workerName: 'Ana Lopez', siteName: f.site.name, apple: { available: false }, google: { available: false } });
    expect(verifyBadgeToken(res.body.badgeToken)).toMatchObject({ associateId: f.associate.id, version: 1 });
    // Not configured: a clear 503 naming what's missing, never a fake pass.
    const apple = await a.get('/me/wallet/badge.pkpass');
    expect(apple.status).toBe(503);
    expect(apple.body.error.message).toMatch(/PASS_TYPE_ID/);
  });

  it('builds a signed .pkpass in the brand design', async () => {
    const f = await associateWithNumber();
    const certs = testPassCerts();
    set('PASS_TYPE_ID', 'pass.com.altohr.test');
    set('PASS_TEAM_ID', 'TEAM123456');
    set('PASS_CERT_PEM', certs.cert);
    set('PASS_KEY_PEM', certs.key);
    set('PASS_WWDR_PEM', certs.cert);
    const a = await loginAs(f.user.email);
    const res = await a.get('/me/wallet/badge.pkpass').buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/vnd.apple.pkpass');
    const files = unzip(res.body as Buffer);
    expect(Object.keys(files)).toEqual(expect.arrayContaining(['pass.json', 'manifest.json', 'signature', 'icon.png', 'logo@2x.png']));
    const pass = JSON.parse(files['pass.json']!.toString());
    expect(pass).toMatchObject({ passTypeIdentifier: 'pass.com.altohr.test', backgroundColor: 'rgb(15, 24, 39)', labelColor: 'rgb(217, 185, 103)', sharingProhibited: true });
    expect(pass.generic.primaryFields[0]).toMatchObject({ label: 'WORKER', value: 'Ana Lopez' });
    expect(verifyBadgeToken(pass.barcodes[0].message)?.associateId).toBe(f.associate.id);
    // The manifest hashes every file; the signature is a PKCS#7 over the manifest.
    const manifest = JSON.parse(files['manifest.json']!.toString()) as Record<string, string>;
    expect(manifest['pass.json']).toBe(createHash('sha1').update(files['pass.json']!).digest('hex'));
    const p7 = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(files['signature']!.toString('binary')));
    expect((p7 as unknown as { certificates: unknown[] }).certificates.length).toBe(2);
  });

  it('a five-minute link lets Safari download the pass without the session; a tampered one is refused', async () => {
    const f = await associateWithNumber();
    const certs = testPassCerts();
    set('PASS_TYPE_ID', 'pass.com.altohr.test');
    set('PASS_TEAM_ID', 'TEAM123456');
    set('PASS_CERT_PEM', certs.cert);
    set('PASS_KEY_PEM', certs.key);
    set('PASS_WWDR_PEM', certs.cert);
    const a = await loginAs(f.user.email);
    const link = await a.post('/me/wallet/badge/apple-link');
    expect(link.status).toBe(200);
    const url = new URL(link.body.url as string);
    expect(url.pathname).toBe('/api/wallet/badge.pkpass');
    const t = url.searchParams.get('t')!;
    // No cookie: the ticket is the key.
    const pass = await request(app()).get(`/wallet/badge.pkpass?t=${encodeURIComponent(t)}`);
    expect(pass.status).toBe(200);
    expect(pass.headers['content-type']).toContain('application/vnd.apple.pkpass');
    const tampered = await request(app()).get(`/wallet/badge.pkpass?t=${encodeURIComponent(`${t.slice(0, -3)}abc`)}`);
    expect(tampered.status).toBe(410);
  });

  it('builds a "Save to Google Wallet" link with the same badge', async () => {
    const f = await associateWithNumber();
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    set('GOOGLE_WALLET_ISSUER_ID', '3388000000012345678');
    set('GOOGLE_WALLET_CLIENT_EMAIL', 'wallet@alto.iam.gserviceaccount.com');
    set('GOOGLE_WALLET_PRIVATE_KEY', privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
    const a = await loginAs(f.user.email);
    const res = await a.get('/me/wallet/badge/google');
    expect(res.status).toBe(200);
    const token = (res.body.url as string).replace('https://pay.google.com/gp/v/save/', '');
    const claims = jwt.verify(token, publicKey.export({ type: 'spki', format: 'pem' }).toString(), { algorithms: ['RS256'] }) as {
      typ: string;
      payload: { genericObjects: Array<{ header: { defaultValue: { value: string } }; barcode: { value: string }; hexBackgroundColor: string }> };
    };
    expect(claims.typ).toBe('savetowallet');
    const obj = claims.payload.genericObjects[0]!;
    expect(obj.header.defaultValue.value).toBe('Ana Lopez');
    expect(obj.hexBackgroundColor).toBe('#0f1827');
    expect(verifyBadgeToken(obj.barcode.value)?.associateId).toBe(f.associate.id);
  });

  it('someone without a clock-in number is told how to get one', async () => {
    const associate = await createAssociate();
    const { user } = await createUser({ role: 'ASSOCIATE', associateId: associate.id, email: mail('new') });
    const res = await (await loginAs(user.email)).get('/me/wallet/badge');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('no_clock_in_number');
  });
});

describe('a badge at the kiosk', () => {
  it('clocks someone in by badge, exactly like their number', async () => {
    const f = await associateWithNumber();
    const badgeToken = signBadgeToken({ associateId: f.associate.id, version: 1, tenantId: f.associate.tenantId ?? null });
    const pre = await request(app()).post('/kiosk/verify-pin').send({ deviceToken: f.deviceToken, badgeToken });
    expect(pre.status).toBe(200);
    expect(pre.body).toMatchObject({ ok: true, associateFirstName: 'Ana', predictedAction: 'CLOCK_IN' });
    _resetKioskRateLimit();
    const punch = await request(app()).post('/kiosk/punch').send({ deviceToken: f.deviceToken, badgeToken });
    expect(punch.status).toBe(200);
    expect(punch.body.action).toBe('CLOCK_IN');
  });

  it('a reissued badge or a forged one is refused — and the punch log says it was a badge', async () => {
    const f = await associateWithNumber();
    const old = signBadgeToken({ associateId: f.associate.id, version: 1, tenantId: f.associate.tenantId ?? null });
    const hr = await createUser({ role: 'HR_ADMINISTRATOR', email: mail('hr') });
    const h = await loginAs(hr.user.email);
    const reissued = await h.post(`/kiosk-pins/${f.pin.id}/reissue-badge`);
    expect(reissued.status).toBe(200);
    expect(reissued.body.badgeVersion).toBe(2);

    const stale = await request(app()).post('/kiosk/punch').send({ deviceToken: f.deviceToken, badgeToken: old });
    expect(stale.status).toBe(401);
    expect(stale.body.error.code).toBe('invalid_badge');
    _resetKioskRateLimit();
    const forged = await request(app()).post('/kiosk/punch').send({ deviceToken: f.deviceToken, badgeToken: `${old.slice(0, -4)}AAAA` });
    expect(forged.status).toBe(401);
    const rejects = await prisma.kioskPunch.findMany({ where: { action: 'REJECTED' }, select: { rejectReason: true } });
    expect(rejects.map((r) => r.rejectReason)).toEqual(['badge_not_recognized', 'badge_not_recognized']);

    // The new badge works; HR can read it to write a tag.
    _resetKioskRateLimit();
    const ok = await request(app()).post('/kiosk/punch').send({ deviceToken: f.deviceToken, badgeToken: reissued.body.badgeToken });
    expect(ok.status).toBe(200);
    expect((await h.get(`/kiosk-pins/${f.pin.id}/badge`)).body.badgeVersion).toBe(2);
  });

  it('the kiosk still requires a number or a badge', async () => {
    const f = await associateWithNumber();
    const res = await request(app()).post('/kiosk/punch').send({ deviceToken: f.deviceToken });
    expect(res.status).toBe(400);
  });
});
