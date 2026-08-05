import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createApp } from '../../app.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { resolveStoragePath } from '../../lib/storage.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * Bulk document export.
 *
 * An archive of one person's identity documents is the same class of
 * disclosure as the SSN reveal and the external payroll sheet — and unlike
 * both of those, this endpoint recorded nothing at all. These tests pin the
 * audit, the kind filter that keeps a reviewer from pulling an associate's
 * entire file to check an I-9, and the manifest that distinguishes a complete
 * archive from a partial one.
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
  if (r.status !== 200) {
    throw new Error(`loginAs(${email}) failed: ${r.status} ${JSON.stringify(r.body)}`);
  }
  return a;
}

/** A document row plus a real blob on disk, so the archive can include it. */
async function docWithFile(
  associateId: string,
  kind: 'ID' | 'SSN_CARD' | 'OFFER_LETTER',
  filename: string,
  opts: { onDisk?: boolean } = {},
) {
  const s3Key = `test/${associateId}/${filename}`;
  const row = await prisma.documentRecord.create({
    data: {
      associateId,
      kind,
      filename,
      mimeType: 'image/jpeg',
      size: 8,
      s3Key,
      // DocumentStatus is UPLOADED | VERIFIED | REJECTED | EXPIRED — there is
      // no PENDING. A freshly uploaded document is UPLOADED.
      status: 'UPLOADED',
    },
  });
  if (opts.onDisk !== false) {
    const path = resolveStoragePath(s3Key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'jpegdata');
  }
  return row;
}

describe('GET /documents/admin/all.zip', () => {
  it('streams an archive and records who took it', async () => {
    const associate = await createAssociate({ firstName: 'Ada', lastName: 'Byron' });
    await docWithFile(associate.id, 'ID', 'license-front.jpg');
    await docWithFile(associate.id, 'SSN_CARD', 'ssn.jpg');

    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);

    const res = await a.get(`/documents/admin/all.zip?associateId=${associate.id}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/zip');
    expect(res.headers['content-disposition']).toContain('documents-byron-ada.zip');
    // An archive of identity documents shouldn't sit in a shared cache.
    expect(res.headers['cache-control']).toContain('no-store');

    await flushPendingAudits();
    const entry = await prisma.auditLog.findFirst({
      where: { action: 'document.bulk_exported' },
      orderBy: { createdAt: 'desc' },
    });
    expect(entry).toBeTruthy();
    expect(entry!.actorUserId).toBe(user.id);
    expect(entry!.entityId).toBe(associate.id);
    const meta = entry!.metadata as Record<string, unknown>;
    expect(meta.documentCount).toBe(2);
    expect(meta.skippedCount).toBe(0);
  });

  // Without the filter, a reviewer checking an I-9 pulls the offer letter and
  // every signed policy along with the IDs.
  it('restricts the archive to the requested kinds', async () => {
    const associate = await createAssociate({ firstName: 'Ada', lastName: 'Byron' });
    await docWithFile(associate.id, 'ID', 'license-front.jpg');
    await docWithFile(associate.id, 'OFFER_LETTER', 'offer.jpg');

    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);

    const res = await a.get(
      `/documents/admin/all.zip?associateId=${associate.id}&kinds=ID`,
    );
    expect(res.status).toBe(200);

    await flushPendingAudits();
    const entry = await prisma.auditLog.findFirst({
      where: { action: 'document.bulk_exported' },
      orderBy: { createdAt: 'desc' },
    });
    const meta = entry!.metadata as Record<string, unknown>;
    expect(meta.documentCount).toBe(1);
    expect(meta.kinds).toEqual(['ID']);
    expect(meta.filtered).toBe(true);
  });

  // The deploy target's ephemeral disk can leave rows whose blobs are gone.
  // Skipping them silently handed an auditor an archive quietly missing
  // documents — indistinguishable from the associate never uploading them.
  it('counts documents whose file is missing rather than dropping them silently', async () => {
    const associate = await createAssociate({ firstName: 'Ada', lastName: 'Byron' });
    await docWithFile(associate.id, 'ID', 'present.jpg');
    await docWithFile(associate.id, 'ID', 'gone.jpg', { onDisk: false });

    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);

    const res = await a.get(`/documents/admin/all.zip?associateId=${associate.id}`);
    expect(res.status).toBe(200);

    await flushPendingAudits();
    const entry = await prisma.auditLog.findFirst({
      where: { action: 'document.bulk_exported' },
      orderBy: { createdAt: 'desc' },
    });
    const meta = entry!.metadata as Record<string, unknown>;
    expect(meta.documentCount).toBe(1);
    expect(meta.skippedCount).toBe(1);
  });

  it('requires manage:documents', async () => {
    const associate = await createAssociate();
    await docWithFile(associate.id, 'ID', 'license-front.jpg');
    const { user } = await createUser({ role: 'SHIFT_SUPERVISOR' });
    const a = await loginAs(user.email);

    await a.get(`/documents/admin/all.zip?associateId=${associate.id}`).expect(403);
  });

  it('400s without an associate', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);
    await a.get('/documents/admin/all.zip').expect(400);
  });
});
