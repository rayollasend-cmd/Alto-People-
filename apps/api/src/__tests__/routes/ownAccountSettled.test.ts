import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { encryptString } from '../../lib/crypto.js';
import { accountFingerprint } from '../../lib/financialChanges.js';
import { _setAdapterForTesting } from '../../lib/disbursement.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createUser, prisma, truncateAll, signOffRun } from '../../../test/db.js';

/**
 * System audit 2026-10-21, Tier 1 #2: a run paid on the company's own
 * account settles when a person marks the bank file uploaded. That path
 * must leave the same obligations as a run the bank partner settled at
 * once — the tax deposit, the tax liabilities and the garnishment
 * remittances — because the money left either way.
 */

const app = () => createApp();
const BANK = '063100688';
const ROUTING_A = '011000015';
const ROUTING_B = '091000019';

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${JSON.stringify(r.body)}`);
  return a;
}

async function ownAccountProfile(a: TestAgent<Test>) {
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
  });
  expect(r.status).toBe(200);
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

/** A finalized run with real withholding and a child-support order deducted on it. */
async function finalizedRunWithObligations() {
  const jane = await createAssociate({ firstName: 'Jane', lastName: 'Doe' });
  const ken = await createAssociate({ firstName: 'Ken', lastName: 'Ito' });
  await bankMethod(jane.id, ROUTING_A, '123456789');
  await bankMethod(ken.id, ROUTING_B, '987654321');
  const run = await prisma.payrollRun.create({
    data: { periodStart: new Date('2026-10-03'), periodEnd: new Date('2026-10-09'), status: 'FINALIZED', totalGross: 2000, totalTax: 564.3, totalNet: 1335.7, totalEmployerTax: 213 },
  });
  const item = (associateId: string, net: number) =>
    prisma.payrollItem.create({
      data: {
        payrollRunId: run.id,
        associateId,
        hoursWorked: 40,
        hourlyRate: 25,
        grossPay: 1000,
        federalWithholding: 120,
        fica: 62,
        medicare: 14.5,
        stateWithholding: 40,
        employerFica: 62,
        employerMedicare: 14.5,
        employerFuta: 6,
        employerSuta: 24,
        taxState: 'FL',
        netPay: net,
      },
    });
  await item(jane.id, 713.5);
  await item(ken.id, 622.2);
  const order = await prisma.garnishment.create({
    data: { associateId: jane.id, kind: 'CHILD_SUPPORT', agencyName: 'Florida SDU', remitTo: 'Florida State Disbursement Unit', amountPerRun: 150, startDate: new Date('2026-01-01') },
  });
  await prisma.garnishmentDeduction.create({ data: { garnishmentId: order.id, payrollRunId: run.id, amount: 150 } });
  await signOffRun(run.id);
  return run;
}

interface Obligations {
  deposit: { amount: number; kind: string } | null;
  liabilities: Array<{ kind: string; jurisdiction: string; amount: number }>;
  remittances: Array<{ payeeName: string; amount: number }>;
}

async function obligationsOf(runId: string): Promise<Obligations> {
  const [deposit, liabilities, remittances] = await Promise.all([
    prisma.taxDeposit.findUnique({ where: { payrollRunId: runId }, select: { amount: true, kind: true } }),
    prisma.taxLiability.findMany({ where: { payrollRunId: runId }, select: { kind: true, jurisdiction: true, amount: true }, orderBy: [{ kind: 'asc' }, { jurisdiction: 'asc' }] }),
    prisma.garnishmentRemittance.findMany({ where: { payrollRunId: runId }, select: { payeeName: true, amount: true }, orderBy: { payeeName: 'asc' } }),
  ]);
  return {
    deposit: deposit ? { amount: Number(deposit.amount), kind: deposit.kind } : null,
    liabilities: liabilities.map((l) => ({ kind: l.kind, jurisdiction: l.jurisdiction, amount: Number(l.amount) })),
    remittances: remittances.map((r) => ({ payeeName: r.payeeName, amount: Number(r.amount) })),
  };
}

/** The disburse route books obligations after it answers; wait for them. */
async function settledObligations(runId: string): Promise<Obligations> {
  for (let i = 0; i < 40; i++) {
    const o = await obligationsOf(runId);
    if (o.deposit && o.liabilities.length > 0 && o.remittances.length > 0) return o;
    await new Promise((r) => setTimeout(r, 50));
  }
  return obligationsOf(runId);
}

beforeEach(async () => {
  await truncateAll();
  _setAdapterForTesting(null);
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('a run settled by “Mark uploaded” owes what a provider-settled run owes', () => {
  it('accrues the tax deposit, posts the liabilities and creates the garnishment remittance on the own-account path', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);
    await ownAccountProfile(a);
    const run = await finalizedRunWithObligations();

    // Disburse writes the file; nothing is owed yet — no money has moved.
    expect((await a.post(`/payroll/runs/${run.id}/disburse`).send({})).status).toBe(200);
    expect((await prisma.payrollRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('FINALIZED');
    expect(await obligationsOf(run.id)).toEqual({ deposit: null, liabilities: [], remittances: [] });

    // The file reached the bank: the run settles and its obligations exist at once.
    const file = await prisma.achFile.findFirstOrThrow({ where: { purpose: 'DIRECT_DEPOSIT' } });
    const up = await a.post(`/payroll-banking/files/${file.id}/uploaded`).send({});
    expect(up.status).toBe(200);
    expect(up.body.runsSettled).toEqual([run.id]);
    expect((await prisma.payrollRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('DISBURSED');

    const own = await obligationsOf(run.id);
    // 941: FIT 240 + SS 124 + Medicare 29 + employer SS 124 + employer Medicare 29.
    expect(own.deposit).toEqual({ kind: 'FED_941', amount: 546 });
    expect(own.liabilities.length).toBeGreaterThan(0);
    expect(own.liabilities.reduce((s, l) => s + l.amount, 0)).toBeCloseTo(546 + 12 + 48 + 80, 2);
    expect(own.remittances).toEqual([{ payeeName: 'Florida State Disbursement Unit', amount: 150 }]);

    // Marking the file again changes nothing: the obligations are not doubled.
    await a.post(`/payroll-banking/files/${file.id}/uploaded`).send({});
    expect(await obligationsOf(run.id)).toEqual(own);
  });

  it('matches the all-success provider path exactly', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);

    // Provider path first: the default platform rail pays every item at once.
    const viaProvider = await finalizedRunWithObligations();
    expect((await a.post(`/payroll/runs/${viaProvider.id}/disburse`).send({})).body.status).toBe('DISBURSED');
    const provider = await settledObligations(viaProvider.id);

    // Own-account path, same people, same numbers.
    await truncateAll();
    const { user: u2 } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const b = await loginAs(u2.email);
    await ownAccountProfile(b);
    const viaFile = await finalizedRunWithObligations();
    await b.post(`/payroll/runs/${viaFile.id}/disburse`).send({});
    const file = await prisma.achFile.findFirstOrThrow({ where: { purpose: 'DIRECT_DEPOSIT' } });
    await b.post(`/payroll-banking/files/${file.id}/uploaded`).send({});
    const own = await obligationsOf(viaFile.id);

    expect(own).toEqual(provider);
    expect(own.deposit).not.toBeNull();
    expect(own.remittances).toHaveLength(1);
  });
});
