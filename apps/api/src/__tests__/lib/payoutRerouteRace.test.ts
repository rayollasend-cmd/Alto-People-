import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { encryptString } from '../../lib/crypto.js';
import { accountFingerprint } from '../../lib/financialChanges.js';
import { _setAdapterForTesting, type DisbursementAdapter, type DisbursementInput } from '../../lib/disbursement.js';
import { rerouteReturnedItem } from '../../lib/payoutReroute.js';
import { ALTO_TENANT_ID, runWithTenant } from '../../lib/tenant.js';
import { createAssociate, prisma, truncateAll } from '../../../test/db.js';

/**
 * Deep audit 2026-10-29, claim-then-act: a returned deposit is re-sent ONCE.
 * The bank's return webhook, its retry and a person pressing "Returned" can
 * arrive together; each used to find reroutedAt empty and pay again.
 */

const calls: DisbursementInput[] = [];
const slowRail: DisbursementAdapter = {
  provider: 'STUB',
  async disburse(input) {
    calls.push(input);
    await new Promise((r) => setTimeout(r, 150));
    return { provider: 'STUB', externalRef: `stub-${calls.length}`, status: 'SUCCESS', failureReason: null };
  },
} as DisbursementAdapter;

async function returnedPaycheck() {
  const p = await createAssociate({ firstName: 'Lena', lastName: 'Ortiz' });
  const bank = (routing: string, account: string, primary: boolean, verifiedAt: Date) =>
    prisma.payoutMethod.create({
      data: { associateId: p.id, type: 'BANK_ACCOUNT', routingNumberEnc: Buffer.from(routing, 'utf8'), accountNumberEnc: encryptString(account), accountType: 'CHECKING', isPrimary: primary, verifiedAt, accountLast4: account.slice(-4), accountFingerprint: accountFingerprint(routing, account) },
    });
  await bank('011000015', '123456789', true, new Date('2026-09-01T00:00:00Z'));
  await bank('091000019', '555666777', false, new Date('2026-08-01T00:00:00Z'));
  const run = await prisma.payrollRun.create({ data: { periodStart: new Date('2026-10-10'), periodEnd: new Date('2026-10-23'), status: 'DISBURSED', disbursedAt: new Date('2026-10-30T12:00:00Z') } });
  return prisma.payrollItem.create({ data: { payrollRunId: run.id, associateId: p.id, hoursWorked: 40, hourlyRate: 20, grossPay: 800, federalWithholding: 0, netPay: 700, status: 'DISBURSED', disbursedAt: new Date('2026-10-30T12:00:00Z') } });
}

beforeEach(async () => {
  await truncateAll();
  calls.length = 0;
  _setAdapterForTesting(slowRail);
});
afterAll(async () => {
  _setAdapterForTesting(null);
  await prisma.$disconnect();
});

describe('a returned deposit is re-sent once', () => {
  it('three returns at once (webhook, retry, a person): one re-send', async () => {
    const item = await returnedPaycheck();
    const go = () => runWithTenant(ALTO_TENANT_ID, 'job', () => rerouteReturnedItem(prisma, { payrollItemId: item.id, reason: 'R01', actorUserId: null }));
    const outcomes = await Promise.all([go(), go(), go()]);
    expect(calls).toHaveLength(1);
    // The winner re-sent it; the others were told it is already being re-sent.
    expect(outcomes.filter((o) => o.outcome === 'rerouted')).toHaveLength(1);
    expect(outcomes.filter((o) => o.outcome === 'held' && o.reason === 'already_rerouted')).toHaveLength(2);
    const after = await prisma.payrollItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.status).toBe('DISBURSED');
    expect(after.reroutedAt).not.toBeNull();
  });

  it('a re-send that fails gives the claim back', async () => {
    const item = await returnedPaycheck();
    _setAdapterForTesting({ provider: 'STUB', disburse: async () => ({ provider: 'STUB', externalRef: '', status: 'FAILED', failureReason: 'rail down' }) } as DisbursementAdapter);
    const out = await runWithTenant(ALTO_TENANT_ID, 'job', () => rerouteReturnedItem(prisma, { payrollItemId: item.id, reason: 'R01', actorUserId: null }));
    expect(out.outcome).toBe('held');
    const after = await prisma.payrollItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after).toMatchObject({ status: 'HELD', reroutedAt: null });
  });
});
