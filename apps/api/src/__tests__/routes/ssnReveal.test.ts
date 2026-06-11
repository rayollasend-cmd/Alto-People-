import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { signSession } from '../../lib/jwt.js';
import { encryptString } from '../../lib/crypto.js';
import { flushPendingAudits } from '../../lib/audit.js';
import {
  createAssociate,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

const app = () => createApp();

async function adminCookie(): Promise<{ cookie: string; userId: string }> {
  const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const token = signSession({
    sub: user.id,
    role: user.role,
    ver: user.tokenVersion,
  });
  return { cookie: `alto.session=${token}`, userId: user.id };
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('SSN masked summary + audited reveal', () => {
  it('masked GET shows last4; reveal requires a reason, returns the number, and lands an audit row', async () => {
    const associate = await createAssociate();
    await prisma.associate.update({
      where: { id: associate.id },
      data: { ssnLast4: '6789' },
    });
    await prisma.w4Submission.create({
      data: {
        associateId: associate.id,
        filingStatus: 'SINGLE',
        ssnEncrypted: encryptString('123456789'),
        signedAt: new Date(),
      },
    });
    const { cookie, userId } = await adminCookie();

    const masked = await request(app())
      .get(`/org/associates/${associate.id}/ssn`)
      .set('Cookie', [cookie]);
    expect(masked.status).toBe(200);
    expect(masked.body).toMatchObject({
      hasSsn: true,
      ssnLast4: '6789',
      source: 'W4',
    });

    // No / too-short reason → rejected, nothing revealed.
    const noReason = await request(app())
      .post(`/org/associates/${associate.id}/ssn/reveal`)
      .set('Cookie', [cookie])
      .send({ reason: 'short' });
    expect(noReason.status).toBe(400);

    const reveal = await request(app())
      .post(`/org/associates/${associate.id}/ssn/reveal`)
      .set('Cookie', [cookie])
      .send({ reason: 'E-Verify mismatch — confirming W-4 SSN' });
    expect(reveal.status).toBe(200);
    expect(reveal.body).toMatchObject({
      kind: 'SSN',
      source: 'W4',
      number: '123-45-6789',
    });

    // The paper trail is the control: actor, reason, target all recorded.
    await flushPendingAudits();
    const log = await prisma.auditLog.findFirst({
      where: { action: 'associate.ssn_revealed', actorUserId: userId },
    });
    expect(log).not.toBeNull();
    expect(log!.entityId).toBe(associate.id);
    expect((log!.metadata as { reason?: string }).reason).toContain('E-Verify');
  });

  it('404s with a helpful message when no SSN/TIN is on file', async () => {
    const associate = await createAssociate();
    const { cookie } = await adminCookie();

    const masked = await request(app())
      .get(`/org/associates/${associate.id}/ssn`)
      .set('Cookie', [cookie]);
    expect(masked.body.hasSsn).toBe(false);

    const reveal = await request(app())
      .post(`/org/associates/${associate.id}/ssn/reveal`)
      .set('Cookie', [cookie])
      .send({ reason: 'background check dispute follow-up' });
    expect(reveal.status).toBe(404);
    expect(reveal.body.error?.code).toBe('no_ssn');
  });

  it('falls back to the 1099 TIN and formats an EIN for business contractors', async () => {
    const associate = await createAssociate();
    await prisma.associate.update({
      where: { id: associate.id },
      data: {
        employmentType: 'CONTRACTOR_1099_BUSINESS',
        tinEncrypted: encryptString('123456789'),
      },
    });
    const { cookie } = await adminCookie();

    const reveal = await request(app())
      .post(`/org/associates/${associate.id}/ssn/reveal`)
      .set('Cookie', [cookie])
      .send({ reason: '1099-NEC filing — verifying recipient TIN' });
    expect(reveal.status).toBe(200);
    expect(reveal.body).toMatchObject({
      kind: 'EIN',
      source: 'TIN',
      number: '12-3456789',
    });
  });

  it('is denied without process:payroll', async () => {
    const associate = await createAssociate();
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const token = signSession({
      sub: user.id,
      role: user.role,
      ver: user.tokenVersion,
    });

    const res = await request(app())
      .post(`/org/associates/${associate.id}/ssn/reveal`)
      .set('Cookie', [`alto.session=${token}`])
      .send({ reason: 'curiosity is not a reason' });
    expect(res.status).toBe(403);
  });
});
