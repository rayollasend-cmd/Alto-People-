import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PayrollGoLive } from '@alto-people/shared';
import { createAssociate, createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';
import { encryptString } from '../../lib/crypto.js';

/**
 * Running payroll in-house: the company checklist reads the site's own
 * records — a fresh company is all gaps with where to fix each; filled in,
 * it says ready. Payroll people only.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const check = (r: PayrollGoLive, key: string) => r.sections.flatMap((s) => s.checks).find((c) => c.key === key);

describe('GET /payroll/go-live', () => {
  it('a fresh company is a list of what to set up, each with where to fix it', async () => {
    const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const a = await createAssociate({ firstName: 'Ana', lastName: 'Reyes' });
    await prisma.associate.update({ where: { id: a.id }, data: { state: 'NJ' } });
    const res = await (await loginAs(agent(), user.email)).get('/payroll/go-live');
    expect(res.status).toBe(200);
    const r = res.body as PayrollGoLive;
    expect(r.ready).toBe(false);
    expect(r.states).toEqual(['NJ']);
    expect(check(r, 'employer')).toMatchObject({ status: 'MISSING', fix: { to: '/admin/employers' } });
    expect(check(r, 'federal-withholding')).toMatchObject({ status: 'MISSING', fix: { to: '/payroll/taxes?tab=agencies' } });
    expect(check(r, 'state-NJ')!.status).toBe('MISSING');
    expect(check(r, 'state-NJ')!.detail).toMatch(/^No state withholding account; no state unemployment account/);
    expect(check(r, 'schedules')!.status).toBe('MISSING');
    // Only one person can run payroll: the second-person checks have nobody to decide.
    expect(check(r, 'two-people')!.status).toBe('MISSING');
    expect(check(r, 'filing')!.status).toBe('INFO');
    expect(check(r, 'quickbooks')!.status).toBe('INFO');
    expect(r.missing).toBeGreaterThan(5);
  });

  it('a company with everything on file is ready to run payroll in-house', async () => {
    const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    await createUser({ role: 'HR_ADMINISTRATOR' });
    await prisma.employerOrganization.create({
      data: { kind: 'TENANT', legalName: 'Coastal Staffing LLC', ein: '12-3456789', addressLine1: '1 Gulf Blvd', city: 'Panama City Beach', state: 'FL', zip: '32413', wcCarrierName: 'Gulf Mutual', wcPolicyNumber: 'WC-1', isDefault: true },
    });
    const year = new Date().getUTCFullYear();
    await prisma.taxAgencyAccount.createMany({
      data: [
        { kind: 'FEDERAL_WITHHOLDING', jurisdiction: 'US', agencyName: 'IRS', depositFrequency: 'SEMIWEEKLY', status: 'ACTIVE' },
        { kind: 'FEDERAL_UNEMPLOYMENT', jurisdiction: 'US', agencyName: 'IRS', status: 'ACTIVE' },
        { kind: 'STATE_UNEMPLOYMENT', jurisdiction: 'FL', agencyName: 'Florida DOR', status: 'ACTIVE', rate: 0.027, rateYear: year },
      ],
    });
    const schedule = await prisma.payrollSchedule.create({ data: { name: 'Weekly', frequency: 'WEEKLY', anchorDate: new Date('2026-10-03'), payDateOffsetDays: 7, isDefault: true } });
    const a = await createAssociate({ firstName: 'Ana', lastName: 'Reyes' });
    await prisma.associate.update({ where: { id: a.id }, data: { state: 'FL', payrollScheduleId: schedule.id } });
    await prisma.w4Submission.create({ data: { associateId: a.id, filingStatus: 'SINGLE', ssnEncrypted: encryptString('123456789'), signedAt: new Date() } });
    await prisma.payoutMethod.create({ data: { associateId: a.id, isPrimary: true, type: 'BANK_ACCOUNT', accountNumberEnc: encryptString('123456789'), routingNumberEnc: encryptString('063100277'), accountType: 'CHECKING' } });
    const funding = await prisma.employerBankAccount.create({ data: { label: 'Payroll', bankName: 'First Coast Bank', routingNumber: '063100277', accountNumberEnc: encryptString('4455667788'), accountLast4: '7788', status: 'VERIFIED' } });
    await prisma.payrollBankingProfile.create({
      data: { bankRail: 'ACH', companyName: 'COASTAL STAFFING', companyId: '1123456789', immediateDestination: '063100277', immediateOrigin: '1123456789', originatingDfi: '06310027', kybStatus: 'APPROVED', perRunLimitCents: 50_000_000n, fundingAccountId: funding.id },
    });

    const res = await (await loginAs(agent(), user.email)).get('/payroll/go-live');
    expect(res.status).toBe(200);
    const r = res.body as PayrollGoLive;
    const notDone = r.sections.flatMap((s) => s.checks).filter((c) => c.status === 'MISSING');
    expect(notDone).toEqual([]);
    expect(r.ready).toBe(true);
    expect(check(r, 'state-FL')).toMatchObject({ status: 'DONE' });
    expect(check(r, 'state-FL')!.detail).toMatch(/No state income tax; unemployment 2\.70%/);
    expect(check(r, 'ach')!.status).toBe('DONE');
    expect(check(r, 'funding')!.status).toBe('DONE');
    expect(check(r, 'two-people')!.status).toBe('DONE');
  });

  it('is for people who run payroll', async () => {
    const { user: exec } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
    const { user: driver } = await createUser({ role: 'DRIVER' });
    expect((await (await loginAs(agent(), exec.email)).get('/payroll/go-live')).status).toBe(403);
    expect((await (await loginAs(agent(), driver.email)).get('/payroll/go-live')).status).toBe(403);
    expect((await agent().get('/payroll/go-live')).status).toBe(401);
  });
});
