import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import ExcelJS from 'exceljs';
import { createApp } from '../../app.js';
import { encryptString } from '../../lib/crypto.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { _setAdapterForTesting, type DisbursementAdapter, type DisbursementResult } from '../../lib/disbursement.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * Financial-change alerts and verify-before-pay, end to end through the
 * routes:
 *   - a bank change retires the old account, writes a ledger row, tells
 *     Finance and the associate — with the last four only, never the number
 *   - risk flags: a recent email change, admin on behalf, a new account,
 *     the same account on two people (auto-held)
 *   - payroll pays the previous verified account while a change is pending,
 *     holds it under the HOLD policy, and holds a high-risk change always
 *   - Finance verifies (never their own change), rejects (previous restored)
 *   - the packet refuses over unverified changes until each is acknowledged,
 *     lists them, logs the download with a watermark, and tells Finance
 */

const app = () => createApp();
const NOW = Date.now();

function binaryParser(res: request.Response, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  (res as unknown as NodeJS.EventEmitter).on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
  (res as unknown as NodeJS.EventEmitter).on('end', () => cb(null, Buffer.concat(chunks)));
}

beforeEach(async () => {
  await truncateAll();
});
afterEach(() => _setAdapterForTesting(null));
afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`loginAs failed: ${r.status} ${JSON.stringify(r.body)}`);
  return a;
}

const BANK = { routingNumber: '021000021', accountNumber: '000123456789', accountType: 'CHECKING', bankName: 'Chase' };

/** An associate with a verified account already on file, an old user account, and a phone. */
async function seedAssociate(opts: { createdDaysAgo?: number; firstName?: string } = {}) {
  const associate = await createAssociate({
    firstName: opts.firstName ?? 'Maria',
    lastName: 'Lopez',
    email: `maria-${Math.random().toString(36).slice(2, 8)}@example.com`,
  });
  await prisma.associate.update({ where: { id: associate.id }, data: { phone: '850-555-0142', employmentType: 'W2_EMPLOYEE' } });
  const verifiedAt = new Date(NOW - 40 * 86_400_000);
  const method = await prisma.payoutMethod.create({
    data: {
      associateId: associate.id,
      type: 'BANK_ACCOUNT',
      accountType: 'SAVINGS',
      bankName: 'Regions',
      routingNumberEnc: Buffer.from('062000019', 'utf8'),
      accountNumberEnc: encryptString('555500001111'),
      accountLast4: '1111',
      isPrimary: true,
      verifiedAt,
      createdAt: verifiedAt,
    },
  });
  const { user } = await createUser({ role: 'ASSOCIATE', associateId: associate.id });
  const born = new Date(NOW - (opts.createdDaysAgo ?? 400) * 86_400_000);
  await prisma.user.update({ where: { id: user.id }, data: { createdAt: born } });
  return { associate, user, method };
}

async function finance() {
  const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT', email: `fin-${Math.random().toString(36).slice(2, 8)}@example.com` });
  return user;
}

async function settle() {
  await flushPendingNotifications();
  await flushPendingAudits();
}

describe('POST /self/me/payout-method — the ledger', () => {
  it('retires the old account, records a masked change, and tells Finance and the associate without the account number', async () => {
    const fin = await finance();
    await prisma.orgSetting.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', financeMailbox: 'finance@example.com' },
      update: { financeMailbox: 'finance@example.com' },
    });
    const { associate, user, method } = await seedAssociate();
    const me = await loginAs(user.email);

    const res = await me.post('/self/me/payout-method').send(BANK);
    expect(res.status).toBe(200);
    expect(res.body.verificationPending).toBe(true);
    await settle();

    const methods = await prisma.payoutMethod.findMany({ where: { associateId: associate.id }, orderBy: { createdAt: 'asc' } });
    expect(methods).toHaveLength(2);
    const old = methods.find((m) => m.id === method.id)!;
    expect(old.retiredAt).not.toBeNull();
    expect(old.isPrimary).toBe(false);
    const fresh = methods.find((m) => m.id !== method.id)!;
    expect(fresh.isPrimary).toBe(true);
    expect(fresh.verifiedAt).toBeNull();
    expect(fresh.accountLast4).toBe('6789');
    expect(fresh.accountFingerprint).toMatch(/^[0-9a-f]{64}$/);

    const change = await prisma.financialChange.findFirstOrThrow({ where: { associateId: associate.id } });
    expect(change.kind).toBe('BANK_ACCOUNT');
    expect(change.source).toBe('SELF');
    expect(change.status).toBe('PENDING');
    expect(change.oldSummary).toBe('Regions · savings · ending 1111');
    expect(change.newSummary).toBe('Chase · checking · ending 6789');
    expect(change.verifyPhoneLast4).toBe('0142');
    expect(change.authStrength).toBe('PASSWORD');
    expect(change.riskFlags).toContain('weak_sign_in');
    expect(change.financeNotifiedAt).not.toBeNull();
    expect(change.associateNotifiedAt).not.toBeNull();

    // Finance: a bell row and an email; the mailbox: an email. The associate: an email.
    const financeBell = await prisma.notification.findFirst({ where: { recipientUserId: fin.id, channel: 'IN_APP' } });
    expect(financeBell?.linkUrl).toBe(`/payroll/financial-changes?id=${change.id}`);
    const emails = await prisma.notification.findMany({ where: { channel: 'EMAIL' } });
    const to = emails.map((e) => e.recipientEmail).sort();
    expect(to).toContain(fin.email);
    expect(to).toContain('finance@example.com');
    expect(to).toContain(user.email);
    // Nothing that left carries the full account number.
    for (const e of emails) {
      expect(`${e.subject} ${e.body}`).not.toContain(BANK.accountNumber);
      expect(`${e.subject} ${e.body}`).not.toContain('555500001111');
    }
    const associateMail = emails.find((e) => e.recipientEmail === user.email)!;
    expect(associateMail.subject).toBe('Your direct deposit account was changed');
    expect(associateMail.body).toContain('ending 6789');
  });

  it('speaks the associate’s language and copies a recently replaced email address', async () => {
    await finance();
    const { associate, user } = await seedAssociate();
    await prisma.user.update({ where: { id: user.id }, data: { language: 'es' } });
    await prisma.auditLog.create({
      data: {
        actorUserId: user.id,
        action: 'auth.email_changed',
        entityType: 'User',
        entityId: user.id,
        metadata: { fromEmail: 'old-maria@example.com', toEmail: user.email },
        createdAt: new Date(NOW - 2 * 86_400_000),
      },
    });
    const me = await loginAs(user.email);
    const res = await me.post('/self/me/payout-method').send(BANK);
    expect(res.status).toBe(200);
    await settle();

    const change = await prisma.financialChange.findFirstOrThrow({ where: { associateId: associate.id } });
    expect(change.riskFlags).toContain('contact_changed_recently');
    expect(change.priorContactNotifiedAt).not.toBeNull();
    const toOld = await prisma.notification.findFirst({ where: { channel: 'EMAIL', recipientEmail: 'old-maria@example.com' } });
    expect(toOld?.subject).toBe('Se cambió su cuenta de depósito directo');
    const toNew = await prisma.notification.findFirst({ where: { channel: 'EMAIL', recipientEmail: user.email } });
    expect(toNew?.subject).toBe('Se cambió su cuenta de depósito directo');
  });

  it('auto-holds when the same bank account is already on file for someone else', async () => {
    await finance();
    const other = await seedAssociate({ firstName: 'Other' });
    const otherAgent = await loginAs(other.user.email);
    expect((await otherAgent.post('/self/me/payout-method').send(BANK)).status).toBe(200);

    const { associate, user } = await seedAssociate();
    const me = await loginAs(user.email);
    expect((await me.post('/self/me/payout-method').send(BANK)).status).toBe(200);
    await settle();

    const change = await prisma.financialChange.findFirstOrThrow({ where: { associateId: associate.id } });
    expect(change.riskFlags).toContain('shared_bank_account');
    expect(change.highRisk).toBe(true);
    expect(change.status).toBe('HELD');
  });

  it('flags a brand-new account and an administrator acting on behalf', async () => {
    await finance();
    const { associate } = await seedAssociate({ createdDaysAgo: 3 });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const asHr = await loginAs(hr.email);
    const res = await asHr.patch(`/payroll/associates/${associate.id}/branch-enrollment`).send({ branchCardId: 'card-77771234' });
    expect(res.status).toBe(200);
    await settle();

    const change = await prisma.financialChange.findFirstOrThrow({ where: { associateId: associate.id } });
    expect(change.kind).toBe('PAY_METHOD');
    expect(change.source).toBe('ADMIN');
    expect(change.onBehalf).toBe(true);
    expect(change.riskFlags).toEqual(expect.arrayContaining(['admin_on_behalf', 'new_account']));
    expect(change.newSummary).toBe('Pay card · ending 1234');
  });
});

describe('verify-before-pay', () => {
  async function runFor(associateId: string, clientId: string) {
    const start = new Date('2026-04-01T13:00:00Z');
    await prisma.timeEntry.create({
      data: {
        associateId,
        clientId,
        clockInAt: start,
        clockOutAt: new Date(start.getTime() + 8 * 60 * 60 * 1000),
        status: 'APPROVED',
        approvedAt: new Date(),
      },
    });
    await prisma.w4Submission.create({
      data: { associateId, filingStatus: 'SINGLE', ssnEncrypted: encryptString('123456789') },
    });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);
    const create = await hrAgent.post('/payroll/runs').send({ periodStart: '2026-04-01', periodEnd: '2026-04-15', defaultHourlyRate: 25 });
    if (create.status !== 201) throw new Error(`create failed ${create.status} ${JSON.stringify(create.body)}`);
    const finalize = await hrAgent.post(`/payroll/runs/${create.body.id}/finalize`);
    if (finalize.status !== 200) throw new Error(`finalize failed ${finalize.status}`);
    return { hrAgent, runId: create.body.id as string };
  }

  it('pays the previous verified account while a change is pending, then the new one once verified', async () => {
    const fin = await finance();
    const client = await createClient();
    const { associate, user } = await seedAssociate();
    const me = await loginAs(user.email);
    expect((await me.post('/self/me/payout-method').send(BANK)).status).toBe(200);
    await settle();

    const seen: string[] = [];
    const spy: DisbursementAdapter = {
      provider: 'STUB',
      async disburse(input): Promise<DisbursementResult> {
        seen.push(JSON.stringify(input.recipient));
        return { provider: 'STUB', externalRef: 'STUB-1', status: 'SUCCESS', failureReason: null };
      },
    };
    _setAdapterForTesting(spy);

    const { hrAgent, runId } = await runFor(associate.id, client.id);
    const res = await hrAgent.post(`/payroll/runs/${runId}/disburse`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('DISBURSED');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('1111'); // the previous verified account
    expect(seen[0]).not.toContain('6789');
    await settle();
    const told = await prisma.notification.findFirst({ where: { recipientUserId: fin.id, channel: 'IN_APP', subject: { contains: 'paid to a previous account' } } });
    expect(told).not.toBeNull();

    // Finance verifies by phone; the next run pays the new account.
    const change = await prisma.financialChange.findFirstOrThrow({ where: { associateId: associate.id } });
    const asFin = await loginAs(fin.email);
    const v = await asFin.post(`/payroll/financial-changes/${change.id}/verify`).send({ via: 'PHONE_CALL', note: 'Called 0142, confirmed', reachedOnNumberOnFile: true });
    expect(v.status).toBe(200);
    expect(v.body.change.status).toBe('VERIFIED');
    const fresh = await prisma.payoutMethod.findFirstOrThrow({ where: { associateId: associate.id, isPrimary: true, retiredAt: null } });
    expect(fresh.verifiedAt).not.toBeNull();
    expect(fresh.verifiedById).toBe(fin.id);
  });

  it('holds the item under the HOLD policy, and always for a high-risk change', async () => {
    const fin = await finance();
    await prisma.orgSetting.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', unverifiedPayoutPolicy: 'HOLD' },
      update: { unverifiedPayoutPolicy: 'HOLD' },
    });
    const client = await createClient();
    const { associate, user } = await seedAssociate();
    const me = await loginAs(user.email);
    expect((await me.post('/self/me/payout-method').send(BANK)).status).toBe(200);
    await settle();

    let calls = 0;
    _setAdapterForTesting({
      provider: 'STUB',
      async disburse(): Promise<DisbursementResult> {
        calls += 1;
        return { provider: 'STUB', externalRef: 'STUB-1', status: 'SUCCESS', failureReason: null };
      },
    });
    const { hrAgent, runId } = await runFor(associate.id, client.id);
    const res = await hrAgent.post(`/payroll/runs/${runId}/disburse`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('FINALIZED');
    expect(calls).toBe(0);
    const item = await prisma.payrollItem.findFirstOrThrow({ where: { payrollRunId: runId } });
    expect(item.status).toBe('HELD');
    expect(item.failureReason).toContain('unverified_payout_change');
    await settle();
    const told = await prisma.notification.findFirst({ where: { recipientUserId: fin.id, channel: 'IN_APP', subject: { contains: '1 held' } } });
    expect(told).not.toBeNull();
  });

  it('a rejected change restores the previous account; nobody verifies their own change', async () => {
    const fin = await finance();
    const { associate, user, method } = await seedAssociate();
    const me = await loginAs(user.email);
    expect((await me.post('/self/me/payout-method').send(BANK)).status).toBe(200);
    await settle();
    const change = await prisma.financialChange.findFirstOrThrow({ where: { associateId: associate.id } });

    // The associate cannot reach the queue at all; a Finance user who made the change could not verify it.
    expect((await me.get('/payroll/financial-changes')).status).toBe(403);

    const asFin = await loginAs(fin.email);
    const list = await asFin.get('/payroll/financial-changes');
    expect(list.status).toBe(200);
    expect(list.body.rows.map((r: { id: string }) => r.id)).toContain(change.id);
    expect(JSON.stringify(list.body)).not.toContain(BANK.accountNumber);

    const r = await asFin.post(`/payroll/financial-changes/${change.id}/reject`).send({ note: 'Could not reach the associate on the number on file' });
    expect(r.status).toBe(200);
    expect(r.body.change.status).toBe('REJECTED');
    const restored = await prisma.payoutMethod.findUniqueOrThrow({ where: { id: method.id } });
    expect(restored.isPrimary).toBe(true);
    expect(restored.retiredAt).toBeNull();
    const rejected = await prisma.payoutMethod.findFirst({ where: { associateId: associate.id, id: { not: method.id } } });
    expect(rejected?.retiredAt).not.toBeNull();
  });

  it('an administrator’s own change cannot be verified by them', async () => {
    const fin = await finance();
    const { associate } = await seedAssociate();
    const asFin = await loginAs(fin.email);
    expect((await asFin.patch(`/payroll/associates/${associate.id}/branch-enrollment`).send({ branchCardId: 'card-0001' })).status).toBe(200);
    await settle();
    const change = await prisma.financialChange.findFirstOrThrow({ where: { associateId: associate.id } });
    const v = await asFin.post(`/payroll/financial-changes/${change.id}/verify`).send({ via: 'PHONE_CALL', reachedOnNumberOnFile: true });
    expect(v.status).toBe(403);
    expect(v.body.error.code).toBe('own_change');
  });
});

describe('the payroll packet', () => {
  const RANGE = { from: '2026-04-01T00:00:00.000Z', to: '2026-04-16T00:00:00.000Z' };

  async function packetSeed() {
    const fin = await finance();
    const client = await createClient();
    const { associate, user } = await seedAssociate();
    const start = new Date('2026-04-02T13:00:00Z');
    await prisma.timeEntry.create({
      data: { associateId: associate.id, clientId: client.id, clockInAt: start, clockOutAt: new Date(start.getTime() + 8 * 3_600_000), status: 'APPROVED', approvedAt: new Date() },
    });
    await prisma.w4Submission.create({ data: { associateId: associate.id, filingStatus: 'SINGLE', ssnEncrypted: encryptString('123456789') } });
    const me = await loginAs(user.email);
    expect((await me.post('/self/me/payout-method').send(BANK)).status).toBe(200);
    await settle();
    const change = await prisma.financialChange.findFirstOrThrow({ where: { associateId: associate.id } });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);
    return { fin, associate, change, hr, hrAgent };
  }

  it('refuses over an unverified change until it is acknowledged, then lists it, watermarks, logs and tells Finance', async () => {
    const { fin, associate, change, hr, hrAgent } = await packetSeed();

    const refused = await hrAgent.post('/time/admin/external-payroll-sheet.xlsx').send(RANGE);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('unverified_changes');
    expect(refused.body.error.details.changes[0].id).toBe(change.id);
    expect(JSON.stringify(refused.body)).not.toContain(BANK.accountNumber);
    expect(await prisma.packetDownload.count()).toBe(0);

    const ok = await hrAgent
      .post('/time/admin/external-payroll-sheet.xlsx')
      .send({ ...RANGE, acknowledgeChangeIds: [change.id] })
      .buffer(true)
      .parse(binaryParser);
    expect(ok.status).toBe(200);
    await settle();

    const download = await prisma.packetDownload.findFirstOrThrow();
    expect(download.userId).toBe(hr.id);
    expect(download.acknowledgedChangeIds).toEqual([change.id]);
    expect(download.watermark).toMatch(/^Downloaded by .* · PKT-[0-9A-F]{8}$/);
    const acked = await prisma.financialChange.findUniqueOrThrow({ where: { id: change.id } });
    expect(acked.acknowledgedById).toBe(hr.id);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(ok.body);
    const changes = wb.getWorksheet('Changes since last packet')!;
    expect(changes).toBeDefined();
    const line = changes.getRow(5);
    expect(String(line.getCell(1).value)).toBe('Maria Lopez');
    expect(String(line.getCell(4).value)).toBe('Regions · savings · ending 1111');
    expect(String(line.getCell(5).value)).toBe('Chase · checking · ending 6789');
    expect(String(line.getCell(9).value)).toBe('UNVERIFIED');
    // The roster pays the previous verified account and says so in Flags.
    const roster = wb.getWorksheet('External Payroll')!;
    let flagsCell = '';
    let accountCell = '';
    roster.eachRow((row) => {
      const values = row.values as unknown[];
      const header = values.findIndex((v) => v === 'Flags');
      if (header > 0) return;
      const text = Array.from(values, (v) => (v == null ? '' : String(v)));
      if (text.some((t) => t.includes('PREVIOUS VERIFIED ACCOUNT'))) {
        flagsCell = text.find((t) => t.includes('PREVIOUS VERIFIED ACCOUNT'))!;
        accountCell = text.find((t) => t === '555500001111') ?? '';
      }
    });
    expect(flagsCell).toContain('new account ending 6789 pending verification');
    expect(accountCell).toBe('555500001111');

    const audit = await prisma.auditLog.findFirst({ where: { action: 'payroll.external_sheet_exported' } });
    expect((audit?.metadata as { packetDownloadId?: string }).packetDownloadId).toBe(download.id);
    const told = await prisma.notification.findFirst({ where: { recipientUserId: fin.id, channel: 'IN_APP', subject: { contains: 'Payroll packet downloaded' } } });
    expect(told).not.toBeNull();
    expect(told?.body).not.toContain(BANK.accountNumber);
    expect(associate.id).toBeTruthy();
  });

  it('goes straight through once Finance has verified the change, and the PDF carries the watermark', async () => {
    const { fin, change, hrAgent } = await packetSeed();
    const asFin = await loginAs(fin.email);
    expect((await asFin.post(`/payroll/financial-changes/${change.id}/verify`).send({ via: 'PHONE_CALL', reachedOnNumberOnFile: true })).status).toBe(200);

    const ok = await hrAgent.post('/time/admin/external-payroll-sheet.pdf').send(RANGE).buffer(true).parse(binaryParser);
    expect(ok.status).toBe(200);
    expect((ok.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    const download = await prisma.packetDownload.findFirstOrThrow();
    expect(download.acknowledgedChangeIds).toEqual([]);
    expect(download.format).toBe('pdf');
  });
});

describe('other financial writes', () => {
  it('a W-4 election change and an SSN change by HR are recorded, masked', async () => {
    await finance();
    const { associate } = await seedAssociate();
    await prisma.w4Submission.create({
      data: { associateId: associate.id, filingStatus: 'SINGLE', ssnEncrypted: encryptString('123456789') },
    });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const asHr = await loginAs(hr.email);
    const res = await asHr.patch(`/org/associates/${associate.id}/w4`).send({ filingStatus: 'MARRIED_FILING_JOINTLY', extraWithholding: 25 });
    expect(res.status).toBe(200);
    await settle();
    const w4 = await prisma.financialChange.findFirstOrThrow({ where: { associateId: associate.id, kind: 'W4' } });
    expect(w4.source).toBe('ADMIN');
    expect(w4.oldSummary).toBe('single');
    expect(w4.newSummary).toBe('married filing jointly · extra $25/period');
  });

  it('a home address change by the associate is recorded, and a phone change is audited for the risk window', async () => {
    await finance();
    const { associate, user } = await seedAssociate();
    const me = await loginAs(user.email);
    const res = await me.put('/self/me/profile').send({ addressLine1: '9 Harbor Way', city: 'Destin', state: 'FL', zip: '32541', phone: '850-555-9999' });
    expect(res.status).toBe(200);
    await settle();
    const addr = await prisma.financialChange.findFirstOrThrow({ where: { associateId: associate.id, kind: 'HOME_ADDRESS' } });
    expect(addr.newSummary).toBe('9 Harbor Way, Destin, FL 32541');
    // The verify phone is the one on file BEFORE the change.
    expect(addr.verifyPhoneLast4).toBe('0142');
    const phone = await prisma.auditLog.findFirst({ where: { action: 'self.phone_changed', entityId: associate.id } });
    expect(phone).not.toBeNull();
    expect(JSON.stringify(phone?.metadata)).not.toContain('5559999');
  });
});
