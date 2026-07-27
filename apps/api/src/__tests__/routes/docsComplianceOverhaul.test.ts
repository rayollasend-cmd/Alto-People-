import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { expireLapsedDocs } from '../../lib/documentMaintenance.js';
import { runAgreementSweep } from '../../lib/expirationDigest.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

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

describe('OSHA recordability default (29 CFR 1904.7)', () => {
  it('first-aid-only incidents default to NOT recordable; medical treatment stays recordable', async () => {
    const client = await createClient();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const firstAid = await a.post('/osha/incidents').send({
      clientId: client.id,
      occurredAt: new Date('2026-06-01T14:00:00Z').toISOString(),
      description: 'Paper cut, bandaged on site',
      severity: 'FIRST_AID',
    });
    expect(firstAid.status).toBe(201);
    const medical = await a.post('/osha/incidents').send({
      clientId: client.id,
      occurredAt: new Date('2026-06-02T14:00:00Z').toISOString(),
      description: 'Sprained ankle, urgent care visit',
      severity: 'MEDICAL_TREATMENT',
    });
    expect(medical.status).toBe(201);

    const rows = await prisma.oshaIncident.findMany({ orderBy: { occurredAt: 'asc' } });
    expect(rows[0]!.isRecordable).toBe(false);
    expect(rows[1]!.isRecordable).toBe(true);

    // The 300A must not count the first-aid case.
    const summary = await a.get(`/osha/300a?clientId=${client.id}&year=2026`);
    expect(summary.status).toBe(200);
    expect(summary.body.totalCases).toBe(1);
  });
});

describe('document expiry lifecycle', () => {
  it('verify captures expiresAt and the sweep flips lapsed docs to EXPIRED', async () => {
    const assoc = await createAssociate({ firstName: 'Vera', lastName: 'Visa' });
    const doc = await prisma.documentRecord.create({
      data: {
        associateId: assoc.id,
        kind: 'ID',
        filename: 'license.jpg',
        mimeType: 'image/jpeg',
        size: 100,
        status: 'UPLOADED',
      },
    });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    // Verify with a PAST expiry (simulating a doc that lapses immediately).
    const res = await a
      .post(`/documents/admin/${doc.id}/verify`)
      .send({ expiresAt: '2026-01-01' });
    expect(res.status).toBe(200);

    const verified = await prisma.documentRecord.findUniqueOrThrow({
      where: { id: doc.id },
    });
    expect(verified.status).toBe('VERIFIED');
    expect(verified.expiresAt?.toISOString().slice(0, 10)).toBe('2026-01-01');

    const sweep = await expireLapsedDocs(prisma, new Date('2026-06-01T00:00:00Z'));
    expect(sweep.expired).toBe(1);
    const after = await prisma.documentRecord.findUniqueOrThrow({
      where: { id: doc.id },
    });
    expect(after.status).toBe('EXPIRED');
  });

  it('admin list reports the real total alongside the capped page', async () => {
    const assoc = await createAssociate({ firstName: 'Tally', lastName: 'Total' });
    for (let i = 0; i < 3; i++) {
      await prisma.documentRecord.create({
        data: {
          associateId: assoc.id,
          kind: 'OTHER',
          filename: `f${i}.pdf`,
          mimeType: 'application/pdf',
          size: 10,
          status: 'UPLOADED',
        },
      });
    }
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const res = await a.get('/documents/admin');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.documents).toHaveLength(3);
  });
});

describe('agreement lifecycle sweep + soft delete', () => {
  it('auto-expires lapsed agreements and reminds week-old unsigned ones', async () => {
    const assoc = await createAssociate({ firstName: 'Signa', lastName: 'Ture' });
    const now = new Date('2026-06-15T00:00:00Z');
    const lapsed = await prisma.agreement.create({
      data: {
        associateId: assoc.id,
        kind: 'NDA',
        status: 'PENDING_SIGNATURE',
        expiresOn: new Date('2026-06-01T00:00:00Z'),
      },
    });
    const staleUnsigned = await prisma.agreement.create({
      data: {
        associateId: assoc.id,
        kind: 'ARBITRATION',
        status: 'PENDING_SIGNATURE',
        createdAt: new Date('2026-06-01T00:00:00Z'),
      },
    });

    const result = await runAgreementSweep(now);
    expect(result.expired).toBe(1);
    expect(result.reminded).toBe(1);

    const after1 = await prisma.agreement.findUniqueOrThrow({ where: { id: lapsed.id } });
    expect(after1.status).toBe('EXPIRED');
    const after2 = await prisma.agreement.findUniqueOrThrow({
      where: { id: staleUnsigned.id },
    });
    expect(after2.reminderSentAt).not.toBeNull();
  });

  it('delete is soft and removes the row from the list', async () => {
    const assoc = await createAssociate({ firstName: 'Del', lastName: 'Eted' });
    const agreement = await prisma.agreement.create({
      data: { associateId: assoc.id, kind: 'NDA', status: 'PENDING_SIGNATURE' },
    });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    expect((await a.delete(`/agreements/${agreement.id}`)).status).toBe(204);
    const row = await prisma.agreement.findUniqueOrThrow({
      where: { id: agreement.id },
    });
    expect(row.deletedAt).not.toBeNull();

    const list = await a.get('/agreements');
    expect(list.status).toBe(200);
    expect(
      list.body.agreements.find((x: { id: string }) => x.id === agreement.id),
    ).toBeUndefined();
  });
});

describe('document template render — unresolved tokens', () => {
  it('names every token that resolved to nothing', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const assoc = await createAssociate({ firstName: 'Toke', lastName: 'Ns' });

    const tpl = await a
      .post('/document-templates')
      .send({ name: 'Offer letter', kind: 'OFFER_LETTER' });
    expect(tpl.status).toBe(201);
    const version = await a
      .post(`/document-templates/${tpl.body.id}/versions`)
      .send({
        body: 'Dear {{associate.firstName}} {{associate.firstname}}, welcome.',
      });
    expect(version.status).toBe(201);
    const publish = await a.post(
      `/document-templates/${tpl.body.id}/versions/${version.body.id}/publish`,
    );
    expect(publish.status).toBe(200);

    const render = await a
      .post(`/document-templates/${tpl.body.id}/render`)
      .send({ associateId: assoc.id });
    expect(render.status).toBe(201);
    expect(render.body.renderedBody).toContain('Toke');
    // The lowercase typo resolved to nothing and MUST be reported.
    expect(render.body.unresolvedTokens).toEqual(['associate.firstname']);
  });
});
