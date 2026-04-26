import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { existsSync } from 'node:fs';
import { createApp } from '../../app.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';
import { resolveStoragePath } from '../../lib/storage.js';

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
  if (r.status !== 200) {
    throw new Error(`loginAs(${email}) failed: ${r.status} ${JSON.stringify(r.body)}`);
  }
  return a;
}

// 1×1 transparent PNG (the smallest valid PNG).
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000100' +
    '0d0a2db40000000049454e44ae426082',
  'hex'
);

async function seedAssociate() {
  const client = await createClient();
  const associate = await createAssociate();
  const { user } = await createUser({
    role: 'ASSOCIATE',
    email: associate.email,
    associateId: associate.id,
    clientId: client.id,
  });
  return { client, associate, user };
}

describe('POST /documents/me/upload', () => {
  it('uploads a PNG, persists metadata, writes audit log', async () => {
    const { associate, user } = await seedAssociate();
    const a = await loginAs(user.email);

    const res = await a
      .post('/documents/me/upload')
      .field('kind', 'ID')
      .attach('file', TINY_PNG, { filename: 'license.png', contentType: 'image/png' });

    expect(res.status).toBe(201);
    expect(res.body.kind).toBe('ID');
    expect(res.body.status).toBe('UPLOADED');
    expect(res.body.filename).toBe('license.png');
    expect(res.body.mimeType).toBe('image/png');
    expect(res.body.size).toBe(TINY_PNG.length);
    expect(res.body.associateId).toBe(associate.id);

    const row = await prisma.documentRecord.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.s3Key).toBeTruthy();
    expect(existsSync(resolveStoragePath(row.s3Key!))).toBe(true);

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'document.uploaded', entityId: res.body.id },
    });
    expect(audit).not.toBeNull();
  });

  it('returns 400 for invalid kind', async () => {
    const { user } = await seedAssociate();
    const a = await loginAs(user.email);
    const res = await a
      .post('/documents/me/upload')
      .field('kind', 'NOT_A_KIND')
      .attach('file', TINY_PNG, { filename: 'x.png', contentType: 'image/png' });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('invalid_kind');
  });

  it('returns 400 for unsupported mime type', async () => {
    const { user } = await seedAssociate();
    const a = await loginAs(user.email);
    const res = await a
      .post('/documents/me/upload')
      .field('kind', 'OTHER')
      .attach('file', Buffer.from('hello'), {
        filename: 'note.txt',
        contentType: 'text/plain',
      });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('invalid_mime');
  });

  it('returns 400 when no file is attached', async () => {
    const { user } = await seedAssociate();
    const a = await loginAs(user.email);
    const res = await a.post('/documents/me/upload').field('kind', 'ID');
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('no_file');
  });

  it('HR (no associateId) gets 403 from /me/upload', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const res = await a
      .post('/documents/me/upload')
      .field('kind', 'ID')
      .attach('file', TINY_PNG, { filename: 'x.png', contentType: 'image/png' });
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('not_an_associate');
  });
});

describe('GET /documents/me', () => {
  it("scopes to the calling associate's own documents", async () => {
    const { user, associate } = await seedAssociate();
    const a = await loginAs(user.email);
    await a
      .post('/documents/me/upload')
      .field('kind', 'ID')
      .attach('file', TINY_PNG, { filename: 'mine.png', contentType: 'image/png' });

    const other = await createAssociate();
    await prisma.documentRecord.create({
      data: {
        associateId: other.id,
        kind: 'ID',
        s3Key: 'fake/path.png',
        filename: 'other.png',
        mimeType: 'image/png',
        size: 100,
      },
    });

    const res = await a.get('/documents/me');
    expect(res.status).toBe(200);
    expect(res.body.documents).toHaveLength(1);
    expect(res.body.documents[0].associateId).toBe(associate.id);
  });
});

describe('GET /documents/:id/download', () => {
  it('streams the file to the owning associate', async () => {
    const { user } = await seedAssociate();
    const a = await loginAs(user.email);
    const upload = await a
      .post('/documents/me/upload')
      .field('kind', 'ID')
      .attach('file', TINY_PNG, { filename: 'license.png', contentType: 'image/png' });

    const res = await a.get(`/documents/${upload.body.id}/download`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/png/);
    expect(res.headers['content-disposition']).toMatch(/license\.png/);
    expect(Buffer.isBuffer(res.body) || typeof res.body === 'object').toBe(true);
  });

  it('returns 404 to a different associate', async () => {
    const { user } = await seedAssociate();
    const a = await loginAs(user.email);
    const upload = await a
      .post('/documents/me/upload')
      .field('kind', 'ID')
      .attach('file', TINY_PNG, { filename: 'mine.png', contentType: 'image/png' });

    const otherAssoc = await createAssociate();
    const { user: otherUser } = await createUser({
      role: 'ASSOCIATE',
      email: otherAssoc.email,
      associateId: otherAssoc.id,
    });
    const otherAgent = await loginAs(otherUser.email);
    const res = await otherAgent.get(`/documents/${upload.body.id}/download`);
    expect(res.status).toBe(404);
  });
});

describe('HR verify / reject', () => {
  it('HR can verify an UPLOADED doc; verifier and timestamp recorded', async () => {
    const { user: assocUser } = await seedAssociate();
    const aAgent = await loginAs(assocUser.email);
    const upload = await aAgent
      .post('/documents/me/upload')
      .field('kind', 'ID')
      .attach('file', TINY_PNG, { filename: 'license.png', contentType: 'image/png' });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);
    const verify = await hrAgent.post(`/documents/admin/${upload.body.id}/verify`).send({});
    expect(verify.status).toBe(200);
    expect(verify.body.status).toBe('VERIFIED');
    expect(verify.body.verifiedById).toBe(hr.id);
    expect(verify.body.verifierEmail).toBe(hr.email);

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'document.verified', entityId: upload.body.id },
    });
    expect(audit).not.toBeNull();
  });

  it('HR can reject with a reason', async () => {
    const { user: assocUser } = await seedAssociate();
    const aAgent = await loginAs(assocUser.email);
    const upload = await aAgent
      .post('/documents/me/upload')
      .field('kind', 'ID')
      .attach('file', TINY_PNG, { filename: 'license.png', contentType: 'image/png' });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);
    const reject = await hrAgent
      .post(`/documents/admin/${upload.body.id}/reject`)
      .send({ reason: 'image is blurry' });
    expect(reject.status).toBe(200);
    expect(reject.body.status).toBe('REJECTED');
    expect(reject.body.rejectionReason).toBe('image is blurry');
  });

  it('HR reject without reason → 400', async () => {
    const { user: assocUser } = await seedAssociate();
    const aAgent = await loginAs(assocUser.email);
    const upload = await aAgent
      .post('/documents/me/upload')
      .field('kind', 'ID')
      .attach('file', TINY_PNG, { filename: 'x.png', contentType: 'image/png' });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);
    const r = await hrAgent.post(`/documents/admin/${upload.body.id}/reject`).send({});
    expect(r.status).toBe(400);
  });

  it('ASSOCIATE cannot hit /admin (lacks manage:documents)', async () => {
    const { user } = await seedAssociate();
    const a = await loginAs(user.email);
    const list = await a.get('/documents/admin');
    expect(list.status).toBe(403);
  });
});

describe('DELETE /documents/me/:id', () => {
  it('soft-deletes an UPLOADED doc and removes the file from disk', async () => {
    const { user } = await seedAssociate();
    const a = await loginAs(user.email);
    const upload = await a
      .post('/documents/me/upload')
      .field('kind', 'ID')
      .attach('file', TINY_PNG, { filename: 'x.png', contentType: 'image/png' });

    const row = await prisma.documentRecord.findUniqueOrThrow({ where: { id: upload.body.id } });
    const filePath = resolveStoragePath(row.s3Key!);
    expect(existsSync(filePath)).toBe(true);

    const del = await a.delete(`/documents/me/${upload.body.id}`);
    expect(del.status).toBe(204);

    const after = await prisma.documentRecord.findUniqueOrThrow({ where: { id: upload.body.id } });
    expect(after.deletedAt).not.toBeNull();
    expect(existsSync(filePath)).toBe(false);

    // List should now exclude it
    const list = await a.get('/documents/me');
    expect(list.body.documents.find((d: { id: string }) => d.id === upload.body.id)).toBeUndefined();
  });

  it('cannot delete a VERIFIED doc → 409', async () => {
    const { user } = await seedAssociate();
    const a = await loginAs(user.email);
    const upload = await a
      .post('/documents/me/upload')
      .field('kind', 'ID')
      .attach('file', TINY_PNG, { filename: 'x.png', contentType: 'image/png' });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);
    await hrAgent.post(`/documents/admin/${upload.body.id}/verify`).send({});

    const del = await a.delete(`/documents/me/${upload.body.id}`);
    expect(del.status).toBe(409);
  });
});

describe('CLIENT_PORTAL access', () => {
  it('does not have view:documents → 403', async () => {
    const client = await createClient();
    const { user } = await createUser({ role: 'CLIENT_PORTAL', clientId: client.id });
    const a = await loginAs(user.email);
    const res = await a.get('/documents/me');
    expect(res.status).toBe(403);
  });
});
