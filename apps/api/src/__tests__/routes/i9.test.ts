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
import { decryptString } from '../../lib/crypto.js';

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
  // Add an I9_VERIFICATION task so we can verify auto-DONE behavior.
  const checklist = await prisma.onboardingChecklist.findUniqueOrThrow({
    where: { applicationId: application.id },
  });
  const i9Task = await prisma.onboardingTask.create({
    data: {
      checklistId: checklist.id,
      kind: 'I9_VERIFICATION',
      status: 'PENDING',
      title: 'I-9',
      order: 99,
    },
  });
  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const { user: assocUser } = await createUser({
    role: 'ASSOCIATE',
    email: associate.email,
    associateId: associate.id,
  });
  const hrAgent = await loginAs(hr.email);
  return { client, associate, application, hr, hrAgent, i9Task, assocUserEmail: assocUser.email };
}

describe('POST /onboarding/applications/:id/i9/section1', () => {
  it('US_CITIZEN happy path: marks completedAt, captures attestation, no A-Number required', async () => {
    const { application, assocUserEmail, associate } = await seedWorld();
    const a = await loginAs(assocUserEmail);
    const res = await a.post(`/onboarding/applications/${application.id}/i9/section1`).send({
      citizenshipStatus: 'US_CITIZEN',
      typedName: 'Pat Hopeful',
    });
    expect(res.status).toBe(200);
    expect(res.body.section1CompletedAt).toBeTruthy();
    expect(res.body.citizenshipStatus).toBe('US_CITIZEN');

    const row = await prisma.i9Verification.findUniqueOrThrow({ where: { associateId: associate.id } });
    expect(row.section1TypedName).toBe('Pat Hopeful');
    expect(row.alienRegistrationNumberEnc).toBeNull();
    expect(row.workAuthExpiresAt).toBeNull();
    expect(row.section1Ip).toBeTruthy();
  });

  it('ALIEN_AUTHORIZED_TO_WORK requires workAuthExpiresAt AND alienRegistrationNumber', async () => {
    const { application, assocUserEmail } = await seedWorld();
    const a = await loginAs(assocUserEmail);
    const missingExpiry = await a.post(`/onboarding/applications/${application.id}/i9/section1`).send({
      citizenshipStatus: 'ALIEN_AUTHORIZED_TO_WORK',
      typedName: 'Pat Hopeful',
      alienRegistrationNumber: 'A123456789',
    });
    expect(missingExpiry.status).toBe(400);
    expect(missingExpiry.body.error?.code).toBe('work_auth_expiry_required');

    const missingANum = await a.post(`/onboarding/applications/${application.id}/i9/section1`).send({
      citizenshipStatus: 'ALIEN_AUTHORIZED_TO_WORK',
      typedName: 'Pat Hopeful',
      workAuthExpiresAt: '2027-01-01',
    });
    expect(missingANum.status).toBe(400);
    expect(missingANum.body.error?.code).toBe('alien_number_required');

    const ok = await a.post(`/onboarding/applications/${application.id}/i9/section1`).send({
      citizenshipStatus: 'ALIEN_AUTHORIZED_TO_WORK',
      typedName: 'Pat Hopeful',
      alienRegistrationNumber: 'A123456789',
      workAuthExpiresAt: '2027-01-01',
    });
    expect(ok.status).toBe(200);
  });

  it('encrypts the alien registration number at rest', async () => {
    const { application, assocUserEmail, associate } = await seedWorld();
    const a = await loginAs(assocUserEmail);
    await a.post(`/onboarding/applications/${application.id}/i9/section1`).send({
      citizenshipStatus: 'LAWFUL_PERMANENT_RESIDENT',
      typedName: 'Pat Hopeful',
      alienRegistrationNumber: 'A987654321',
    });
    const row = await prisma.i9Verification.findUniqueOrThrow({ where: { associateId: associate.id } });
    expect(row.alienRegistrationNumberEnc).not.toBeNull();
    expect(row.alienRegistrationNumberEnc!.length).toBeGreaterThan(20);
    // First byte is the version marker per crypto.ts; round-trip decrypts.
    expect(row.alienRegistrationNumberEnc![0]).toBe(0x01);
    expect(decryptString(row.alienRegistrationNumberEnc!)).toBe('A987654321');
  });

  it('rejects unknown citizenship status (400)', async () => {
    const { application, assocUserEmail } = await seedWorld();
    const a = await loginAs(assocUserEmail);
    const res = await a.post(`/onboarding/applications/${application.id}/i9/section1`).send({
      citizenshipStatus: 'BANANA',
      typedName: 'Pat Hopeful',
    });
    expect(res.status).toBe(400);
  });

  it('rejects too-short typed name (400)', async () => {
    const { application, assocUserEmail } = await seedWorld();
    const a = await loginAs(assocUserEmail);
    const res = await a.post(`/onboarding/applications/${application.id}/i9/section1`).send({
      citizenshipStatus: 'US_CITIZEN',
      typedName: 'X',
    });
    expect(res.status).toBe(400);
  });

  it('cross-tenant: another associate cannot submit on someone else’s app (404)', async () => {
    const { application } = await seedWorld();
    const { user: other } = await createUser({
      role: 'ASSOCIATE',
      email: `other-${Math.random().toString(36).slice(2, 8)}@example.com`,
    });
    const b = await loginAs(other.email);
    const res = await b.post(`/onboarding/applications/${application.id}/i9/section1`).send({
      citizenshipStatus: 'US_CITIZEN',
      typedName: 'Trespasser',
    });
    expect(res.status).toBe(404);
  });
});

describe('POST /onboarding/applications/:id/i9/documents (mobile camera upload)', () => {
  function fakePngBuffer(): Buffer {
    // Minimum valid PNG (8-byte signature + IHDR for a 1x1 image is enough
    // for our route's content-type sniffing and storage write).
    return Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
      // IHDR chunk
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
      0x89,
    ]);
  }

  it('happy path: uploads, creates DocumentRecord, returns sha256', async () => {
    const { application, assocUserEmail, associate } = await seedWorld();
    const a = await loginAs(assocUserEmail);
    const res = await a
      .post(`/onboarding/applications/${application.id}/i9/documents`)
      .field('documentKind', 'ID')
      .field('documentSide', 'FRONT')
      .attach('file', fakePngBuffer(), { filename: 'license-front.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
    expect(res.body.documentId).toBeTruthy();
    expect(res.body.kind).toBe('ID');
    expect(res.body.side).toBe('FRONT');
    expect(res.body.sha256).toMatch(/^[0-9a-f]{64}$/);

    const doc = await prisma.documentRecord.findUniqueOrThrow({ where: { id: res.body.documentId } });
    expect(doc.associateId).toBe(associate.id);
    expect(doc.kind).toBe('ID');
    expect(doc.s3Key).toMatch(/^i9\//);
  });

  it('rejects missing file (400)', async () => {
    const { application, assocUserEmail } = await seedWorld();
    const a = await loginAs(assocUserEmail);
    const res = await a
      .post(`/onboarding/applications/${application.id}/i9/documents`)
      .field('documentKind', 'ID');
    expect(res.status).toBe(400);
  });

  it('rejects unsupported mime (e.g. text/plain) → 400', async () => {
    const { application, assocUserEmail } = await seedWorld();
    const a = await loginAs(assocUserEmail);
    const res = await a
      .post(`/onboarding/applications/${application.id}/i9/documents`)
      .field('documentKind', 'ID')
      .attach('file', Buffer.from('hello'), { filename: 'hi.txt', contentType: 'text/plain' });
    expect(res.status).toBe(400);
  });

  it('rejects bad documentKind → 400', async () => {
    const { application, assocUserEmail } = await seedWorld();
    const a = await loginAs(assocUserEmail);
    const res = await a
      .post(`/onboarding/applications/${application.id}/i9/documents`)
      .field('documentKind', 'PAYSTUB') // not in the I-9 allow list
      .attach('file', fakePngBuffer(), { filename: 'x.png', contentType: 'image/png' });
    expect(res.status).toBe(400);
  });
});

describe('POST /onboarding/applications/:id/i9/section2 (HR verifier)', () => {
  function fakePng(): Buffer {
    return Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
      0x89,
    ]);
  }

  async function uploadDoc(a: TestAgent<Test>, applicationId: string, side: 'FRONT' | 'BACK') {
    const r = await a
      .post(`/onboarding/applications/${applicationId}/i9/documents`)
      .field('documentKind', 'I9_SUPPORTING')
      .field('documentSide', side)
      .attach('file', fakePng(), { filename: `doc-${side}.png`, contentType: 'image/png' });
    if (r.status !== 201) throw new Error(`upload failed ${r.status}`);
    return r.body.documentId as string;
  }

  it('LIST_A: section1 done + 1 doc → marks section2 complete and DONE-s the I9 task', async () => {
    const { application, assocUserEmail, hrAgent, i9Task } = await seedWorld();
    const a = await loginAs(assocUserEmail);
    await a.post(`/onboarding/applications/${application.id}/i9/section1`).send({
      citizenshipStatus: 'US_CITIZEN',
      typedName: 'Pat Hopeful',
    });
    const docId = await uploadDoc(a, application.id, 'FRONT');

    const res = await hrAgent.post(`/onboarding/applications/${application.id}/i9/section2`).send({
      documentList: 'LIST_A',
      supportingDocIds: [docId],
    });
    expect(res.status).toBe(200);
    expect(res.body.documentList).toBe('LIST_A');
    expect(res.body.supportingDocIds).toContain(docId);

    const taskAfter = await prisma.onboardingTask.findUniqueOrThrow({ where: { id: i9Task.id } });
    expect(taskAfter.status).toBe('DONE');
    expect(taskAfter.completedAt).not.toBeNull();

    const docAfter = await prisma.documentRecord.findUniqueOrThrow({ where: { id: docId } });
    expect(docAfter.status).toBe('VERIFIED');
    expect(docAfter.verifiedById).toBeTruthy();
  });

  it('LIST_B_AND_C requires at least 2 docs (400 with 1)', async () => {
    const { application, assocUserEmail, hrAgent } = await seedWorld();
    const a = await loginAs(assocUserEmail);
    await a.post(`/onboarding/applications/${application.id}/i9/section1`).send({
      citizenshipStatus: 'US_CITIZEN',
      typedName: 'Pat Hopeful',
    });
    const docId = await uploadDoc(a, application.id, 'FRONT');

    const res = await hrAgent.post(`/onboarding/applications/${application.id}/i9/section2`).send({
      documentList: 'LIST_B_AND_C',
      supportingDocIds: [docId],
    });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('doc_count');
  });

  it('refuses Section 2 before Section 1 → 409', async () => {
    const { application, assocUserEmail, hrAgent } = await seedWorld();
    const a = await loginAs(assocUserEmail);
    const docId = await uploadDoc(a, application.id, 'FRONT');

    const res = await hrAgent.post(`/onboarding/applications/${application.id}/i9/section2`).send({
      documentList: 'LIST_A',
      supportingDocIds: [docId],
    });
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('section1_required');
  });

  it('rejects supporting doc that belongs to a different associate → 404', async () => {
    const { application, hrAgent } = await seedWorld();
    // Create a totally different associate + their doc and try to submit it.
    const { associate: otherAssoc } = await seedWorld();
    const otherDoc = await prisma.documentRecord.create({
      data: {
        associateId: otherAssoc.id,
        clientId: null,
        kind: 'I9_SUPPORTING',
        s3Key: 'i9/fake/key.png',
        filename: 'fake.png',
        mimeType: 'image/png',
        size: 33,
        status: 'UPLOADED',
      },
    });
    // First make sure section1 exists for the original application.
    await prisma.i9Verification.create({
      data: {
        associateId: application.associateId,
        section1CompletedAt: new Date(),
        citizenshipStatus: 'US_CITIZEN',
        section1TypedName: 'Pat',
      },
    });
    const res = await hrAgent.post(`/onboarding/applications/${application.id}/i9/section2`).send({
      documentList: 'LIST_A',
      supportingDocIds: [otherDoc.id],
    });
    expect(res.status).toBe(404);
  });

  it('associate cannot self-verify Section 2 (manage:onboarding required)', async () => {
    const { application, assocUserEmail } = await seedWorld();
    const a = await loginAs(assocUserEmail);
    await a.post(`/onboarding/applications/${application.id}/i9/section1`).send({
      citizenshipStatus: 'US_CITIZEN',
      typedName: 'Pat Hopeful',
    });
    const docId = await uploadDoc(a, application.id, 'FRONT');
    const res = await a.post(`/onboarding/applications/${application.id}/i9/section2`).send({
      documentList: 'LIST_A',
      supportingDocIds: [docId],
    });
    expect([403, 404]).toContain(res.status);
  });
});

describe('GET /onboarding/applications/:id/i9/documents (Phase 24 verifier list)', () => {
  function fakePng(): Buffer {
    return Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
      0x89,
    ]);
  }

  it('returns I-9 docs grouped by side, only I-9-relevant kinds', async () => {
    const { application, assocUserEmail, hrAgent, associate } = await seedWorld();
    const a = await loginAs(assocUserEmail);
    // Two I-9 docs (front + back).
    await a
      .post(`/onboarding/applications/${application.id}/i9/documents`)
      .field('documentKind', 'ID')
      .field('documentSide', 'FRONT')
      .attach('file', fakePng(), { filename: 'license-front.png', contentType: 'image/png' });
    await a
      .post(`/onboarding/applications/${application.id}/i9/documents`)
      .field('documentKind', 'ID')
      .field('documentSide', 'BACK')
      .attach('file', fakePng(), { filename: 'license-back.png', contentType: 'image/png' });
    // Plus one unrelated kind that must NOT appear.
    await prisma.documentRecord.create({
      data: {
        associateId: associate.id,
        clientId: null,
        kind: 'OTHER',
        s3Key: 'unrelated/x.pdf',
        filename: 'handbook.pdf',
        mimeType: 'application/pdf',
        size: 100,
        status: 'UPLOADED',
      },
    });

    const res = await hrAgent.get(`/onboarding/applications/${application.id}/i9/documents`);
    expect(res.status).toBe(200);
    expect(res.body.documents).toHaveLength(2);
    const kinds = res.body.documents.map((d: { kind: string }) => d.kind);
    expect(kinds).toEqual(['ID', 'ID']);
    const sides = res.body.documents.map((d: { side: string | null }) => d.side);
    expect(sides).toContain('FRONT');
    expect(sides).toContain('BACK');
  });

  it('bogus application id → 404 (not 403 — no existence oracle)', async () => {
    const { hrAgent } = await seedWorld();
    const bogusId = '00000000-0000-4000-8000-000000000000';
    const res = await hrAgent.get(`/onboarding/applications/${bogusId}/i9/documents`);
    expect(res.status).toBe(404);
  });
});

describe('I-9 federal document catalog', () => {
  function fakePng(): Buffer {
    return Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
      0x89,
    ]);
  }

  async function signSection1(a: TestAgent<Test>, applicationId: string) {
    const r = await a.post(`/onboarding/applications/${applicationId}/i9/section1`).send({
      citizenshipStatus: 'US_CITIZEN',
      typedName: 'Pat Hopeful',
    });
    if (r.status !== 200) throw new Error(`section1 failed ${r.status}`);
  }

  async function uploadCatalogDoc(
    a: TestAgent<Test>,
    applicationId: string,
    title: string,
    kind: string,
    side?: 'FRONT' | 'BACK',
  ) {
    let req = a
      .post(`/onboarding/applications/${applicationId}/i9/documents`)
      .field('documentKind', kind)
      .field('i9DocTitle', title);
    if (side) req = req.field('documentSide', side);
    const r = await req.attach('file', fakePng(), {
      filename: 'doc.png',
      contentType: 'image/png',
    });
    return r;
  }

  it('upload with a catalog title stores i9DocTitle, server-derived i9List, and side columns', async () => {
    const { application, assocUserEmail } = await seedWorld();
    const a = await loginAs(assocUserEmail);
    const res = await uploadCatalogDoc(
      a,
      application.id,
      "Driver's license",
      'ID',
      'FRONT',
    );
    expect(res.status).toBe(201);
    expect(res.body.i9DocTitle).toBe("Driver's license");
    expect(res.body.i9List).toBe('B');

    const doc = await prisma.documentRecord.findUniqueOrThrow({
      where: { id: res.body.documentId },
    });
    expect(doc.i9DocTitle).toBe("Driver's license");
    expect(doc.i9List).toBe('B');
    expect(doc.side).toBe('FRONT');
  });

  it('rejects an unknown catalog title (400 invalid_i9_doc)', async () => {
    const { application, assocUserEmail } = await seedWorld();
    const a = await loginAs(assocUserEmail);
    const res = await uploadCatalogDoc(a, application.id, 'Library card', 'ID');
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('invalid_i9_doc');
  });

  it('rejects a title/kind mismatch (400 i9_kind_mismatch)', async () => {
    const { application, assocUserEmail } = await seedWorld();
    const a = await loginAs(assocUserEmail);
    // SSN card belongs under SSN_CARD, not ID.
    const res = await uploadCatalogDoc(
      a,
      application.id,
      'Social Security card (unrestricted)',
      'ID',
    );
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('i9_kind_mismatch');
  });

  it('submit gate: List B alone is insufficient (400 i9_combination_insufficient)', async () => {
    const { application, assocUserEmail } = await seedWorld();
    const a = await loginAs(assocUserEmail);
    await signSection1(a, application.id);
    await uploadCatalogDoc(a, application.id, "Driver's license", 'ID', 'FRONT');

    const res = await a.post(`/onboarding/applications/${application.id}/i9/submit`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('i9_combination_insufficient');
  });

  it('submit gate: one List A document passes', async () => {
    const { application, assocUserEmail } = await seedWorld();
    const a = await loginAs(assocUserEmail);
    await signSection1(a, application.id);
    await uploadCatalogDoc(a, application.id, 'U.S. Passport or Passport Card', 'ID');

    const res = await a.post(`/onboarding/applications/${application.id}/i9/submit`).send({});
    expect(res.status).toBe(200);
    expect(res.body.documentsSubmittedAt).toBeTruthy();
  });

  it('submit gate: List B + List C together pass', async () => {
    const { application, assocUserEmail } = await seedWorld();
    const a = await loginAs(assocUserEmail);
    await signSection1(a, application.id);
    await uploadCatalogDoc(a, application.id, "Driver's license", 'ID', 'FRONT');
    await uploadCatalogDoc(
      a,
      application.id,
      'Social Security card (unrestricted)',
      'SSN_CARD',
    );

    const res = await a.post(`/onboarding/applications/${application.id}/i9/submit`).send({});
    expect(res.status).toBe(200);
  });

  it('submit gate: a legacy unclassified upload passes (compatibility pass-through)', async () => {
    const { application, assocUserEmail } = await seedWorld();
    const a = await loginAs(assocUserEmail);
    await signSection1(a, application.id);
    // No i9DocTitle at all — exactly what every pre-catalog record looks like.
    const up = await a
      .post(`/onboarding/applications/${application.id}/i9/documents`)
      .field('documentKind', 'ID')
      .attach('file', fakePng(), { filename: 'old-style.png', contentType: 'image/png' });
    expect(up.status).toBe(201);
    expect(up.body.i9List).toBeNull();

    const res = await a.post(`/onboarding/applications/${application.id}/i9/submit`).send({});
    expect(res.status).toBe(200);
  });

  it('verifier list prefers the stored side column and carries the federal identity', async () => {
    const { application, assocUserEmail, hrAgent } = await seedWorld();
    const a = await loginAs(assocUserEmail);
    // Filename has no side tag — only the column knows it's the back.
    await a
      .post(`/onboarding/applications/${application.id}/i9/documents`)
      .field('documentKind', 'ID')
      .field('documentSide', 'BACK')
      .field('i9DocTitle', 'State ID card')
      .attach('file', fakePng(), { filename: 'photo.png', contentType: 'image/png' });

    const res = await hrAgent.get(`/onboarding/applications/${application.id}/i9/documents`);
    expect(res.status).toBe(200);
    expect(res.body.documents).toHaveLength(1);
    expect(res.body.documents[0].side).toBe('BACK');
    expect(res.body.documents[0].i9DocTitle).toBe('State ID card');
    expect(res.body.documents[0].i9List).toBe('B');
  });
});

describe('GET /onboarding/applications/:id/i9', () => {
  it('returns null sections when nothing has happened yet', async () => {
    const { application, assocUserEmail } = await seedWorld();
    const a = await loginAs(assocUserEmail);
    const res = await a.get(`/onboarding/applications/${application.id}/i9`);
    expect(res.status).toBe(200);
    expect(res.body.section1).toBeNull();
    expect(res.body.section2).toBeNull();
  });

  it('returns Section 1 summary AND hasAlienNumber=true after attestation, but no plaintext A#', async () => {
    const { application, assocUserEmail } = await seedWorld();
    const a = await loginAs(assocUserEmail);
    await a.post(`/onboarding/applications/${application.id}/i9/section1`).send({
      citizenshipStatus: 'LAWFUL_PERMANENT_RESIDENT',
      typedName: 'Pat Hopeful',
      alienRegistrationNumber: 'A111222333',
    });
    const res = await a.get(`/onboarding/applications/${application.id}/i9`);
    expect(res.status).toBe(200);
    expect(res.body.section1.citizenshipStatus).toBe('LAWFUL_PERMANENT_RESIDENT');
    expect(res.body.section1.hasAlienNumber).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('A111222333');
  });
});
