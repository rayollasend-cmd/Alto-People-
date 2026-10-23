import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { encryptString } from '../../lib/crypto.js';
import { fileContent } from '../../lib/banking/ach.js';
import { validateNachaFile } from '../../lib/banking/nacha.js';
import { accrueRemittancesForRun } from '../../lib/garnishmentRemittance.js';
import { sealPayeeBank } from '../../lib/garnishmentRemit.js';
import { segmentsOf } from '../../lib/edi834.js';
import { aggregatePayrollProjection } from '../../lib/payrollAggregator.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

const app = () => createApp();

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${JSON.stringify(r.body)}`);
  return a;
}

async function admin() {
  const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
  return { user, a: await loginAs(user.email) };
}

/** A person with a W-4 holding their full SSN. */
async function person(first: string, last: string, ssn: string, extra: Record<string, unknown> = {}) {
  const p = await createAssociate({ firstName: first, lastName: last });
  await prisma.associate.update({ where: { id: p.id }, data: { ssnLast4: ssn.slice(-4), dob: new Date('1985-03-04'), hireDate: new Date('2024-01-10'), employmentType: 'W2_EMPLOYEE', addressLine1: '5 Elm St', city: 'Austin', state: 'TX', zip: '78701', ...extra } });
  await prisma.w4Submission.create({ data: { associateId: p.id, filingStatus: 'SINGLE', ssnEncrypted: encryptString(ssn) } });
  return p;
}

const EIWO = (caseId: string, ssn: string, last: string, action = 'ORG', extra = '') => `<?xml version="1.0"?>
<IWOTransmission>
  <IWODocument>
    <DocumentActionCode>${action}</DocumentActionCode>
    <CaseIdentifier>${caseId}</CaseIdentifier>
    <OrderIdentifier>ORD-${caseId}</OrderIdentifier>
    <RemittanceIdentifier>RID-${caseId}</RemittanceIdentifier>
    <IssuingStateTribeTerritory>TX</IssuingStateTribeTerritory>
    <IssuingJurisdictionFIPSCode>48000</IssuingJurisdictionFIPSCode>
    <EmployeeFirstName>Maria</EmployeeFirstName>
    <EmployeeLastName>${last}</EmployeeLastName>
    <EmployeeSSN>${ssn}</EmployeeSSN>
    <CurrentChildSupportAmount>400.00</CurrentChildSupportAmount>
    <PastDueChildSupportAmount>50.00</PastDueChildSupportAmount>
    <CurrentSupportFrequency>M</CurrentSupportFrequency>
    <SDUName>Texas State Disbursement Unit</SDUName>
    ${extra}
  </IWODocument>
</IWOTransmission>`;

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('garnishment desk: e-IWO intake', () => {
  it('reads the file, matches the employee by full SSN, accepts into an order and writes the acknowledgment', async () => {
    const { a } = await admin();
    const maria = await person('Maria', 'Lopez', '123456789');
    const up = await a.post('/garnishment-desk/eiwo').send({ xml: EIWO('CS100', '123-45-6789', 'Lopez') });
    expect(up.status).toBe(201);
    const doc = up.body.documents[0];
    expect(doc.associateId).toBe(maria.id);
    expect(doc.employeeSsnLast4).toBe('6789');
    expect(JSON.stringify(doc)).not.toContain('123456789');
    // The raw file is kept encrypted.
    const row = await prisma.eiwoDocument.findUniqueOrThrow({ where: { id: doc.id } });
    expect(row.rawContent).not.toContain('<IWODocument>');

    const ok = await a.post(`/garnishment-desk/eiwo/${doc.id}/accept`).send({ remitMethod: 'EFT_SDU' });
    expect(ok.status).toBe(200);
    const g = await prisma.garnishment.findUniqueOrThrow({ where: { id: ok.body.garnishmentId } });
    expect(g).toMatchObject({ source: 'EIWO', kind: 'CHILD_SUPPORT', caseNumber: 'CS100', orderIdentifier: 'ORD-CS100', remittanceIdentifier: 'RID-CS100', state: 'TX', fipsCode: '48000', orderFrequency: 'MONTHLY', remitMethod: 'EFT_SDU', remitTo: 'Texas State Disbursement Unit' });
    expect(Number(g.currentSupport)).toBe(400);
    expect(Number(g.pastDueSupport)).toBe(50);

    const ack = await a.get(`/garnishment-desk/eiwo/${doc.id}/ack.xml`);
    expect(ack.status).toBe(200);
    expect(ack.text).toContain('<DispositionStatusCode>A</DispositionStatusCode>');
    expect(ack.text).toContain('<EmployeeSSN>123456789</EmployeeSSN>');

    // A second original for the same case is a duplicate; an amendment updates the order.
    const dup = await a.post('/garnishment-desk/eiwo').send({ xml: EIWO('CS100', '123456789', 'Lopez') });
    expect((await a.post(`/garnishment-desk/eiwo/${dup.body.documents[0].id}/accept`).send({})).status).toBe(409);
    const amd = await a.post('/garnishment-desk/eiwo').send({ xml: EIWO('CS100', '123456789', 'Lopez', 'AMD').replace('400.00', '300.00') });
    expect((await a.post(`/garnishment-desk/eiwo/${amd.body.documents[0].id}/accept`).send({})).status).toBe(200);
    expect(Number((await prisma.garnishment.findUniqueOrThrow({ where: { id: g.id } })).currentSupport)).toBe(300);
    // A termination ends it.
    const trm = await a.post('/garnishment-desk/eiwo').send({ xml: EIWO('CS100', '123456789', 'Lopez', 'TRM') });
    expect((await a.post(`/garnishment-desk/eiwo/${trm.body.documents[0].id}/accept`).send({})).status).toBe(200);
    expect((await prisma.garnishment.findUniqueOrThrow({ where: { id: g.id } })).status).toBe('TERMINATED');
  });

  it('rejects with a reason code, refuses an unreadable file, and leaves no one else’s documents visible', async () => {
    const { a } = await admin();
    const bad = await a.post('/garnishment-desk/eiwo').send({ xml: '<IWO><CaseIdentifier>x</IWO>' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/not a readable e-IWO/);

    const up = await a.post('/garnishment-desk/eiwo').send({ xml: EIWO('CS200', '555443333', 'Nobody') });
    const doc = up.body.documents[0];
    expect(doc.associateId).toBeNull();
    expect((await a.post(`/garnishment-desk/eiwo/${doc.id}/accept`).send({})).status).toBe(400);
    expect((await a.post(`/garnishment-desk/eiwo/${doc.id}/reject`).send({ reasonCode: 'O' })).status).toBe(400);
    const no = await a.post(`/garnishment-desk/eiwo/${doc.id}/reject`).send({ reasonCode: 'N' });
    expect(no.status).toBe(200);
    expect(no.body.document.status).toBe('REJECTED');
    const ack = await a.get(`/garnishment-desk/eiwo/${doc.id}/ack.xml`);
    expect(ack.text).toContain('<DispositionStatusCode>R</DispositionStatusCode>');
    expect(ack.text).toContain('<DispositionReasonCode>N</DispositionReasonCode>');
    expect((await a.post(`/garnishment-desk/eiwo/${doc.id}/accept`).send({})).status).toBe(409);

    // An associate cannot reach the desk.
    const p = await createAssociate();
    const { user: worker } = await createUser({ role: 'ASSOCIATE', associateId: p.id });
    expect((await (await loginAs(worker.email)).get('/garnishment-desk/eiwo')).status).toBe(403);
  });
});

describe('garnishment desk: rules, notices, payee bank and electronic remittance', () => {
  it('state rules and levy figures save per tenant; the desk shows balance, next remittance and status', async () => {
    const { a } = await admin();
    expect((await a.put('/garnishment-desk/state-rules/tx').send({ allocationMethod: 'FIRST_IN_TIME', adminFeeMax: 2, adminFeeFrequency: 'MONTHLY' })).body.rule).toMatchObject({ state: 'TX', allocationMethod: 'FIRST_IN_TIME', adminFeeMax: 2 });
    expect((await a.put('/garnishment-desk/state-rules/TX').send({ allocationMethod: 'PRO_RATA' })).body.rule.allocationMethod).toBe('PRO_RATA');
    expect((await a.put('/garnishment-desk/state-rules/CA').send({ allocationMethod: 'PRO_RATA', creditorMaxPercent: 0.5 })).status).toBe(400);
    const lev = await a.put('/garnishment-desk/levy-parameters').send({ taxYear: 2026, filingStatus: 'SINGLE', standardDeduction: 15000, additionalStandardDeduction: 2000, exemptionAmount: 5000, source: 'Pub 1494 (2026)' });
    expect(lev.status).toBe(200);

    const p = await person('Ann', 'Lee', '111223333');
    const g = await prisma.garnishment.create({ data: { associateId: p.id, kind: 'CREDITOR', amountPerRun: 100, totalCap: 1000, amountWithheld: 300, startDate: new Date('2026-01-01'), remitTo: 'Acme Collections' } });
    const run = await prisma.payrollRun.create({ data: { periodStart: new Date('2026-10-03'), periodEnd: new Date('2026-10-09'), status: 'DISBURSED' } });
    await prisma.garnishmentDeduction.create({ data: { garnishmentId: g.id, payrollRunId: run.id, amount: 100 } });
    await accrueRemittancesForRun(prisma, run.id);

    const desk = await a.get('/garnishment-desk');
    expect(desk.status).toBe(200);
    const o = desk.body.orders.find((x: { id: string }) => x.id === g.id);
    expect(o.remainingBalance).toBe(700);
    expect(o.status).toBe('ACTIVE');
    expect(o.nextRemittance).toMatchObject({ amount: 100, payee: 'Acme Collections' });
    expect(o.nextRemittance.dueBy).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(desk.body.totals.remittancesPending).toBe(1);
    expect(desk.body.levyYears).toEqual([2026]);
  });

  it('a payee bank change waits for a second person, then remittance goes out as CCD+ with the DED addenda', async () => {
    const { a } = await admin();
    const { a: b } = await admin();
    const p = await person('Maria', 'Lopez', '123456789');
    const g = await prisma.garnishment.create({
      data: { associateId: p.id, kind: 'CHILD_SUPPORT', caseNumber: 'CS777', remittanceIdentifier: 'RID777', fipsCode: '48000', currentSupport: 400, orderFrequency: 'MONTHLY', startDate: new Date('2026-01-01'), remitTo: 'Texas SDU', remitMethod: 'EFT_SDU' },
    });
    const req = await a.post(`/garnishment-desk/orders/${g.id}/payee-bank`).send({ routingNumber: '011000015', accountNumber: '99887766' });
    expect(req.status).toBe(202);
    expect((await prisma.garnishment.findUniqueOrThrow({ where: { id: g.id } })).payeeAccountEnc).toBeNull();
    expect((await a.post(`/approvals/requests/${req.body.approvalId}/decide`).send({ decision: 'APPROVE' })).status).toBeGreaterThanOrEqual(400);
    const decided = await b.post(`/approvals/requests/${req.body.approvalId}/decide`).send({ decision: 'APPROVE' });
    expect(decided.status).toBe(200);
    const after = await prisma.garnishment.findUniqueOrThrow({ where: { id: g.id } });
    expect(after.payeeAccountLast4).toBe('7766');
    expect(after.payeeAccountEnc).not.toContain('99887766');

    // Payroll banking set up for our own ACH (MONEY's profile).
    expect((await a.put('/payroll-banking/profile').send({ bankRail: 'ACH', achSpeed: 'NEXT_DAY', companyName: 'Alto HR', companyId: '1234567890', immediateDestination: '091000019', immediateDestinationName: 'Wells Fargo', immediateOrigin: '1234567890', immediateOriginName: 'Alto HR', originatingDfi: '09100001' })).status).toBe(200);
    const run = await prisma.payrollRun.create({ data: { periodStart: new Date('2026-10-03'), periodEnd: new Date('2026-10-09'), status: 'DISBURSED' } });
    await prisma.garnishmentDeduction.create({ data: { garnishmentId: g.id, payrollRunId: run.id, amount: 184.62 } });
    await accrueRemittancesForRun(prisma, run.id);
    const rem = await prisma.garnishmentRemittance.findFirstOrThrow({ where: { payrollRunId: run.id } });

    const sent = await a.post('/garnishment-desk/remittances/send').send({ remittanceIds: [rem.id], effectiveDate: '2026-10-19' });
    expect(sent.status).toBe(200);
    const file = await prisma.achFile.findUniqueOrThrow({ where: { id: sent.body.achFileId } });
    expect(file.purpose).toBe('GARNISHMENT');
    const nacha = fileContent(file);
    expect(validateNachaFile(nacha)).toEqual({ ok: true });
    const addenda = nacha.split('\n').find((l) => l.startsWith('705'))!;
    expect(addenda.slice(3, 83).trim()).toMatch(/^DED\*CS\*CS777\*\d{6}\*18462\*123456789\*N\*LOPEZ,M\*48000\*N\\$/);
    expect(nacha).toContain('CCD');
    const done = await prisma.garnishmentRemittance.findUniqueOrThrow({ where: { id: rem.id } });
    expect(done).toMatchObject({ status: 'SENT', method: 'EFT_SDU', fileId: file.id });
    expect(done.advice).toContain('CS777');
    expect((await a.get(`/garnishment-desk/remittances/${rem.id}/advice.txt`)).text).toContain('Total 184.62');
    // Sending again is refused.
    expect((await a.post('/garnishment-desk/remittances/send').send({ remittanceIds: [rem.id], effectiveDate: '2026-10-19' })).status).toBe(409);
  });

  it('a check-paid order is named instead of sent; termination notices end the order', async () => {
    const { a } = await admin();
    const p = await person('Bo', 'Kim', '222334444');
    const g = await prisma.garnishment.create({ data: { associateId: p.id, kind: 'CHILD_SUPPORT', caseNumber: 'CS9', currentSupport: 100, startDate: new Date('2026-01-01'), remitTo: 'CA SDU' } });
    const run = await prisma.payrollRun.create({ data: { periodStart: new Date('2026-10-03'), periodEnd: new Date('2026-10-09'), status: 'DISBURSED' } });
    await prisma.garnishmentDeduction.create({ data: { garnishmentId: g.id, payrollRunId: run.id, amount: 50 } });
    await accrueRemittancesForRun(prisma, run.id);
    const rem = await prisma.garnishmentRemittance.findFirstOrThrow({ where: { payrollRunId: run.id } });
    const r = await a.post('/garnishment-desk/remittances/send').send({ remittanceIds: [rem.id], effectiveDate: '2026-10-19' });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/paid by check/);

    const n = await a.post(`/garnishment-desk/orders/${g.id}/notices`).send({ kind: 'TERMINATION', terminationDate: '2026-10-10', lastPayDate: '2026-10-16', finalPaymentAmount: 50 });
    expect(n.status).toBe(201);
    expect((await prisma.garnishment.findUniqueOrThrow({ where: { id: g.id } })).status).toBe('TERMINATED');
    const xml = await a.get(`/garnishment-desk/notices/${n.body.notice.id}/file.xml`);
    expect(xml.text).toContain('<TerminationDate>2026-10-10</TerminationDate>');
    expect(xml.text).toContain('<EmployeeSSN>222334444</EmployeeSSN>');
  });
});

describe('401(k): plans, eligibility, recordkeeper files and deferral changes', () => {
  it('enforces SECURE 2.0 auto-enroll, syncs eligibility, builds the contribution file and reads deferral changes', async () => {
    const { a } = await admin();
    const client = await createClient();
    const bp = await prisma.benefitsPlan.create({ data: { clientId: client.id, kind: 'RETIREMENT_401K', name: 'Acme 401(k) deferrals' } });
    expect((await a.post('/retirement/plans').send({ name: 'No link', recordkeeper: 'GUIDELINE', eligibilityMinAge: 21, eligibilityServiceDays: 0, entryTiming: 'IMMEDIATE', autoEnroll: false, autoEnrollPercent: 0, autoEscalatePercent: 0, autoEscalateMax: 0, optOutDays: 0, matchFormula: [], safeHarbor: 'NONE', rothEnabled: true, catchUpEnabled: true })).status).toBe(400);
    const base = {
      benefitsPlanId: bp.id,
      name: 'Acme 401(k)', planNumber: 'PLAN-1', recordkeeper: 'GUIDELINE', establishedOn: '2024-01-01', eligibilityMinAge: 21, eligibilityServiceDays: 0, entryTiming: 'IMMEDIATE',
      autoEnroll: false, autoEnrollPercent: 0, autoEscalatePercent: 0, autoEscalateMax: 0, optOutDays: 0, matchFormula: [{ upToPercent: 4, matchPercent: 100 }], safeHarbor: 'NONE', rothEnabled: true, catchUpEnabled: true,
    };
    const refused = await a.post('/retirement/plans').send(base);
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toMatch(/must auto-enroll/);
    const created = await a.post('/retirement/plans').send({ ...base, autoEnroll: true, autoEnrollPercent: 3, autoEscalatePercent: 1, autoEscalateMax: 10 });
    expect(created.status).toBe(201);
    const planId = created.body.plan.id;

    const ann = await person('Ann', 'Lee', '111223333');
    const sync = await a.post(`/retirement/plans/${planId}/sync`);
    expect(sync.body.eligible).toBeGreaterThanOrEqual(1);
    const el = await a.get(`/retirement/plans/${planId}/elections`);
    const annEl = el.body.elections.find((e: { associateId: string }) => e.associateId === ann.id);
    expect(annEl.status).toBe('ELIGIBLE');
    expect(annEl.optOutDeadline).toBe(annEl.eligibleOn); // zero-day opt-out window
    // The next sweep auto-enrolls at the plan's 3% — written to the one election, her enrollment.
    await a.post(`/retirement/plans/${planId}/sync`);
    expect((await prisma.retirementElection.findFirstOrThrow({ where: { planId, associateId: ann.id } })).status).toBe('AUTO_ENROLLED');
    const auto = await prisma.benefitsEnrollment.findFirstOrThrow({ where: { associateId: ann.id, planId: bp.id, terminationDate: null } });
    expect(Number(auto.electedPercent)).toBe(3);
    expect(auto.retirementPlanId).toBe(planId);
    expect((await a.get(`/retirement/plans/${planId}/elections`)).body.elections.find((e: { associateId: string }) => e.associateId === ann.id).preTaxPercent).toBe(3);

    // A pay date's contributions → the Guideline file.
    const run = await prisma.payrollRun.create({ data: { periodStart: new Date('2026-10-03'), periodEnd: new Date('2026-10-09'), status: 'FINALIZED' } });
    const item = await prisma.payrollItem.create({ data: { payrollRunId: run.id, associateId: ann.id, hoursWorked: 80, hourlyRate: 25, grossPay: 2000, federalWithholding: 0, netPay: 1500 } });
    await prisma.retirementContribution.create({ data: { planId, associateId: ann.id, payrollRunId: run.id, payrollItemId: item.id, payDate: new Date('2026-10-16'), eligibleComp: 2000, preTax: 60, employerMatch: 60, loanRepayments: [{ loanNumber: 'L-1', amount: 25 }] } });
    const dates = await a.get(`/retirement/plans/${planId}/pay-dates`);
    expect(dates.body.payDates[0]).toMatchObject({ payDate: '2026-10-16', people: 1, employee: 60, employer: 60, fileStatus: null });
    const made = await a.post(`/retirement/plans/${planId}/files/contributions`).send({ payDate: '2026-10-16' });
    expect(made.status).toBe(201);
    expect(made.body.file.totals).toMatchObject({ people: 1, preTax: 60, employer: 60, loans: 25 });
    const dl = await a.get(`/retirement/files/${made.body.file.id}/download`);
    expect(dl.status).toBe(200);
    expect(dl.text).toContain('111223333');
    expect(dl.text).toContain('L-1');
    // No connection yet → the send fails plainly and the file stays.
    const send = await a.post(`/retirement/files/${made.body.file.id}/send`);
    expect(send.status).toBe(502);
    expect(send.body.file.status).toBe('FAILED');

    const census = await a.post(`/retirement/plans/${planId}/files/census`);
    expect(census.status).toBe(201);

    const changes = await a.post(`/retirement/plans/${planId}/deferral-changes`).send({ content: 'SSN,Pre-Tax %,Roth %,Effective Date\r\n111-22-3333,6,2,11/01/2026\r\n999999999,5,0,11/01/2026\r\n' });
    expect(changes.body).toMatchObject({ applied: 1, unmatched: ['SSN ending 9999'] });
    const after = await prisma.retirementElection.findFirstOrThrow({ where: { planId, associateId: ann.id } });
    expect(after).toMatchObject({ status: 'ENROLLED', source: 'RECORDKEEPER' });
    const live = await prisma.benefitsEnrollment.findMany({ where: { associateId: ann.id, planId: bp.id, terminationDate: null } });
    expect(live).toHaveLength(1);
    expect(Number(live[0]!.electedPercent)).toBe(6);
    expect(Number(live[0]!.rothPercent)).toBe(2);

    // True-up: $100k comp with match paid short.
    await prisma.retirementContribution.create({ data: { planId, associateId: ann.id, payrollRunId: (await prisma.payrollRun.create({ data: { periodStart: new Date('2026-06-01'), periodEnd: new Date('2026-06-07'), status: 'FINALIZED' } })).id, payDate: new Date('2026-06-12'), eligibleComp: 98000, preTax: 24440, employerMatch: 1000 } });
    const tu = await a.post(`/retirement/plans/${planId}/files/true-up`).send({ year: 2026 });
    expect(tu.status).toBe(201);
    expect(tu.body.owed[0].amount).toBe(2940); // 4% of $100,000 = 4,000 − 1,060 paid
  });
});

describe('401(k): one election, one deduction', () => {
  it('a person in a retirement plan with a benefits enrollment is deducted once, and the contribution reports to the plan', async () => {
    const client = await createClient('TX store');
    const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    await prisma.site.update({ where: { id: site.id }, data: { state: 'TX', city: 'Austin', timezone: 'America/Chicago' } });
    const p = await person('Ana', 'Ruiz', '333445555', { state: 'TX', dob: new Date('1990-01-01') });
    await prisma.associateAssignment.create({ data: { associateId: p.id, locationId: site.id, startedAt: new Date('2026-01-02') } });
    const bp = await prisma.benefitsPlan.create({ data: { clientId: client.id, kind: 'RETIREMENT_401K', name: '401(k)' } });
    const plan = await prisma.retirementPlan.create({ data: { name: 'Plan', recordkeeper: 'GUIDELINE', benefitsPlanId: bp.id, matchFormula: [{ upToPercent: 4, matchPercent: 100 }] } });
    await prisma.retirementElection.create({ data: { planId: plan.id, associateId: p.id, status: 'ENROLLED', source: 'HR' } });
    await prisma.benefitsEnrollment.create({ data: { associateId: p.id, planId: bp.id, retirementPlanId: plan.id, electedAmountCentsPerPeriod: 0, electedPercent: 5, effectiveDate: new Date('2026-01-01') } });
    const start = new Date('2026-09-14T14:00:00Z');
    await prisma.timeEntry.create({ data: { associateId: p.id, clientId: client.id, locationId: site.id, clockInAt: start, clockOutAt: new Date(start.getTime() + 8 * 3_600_000), status: 'APPROVED', approvedAt: new Date() } });

    const r = await aggregatePayrollProjection(prisma, { periodStart: new Date('2026-09-12T00:00:00Z'), periodEndExclusive: new Date('2026-09-26T00:00:00Z'), clientId: null, defaultRate: 25 });
    const it0 = r.items.find((i) => i.associateId === p.id)!;
    expect(it0.grossPay).toBe(200);
    expect(it0.preTaxRetirement).toBe(10); // 5% once, not twice
    expect(it0.deferrals).toMatchObject({ pre401k: 10 });
    expect(it0.retirement).toMatchObject({ planId: plan.id, preTax: 10, employerMatch: 8 });
  });
});

describe('benefit carriers: EDI 834 full and change files', () => {
  it('links plans, builds a full 834 with subscriber and dependent, then a change file only when something changed', async () => {
    const { a } = await admin();
    const client = await createClient();
    const plan = await prisma.benefitsPlan.create({ data: { clientId: client.id, kind: 'HEALTH_MEDICAL', name: 'PPO 500' } });
    const ann = await person('Ann', 'Lee', '111223333');
    const kid = await prisma.dependent.create({ data: { associateId: ann.id, firstName: 'Cy', lastName: 'Lee', relation: 'CHILD', dob: new Date('2015-06-01') } });
    await prisma.benefitsEnrollment.create({ data: { associateId: ann.id, planId: plan.id, electedAmountCentsPerPeriod: 5000, effectiveDate: new Date('2026-01-01'), coveredDependentIds: [kid.id] } });
    const noSsn = await createAssociate({ firstName: 'No', lastName: 'Ssn' });
    await prisma.benefitsEnrollment.create({ data: { associateId: noSsn.id, planId: plan.id, electedAmountCentsPerPeriod: 5000, effectiveDate: new Date('2026-01-01') } });

    const c = await a.post('/benefit-carriers').send({ name: 'Blue Cross', receiverId: 'BCBSTX', receiverQualifier: 'ZZ', senderId: 'ALTOHR', senderQualifier: 'ZZ', sponsorTaxId: '123456789', policyNumber: 'GRP-1', usageIndicator: 'T', transport: 'DOWNLOAD' });
    expect(c.status).toBe(201);
    const id = c.body.carrier.id;
    expect((await a.put(`/benefit-carriers/${id}/plans`).send({ plans: [{ planId: plan.id, carrierPlanCode: 'PPO500' }] })).status).toBe(200);
    // Production needs a test file first.
    expect((await a.put(`/benefit-carriers/${id}`).send({ ...c.body.carrier, usageIndicator: 'P' })).status).toBe(409);

    const full = await a.post(`/benefit-carriers/${id}/files`).send({ mode: 'FULL' });
    expect(full.status).toBe(201);
    expect(full.body.file.memberCount).toBe(2);
    expect(full.body.excluded[0]).toMatch(/No Ssn: no SSN on file/);
    const dl = await a.get(`/benefit-files/${full.body.file.id}/download`);
    const segs = segmentsOf(dl.text);
    expect(segs[0]![0]).toBe('ISA');
    expect(segs.find((s) => s[0] === 'BGN')![8]).toBe('RX');
    expect(segs.filter((s) => s[0] === 'INS').map((s) => s.slice(1, 4))).toEqual([['Y', '18', '030'], ['N', '19', '030']]);
    expect(segs.find((s) => s[0] === 'HD')).toEqual(['HD', '030', '', 'HLT', 'PPO500', 'E1D']);
    expect(segs.find((s) => s[0] === 'NM1')).toEqual(['NM1', 'IL', '1', 'LEE', 'ANN', '', '', '', '34', '111223333']);

    const none = await a.post(`/benefit-carriers/${id}/files`).send({ mode: 'CHANGE' });
    expect(none.body.file).toBeNull();
    expect(none.body.message).toMatch(/Nothing has changed/);

    // A termination after the last file → a change file with 024 and DTP*349.
    await prisma.benefitsEnrollment.updateMany({ where: { associateId: ann.id }, data: { terminationDate: new Date('2026-10-31') } });
    const change = await a.post(`/benefit-carriers/${id}/files`).send({ mode: 'CHANGE' });
    expect(change.status).toBe(201);
    expect(change.body.file.controlNumber).toBe(full.body.file.controlNumber + 1);
    const cs = segmentsOf((await a.get(`/benefit-files/${change.body.file.id}/download`)).text);
    expect(cs.find((s) => s[0] === 'BGN')![8]).toBe('2');
    expect(cs.find((s) => s[0] === 'INS')!.slice(1, 5)).toEqual(['Y', '18', '024', '07']);
    expect(cs.find((s) => s[0] === 'DTP' && s[1] === '349')).toEqual(['DTP', '349', 'D8', '20261031']);

    const log = await a.get(`/benefit-carriers/${id}/files`);
    expect(log.body.files).toHaveLength(2);
    // Download transport: the send says to upload by hand.
    const send = await a.post(`/benefit-files/${change.body.file.id}/send`);
    expect(send.status).toBe(502);
    expect(send.body.error.message).toMatch(/download/);
  });
});

describe('benefit carriers: how each feed is doing (F500 G6)', () => {
  it('people in the feed, changes waiting since the last file, and the last file’s delivery — exact, per carrier', async () => {
    const { a } = await admin();
    const client = await createClient();
    const ppo = await prisma.benefitsPlan.create({ data: { clientId: client.id, kind: 'HEALTH_MEDICAL', name: 'PPO 500' } });
    const dental = await prisma.benefitsPlan.create({ data: { clientId: client.id, kind: 'DENTAL', name: 'Dental' } });
    const other = await prisma.benefitsPlan.create({ data: { clientId: client.id, kind: 'VISION', name: 'Vision' } });
    const ann = await person('Ann', 'Lee', '111223333');
    const bo = await person('Bo', 'Ray', '222334444');
    const cy = await person('Cy', 'Day', '333445555');
    const enroll = (associateId: string, planId: string, extra: Record<string, unknown> = {}) =>
      prisma.benefitsEnrollment.create({ data: { associateId, planId, electedAmountCentsPerPeriod: 5000, effectiveDate: new Date('2026-01-01'), ...extra } });
    await enroll(ann.id, ppo.id);
    await enroll(ann.id, dental.id); // the same person on two plans counts once
    await enroll(bo.id, ppo.id);
    await enroll(cy.id, ppo.id, { terminationDate: new Date('2025-12-31'), effectiveDate: new Date('2025-01-01') }); // ended: not in the feed
    await enroll(cy.id, other.id); // another carrier's plan
    const blue = (await a.post('/benefit-carriers').send({ name: 'Blue Cross', receiverId: 'BCBSTX', receiverQualifier: 'ZZ', senderId: 'ALTOHR', senderQualifier: 'ZZ', usageIndicator: 'T', transport: 'DOWNLOAD' })).body.carrier.id;
    const eye = (await a.post('/benefit-carriers').send({ name: 'Eye Co', receiverId: 'EYECO', receiverQualifier: 'ZZ', senderId: 'ALTOHR', senderQualifier: 'ZZ', usageIndicator: 'T', transport: 'DOWNLOAD' })).body.carrier.id;
    await a.put(`/benefit-carriers/${blue}/plans`).send({ plans: [{ planId: ppo.id }, { planId: dental.id }] });

    const before = (await a.get('/benefit-carriers')).body.carriers as Array<{ id: string; health: { people: number; changesWaiting: number | null; lastFile: unknown } }>;
    expect(before.find((c) => c.id === blue)!.health).toEqual({ people: 2, changesWaiting: null, lastFile: null });
    expect(before.find((c) => c.id === eye)!.health).toEqual({ people: 0, changesWaiting: null, lastFile: null });

    const full = (await a.post(`/benefit-carriers/${blue}/files`).send({ mode: 'FULL' })).body.file;
    // One change after the file: Bo's PPO election.
    await new Promise((r) => setTimeout(r, 20));
    await prisma.benefitsEnrollment.updateMany({ where: { associateId: bo.id, planId: ppo.id }, data: { electedAmountCentsPerPeriod: 6000 } });
    const after = (await a.get('/benefit-carriers')).body.carriers.find((c: { id: string }) => c.id === blue).health;
    expect(after).toMatchObject({ people: 2, changesWaiting: 1, lastFile: { mode: 'FULL', status: 'GENERATED', controlNumber: full.controlNumber, memberCount: 2, sentAt: null, error: null } });
    // A failed send is still the last file, with its error.
    const send = await a.post(`/benefit-files/${full.id}/send`);
    expect(send.status).toBe(502);
    const failed = (await a.get('/benefit-carriers')).body.carriers.find((c: { id: string }) => c.id === blue).health.lastFile;
    expect(failed.status).toBe('FAILED');
    expect(failed.error).toMatch(/download/);
  });
});

describe('sealing payee bank details', () => {
  it('refuses a bad routing number and never stores the account in the clear', () => {
    expect(() => sealPayeeBank('011000016', '1234')).toThrow(/check digit/);
    const s = sealPayeeBank('011000015', '12345678');
    expect(s.payeeAccountLast4).toBe('5678');
    expect(s.payeeAccountEnc).not.toContain('12345678');
  });
});
