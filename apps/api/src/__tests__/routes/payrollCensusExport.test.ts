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

describe('Payroll-provider census export', () => {
  it('exports active associates with decrypted SSN + bank info and lands a bulk audit row', async () => {
    const associate = await createAssociate({
      firstName: 'Ada',
      lastName: 'Lovelace',
    });
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
    await prisma.payoutMethod.create({
      data: {
        associateId: associate.id,
        type: 'BANK_ACCOUNT',
        isPrimary: true,
        accountType: 'CHECKING',
        routingNumberEnc: Buffer.from('021000021', 'utf8'),
        accountNumberEnc: encryptString('55554444'),
      },
    });
    const { cookie, userId } = await adminCookie();

    const res = await request(app())
      .post('/org/associates/payroll-census-export')
      .set('Cookie', [cookie])
      .send({ reason: 'Onboarding to new payroll provider — trial import' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['x-row-count']).toBe('1');
    expect(res.headers['x-decrypt-failures']).toBe('0');

    const lines = res.text.trim().split('\r\n');
    expect(lines[0]).toContain('SSN');
    expect(lines[0]).toContain('Routing Number');
    expect(lines[0]).toContain('Account Number');
    // The one data row carries the decrypted, formatted values.
    expect(lines[1]).toContain('Ada');
    expect(lines[1]).toContain('123-45-6789');
    expect(lines[1]).toContain('021000021');
    expect(lines[1]).toContain('55554444');
    expect(lines[1]).toContain('CHECKING');

    // The paper trail is the control: actor, reason, row count, and the exact
    // roster of exported associates are all recorded.
    await flushPendingAudits();
    const log = await prisma.auditLog.findFirst({
      where: {
        action: 'associate.payroll_census_exported',
        actorUserId: userId,
      },
    });
    expect(log).not.toBeNull();
    const meta = log!.metadata as {
      reason?: string;
      rowCount?: number;
      associateIds?: string[];
      scope?: string;
    };
    expect(meta.reason).toContain('payroll provider');
    expect(meta.rowCount).toBe(1);
    expect(meta.scope).toBe('active');
    expect(meta.associateIds).toContain(associate.id);
  });

  it('excludes soft-deleted and separated associates', async () => {
    const active = await createAssociate({ firstName: 'Keep', lastName: 'Me' });
    const deleted = await createAssociate({ firstName: 'Soft', lastName: 'Gone' });
    const separated = await createAssociate({ firstName: 'Term', lastName: 'Inated' });

    await prisma.associate.update({
      where: { id: deleted.id },
      data: { deletedAt: new Date() },
    });
    await prisma.separation.create({
      data: {
        associateId: separated.id,
        reason: 'VOLUNTARY_PERSONAL',
        status: 'COMPLETE',
        lastDayWorked: new Date(),
      },
    });

    const { cookie } = await adminCookie();
    const res = await request(app())
      .post('/org/associates/payroll-census-export')
      .set('Cookie', [cookie])
      .send({ reason: 'Active-only census for provider trial' });

    expect(res.status).toBe(200);
    expect(res.headers['x-row-count']).toBe('1');
    expect(res.text).toContain(active.id);
    expect(res.text).not.toContain(deleted.id);
    expect(res.text).not.toContain(separated.id);
  });

  it('rejects a too-short reason and writes no audit row', async () => {
    await createAssociate();
    const { cookie, userId } = await adminCookie();

    const res = await request(app())
      .post('/org/associates/payroll-census-export')
      .set('Cookie', [cookie])
      .send({ reason: 'short' });
    expect(res.status).toBe(400);

    await flushPendingAudits();
    const log = await prisma.auditLog.findFirst({
      where: {
        action: 'associate.payroll_census_exported',
        actorUserId: userId,
      },
    });
    expect(log).toBeNull();
  });

  it('is denied without process:payroll', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const token = signSession({
      sub: user.id,
      role: user.role,
      ver: user.tokenVersion,
    });

    const res = await request(app())
      .post('/org/associates/payroll-census-export')
      .set('Cookie', [`alto.session=${token}`])
      .send({ reason: 'curiosity is not a reason' });
    expect(res.status).toBe(403);
  });
});
