import { afterAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import request, { type Test } from 'supertest';
import sharp from 'sharp';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { getBlobStore } from '../../lib/blobStore.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * Staff accounts have faces too. A login with no associate (HR,
 * recruiters, managers) had nowhere to keep a photo — /me/profile-photo
 * refused them and the session carried null — so every staff avatar was
 * initials. And a photo whose file is gone looked exactly like no photo,
 * so a storage that loses files went unnoticed.
 */

const app = () => createApp();

beforeEach(async () => {
  await truncateAll();
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

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);

describe('a staff account sets its own photo', () => {
  it('uploads, shows on the session, serves to a colleague, and removes', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { user: colleague } = await createUser({ role: 'OPERATIONS_MANAGER' });
    const agent = await loginAs(hr.email);

    const up = await agent.post('/me/profile-photo').attach('file', PNG, { filename: 'me.png', contentType: 'image/png' });
    expect(up.status).toBe(201);
    expect(up.body.photoUrl).toMatch(new RegExp(`^/api/users/${hr.id}/photo\\?v=\\d+$`));

    const me = await agent.get('/auth/me');
    expect(me.body.user.photoUrl).toBe(up.body.photoUrl);

    const other = await loginAs(colleague.email);
    const img = await other.get(`/users/${hr.id}/photo`);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');

    expect((await agent.delete('/me/profile-photo')).status).toBe(204);
    expect((await agent.get('/auth/me')).body.user.photoUrl).toBeNull();
    const gone = await other.get(`/users/${hr.id}/photo`);
    expect(gone.status).toBe(404);
    // "No photo" is remembered briefly, so a roster of initials isn't re-asked on every visit.
    expect(gone.headers['cache-control']).toBe('private, max-age=120');
  });

  it("an associate-linked login still sets the associate's headshot", async () => {
    const associate = await createAssociate();
    const { user } = await createUser({ role: 'ASSOCIATE', associateId: associate.id });
    const agent = await loginAs(user.email);
    const up = await agent.post('/me/profile-photo').attach('file', PNG, { filename: 'me.png', contentType: 'image/png' });
    expect(up.body.photoUrl).toMatch(new RegExp(`^/api/associates/${associate.id}/photo`));
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { photoS3Key: true } });
    expect(row.photoS3Key).toBeNull();
  });
});

describe('profile photo storage health', () => {
  it('counts photos whose file is gone, and clearing them asks those people again', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);
    // One real photo on file…
    await agent.post('/me/profile-photo').attach('file', PNG, { filename: 'me.png', contentType: 'image/png' });
    // …and one the database points at whose file was lost (a wiped disk).
    const lost = await createAssociate();
    await prisma.associate.update({
      where: { id: lost.id },
      data: { photoS3Key: 'profile-photos/gone-on-redeploy.jpg', photoUpdatedAt: new Date() },
    });

    const health = await agent.get('/profile-photos/health');
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ onFile: 2, missing: 1, durable: true });

    const cleared = await agent.post('/profile-photos/clear-missing').send({});
    expect(cleared.body).toEqual({ cleared: 1 });
    const row = await prisma.associate.findUniqueOrThrow({ where: { id: lost.id }, select: { photoS3Key: true } });
    expect(row.photoS3Key).toBeNull();
    expect((await agent.get('/profile-photos/health')).body).toMatchObject({ onFile: 1, missing: 0 });
    // The real photo survived.
    expect((await agent.get('/auth/me')).body.user.photoUrl).toMatch(/^\/api\/users\//);
  });

  it('is HR-only', async () => {
    const { user } = await createUser({ role: 'SHIFT_SUPERVISOR' });
    const agent = await loginAs(user.email);
    expect((await agent.get('/profile-photos/health')).status).toBe(403);
    expect((await agent.post('/profile-photos/clear-missing').send({})).status).toBe(403);
  });
});

describe('a face by user id, and when a browser may keep it', () => {
  it("/users/:id/photo serves an associate-linked login's headshot", async () => {
    const associate = await createAssociate();
    const { user } = await createUser({ role: 'ASSOCIATE', associateId: associate.id });
    const me = await loginAs(user.email);
    await me.post('/me/profile-photo').attach('file', PNG, { filename: 'me.png', contentType: 'image/png' });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const res = await (await loginAs(hr.email)).get(`/users/${user.id}/photo`);
    expect(res.status).toBe(200);
  });

  it('a versioned URL may be kept; a bare one revalidates', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);
    const up = await agent.post('/me/profile-photo').attach('file', PNG, { filename: 'me.png', contentType: 'image/png' });
    const versioned = await agent.get(up.body.photoUrl.replace(/^\/api/, ''));
    // A new photo gets a new ?v=, so this version is kept a week.
    expect(versioned.headers['cache-control']).toBe('private, max-age=604800, immutable');
    const bare = await agent.get(`/users/${hr.id}/photo`);
    expect(bare.headers['cache-control']).toBe('private, no-cache');
    expect(bare.headers.etag).toBeTruthy();
    // An old version's link revalidates like a bare one.
    expect((await agent.get(`/users/${hr.id}/photo?v=1`)).headers['cache-control']).toBe('private, no-cache');

    // Revalidating answers 304 from the row: the image isn't read from storage.
    const read = vi.spyOn(getBlobStore(), 'get');
    onTestFinished(() => read.mockRestore());
    const again = await agent.get(`/users/${hr.id}/photo`).set('If-None-Match', bare.headers.etag!);
    expect(again.status).toBe(304);
    expect(read).not.toHaveBeenCalled();

    // A new photo is a new ETag: the old one gets the new bytes.
    await agent.post('/me/profile-photo').attach('file', PNG, { filename: 'me2.png', contentType: 'image/png' });
    const changed = await agent.get(`/users/${hr.id}/photo`).set('If-None-Match', bare.headers.etag!);
    expect(changed.status).toBe(200);
    expect(changed.headers.etag).not.toBe(bare.headers.etag);
  });
});

/*
 * Nov 2026: a row avatar downloaded the whole upload (59 KB typical, up to
 * 2.4 MB), and a People page on a phone asked for a hundred at once — the
 * page's own data waited behind them ("Still loading — the server may be
 * waking up…"). Avatars now ask for a thumbnail.
 */
describe('a row avatar gets a thumbnail, not the upload', () => {
  it('?size=96 is a small square WebP, made once and kept; the full photo is unchanged', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);
    const photo = await sharp({ create: { width: 900, height: 1200, channels: 3, background: '#3a4a73' } }).jpeg({ quality: 95 }).toBuffer();
    const up = await agent.post('/me/profile-photo').attach('file', photo, { filename: 'me.jpg', contentType: 'image/jpeg' });
    expect(up.status).toBe(201);
    const url = String(up.body.photoUrl).replace(/^\/api/, '');

    const full = await agent.get(url).buffer(true);
    expect(full.headers['content-type']).toBe('image/jpeg');
    expect((full.body as Buffer).length).toBe(photo.length);

    const store = getBlobStore();
    const put = vi.spyOn(store, 'put');
    onTestFinished(() => put.mockRestore());
    const thumb = await agent.get(`${url}&size=96`).buffer(true);
    expect(thumb.status).toBe(200);
    expect(thumb.headers['content-type']).toBe('image/webp');
    expect(await sharp(thumb.body as Buffer).metadata()).toMatchObject({ width: 96, height: 96, format: 'webp' });
    expect((thumb.body as Buffer).length).toBeLessThan(photo.length / 10);
    // Same version, same week-long keep; its own ETag, so it never answers for the full photo.
    expect(thumb.headers['cache-control']).toBe('private, max-age=604800, immutable');
    expect(thumb.headers.etag).not.toBe(full.headers.etag);
    expect(put).toHaveBeenCalledTimes(1);

    // Kept: the next ask reads it back instead of making it again.
    const again = await agent.get(`${url}&size=96`).buffer(true);
    expect(Buffer.compare(again.body as Buffer, thumb.body as Buffer)).toBe(0);
    expect(put).toHaveBeenCalledTimes(1);

    const big = await agent.get(`${url}&size=256`).buffer(true);
    expect(await sharp(big.body as Buffer).metadata()).toMatchObject({ width: 256, height: 256 });
    // A size the app doesn't use gets the photo as uploaded.
    expect((await agent.get(`${url}&size=500`).buffer(true)).headers['content-type']).toBe('image/jpeg');
  });

  it('a new photo drops the old one\'s thumbnails', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);
    const photo = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#73513a' } }).jpeg().toBuffer();
    const up = await agent.post('/me/profile-photo').attach('file', photo, { filename: 'me.jpg', contentType: 'image/jpeg' });
    await agent.get(`${String(up.body.photoUrl).replace(/^\/api/, '')}&size=96`);
    const oldKey = (await prisma.user.findUniqueOrThrow({ where: { id: hr.id }, select: { photoS3Key: true } })).photoS3Key!;
    expect(await getBlobStore().exists(`${oldKey}.96.webp`)).toBe(true);

    await agent.post('/me/profile-photo').attach('file', photo, { filename: 'me2.jpg', contentType: 'image/jpeg' });
    expect(await getBlobStore().exists(oldKey)).toBe(false);
    expect(await getBlobStore().exists(`${oldKey}.96.webp`)).toBe(false);
  });

  it('an image the resizer cannot read is still shown, as uploaded', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);
    await agent.post('/me/profile-photo').attach('file', PNG, { filename: 'me.png', contentType: 'image/png' });
    const res = await agent.get(`/users/${hr.id}/photo?size=96`).buffer(true);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
  });
});

describe("a client's account sees its own people's faces, not everyone's", () => {
  it('portal: their roster yes, another client\'s associate no', async () => {
    const mine = await createClient('Walmart 1234');
    const theirs = await createClient('Walmart 9999');
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);
    const withPhoto = async (clientId: string) => {
      const a = await createAssociate();
      const site = await prisma.site.findFirstOrThrow({ where: { clientId } });
      await prisma.associateAssignment.create({ data: { associateId: a.id, locationId: site.id, startedAt: new Date() } });
      await hrAgent.post(`/associates/${a.id}/photo`).attach('file', PNG, { filename: 'a.png', contentType: 'image/png' });
      return a;
    };
    const ours = await withPhoto(mine.id);
    const other = await withPhoto(theirs.id);
    const { user: portal } = await createUser({ role: 'CLIENT_PORTAL', clientId: mine.id });
    const p = await loginAs(portal.email);

    expect((await p.get(`/associates/${ours.id}/photo`)).status).toBe(200);
    expect((await p.get(`/associates/${other.id}/photo`)).status).toBe(404);
    // HR still sees everyone.
    expect((await hrAgent.get(`/associates/${other.id}/photo`)).status).toBe(200);
  });
});
