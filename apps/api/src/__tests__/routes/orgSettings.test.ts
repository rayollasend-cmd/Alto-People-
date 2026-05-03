import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TEST_PASSWORD,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';
import { __resetBrandingCacheForTests, getBrandingSync } from '../../lib/branding.js';

beforeEach(async () => {
  await truncateAll();
  __resetBrandingCacheForTests();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

describe('GET /admin/org/settings', () => {
  it('returns hard defaults when no row exists', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);

    const res = await a.get('/admin/org/settings');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      orgName: 'Alto HR',
      senderName: null,
      supportEmail: null,
      primaryColor: null,
      logoUrl: null,
    });
  });

  it('rejects callers without view:hr-admin', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);

    const res = await a.get('/admin/org/settings');
    expect(res.status).toBe(403);
  });
});

describe('PATCH /admin/org/settings', () => {
  it('upserts the singleton row, refreshes cache, and writes an audit entry', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);

    const res = await a
      .patch('/admin/org/settings')
      .send({
        orgName: 'Acme HR',
        senderName: 'Acme Notifications',
        supportEmail: 'help@acme.test',
        primaryColor: '#112233',
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      orgName: 'Acme HR',
      senderName: 'Acme Notifications',
      supportEmail: 'help@acme.test',
      primaryColor: '#112233',
    });

    const cached = getBrandingSync();
    expect(cached.orgName).toBe('Acme HR');
    expect(cached.primaryColor).toBe('#112233');

    const audits = await prisma.auditLog.findMany({
      where: { action: 'org.branding_updated' },
    });
    expect(audits).toHaveLength(1);
  });

  it('rejects an invalid hex colour', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);

    const res = await a
      .patch('/admin/org/settings')
      .send({ primaryColor: 'navy blue' });
    expect(res.status).toBe(400);
  });

  it('rejects a malformed support email', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);

    const res = await a
      .patch('/admin/org/settings')
      .send({ supportEmail: 'not-an-email' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when body is empty', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);

    const res = await a.patch('/admin/org/settings').send({});
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('no_changes');
  });

  it('rejects callers without view:hr-admin', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);

    const res = await a
      .patch('/admin/org/settings')
      .send({ orgName: 'Hacked' });
    expect(res.status).toBe(403);
  });
});

describe('logo upload / serve / delete', () => {
  it('round-trips a PNG: upload → GET serves bytes with correct content-type → DELETE clears', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);

    const upload = await a
      .post('/admin/org/settings/logo')
      .attach('file', ONE_PX_PNG, { filename: 'logo.png', contentType: 'image/png' });
    expect(upload.status).toBe(201);
    expect(upload.body.logoUrl).toMatch(/^\/admin\/org\/settings\/logo\?v=\d+$/);

    // Cache should expose the data: URI now.
    expect(getBrandingSync().logoDataUri).toMatch(/^data:image\/png;base64,/);

    const fetched = await a.get('/admin/org/settings/logo');
    expect(fetched.status).toBe(200);
    expect(fetched.headers['content-type']).toBe('image/png');
    expect(fetched.body).toBeInstanceOf(Buffer);
    expect((fetched.body as Buffer).equals(ONE_PX_PNG)).toBe(true);

    const removed = await a.delete('/admin/org/settings/logo');
    expect(removed.status).toBe(204);

    const after = await a.get('/admin/org/settings/logo');
    expect(after.status).toBe(404);
    expect(getBrandingSync().logoDataUri).toBeNull();
  });

  it('rejects an unsupported MIME type', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);

    const res = await a
      .post('/admin/org/settings/logo')
      .attach('file', Buffer.from('hello'), {
        filename: 'logo.txt',
        contentType: 'text/plain',
      });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('invalid_mime');
  });

  it('rejects upload by a non-admin', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);

    const res = await a
      .post('/admin/org/settings/logo')
      .attach('file', ONE_PX_PNG, { filename: 'logo.png', contentType: 'image/png' });
    expect(res.status).toBe(403);
  });
});
