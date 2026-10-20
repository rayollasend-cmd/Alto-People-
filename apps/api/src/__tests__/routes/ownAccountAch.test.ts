import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { encryptString } from '../../lib/crypto.js';
import { accountFingerprint } from '../../lib/financialChanges.js';
import { validateNachaFile } from '../../lib/banking/nacha.js';
import { _setAdapterForTesting } from '../../lib/disbursement.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createUser, prisma, truncateAll, signOffRun } from '../../../test/db.js';

/**
 * Payroll drawn on the company's own account at the bank (settlement
 * OWN_ACCOUNT): nothing is pulled ahead, the NACHA file is the money —
 * balanced (with the offset debit) or unbalanced — never same-day in-house,
 * and a paycheck reads paid only when a person marks the file uploaded.
 */

const app = () => createApp();
const BANK = '063100688'; // Capital City Bank, as the routing directories list it
const ROUTING_A = '011000015';
const ROUTING_B = '091000019';

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${JSON.stringify(r.body)}`);
  return a;
}

async function ownAccountProfile(a: TestAgent<Test>, extra: Record<string, unknown> = {}) {
  const r = await a.put('/payroll-banking/profile').send({
    bankRail: 'ACH',
    achSpeed: 'NEXT_DAY',
    settlement: 'OWN_ACCOUNT',
    fileFormat: 'UNBALANCED',
    companyName: 'Alto HR',
    companyId: '1593456789',
    immediateDestination: BANK,
    immediateDestinationName: 'Capital City Bank',
    immediateOrigin: '1593456789',
    immediateOriginName: 'Alto HR',
    originatingDfi: BANK.slice(0, 8),
    ...extra,
  });
  expect(r.status).toBe(200);
  return r.body.profile;
}

async function verifiedCompanyAccount(a: TestAgent<Test>) {
  const add = await a.post('/payroll-banking/accounts').send({ label: 'Operating', bankName: 'Capital City Bank', routingNumber: BANK, accountNumber: '1122334455', accountType: 'CHECKING' });
  expect(add.status).toBe(201);
  const id = add.body.account.id as string;
  const sent = await a.post(`/payroll-banking/accounts/${id}/verify`).send({ method: 'MICRODEPOSITS' });
  const [x, y] = sent.body.amountsForTest as [number, number];
  expect((await a.post(`/payroll-banking/accounts/${id}/confirm`).send({ amounts: [x, y] })).body.status).toBe('VERIFIED');
  expect((await a.post(`/payroll-banking/accounts/${id}/funding`).send({})).status).toBe(200);
  return id;
}

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

/** A finalized run: two people paid by bank account, net $1,250.50 and $500.00. */
async function finalizedRun() {
  const jane = await createAssociate({ firstName: 'Jane', lastName: 'Doe' });
  const ken = await createAssociate({ firstName: 'Ken', lastName: 'Ito' });
  await bankMethod(jane.id, ROUTING_A, '123456789');
  await bankMethod(ken.id, ROUTING_B, '987654321');
  const run = await prisma.payrollRun.create({
    data: { periodStart: new Date('2026-10-03'), periodEnd: new Date('2026-10-09'), status: 'FINALIZED', totalGross: 2000, totalTax: 249.5, totalNet: 1750.5, totalEmployerTax: 120 },
  });
  const item = (associateId: string, net: number) =>
    prisma.payrollItem.create({ data: { payrollRunId: run.id, associateId, hoursWorked: 40, hourlyRate: 25, grossPay: 1000, federalWithholding: 0, netPay: net } });
  await item(jane.id, 1250.5);
  await item(ken.id, 500);
  await signOffRun(run.id);
  return run;
}

const lines = (text: string) => text.split(/\r?\n/).filter(Boolean);

beforeEach(async () => {
  await truncateAll();
  _setAdapterForTesting(null);
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('payroll on the company’s own account', () => {
  it('a balanced file: no pull, the offset debit balances the credits, and the paychecks read paid only once the file is marked uploaded', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);
    await ownAccountProfile(a, { fileFormat: 'BALANCED', achSpeed: 'SAME_DAY' });
    await verifiedCompanyAccount(a);
    const run = await finalizedRun();

    // Nothing to fund: the file is the money.
    expect((await a.get(`/payroll-banking/runs/${run.id}/funding`)).body).toEqual({ applies: false, funding: null });
    const pull = await a.post(`/payroll-banking/runs/${run.id}/funding`).send({});
    expect(pull.status).toBe(409);
    expect(pull.body.error.code).toBe('own_account');
    expect((await a.get('/payroll-banking/summary')).body.runs).toEqual([]);

    // Disburse writes the file; the paychecks wait with their trace numbers.
    const disb = await a.post(`/payroll/runs/${run.id}/disburse`).send({});
    expect(disb.status).toBe(200);
    expect(disb.body.status).toBe('FINALIZED');
    const waiting = await prisma.payrollItem.findMany({ where: { payrollRunId: run.id } });
    expect(waiting.every((i) => i.status === 'PENDING' && /^06310068\d{7}$/.test(i.disbursementRef ?? ''))).toBe(true);
    expect(await prisma.payrollDisbursementAttempt.count({ where: { provider: 'ACH', status: 'PENDING' } })).toBe(2);
    expect(await prisma.achFile.count({ where: { purpose: 'FUNDING' } })).toBe(0);

    const file = await prisma.achFile.findFirstOrThrow({ where: { purpose: 'DIRECT_DEPOSIT' } });
    expect(file).toMatchObject({ provider: 'IN_HOUSE', status: 'CREATED', entryCount: 3, sameDay: false }); // never same-day in-house
    expect(Number(file.totalCreditCents)).toBe(175050);
    expect(Number(file.totalDebitCents)).toBe(175050);
    expect(file.effectiveDate.toISOString().slice(0, 10) > new Date().toISOString().slice(0, 10)).toBe(true);
    const offset = await prisma.achEntry.findFirstOrThrow({ where: { achFileId: file.id, kind: 'OFFSET' } });
    expect(offset).toMatchObject({ transactionCode: '27', accountLast4: '4455' });
    expect(Number(offset.amountCents)).toBe(175050);

    const dl = await a.get(`/payroll-banking/files/${file.id}/download`);
    expect(dl.status).toBe(200);
    expect(validateNachaFile(dl.text)).toEqual({ ok: true });
    const l = lines(dl.text);
    expect(l[0]!.slice(3, 13)).toBe(' 063100688');
    expect(l[1]!.slice(0, 4)).toBe('5200'); // credits and the debit together
    expect(l.filter((x) => x.startsWith('622') || x.startsWith('632'))).toHaveLength(2);
    const debit = l.find((x) => x.startsWith('627'))!;
    expect(debit.slice(12, 29)).toBe('1122334455       ');
    expect(debit.slice(29, 39)).toBe('0000175050');
    expect(debit).toContain('ALTO HR');
    expect(dl.text).toContain('JANE DOE');
    expect((await a.get('/payroll-banking/files')).body.files[0]).toMatchObject({ status: 'DOWNLOADED', uploadable: true });

    // The guided close names the step.
    const close = await a.get(`/payroll/runs/${run.id}/close`);
    expect(close.body.bankFile).toMatchObject({ id: file.id, status: 'DOWNLOADED', entryCount: 3, totalCreditCents: 175050, format: 'BALANCED', bank: 'Capital City Bank' });
    const step = close.body.steps.find((s: { key: string }) => s.key === 'disburse');
    expect(step.state).toBe('current');
    expect(step.note).toMatch(/upload it in Capital City Bank’s portal, then mark it uploaded/);

    // A person says it reached the bank: now the paychecks read paid and the run settles.
    const up = await a.post(`/payroll-banking/files/${file.id}/uploaded`).send({});
    expect(up.status).toBe(200);
    expect(up.body).toMatchObject({ paid: 2, runsSettled: [run.id], already: false });
    const paid = await prisma.payrollItem.findMany({ where: { payrollRunId: run.id } });
    expect(paid.every((i) => i.status === 'DISBURSED' && i.disbursedAt !== null)).toBe(true);
    expect(await prisma.payrollDisbursementAttempt.count({ where: { provider: 'ACH', status: 'SUCCESS' } })).toBe(2);
    expect((await prisma.payrollRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('DISBURSED');
    expect((await prisma.achFile.findUniqueOrThrow({ where: { id: file.id } })).status).toBe('SUBMITTED');
    expect((await a.get('/payroll-banking/files')).body.files[0]).toMatchObject({ status: 'SUBMITTED', uploadable: false });

    // Marking it again changes nothing.
    const again = await a.post(`/payroll-banking/files/${file.id}/uploaded`).send({});
    expect(again.body).toMatchObject({ paid: 0, already: true });
    expect(await prisma.payrollDisbursementAttempt.count({ where: { provider: 'ACH', status: 'SUCCESS' } })).toBe(2);
    expect((await a.get(`/payroll/runs/${run.id}/close`)).body.steps.find((s: { key: string }) => s.key === 'disburse').state).toBe('done');
  });

  it('an unbalanced file carries the credits alone; a balanced file needs the verified company account; the go-live checklist says which', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);
    await ownAccountProfile(a);
    const run = await finalizedRun();
    expect((await a.post(`/payroll/runs/${run.id}/disburse`).send({})).status).toBe(200);
    const file = await prisma.achFile.findFirstOrThrow({ where: { purpose: 'DIRECT_DEPOSIT' } });
    expect(file.entryCount).toBe(2);
    expect(Number(file.totalDebitCents)).toBe(0);
    const dl = await a.get(`/payroll-banking/files/${file.id}/download`);
    expect(validateNachaFile(dl.text)).toEqual({ ok: true });
    expect(lines(dl.text)[1]!.slice(0, 4)).toBe('5220');
    expect(lines(dl.text).some((x) => x.startsWith('627'))).toBe(false);

    const goLive = await a.get('/payroll/go-live');
    const funding = (goLive.body.sections as Array<{ checks: Array<{ key: string; status: string; title: string; detail: string }> }>).flatMap((s) => s.checks).find((c) => c.key === 'funding')!;
    expect(funding.status).toBe('DONE');
    expect(funding.title).toBe('Company account at the bank');
    expect(funding.detail).toMatch(/drawn on your account at Capital City Bank/);

    // Balanced without a verified company account: every paycheck is held and the reason says so.
    await a.put('/payroll-banking/profile').send({ fileFormat: 'BALANCED' });
    const gaps = (await a.get('/payroll-banking/summary')).body.profile.gaps as string[];
    expect(gaps.some((g) => /balanced file debits/.test(g))).toBe(true);
    const run2 = await finalizedRun();
    expect((await a.post(`/payroll/runs/${run2.id}/disburse`).send({})).status).toBe(200);
    const held = await prisma.payrollItem.findMany({ where: { payrollRunId: run2.id } });
    expect(held.every((i) => i.status === 'HELD' && /balanced file debits/.test(i.failureReason ?? ''))).toBe(true);
  });

  it('a file nobody marked uploaded never settles on its own; a run cannot read paid twice', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);
    await ownAccountProfile(a);
    const run = await finalizedRun();
    await a.post(`/payroll/runs/${run.id}/disburse`).send({});
    const file = await prisma.achFile.findFirstOrThrow({ where: { purpose: 'DIRECT_DEPOSIT' } });
    // Pretend a week passed: the hourly sweep settles marked files only.
    const { markEntriesSettled } = await import('../../lib/banking/directDeposit.js');
    const { ALTO_TENANT_ID, runWithTenant } = await import('../../lib/tenant.js');
    const later = new Date(Date.now() + 10 * 86_400_000);
    expect(await runWithTenant(ALTO_TENANT_ID, 'job', () => markEntriesSettled(prisma, later))).toBe(0);
    expect((await prisma.achFile.findUniqueOrThrow({ where: { id: file.id } })).status).toBe('CREATED');
    expect((await prisma.payrollRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('FINALIZED');
    await a.post(`/payroll-banking/files/${file.id}/uploaded`).send({});
    expect(await runWithTenant(ALTO_TENANT_ID, 'job', () => markEntriesSettled(prisma, later))).toBe(2);
    expect((await prisma.achFile.findUniqueOrThrow({ where: { id: file.id } })).status).toBe('SETTLED');
  });
});
