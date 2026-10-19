import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { encryptString } from '../../lib/crypto.js';
import { accountFingerprint } from '../../lib/financialChanges.js';
import { _setAdapterForTesting } from '../../lib/disbursement.js';
import { buildPaystubDataById } from '../../lib/paystubData.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createUser, prisma, signOffRun, truncateAll } from '../../../test/db.js';

/**
 * Paper checks: a one-time "pay by check" on a paycheck (payroll's call
 * or the associate's approved request), how payout honours it on every
 * rail, and a check's life afterwards — print, void, reissue, stop
 * payment and the bank's positive-pay file.
 */

const app = () => createApp();

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${JSON.stringify(r.body)}`);
  return a;
}

const ROUTING_A = '011000015';
const ROUTING_B = '091000019';

async function bankMethod(associateId: string, routing: string, account: string) {
  return prisma.payoutMethod.create({
    data: {
      associateId,
      type: 'BANK_ACCOUNT',
      routingNumberEnc: Buffer.from(routing, 'utf8'),
      accountNumberEnc: encryptString(account),
      accountType: 'CHECKING',
      isPrimary: true,
      verifiedAt: new Date('2026-09-01T00:00:00Z'),
      accountLast4: account.slice(-4),
      accountFingerprint: accountFingerprint(routing, account),
    },
  });
}

/** A finalized run: Jane $1,250.50 and Ken $500.00, both with a bank account on file. */
async function finalizedRun(status: 'FINALIZED' | 'DRAFT' = 'FINALIZED') {
  const jane = await createAssociate({ firstName: 'Jane', lastName: 'Doe' });
  const ken = await createAssociate({ firstName: 'Ken', lastName: 'Ito' });
  await prisma.associate.update({ where: { id: ken.id }, data: { addressLine1: '9 Bay St', city: 'Destin', state: 'FL', zip: '32541' } });
  await bankMethod(jane.id, ROUTING_A, '123456789');
  await bankMethod(ken.id, ROUTING_B, '987654321');
  const run = await prisma.payrollRun.create({
    data: { periodStart: new Date('2026-10-03'), periodEnd: new Date('2026-10-09'), status, totalGross: 2000, totalTax: 249.5, totalNet: 1750.5, totalEmployerTax: 120 },
  });
  const item = (associateId: string, net: number) =>
    prisma.payrollItem.create({ data: { payrollRunId: run.id, associateId, hoursWorked: 40, hourlyRate: 25, grossPay: 1000, federalWithholding: 0, netPay: net } });
  const janeItem = await item(jane.id, 1250.5);
  const kenItem = await item(ken.id, 500);
  return { run, jane, ken, janeItem, kenItem };
}

async function ownAch(a: TestAgent<Test>) {
  const r = await a.put('/payroll-banking/profile').send({
    bankRail: 'ACH',
    achSpeed: 'NEXT_DAY',
    companyName: 'Alto HR',
    companyId: '1234567890',
    immediateDestination: ROUTING_B,
    immediateDestinationName: 'Wells Fargo',
    immediateOrigin: '1234567890',
    immediateOriginName: 'Alto HR',
    originatingDfi: '09100001',
  });
  expect(r.status).toBe(200);
  const add = await a.post('/payroll-banking/accounts').send({ label: 'Operating', bankName: 'Chase', routingNumber: ROUTING_A, accountNumber: '000123456789', accountType: 'CHECKING' });
  const id = add.body.account.id as string;
  const sent = await a.post(`/payroll-banking/accounts/${id}/verify`).send({ method: 'MICRODEPOSITS' });
  const [x, y] = sent.body.amountsForTest as [number, number];
  await a.post(`/payroll-banking/accounts/${id}/confirm`).send({ amounts: [y, x] });
  await a.post(`/payroll-banking/accounts/${id}/funding`).send({});
  return id;
}

/** The account checks are drawn on, set in Check settings. */
async function checkBank(a: TestAgent<Test>) {
  const acct = await prisma.employerBankAccount.create({
    data: { label: 'Payroll', bankName: 'First Coast Bank', routingNumber: '063100277', accountNumberEnc: encryptString('4455667788'), accountLast4: '7788', status: 'VERIFIED' },
  });
  const put = await a.put('/payroll/check-settings').send({ bankAccountId: acct.id, bankAddress: 'Panama City, FL', fractionalRouting: '63-1234/631', signatureSignerName: 'Dana Reyes', offsetXPt: 1.5 });
  expect(put.status).toBe(200);
  expect(put.body.settings).toMatchObject({ ready: true, bankName: 'First Coast Bank', bankAccountLabel: 'Payroll ••••7788' });
  return acct;
}

const binary = (r: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  r.on('data', (c: Buffer) => chunks.push(c));
  r.on('end', () => cb(null, Buffer.concat(chunks)));
};

beforeEach(async () => {
  await truncateAll();
  _setAdapterForTesting(null);
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await prisma.$disconnect();
});

describe('pay by check this time', () => {
  it('payroll sets and clears it before payout; the review numbers don’t move; the close and the report show it', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);
    const { run, kenItem } = await finalizedRun();
    const before = (await a.get(`/payroll/runs/${run.id}/review/status`)).body.fingerprint;

    const noReason = await a.put(`/payroll/items/${kenItem.id}/pay-by-check`).send({ reason: '' });
    expect(noReason.status).toBe(400);
    const set = await a.put(`/payroll/items/${kenItem.id}/pay-by-check`).send({ reason: 'Ken asked for a check this payday' });
    expect(set.status).toBe(200);
    expect(set.body.override).toMatchObject({ name: 'Ken Ito', source: 'PAYROLL' });

    expect((await a.get(`/payroll/runs/${run.id}/review/status`)).body.fingerprint).toBe(before);
    const report = (await a.get(`/payroll/runs/${run.id}/review`)).body.report;
    expect(report.payByCheck).toEqual([expect.objectContaining({ name: 'Ken Ito', reason: 'Ken asked for a check this payday', net: 500 })]);
    const close = (await a.get(`/payroll/runs/${run.id}/close`)).body;
    expect(close.payByCheck).toEqual([expect.objectContaining({ name: 'Ken Ito' })]);
    const checks = (await a.get(`/payroll/runs/${run.id}/checks`)).body;
    expect(checks.overrides).toHaveLength(1);

    const cleared = await a.delete(`/payroll/items/${kenItem.id}/pay-by-check`).send({ reason: 'Changed his mind' });
    expect(cleared.status).toBe(204);
    expect((await a.get(`/payroll/runs/${run.id}/close`)).body.payByCheck).toEqual([]);
    expect((await a.delete(`/payroll/items/${kenItem.id}/pay-by-check`).send({})).status).toBe(409);

    const audits = await prisma.auditLog.findMany({ where: { entityId: kenItem.id, action: { startsWith: 'payroll.' } }, select: { action: true }, orderBy: { createdAt: 'asc' } });
    expect(audits.map((x) => x.action)).toEqual(['payroll.pay_by_check_set', 'payroll.pay_by_check_cleared']);
  });

  it('a paid paycheck can’t switch, and only payroll can switch one', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { user: assoc } = await createUser({ role: 'ASSOCIATE' });
    const a = await loginAs(user.email);
    const { run, kenItem } = await finalizedRun();
    expect((await (await loginAs(assoc.email)).put(`/payroll/items/${kenItem.id}/pay-by-check`).send({ reason: 'Please' })).status).toBe(403);
    await prisma.payrollRun.update({ where: { id: run.id }, data: { status: 'DISBURSED' } });
    const late = await a.put(`/payroll/items/${kenItem.id}/pay-by-check`).send({ reason: 'Too late' });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('run_closed');
  });

  it('on our own ACH the check stays out of the NACHA file, the funding debit still covers it, and it pays by check', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);
    await ownAch(a);
    const { run, kenItem, janeItem } = await finalizedRun();
    await a.put(`/payroll/items/${kenItem.id}/pay-by-check`).send({ reason: 'Ken asked for a check' });

    const preview = await a.get(`/payroll-banking/runs/${run.id}/funding`);
    expect(preview.body.funding).toMatchObject({ amountCents: 175050 });
    expect(preview.body.funding.breakdown).toMatchObject({ netPayCents: 125050, achPeople: 1, paperCheckNetCents: 50000, paperCheckPeople: 1 });
    await a.post(`/payroll-banking/runs/${run.id}/funding`).send({});
    await prisma.payrollFunding.updateMany({ data: { status: 'SETTLED', settledAt: new Date() } });
    await signOffRun(run.id);
    const paid = await a.post(`/payroll/runs/${run.id}/disburse`).send({});
    expect(paid.status).toBe(200);
    expect(paid.body.status).toBe('DISBURSED');

    const dd = await prisma.achFile.findFirstOrThrow({ where: { purpose: 'DIRECT_DEPOSIT' } });
    expect(dd.entryCount).toBe(1);
    expect(Number(dd.totalCreditCents)).toBe(125050);
    expect(await prisma.achEntry.count({ where: { payrollItemId: kenItem.id } })).toBe(0);
    const ken = await prisma.payrollItem.findUniqueOrThrow({ where: { id: kenItem.id } });
    const check = await prisma.payCheck.findFirstOrThrow({ where: { payrollItemId: kenItem.id } });
    expect(ken.disbursementRef).toBe(`CHECK-${check.checkNumber}`);
    expect(Number(check.amount)).toBe(500);
    expect(check.payeeAddress).toMatchObject({ line1: '9 Bay St', city: 'Destin' });
    expect((await prisma.payrollItem.findUniqueOrThrow({ where: { id: janeItem.id } })).disbursementRef).toMatch(/^09100001\d{7}$/);

    const stub = await buildPaystubDataById(prisma, kenItem.id);
    expect(stub!.data.payDistribution).toEqual({ label: `Paper check #${check.checkNumber}`, detail: 'Paid by paper check this payday instead of your usual deposit' });
  });
});

describe('the associate asks for a paper check', () => {
  it('asks from their pay screen; payroll approves; payout pays them by check', async () => {
    const { run, jane, janeItem } = await finalizedRun('DRAFT');
    const { user: me } = await createUser({ role: 'ASSOCIATE', associateId: jane.id });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const w = await loginAs(me.email);
    const a = await loginAs(hr.email);

    const status = await w.get('/me/pay-by-check');
    expect(status.body).toMatchObject({ openPaycheck: { itemId: janeItem.id, periodEnd: '2026-10-09' }, override: null, request: null });
    const asked = await w.post('/me/pay-by-check').send({ reason: 'My bank account is closing this week' });
    expect(asked.status).toBe(201);
    expect(asked.body.request).toMatchObject({ status: 'PENDING', reason: 'My bank account is closing this week' });
    expect((await w.post('/me/pay-by-check').send({ reason: 'Again' })).body.error.code).toBe('already_requested');

    const pending = (await a.get(`/payroll/runs/${run.id}/checks`)).body.requests;
    expect(pending).toHaveLength(1);
    const decided = await a.post(`/approvals/requests/${pending[0].id}/decide`).send({ decision: 'APPROVE' });
    expect(decided.status).toBe(200);
    expect((await w.get('/me/pay-by-check')).body).toMatchObject({ override: { source: 'ASSOCIATE' }, request: { status: 'APPROVED' } });

    await prisma.payrollRun.update({ where: { id: run.id }, data: { status: 'FINALIZED', finalizedAt: new Date() } });
    await signOffRun(run.id);
    expect((await a.post(`/payroll/runs/${run.id}/disburse`).send({})).status).toBe(200);
    expect((await prisma.payrollItem.findUniqueOrThrow({ where: { id: janeItem.id } })).disbursementRef).toMatch(/^CHECK-\d+$/);
  });

  it('a request still open at payout closes with the cut-off, and an office account has no paycheck to ask about', async () => {
    const { run, jane } = await finalizedRun();
    const { user: me } = await createUser({ role: 'ASSOCIATE', associateId: jane.id });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const w = await loginAs(me.email);
    await w.post('/me/pay-by-check').send({ reason: 'Prefer a check' });
    await signOffRun(run.id);
    expect((await (await loginAs(hr.email)).post(`/payroll/runs/${run.id}/disburse`).send({})).status).toBe(200);
    const req = await prisma.approvalRequest.findFirstOrThrow({ where: { kind: 'PAY_BY_CHECK' } });
    expect(req.status).toBe('CANCELLED');
    expect((await w.get('/me/pay-by-check')).body.openPaycheck).toBeNull();
    expect((await (await loginAs(hr.email)).get('/me/pay-by-check')).status).toBe(403);
  });
});

describe('a check’s life', () => {
  async function paidByCheck() {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);
    const { run, kenItem } = await finalizedRun();
    await a.put(`/payroll/items/${kenItem.id}/pay-by-check`).send({ reason: 'Asked for a check' });
    await signOffRun(run.id);
    expect((await a.post(`/payroll/runs/${run.id}/disburse`).send({})).status).toBe(200);
    const check = await prisma.payCheck.findFirstOrThrow({ where: { payrollItemId: kenItem.id } });
    return { a, run, kenItem, check, user };
  }

  it('prints only once the bank is set up, in the house layout, and records who printed', async () => {
    const { a, run, check, user } = await paidByCheck();
    const early = await a.get(`/payroll/runs/${run.id}/checks.pdf`);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('check_bank_missing');
    await checkBank(a);
    const pdf = await a.get(`/payroll/runs/${run.id}/checks.pdf`).buffer(true).parse(binary);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    const after = await prisma.payCheck.findUniqueOrThrow({ where: { id: check.id } });
    expect(after.printedById).toBe(user.id);
    expect(after.printCount).toBe(1);
    const list = (await a.get(`/payroll/runs/${run.id}/checks`)).body;
    expect(list.checks[0]).toMatchObject({ checkNumber: check.checkNumber, status: 'PRINTED', payeeName: 'Ken Ito', amount: 500 });
    expect(list.settings.gaps.some((g: string) => /MICR/.test(g))).toBe(true);
    const align = await a.get('/payroll/checks/alignment.pdf').buffer(true).parse(binary);
    expect((align.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    const register = await a.get(`/payroll/runs/${run.id}/check-register.pdf`).buffer(true).parse(binary);
    expect(register.status).toBe(200);
  });

  it('void, reissue with a new number, stop payment — each on the record', async () => {
    const { a, run, kenItem, check } = await paidByCheck();
    await checkBank(a);
    expect((await a.post(`/payroll/checks/${check.id}/void`).send({ reason: 'x' })).status).toBe(400);
    const reissued = await a.post(`/payroll/checks/${check.id}/reissue`).send({ reason: 'Check was lost in the mail' });
    expect(reissued.status).toBe(201);
    expect(reissued.body.checkNumber).toBeGreaterThan(check.checkNumber);
    const old = await prisma.payCheck.findUniqueOrThrow({ where: { id: check.id } });
    expect(old.voidReason).toBe('Check was lost in the mail');
    expect((await prisma.payrollItem.findUniqueOrThrow({ where: { id: kenItem.id } })).disbursementRef).toBe(`CHECK-${reissued.body.checkNumber}`);
    // A voided check can't be reprinted; the live one can.
    expect((await a.get(`/payroll/checks/${check.id}/print.pdf`)).status).toBe(404);
    expect((await a.get(`/payroll/checks/${reissued.body.id}/print.pdf`)).status).toBe(200);

    const stopped = await a.post(`/payroll/checks/${reissued.body.id}/stop-payment`).send({ reason: 'Reported stolen', bankRef: 'SP-4471' });
    expect(stopped.status).toBe(200);
    const list = (await a.get(`/payroll/runs/${run.id}/checks`)).body.checks;
    expect(list.map((c: { status: string }) => c.status)).toEqual(['VOID', 'STOPPED']);
    expect(list[1].replacesCheckNumber).toBe(check.checkNumber);
    const actions = (await prisma.auditLog.findMany({ where: { entityType: 'PayCheck' }, select: { action: true } })).map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['payroll.check_voided', 'payroll.check_reissued', 'payroll.check_stop_payment', 'payroll.checks_printed']));
  });

  it('positive pay lists issued and void checks for the bank, then only what’s new', async () => {
    const { a, run, check } = await paidByCheck();
    await checkBank(a);
    const reissued = (await a.post(`/payroll/checks/${check.id}/reissue`).send({ reason: 'Damaged' })).body;
    const file = await a.get(`/payroll/positive-pay.csv?runId=${run.id}`);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toContain('text/csv');
    const lines = file.text.trim().split('\r\n');
    expect(lines[0]).toBe('Account Number,Check Number,Issue Date,Amount,Payee Name,Void');
    expect(lines[1]).toMatch(new RegExp(`^4455667788,${check.checkNumber},\\d{8},500.00,Ken Ito,V$`));
    expect(lines[2]).toMatch(new RegExp(`^4455667788,${reissued.checkNumber},\\d{8},500.00,Ken Ito,$`));
    const again = await a.get('/payroll/positive-pay.csv?onlyNew=1');
    expect(again.text.trim().split('\r\n')).toHaveLength(1);
  });
});
