import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
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
    expect((await other.get(`/users/${hr.id}/photo`)).status).toBe(404);
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
    expect(versioned.headers['cache-control']).toBe('private, max-age=3600');
    const bare = await agent.get(`/users/${hr.id}/photo`);
    expect(bare.headers['cache-control']).toBe('private, no-cache');
    expect(bare.headers.etag).toBeTruthy();
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
