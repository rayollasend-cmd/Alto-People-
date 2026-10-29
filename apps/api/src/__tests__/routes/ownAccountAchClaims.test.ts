import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { encryptString } from '../../lib/crypto.js';
import { accountFingerprint } from '../../lib/financialChanges.js';
import { _setAdapterForTesting } from '../../lib/disbursement.js';
import { AchRailAdapter } from '../../lib/banking/directDeposit.js';
import { ALTO_TENANT_ID, runWithTenant } from '../../lib/tenant.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createUser, prisma, truncateAll, signOffRun } from '../../../test/db.js';

/**
 * Deep audit 2026-10-29, CODE-3 / CODE-21 — claim-then-act on our own ACH.
 * Drawn on the company's own account with no bank partner, Disburse writes
 * a NACHA file and the paychecks wait (PENDING) for "mark uploaded". A
 * second Disburse used to write a SECOND file with the same paychecks; a
 * retry of held paychecks marked them paid before any file was uploaded.
 * Now: one payer at a time, no second file while one waits, and a retry
 * waits for the upload like Disburse does.
 */

const app = () => createApp();
const BANK = '063100688';

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
}

async function finalizedRun() {
  const jane = await createAssociate({ firstName: 'Jane', lastName: 'Doe' });
  const ken = await createAssociate({ firstName: 'Ken', lastName: 'Ito' });
  for (const [p, routing, account] of [[jane, '011000015', '123456789'], [ken, '091000019', '987654321']] as const) {
    await prisma.payoutMethod.create({
      data: {
        associateId: p.id,
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
  const run = await prisma.payrollRun.create({
    data: { periodStart: new Date('2026-10-03'), periodEnd: new Date('2026-10-09'), status: 'FINALIZED', totalGross: 2000, totalTax: 249.5, totalNet: 1750.5, totalEmployerTax: 120 },
  });
  for (const [p, net] of [[jane, 1250.5], [ken, 500]] as const) {
    await prisma.payrollItem.create({ data: { payrollRunId: run.id, associateId: p.id, hoursWorked: 40, hourlyRate: 25, grossPay: 1000, federalWithholding: 0, netPay: net } });
  }
  await signOffRun(run.id);
  return run;
}

const ddFiles = () => prisma.achFile.count({ where: { purpose: 'DIRECT_DEPOSIT' } });
const credits = () => prisma.achEntry.count({ where: { kind: 'CREDIT' } });

beforeEach(async () => {
  await truncateAll();
  _setAdapterForTesting(null);
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('own-account ACH: paid once', () => {
  it('Disburse twice writes one bank file; the second answers "waiting for the bank upload"', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);
    await ownAccountProfile(a);
    const run = await finalizedRun();
    const first = await a.post(`/payroll/runs/${run.id}/disburse`).send({});
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('FINALIZED');
    // The answer says what it waits on, so the screen never reads "Run disbursed" when nothing moved.
    expect(first.body.nextStep?.key).toBe('uploadFile');
    const second = await a.post(`/payroll/runs/${run.id}/disburse`).send({});
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('awaiting_bank_upload');
    expect(await ddFiles()).toBe(1);
    expect(await credits()).toBe(2);
    // The run's next step names the upload (the web shows it in place of Disburse).
    const runs = await a.get('/payroll/runs');
    const row = (runs.body.runs ?? runs.body).find((r: { id: string }) => r.id === run.id);
    expect(row.nextStep?.key).toBe('uploadFile');
    // Once marked uploaded, everything is paid — once.
    const file = await prisma.achFile.findFirstOrThrow({ where: { purpose: 'DIRECT_DEPOSIT' } });
    expect((await a.post(`/payroll-banking/files/${file.id}/uploaded`).send({})).body).toMatchObject({ paid: 2 });
    expect((await prisma.payrollRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('DISBURSED');
    expect((await a.post(`/payroll/runs/${run.id}/disburse`).send({})).status).toBe(409);
    expect(await ddFiles()).toBe(1);
  });

  it('two Disburse requests at once (two tabs, different keys): one pays, one is refused, one file', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);
    await ownAccountProfile(a);
    const run = await finalizedRun();
    const [x, y] = await Promise.all([
      a.post(`/payroll/runs/${run.id}/disburse`).set('Idempotency-Key', 'tab-1').send({}),
      a.post(`/payroll/runs/${run.id}/disburse`).set('Idempotency-Key', 'tab-2').send({}),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    const refused = x.status === 409 ? x : y;
    expect(['disburse_in_progress', 'awaiting_bank_upload']).toContain(refused.body.error.code);
    expect(await ddFiles()).toBe(1);
    expect(await credits()).toBe(2);
    // The claim is released when the winner finishes.
    expect((await prisma.payrollRun.findUniqueOrThrow({ where: { id: run.id } })).disburseClaimedAt).toBeNull();
  });

  it('a retry of held paychecks waits for "mark uploaded" like Disburse — never paid before money moves (CODE-21)', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);
    // Balanced with no verified company account: the file can't be written, every paycheck is held.
    await ownAccountProfile(a, { fileFormat: 'BALANCED' });
    const run = await finalizedRun();
    expect((await a.post(`/payroll/runs/${run.id}/disburse`).send({})).status).toBe(200);
    expect((await prisma.payrollItem.findMany({ where: { payrollRunId: run.id } })).every((i) => i.status === 'HELD')).toBe(true);
    expect(await ddFiles()).toBe(0);

    await a.put('/payroll-banking/profile').send({ fileFormat: 'UNBALANCED' });
    const retry = await a.post(`/payroll/runs/${run.id}/retry-failures`).send({});
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ retried: 2, succeeded: 0, awaitingBankUpload: 2 });
    const items = await prisma.payrollItem.findMany({ where: { payrollRunId: run.id } });
    expect(items.every((i) => i.status === 'PENDING' && i.disbursedAt === null)).toBe(true);
    expect((await prisma.payrollRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('FINALIZED');
    expect(await ddFiles()).toBe(1);
    // A second retry finds nothing held: no second file.
    expect((await a.post(`/payroll/runs/${run.id}/retry-failures`).send({})).body).toMatchObject({ retried: 0 });
    expect(await ddFiles()).toBe(1);
    const file = await prisma.achFile.findFirstOrThrow({ where: { purpose: 'DIRECT_DEPOSIT' } });
    expect((await a.post(`/payroll-banking/files/${file.id}/uploaded`).send({})).body).toMatchObject({ paid: 2, runsSettled: [run.id] });
  });

  it('two retries at once write one file', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);
    await ownAccountProfile(a, { fileFormat: 'BALANCED' });
    const run = await finalizedRun();
    await a.post(`/payroll/runs/${run.id}/disburse`).send({});
    await a.put('/payroll-banking/profile').send({ fileFormat: 'UNBALANCED' });
    const [x, y] = await Promise.all([
      a.post(`/payroll/runs/${run.id}/retry-failures`).set('Idempotency-Key', 'r-1').send({}),
      a.post(`/payroll/runs/${run.id}/retry-failures`).set('Idempotency-Key', 'r-2').send({}),
    ]);
    expect([x.status, y.status]).toContain(200);
    expect(await ddFiles()).toBe(1);
    expect(await credits()).toBe(2);
  });

  it('the rail never writes a paycheck into a second live file, even asked directly', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);
    await ownAccountProfile(a);
    const run = await finalizedRun();
    await a.post(`/payroll/runs/${run.id}/disburse`).send({});
    const item = await prisma.payrollItem.findFirstOrThrow({ where: { payrollRunId: run.id, netPay: 500 } });
    const out = await runWithTenant(ALTO_TENANT_ID, 'job', () =>
      new AchRailAdapter(prisma, false, null).disburse({
        amount: 500,
        currency: 'USD',
        recipient: { associateId: item.associateId, fullName: 'Ken Ito', routingNumber: '091000019', accountNumber: '987654321', accountType: 'CHECKING' } as never,
        idempotencyKey: item.id,
        memo: 'retry',
      }),
    );
    expect(out.status).toBe('PENDING');
    expect(await ddFiles()).toBe(1);
    // And the database refuses a second live credit for the same paycheck and account.
    const entry = await prisma.achEntry.findFirstOrThrow({ where: { payrollItemId: item.id } });
    await expect(
      prisma.achEntry.create({ data: { achFileId: entry.achFileId, traceNumber: '063100689999999', kind: 'CREDIT', transactionCode: '22', amountCents: BigInt(50000), payrollItemId: item.id, payoutMethodId: entry.payoutMethodId, individualName: 'KEN ITO', accountLast4: '4321' } }),
    ).rejects.toThrow();
  });
});
