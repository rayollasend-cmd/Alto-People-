import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * The IRS lock-in letter itself (wave 2): payroll files the letter on the
 * federal W-4 facts card; it lands in the person's documents and reads back.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');

describe('the lock-in letter upload', () => {
  it('files the letter in the person’s documents, shows it on the card and reads it back', async () => {
    const associate = await createAssociate({ firstName: 'Ana', lastName: 'Silva' });
    await prisma.w4Submission.create({ data: { associateId: associate.id, filingStatus: 'MARRIED_FILING_JOINTLY' } });
    const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const a = await loginAs(agent(), user.email);

    await a.put(`/payroll/federal-w4/${associate.id}`).send({ lockIn: { filingStatus: 'SINGLE', multipleJobs: false, effectiveDate: '2026-01-01' } });
    expect((await a.get(`/payroll/federal-w4/${associate.id}`)).body.lockInLetter).toBeNull();
    expect((await a.get(`/payroll/federal-w4/${associate.id}/lock-in-letter`)).status).toBe(404);

    const up = await a.post(`/payroll/federal-w4/${associate.id}/lock-in-letter`).attach('file', PDF, { filename: 'letter-2800C.pdf', contentType: 'application/pdf' });
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    expect(up.body.lockInLetter).toMatchObject({ filename: 'letter-2800C.pdf', mimeType: 'application/pdf', available: true });
    expect(up.body.lockIn).toMatchObject({ filingStatus: 'SINGLE' });

    const doc = await prisma.documentRecord.findUniqueOrThrow({ where: { id: up.body.lockInLetter.documentId } });
    expect(doc).toMatchObject({ associateId: associate.id, kind: 'OTHER', status: 'VERIFIED' });
    expect(await prisma.auditLog.count({ where: { action: 'payroll.lock_in_letter_uploaded' } })).toBe(1);

    const back = await a.get(`/payroll/federal-w4/${associate.id}/lock-in-letter`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(back.status).toBe(200);
    expect(back.headers['content-type']).toMatch(/application\/pdf/);
    expect((back.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');

    // Clearing the lock-in unlinks the letter from the card; the file stays in the vault.
    const cleared = await a.put(`/payroll/federal-w4/${associate.id}`).send({ lockIn: null });
    expect(cleared.body.lockInLetter).toBeNull();
    expect(await prisma.documentRecord.count({ where: { id: doc.id, deletedAt: null } })).toBe(1);
  });

  it('refuses a file that is not what it says, and anyone without payroll access', async () => {
    const associate = await createAssociate();
    await prisma.w4Submission.create({ data: { associateId: associate.id, filingStatus: 'SINGLE' } });
    const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const a = await loginAs(agent(), user.email);
    const fake = await a.post(`/payroll/federal-w4/${associate.id}/lock-in-letter`).attach('file', Buffer.from('not a pdf at all'), { filename: 'x.pdf', contentType: 'application/pdf' });
    expect(fake.status).toBe(400);
    const exe = await a.post(`/payroll/federal-w4/${associate.id}/lock-in-letter`).attach('file', Buffer.from('MZ....'), { filename: 'x.exe', contentType: 'application/octet-stream' });
    expect(exe.status).toBe(400);
    const none = await a.post(`/payroll/federal-w4/${associate.id}/lock-in-letter`);
    expect(none.status).toBe(400);

    const { user: worker } = await createUser({ role: 'ASSOCIATE' });
    const w = await loginAs(agent(), worker.email);
    expect((await w.post(`/payroll/federal-w4/${associate.id}/lock-in-letter`).attach('file', PDF, { filename: 'l.pdf', contentType: 'application/pdf' })).status).toBe(403);
  });
});
