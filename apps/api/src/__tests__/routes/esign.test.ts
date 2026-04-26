import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import {
  DEFAULT_TEST_PASSWORD,
  createApplicationWithChecklist,
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

async function seedWorld() {
  const client = await createClient();
  const associate = await createAssociate({
    firstName: 'Pat',
    lastName: 'Hopeful',
    email: `pat-${Math.random().toString(36).slice(2, 8)}@example.com`,
  });
  const application = await createApplicationWithChecklist({
    associateId: associate.id,
    clientId: client.id,
  });
  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const { user: assocUser } = await createUser({
    role: 'ASSOCIATE',
    email: associate.email,
    associateId: associate.id,
  });
  const hrAgent = await loginAs(hr.email);
  return { client, associate, application, hr, hrAgent, assocUserEmail: assocUser.email };
}

describe('POST /onboarding/applications/:id/esign/agreements', () => {
  it('HR can create an agreement', async () => {
    const { hrAgent, application } = await seedWorld();
    const res = await hrAgent.post(`/onboarding/applications/${application.id}/esign/agreements`).send({
      title: 'Confidentiality Agreement',
      body: 'I agree to keep all proprietary information confidential.',
    });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.title).toBe('Confidentiality Agreement');
    expect(res.body.signedAt).toBeNull();
  });

  it('rejects empty title or body', async () => {
    const { hrAgent, application } = await seedWorld();
    const r1 = await hrAgent.post(`/onboarding/applications/${application.id}/esign/agreements`).send({
      title: '',
      body: 'something',
    });
    expect(r1.status).toBe(400);
    const r2 = await hrAgent.post(`/onboarding/applications/${application.id}/esign/agreements`).send({
      title: 'something',
      body: '',
    });
    expect(r2.status).toBe(400);
  });

  it('associate cannot create an agreement (manage:onboarding required)', async () => {
    const { application, assocUserEmail } = await seedWorld();
    const a = await loginAs(assocUserEmail);
    const res = await a.post(`/onboarding/applications/${application.id}/esign/agreements`).send({
      title: 'NDA',
      body: 'body',
    });
    expect([403, 404]).toContain(res.status);
  });

  it('rejects taskId that does not belong to the application', async () => {
    const { hrAgent, application } = await seedWorld();
    const res = await hrAgent.post(`/onboarding/applications/${application.id}/esign/agreements`).send({
      title: 'NDA',
      body: 'body',
      taskId: '00000000-0000-0000-0000-000000000000',
    });
    expect(res.status).toBe(404);
  });
});

describe('POST /onboarding/applications/:id/esign/agreements/:agreementId/sign', () => {
  async function seedAndCreateAgreement() {
    const w = await seedWorld();
    const create = await w.hrAgent.post(`/onboarding/applications/${w.application.id}/esign/agreements`).send({
      title: 'NDA',
      body: 'I will not disclose proprietary information.',
    });
    if (create.status !== 201) throw new Error(`seed agreement failed ${create.status}`);
    return { ...w, agreementId: create.body.id as string };
  }

  it('happy path: associate signs, signature row created, PDF stored, hash returned', async () => {
    const { application, agreementId, assocUserEmail } = await seedAndCreateAgreement();
    const a = await loginAs(assocUserEmail);
    const res = await a.post(`/onboarding/applications/${application.id}/esign/agreements/${agreementId}/sign`).send({
      typedName: 'Pat Hopeful',
    });
    expect(res.status).toBe(200);
    expect(res.body.signatureId).toBeTruthy();
    expect(res.body.documentId).toBeTruthy();
    expect(res.body.pdfHash).toMatch(/^[0-9a-f]{64}$/);

    const sig = await prisma.signature.findUniqueOrThrow({ where: { id: res.body.signatureId } });
    expect(sig.typedName).toBe('Pat Hopeful');
    expect(sig.pdfHash).toBe(res.body.pdfHash);
    expect(sig.agreementId).toBe(agreementId);
    expect(sig.signatureS3Key).toMatch(/^esign\//);

    const doc = await prisma.documentRecord.findUniqueOrThrow({ where: { id: res.body.documentId } });
    expect(doc.kind).toBe('SIGNED_AGREEMENT');
    expect(doc.mimeType).toBe('application/pdf');
    expect(doc.status).toBe('VERIFIED');

    const agreement = await prisma.esignAgreement.findUniqueOrThrow({ where: { id: agreementId } });
    expect(agreement.signedAt).not.toBeNull();
    expect(agreement.signatureId).toBe(res.body.signatureId);
  });

  it('linked task gets marked DONE on sign', async () => {
    const { application, hrAgent, assocUserEmail } = await seedWorld();
    // Find an existing task (the seed has a checklist) — but the standard
    // template has no E_SIGN. Add one directly so we can wire it up.
    const checklist = await prisma.onboardingChecklist.findUniqueOrThrow({
      where: { applicationId: application.id },
    });
    const task = await prisma.onboardingTask.create({
      data: {
        checklistId: checklist.id,
        kind: 'E_SIGN',
        status: 'PENDING',
        title: 'Sign NDA',
        order: 99,
      },
    });
    const create = await hrAgent.post(`/onboarding/applications/${application.id}/esign/agreements`).send({
      title: 'NDA',
      body: 'NDA body',
      taskId: task.id,
    });
    expect(create.status).toBe(201);

    const a = await loginAs(assocUserEmail);
    const sign = await a
      .post(`/onboarding/applications/${application.id}/esign/agreements/${create.body.id}/sign`)
      .send({ typedName: 'Pat Hopeful' });
    expect(sign.status).toBe(200);

    const after = await prisma.onboardingTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(after.status).toBe('DONE');
    expect(after.completedAt).not.toBeNull();
    expect(after.documentId).toBe(sign.body.documentId);
  });

  it('rejects a 2nd sign attempt on the same agreement → 409', async () => {
    const { application, agreementId, assocUserEmail } = await seedAndCreateAgreement();
    const a = await loginAs(assocUserEmail);
    const first = await a.post(`/onboarding/applications/${application.id}/esign/agreements/${agreementId}/sign`).send({
      typedName: 'Pat Hopeful',
    });
    expect(first.status).toBe(200);
    const second = await a.post(`/onboarding/applications/${application.id}/esign/agreements/${agreementId}/sign`).send({
      typedName: 'Pat Hopeful',
    });
    expect(second.status).toBe(409);
  });

  it('rejects too-short typed name → 400', async () => {
    const { application, agreementId, assocUserEmail } = await seedAndCreateAgreement();
    const a = await loginAs(assocUserEmail);
    const res = await a.post(`/onboarding/applications/${application.id}/esign/agreements/${agreementId}/sign`).send({
      typedName: 'P',
    });
    expect(res.status).toBe(400);
  });

  it('cross-tenant: another associate cannot sign or read someone else’s agreement → 404', async () => {
    const { application, agreementId } = await seedAndCreateAgreement();
    const { user: other } = await createUser({
      role: 'ASSOCIATE',
      email: `other-${Math.random().toString(36).slice(2, 8)}@example.com`,
    });
    const b = await loginAs(other.email);
    const sign = await b.post(`/onboarding/applications/${application.id}/esign/agreements/${agreementId}/sign`).send({
      typedName: 'Trespasser',
    });
    expect(sign.status).toBe(404);
    const read = await b.get(`/onboarding/applications/${application.id}/esign/agreements/${agreementId}`);
    expect(read.status).toBe(404);
  });
});

describe('GET /onboarding/esign/signatures/:signatureId/pdf', () => {
  it('streams the signed PDF and exposes both stored + live hash', async () => {
    const { application, hrAgent, assocUserEmail } = await seedWorld();
    const create = await hrAgent.post(`/onboarding/applications/${application.id}/esign/agreements`).send({
      title: 'NDA',
      body: 'body',
    });
    const a = await loginAs(assocUserEmail);
    const sign = await a
      .post(`/onboarding/applications/${application.id}/esign/agreements/${create.body.id}/sign`)
      .send({ typedName: 'Pat Hopeful' });

    const res = await hrAgent.get(`/onboarding/esign/signatures/${sign.body.signatureId}/pdf`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.body.slice(0, 5).toString()).toBe('%PDF-');
    const live = res.headers['x-pdf-hash'];
    const stored = res.headers['x-pdf-hash-stored'];
    expect(live).toMatch(/^[0-9a-f]{64}$/);
    expect(live).toBe(stored);
  });
});
