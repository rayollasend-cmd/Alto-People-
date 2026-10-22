import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { buildAcaAirXml } from '../../lib/acaAir.js';
import { build940Xml, build941Xml } from '../../lib/irsMef.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * Filing files and the ledger split: 1095-C PDFs and the AIR file, the
 * 941/940 MeF returns, "mark filed" with the acknowledgment, and GL by
 * cost center.
 */

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
  if (r.status !== 200) throw new Error(`loginAs failed: ${r.status}`);
  return a;
}

const filer = { ein: '12-3456789', name: 'Alto Staffing LLC', addressLine1: '1 Harbor Way', city: 'Panama City', state: 'FL', zip: '32401', contactName: 'Dana Reyes', contactPhone: '850-555-0101' };

describe('the files', () => {
  it('builds a 941 and a 940 in MeF shape', () => {
    const x = build941Xml({ taxYear: 2026, quarter: 2, filer, amounts: { employeeCount: 12, totalWages: '48000.00', totalFederalWithheld: '5200.00', ficaMedicareWages: '48000.00', depositsMade: '12000.00' }, generatedAt: new Date('2026-07-01T00:00:00Z') });
    expect(x).toContain('<ReturnTypeCd>941</ReturnTypeCd>');
    expect(x).toContain('<EIN>123456789</EIN>');
    expect(x).toContain('<TaxPeriodBeginDt>2026-04-01</TaxPeriodBeginDt>');
    expect(x).toContain('<TaxPeriodEndDt>2026-06-30</TaxPeriodEndDt>');
    expect(x).toContain('<SocialSecurityTaxAmt>5952.00</SocialSecurityTaxAmt>');
    const y = build940Xml({ taxYear: 2026, filer, amounts: { totalPayments: '100000.00', exemptPayments: '0.00', excessPayments: '58000.00', futaTaxableWages: '42000.00', futaTaxNet: '252.00', depositsMade: '252.00', balanceDue: '0.00' }, generatedAt: new Date('2027-01-15T00:00:00Z') });
    expect(y).toContain('<IRS940 documentId="IRS940-1">');
    expect(y).toContain('<TotalTaxableWagesAmt>42000.00</TotalTaxableWagesAmt>');
  });

  it('builds the AIR transmission with the annual shortcut when the months agree', () => {
    const months = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, offerOfCoverage: 'CODE_1E', lowestPremiumCents: 12000, safeHarbor: '2C', isFullTime: true }));
    const x = buildAcaAirXml({
      taxYear: 2025,
      employer: { ...filer },
      employees: [{ recordId: 1, firstName: 'Ana', lastName: "O'Neil", ssn: '123-45-6789', dob: '1990-02-03', addressLine1: '2 Bay St', city: 'Destin', state: 'FL', zip: '32541', months }],
      fullTimeByMonth: Array(12).fill(1),
      totalByMonth: Array(12).fill(1),
      generatedAt: new Date('2026-02-01T00:00:00Z'),
    });
    expect(x).toContain('<AnnualOfferOfCoverageCd>1E</AnnualOfferOfCoverageCd>');
    expect(x).toContain('<AnnualContributionAmt>120.00</AnnualContributionAmt>');
    expect(x).toContain('<AnnualSafeHarborCd>2C</AnnualSafeHarborCd>');
    expect(x).toContain('<SSN>123456789</SSN>');
    expect(x).toContain('<PersonNameControlTxt>ONEI</PersonNameControlTxt>');
    expect(x).toContain("O&apos;Neil".replace('&apos;', "'"));
  });
});

describe('1095-C and marking filed', () => {
  it('generates the forms from ACA months, renders a PDF, builds the AIR file, and records the acknowledgment', async () => {
    const a = await createAssociate({ firstName: 'Ana', lastName: 'Ruiz' });
    for (let m = 1; m <= 12; m++) {
      await prisma.acaMonth.create({ data: { associateId: a.id, year: 2025, month: m, offerOfCoverage: 'CODE_1A', lowestPremiumCents: 0, safeHarbor: null, isFullTime: m > 2 } });
    }
    const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const agent = await loginAs(user.email);
    const gen = await agent.post('/aca/1095c/generate').send({ year: 2025 });
    expect(gen.status).toBe(200);
    expect(gen.body).toMatchObject({ created: 1, skipped: 0, employees: 1 });
    expect((await agent.post('/aca/1095c/generate').send({ year: 2025 })).body.skipped).toBe(1);
    const forms = await prisma.taxForm.findMany({ where: { taxYear: 2025 } });
    expect(forms.map((f) => f.kind).sort()).toEqual(['F1094C', 'F1095C']);
    const f1095 = forms.find((f) => f.kind === 'F1095C')!;
    const pdf = await agent.get(`/aca/1095c/${f1095.id}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    const air = await agent.get('/aca/air.xml?year=2025');
    expect(air.status).toBe(200);
    expect(air.text).toContain('<Form1095CAttachedCnt>1</Form1095CAttachedCnt>');
    expect(air.text).toContain('<MarchALEMonthlyInfoGrp>');

    const filed = await agent.post(`/tax-forms/${f1095.id}/file`).send({ confirmationNumber: 'AIR-1095C-2025-00042' });
    expect(filed.status).toBe(200);
    const row = await prisma.taxForm.findUniqueOrThrow({ where: { id: f1095.id } });
    expect(row.status).toBe('FILED');
    expect(row.filingConfirmation).toBe('AIR-1095C-2025-00042');
    const list = await agent.get('/tax-forms?taxYear=2025');
    expect(list.body.forms.find((f: { id: string }) => f.id === f1095.id).filingConfirmation).toBe('AIR-1095C-2025-00042');
  });

  it('serves the MeF return for a 941 once the submitter profile exists', async () => {
    const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const agent = await loginAs(user.email);
    const form = await prisma.taxForm.create({ data: { kind: 'F941', taxYear: 2026, quarter: 1, amounts: { employeeCount: 3, totalWages: '9000.00', totalFederalWithheld: '900.00', ficaMedicareWages: '9000.00' }, status: 'DRAFT' } });
    expect((await agent.get(`/tax-forms/${form.id}/mef.xml`)).status).toBe(409);
    await prisma.submitterProfile.create({
      data: { id: 'singleton', ein: '123456789', userId: 'BSO12345', name: 'Alto Staffing LLC', addressLine1: '1 Harbor Way', city: 'Panama City', state: 'FL', zip5: '32401', contactName: 'Dana Reyes', contactPhone: '8505550101', contactEmail: 'dana@example.com' },
    });
    const r = await agent.get(`/tax-forms/${form.id}/mef.xml`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('xml');
    expect(r.text).toContain('<IRS941 documentId="IRS941-1">');
    expect(r.text).toContain('<WagesAmt>9000.00</WagesAmt>');
  });
});
