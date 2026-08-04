import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { encryptString } from '../../lib/crypto.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { resolveStoragePath } from '../../lib/storage.js';
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

/** A blob shaped like a real v1 ciphertext that will not decrypt. */
function unreadableBlob(): Buffer {
  return Buffer.concat([Buffer.from([1]), randomBytes(12), randomBytes(24), randomBytes(16)]);
}

interface SeedOptions {
  separated?: boolean;
  ssnBlob?: Buffer;
}

/**
 * An associate with a full PII footprint: identity fields, login (with
 * passkey / MFA / push), W-4 SSN, bank details, an on-disk document,
 * emergency contact, kiosk PIN + selfie + face template, a notification,
 * and retained time + payroll rows.
 */
async function seedFullAssociate(clientId: string, opts: SeedOptions = {}) {
  const separated = opts.separated !== false;
  const base = await createAssociate({ firstName: 'Maria', lastName: 'Gonzalez' });
  const photoKey = `profile-photos/erasure-test-${base.id}.jpg`;
  const photoPath = resolveStoragePath(photoKey);
  await mkdir(dirname(photoPath), { recursive: true });
  await writeFile(photoPath, 'photo bytes');
  const associate = await prisma.associate.update({
    where: { id: base.id },
    data: {
      middleInitial: 'L',
      otherLastNames: ['Lopez'],
      dob: new Date('1990-04-05'),
      phone: '555-0100',
      ssnLast4: '6789',
      addressLine1: '1 Main St',
      addressLine2: 'Apt 2',
      city: 'Springfield',
      state: 'IL',
      zip: '62701',
      photoS3Key: photoKey,
      photoUpdatedAt: new Date(),
      faceConsentStatus: 'GRANTED',
      faceConsentAt: new Date(),
      ...(separated ? { deletedAt: new Date() } : {}),
    },
  });

  const { user } = await createUser({ role: 'ASSOCIATE', associateId: associate.id });
  await prisma.webAuthnCredential.create({
    data: {
      userId: user.id,
      credentialId: `cred-${associate.id}`,
      publicKey: randomBytes(32),
    },
  });
  await prisma.mfaRecoveryCode.create({
    data: { userId: user.id, codeHash: `hash-${associate.id}` },
  });
  await prisma.pushSubscription.create({
    data: {
      userId: user.id,
      endpoint: `https://push.example/${associate.id}`,
      p256dh: 'k',
      auth: 'a',
    },
  });

  await prisma.w4Submission.create({
    data: {
      associateId: associate.id,
      filingStatus: 'MARRIED_FILING_JOINTLY',
      dependentsAmount: 2000,
      extraWithholding: 25,
      ssnEncrypted: opts.ssnBlob ?? encryptString('123456789'),
      signedAt: new Date(),
    },
  });

  await prisma.payoutMethod.create({
    data: {
      associateId: associate.id,
      type: 'BANK_ACCOUNT',
      routingNumberEnc: Buffer.from('021000021', 'utf8'),
      accountNumberEnc: encryptString('000123456789'),
      accountType: 'CHECKING',
      bankName: 'Chase',
      isPrimary: true,
    },
  });

  // Real blob on disk so the unlink path is exercised for real.
  const blobKey = `erasure-test/${associate.id}.txt`;
  const blobPath = resolveStoragePath(blobKey);
  await mkdir(dirname(blobPath), { recursive: true });
  await writeFile(blobPath, 'document bytes');
  const document = await prisma.documentRecord.create({
    data: {
      associateId: associate.id,
      clientId,
      kind: 'SSN_CARD',
      s3Key: blobKey,
      filename: 'ssn-card.jpg',
      mimeType: 'image/jpeg',
      size: 14,
      status: 'VERIFIED',
    },
  });

  await prisma.emergencyContact.create({
    data: {
      associateId: associate.id,
      name: 'Jose Gonzalez',
      relation: 'SPOUSE',
      phone: '555-0101',
      isPrimary: true,
    },
  });

  const location = await prisma.location.findFirstOrThrow({ where: { clientId } });
  const device = await prisma.kioskDevice.create({
    data: {
      clientId,
      locationId: location.id,
      name: 'Front kiosk',
      tokenHash: 'x',
    },
  });
  const pin = await prisma.kioskPin.create({
    data: {
      associateId: associate.id,
      clientId,
      pinHmac: randomBytes(32),
      pinEncrypted: encryptString('1234'),
    },
  });
  const punch = await prisma.kioskPunch.create({
    data: {
      kioskDeviceId: device.id,
      kioskPinId: pin.id,
      associateId: associate.id,
      action: 'CLOCK_IN',
      selfie: randomBytes(64),
    },
  });
  await prisma.kioskFaceReference.create({
    data: {
      associateId: associate.id,
      descriptor: randomBytes(512),
      enrolledByPunchId: punch.id,
    },
  });

  const timeEntry = await prisma.timeEntry.create({
    data: {
      associateId: associate.id,
      clientId,
      clockInAt: new Date('2026-07-01T09:00:00Z'),
      clockOutAt: new Date('2026-07-01T17:00:00Z'),
      status: 'APPROVED',
      payRate: 20,
    },
  });

  const run = await prisma.payrollRun.create({
    data: {
      clientId,
      periodStart: new Date('2026-06-22'),
      periodEnd: new Date('2026-07-05'),
      status: 'DISBURSED',
      disbursedAt: new Date(),
    },
  });
  const payrollItem = await prisma.payrollItem.create({
    data: {
      payrollRunId: run.id,
      associateId: associate.id,
      hoursWorked: 8,
      hourlyRate: 20,
      grossPay: 160,
      federalWithholding: 16,
      netPay: 130,
      status: 'DISBURSED',
    },
  });

  const notification = await prisma.notification.create({
    data: {
      channel: 'EMAIL',
      status: 'SENT',
      recipientUserId: user.id,
      recipientEmail: associate.email,
      subject: 'Your paystub is ready',
      body: `Hi Maria, your paystub for June is ready.`,
      category: 'payroll',
      sentAt: new Date(),
    },
  });

  return { associate, user, document, blobPath, photoPath, pin, punch, timeEntry, payrollItem, run, notification };
}

async function seedHrAdmin() {
  const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
  return loginAs(user.email);
}

describe('POST /org/associates/:id/erase', () => {
  it('anonymizes every PII category and leaves payroll history untouched', async () => {
    const client = await createClient();
    const seeded = await seedFullAssociate(client.id);
    const hr = await seedHrAdmin();
    const originalEmail = seeded.associate.email;

    const r = await hr.post(`/org/associates/${seeded.associate.id}/erase`).send({
      reason: 'GDPR deletion request, ticket #4711',
      confirmName: 'Gonzalez',
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.counts).toMatchObject({
      userDisabled: 1,
      passkeysDeleted: 1,
      mfaRecoveryCodesDeleted: 1,
      pushSubscriptionsDeleted: 1,
      w4SsnCleared: 1,
      payoutMethodsScrubbed: 1,
      documentsSoftDeleted: 1,
      documentBlobsUnlinked: 2, // SSN card file + profile photo file
      emergencyContactsDeleted: 1,
      kioskPinsDeleted: 1,
      kioskSelfiesPurged: 1,
      faceReferenceCleared: 1,
      notificationsScrubbed: 1,
    });

    // Associate identity → anonymized in place.
    const a = await prisma.associate.findUniqueOrThrow({
      where: { id: seeded.associate.id },
    });
    const last6 = seeded.associate.id.replace(/-/g, '').slice(-6);
    expect(a.firstName).toBe('Erased');
    expect(a.lastName).toBe(`Associate-${last6}`);
    expect(a.middleInitial).toBeNull();
    expect(a.otherLastNames).toEqual([]);
    expect(a.dob).toBeNull();
    expect(a.email).toBe(`erased+${a.id}@invalid.local`);
    expect(a.phone).toBeNull();
    expect(a.ssnLast4).toBeNull();
    expect(a.addressLine1).toBeNull();
    expect(a.addressLine2).toBeNull();
    expect(a.city).toBeNull();
    expect(a.state).toBeNull();
    expect(a.zip).toBeNull();
    expect(a.photoS3Key).toBeNull();
    expect(a.faceConsentStatus).toBeNull();
    expect(a.erasedAt).not.toBeNull();

    // Login → disabled, credentials gone, sessions dead.
    const u = await prisma.user.findUniqueOrThrow({ where: { id: seeded.user.id } });
    expect(u.status).toBe('DISABLED');
    expect(u.email).toBe(`erased+${u.id}@invalid.local`);
    expect(u.passwordHash).toBeNull();
    expect(u.tokenVersion).toBe(seeded.user.tokenVersion + 1);
    expect(u.mfaSecretEncrypted).toBeNull();
    expect(await prisma.webAuthnCredential.count({ where: { userId: u.id } })).toBe(0);
    expect(await prisma.mfaRecoveryCode.count({ where: { userId: u.id } })).toBe(0);
    expect(await prisma.pushSubscription.count({ where: { userId: u.id } })).toBe(0);

    // W-4: SSN ciphertext gone, numeric elections retained.
    const w4 = await prisma.w4Submission.findUniqueOrThrow({
      where: { associateId: a.id },
    });
    expect(w4.ssnEncrypted).toBeNull();
    expect(w4.filingStatus).toBe('MARRIED_FILING_JOINTLY');
    expect(Number(w4.dependentsAmount)).toBe(2000);

    // Payout: bank ciphertext + labels gone, row retained.
    const payout = await prisma.payoutMethod.findFirstOrThrow({
      where: { associateId: a.id },
    });
    expect(payout.accountNumberEnc).toBeNull();
    expect(payout.routingNumberEnc).toBeNull();
    expect(payout.bankName).toBeNull();

    // Documents: soft-deleted, blob unlinked, evidential row retained.
    const doc = await prisma.documentRecord.findUniqueOrThrow({
      where: { id: seeded.document.id },
    });
    expect(doc.deletedAt).not.toBeNull();
    expect(doc.s3Key).toBeNull();
    expect(doc.kind).toBe('SSN_CARD');
    expect(existsSync(seeded.blobPath)).toBe(false);
    expect(existsSync(seeded.photoPath)).toBe(false);

    // Emergency contacts deleted.
    expect(await prisma.emergencyContact.count({ where: { associateId: a.id } })).toBe(0);

    // Kiosk: PIN credential deleted, selfie bytes gone, face template gone;
    // the punch row itself is retained for time-audit.
    expect(await prisma.kioskPin.count({ where: { associateId: a.id } })).toBe(0);
    expect(await prisma.kioskFaceReference.count({ where: { associateId: a.id } })).toBe(0);
    const punch = await prisma.kioskPunch.findUniqueOrThrow({ where: { id: seeded.punch.id } });
    expect(punch.selfie).toBeNull();
    expect(punch.associateId).toBe(a.id);

    // Notifications: rows + category kept, content gone.
    const n = await prisma.notification.findUniqueOrThrow({
      where: { id: seeded.notification.id },
    });
    expect(n.subject).toBeNull();
    expect(n.body).toBe('');
    expect(n.recipientEmail).toBeNull();
    expect(n.category).toBe('payroll');

    // LEGAL RETENTION: time + payroll rows untouched, still pointing at the
    // anonymized associate.
    const te = await prisma.timeEntry.findUniqueOrThrow({ where: { id: seeded.timeEntry.id } });
    expect(te.associateId).toBe(a.id);
    expect(te.status).toBe('APPROVED');
    const item = await prisma.payrollItem.findUniqueOrThrow({
      where: { id: seeded.payrollItem.id },
    });
    expect(item.associateId).toBe(a.id);
    expect(Number(item.grossPay)).toBe(160);
    expect(item.status).toBe('DISBURSED');

    // Provable critical audit — reason + counts, and zero PII.
    await flushPendingAudits();
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'privacy.associate_erased', entityId: a.id },
    });
    const meta = audit.metadata as Record<string, unknown>;
    expect(meta.reason).toBe('GDPR deletion request, ticket #4711');
    expect((meta.counts as Record<string, number>).w4SsnCleared).toBe(1);
    const metaJson = JSON.stringify(meta);
    expect(metaJson).not.toContain('Gonzalez');
    expect(metaJson).not.toContain('Maria');
    expect(metaJson).not.toContain(originalEmail);
  });

  it('refuses (409 not_terminated) for a non-separated associate without force, and drops the associate from the W-4 recollection roster when forced', async () => {
    const client = await createClient();
    const seeded = await seedFullAssociate(client.id, {
      separated: false,
      ssnBlob: unreadableBlob(), // affected by the key incident → on the roster
    });
    const hr = await seedHrAdmin();

    // On the recollection roster before erasure.
    const before = await hr.get('/w4-recollection');
    expect(before.status).toBe(200);
    expect(
      before.body.rows.map((r: { associateId: string }) => r.associateId),
    ).toContain(seeded.associate.id);

    // Not separated + no force → refused, nothing changed.
    const refused = await hr.post(`/org/associates/${seeded.associate.id}/erase`).send({
      reason: 'Deletion request, ticket #100',
      confirmName: 'Gonzalez',
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('not_terminated');
    const untouched = await prisma.associate.findUniqueOrThrow({
      where: { id: seeded.associate.id },
    });
    expect(untouched.firstName).toBe('Maria');
    expect(untouched.erasedAt).toBeNull();

    // force → erased, and a forced erasure marks the associate separated.
    const forced = await hr.post(`/org/associates/${seeded.associate.id}/erase`).send({
      reason: 'Deletion request, ticket #100',
      confirmName: 'Gonzalez',
      force: true,
    });
    expect(forced.status).toBe(200);
    const erased = await prisma.associate.findUniqueOrThrow({
      where: { id: seeded.associate.id },
    });
    expect(erased.erasedAt).not.toBeNull();
    expect(erased.deletedAt).not.toBeNull();

    // Nulled ssnEncrypted no longer matches the roster's
    // `ssnEncrypted: { not: null }` filter → gone from the campaign.
    const after = await hr.get('/w4-recollection');
    expect(after.status).toBe(200);
    expect(
      after.body.rows.map((r: { associateId: string }) => r.associateId),
    ).not.toContain(seeded.associate.id);
  });

  it('409s on a last-name confirmation mismatch and changes nothing', async () => {
    const client = await createClient();
    const seeded = await seedFullAssociate(client.id);
    const hr = await seedHrAdmin();

    const r = await hr.post(`/org/associates/${seeded.associate.id}/erase`).send({
      reason: 'Deletion request, ticket #200',
      confirmName: 'Gonzales', // typo
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('name_mismatch');
    const a = await prisma.associate.findUniqueOrThrow({
      where: { id: seeded.associate.id },
    });
    expect(a.firstName).toBe('Maria');
    expect(a.erasedAt).toBeNull();
  });

  it('409s while the associate has items on an in-flight payroll run, even with force', async () => {
    const client = await createClient();
    const seeded = await seedFullAssociate(client.id);
    const hr = await seedHrAdmin();

    const draftRun = await prisma.payrollRun.create({
      data: {
        clientId: client.id,
        periodStart: new Date('2026-07-06'),
        periodEnd: new Date('2026-07-19'),
        status: 'DRAFT',
      },
    });
    await prisma.payrollItem.create({
      data: {
        payrollRunId: draftRun.id,
        associateId: seeded.associate.id,
        hoursWorked: 8,
        hourlyRate: 20,
        grossPay: 160,
        federalWithholding: 16,
        netPay: 130,
      },
    });

    const r = await hr.post(`/org/associates/${seeded.associate.id}/erase`).send({
      reason: 'Deletion request, ticket #300',
      confirmName: 'Gonzalez',
      force: true,
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('payroll_in_flight');
    const a = await prisma.associate.findUniqueOrThrow({
      where: { id: seeded.associate.id },
    });
    expect(a.erasedAt).toBeNull();
  });

  it('is not repeatable (409 already_erased) and rejects short reasons + non-admin callers', async () => {
    const client = await createClient();
    const seeded = await seedFullAssociate(client.id);
    const hr = await seedHrAdmin();

    // Short reason → zod 400.
    const short = await hr.post(`/org/associates/${seeded.associate.id}/erase`).send({
      reason: 'too short',
      confirmName: 'Gonzalez',
    });
    expect(short.status).toBe(400);

    // A plain associate cannot reach the endpoint.
    const { user: rando } = await createUser({ role: 'ASSOCIATE' });
    const randoAgent = await loginAs(rando.email);
    const forbidden = await randoAgent
      .post(`/org/associates/${seeded.associate.id}/erase`)
      .send({ reason: 'Deletion request, ticket #1', confirmName: 'Gonzalez' });
    expect(forbidden.status).toBe(403);

    const first = await hr.post(`/org/associates/${seeded.associate.id}/erase`).send({
      reason: 'Deletion request, ticket #400',
      confirmName: 'Gonzalez',
    });
    expect(first.status).toBe(200);

    // Second attempt: confirm against the anonymized name to get past the
    // fat-finger check, then hit the idempotence guard.
    const last6 = seeded.associate.id.replace(/-/g, '').slice(-6);
    const again = await hr.post(`/org/associates/${seeded.associate.id}/erase`).send({
      reason: 'Deletion request, ticket #400 re-run',
      confirmName: `Associate-${last6}`,
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('already_erased');
  });
});
