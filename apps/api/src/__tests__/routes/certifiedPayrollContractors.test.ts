import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { encryptString } from '../../lib/crypto.js';
import { computePayrollExceptions } from '../../lib/payrollExceptions.js';
import { aggregatePayrollProjection } from '../../lib/payrollAggregator.js';
import { aggregateF1099NecPayments } from '../../lib/f1099NecAggregator.js';
import { applyDueBackupWithholding, buildTinMatchRequestFile, parseTinMatchResultsFile, setTinMatchProviderForTests } from '../../lib/contractors.js';
import { computeCertifiedWeek, splitOvertime } from '../../lib/certifiedPayroll.js';
import { renderWh347Pdf } from '../../lib/wh347Pdf.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * Certified payroll (prevailing wage) and the contractors (1099) desk:
 * the below-prevailing exception, the WH-347 and its signature, the
 * California eCPR XML, TIN matching both ways, the B-notice timeline,
 * backup withholding on payment runs and hourly contractor pay, and the
 * state 1099 export.
 */

const app = () => createApp();
const WEEK = '2026-09-05'; // a Saturday

beforeEach(async () => {
  await truncateAll();
});

afterEach(() => {
  setTinMatchProviderForTests(undefined);
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

async function payrollPerson() {
  const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
  return { user, agent: await loginAs(user.email) };
}

/** The text drawn on a pdfkit PDF: inflate each content stream and decode its TJ hex strings. */
function pdfText(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  const out: string[] = [];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    try {
      const body = inflateSync(Buffer.from(raw.slice(start, end), 'latin1')).toString('latin1');
      for (const tj of body.matchAll(/\[(.*?)\]\s*TJ/g)) {
        out.push([...tj[1]!.matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => Buffer.from(h[1]!, 'hex').toString('latin1')).join(''));
      }
    } catch {
      // not a Flate stream (fonts, images)
    }
  }
  return out.join('\n');
}

/** Tags open and close in order: a well-formedness check without an XML library. */
function balanced(xml: string): boolean {
  const stack: string[] = [];
  for (const t of xml.replace(/<\?xml[^>]*\?>/, '').matchAll(/<(\/?)([A-Za-z:]+)[^>]*?(\/?)>/g)) {
    if (t[3]) continue;
    if (t[1]) {
      if (stack.pop() !== t[2]) return false;
    } else stack.push(t[2]!);
  }
  return stack.length === 0;
}

async function caProject(agent: TestAgent<Test>) {
  const client = await createClient();
  const site = await prisma.site.create({ data: { clientId: client.id, name: 'Civic Center', timezone: 'America/Los_Angeles' } });
  const created = await agent.post('/certified-payroll/projects').send({
    name: 'Civic Center Retrofit',
    contractNumber: 'C-2026-114',
    agency: 'City of Fresno',
    awardingBody: 'City of Fresno Public Works',
    wageDeterminationNumber: 'CA20260001',
    dirProjectId: '2026-123456',
    siteId: site.id,
    addressLine1: '2600 Fresno St',
    city: 'Fresno',
    county: 'Fresno',
    state: 'CA',
    zip: '93721',
    startDate: '2026-08-24',
    fringeMode: 'CASH',
  });
  expect(created.status).toBe(201);
  const projectId = created.body.id as string;
  expect((await agent.post(`/certified-payroll/projects/${projectId}/rates`).send({ classification: 'Electrician', baseRate: 40, fringeRate: 10, effectiveFrom: '2026-07-01' })).status).toBe(201);
  const worker = await createAssociate({ firstName: 'Rosa', lastName: 'Lopez' });
  await prisma.associate.update({ where: { id: worker.id }, data: { ssnLast4: '4321' } });
  await prisma.compensationRecord.create({ data: { associateId: worker.id, payType: 'HOURLY', amount: 45, reason: 'HIRE', effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
  expect((await agent.post(`/certified-payroll/projects/${projectId}/workers`).send({ associateId: worker.id, classification: 'Electrician', startedOn: '2026-08-24' })).status).toBe(201);
  // Monday–Friday, 8am–5pm Pacific: nine hours a day at the site.
  for (const d of ['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']) {
    const inAt = new Date(`${d}T15:00:00Z`);
    await prisma.timeEntry.create({ data: { associateId: worker.id, clientId: client.id, locationId: site.id, clockInAt: inAt, clockOutAt: new Date(inAt.getTime() + 9 * 3_600_000), status: 'APPROVED' } });
  }
  return { projectId, worker, site, client };
}

describe('certified payroll', () => {
  it('flags pay below the prevailing rate before the run and refuses to sign over it', async () => {
    const { agent } = await payrollPerson();
    const { projectId, worker } = await caProject(agent);

    const week = await agent.get(`/certified-payroll/projects/${projectId}/weeks/${WEEK}`);
    expect(week.status).toBe(200);
    const row = week.body.week.rows[0];
    // California public works: over eight in a day is overtime.
    expect(row.straight).toEqual([0, 8, 8, 8, 8, 8, 0]);
    expect(row.overtime).toEqual([0, 1, 1, 1, 1, 1, 0]);
    expect(row.requiredRate).toBe(50);
    expect(row.belowPrevailing).toBe(true);
    expect(week.body.week.exceptions.map((e: { kind: string }) => e.kind)).toContain('BELOW_PREVAILING');

    const pre = await computePayrollExceptions(prisma, { periodStart: new Date('2026-08-29T00:00:00Z'), periodEndExclusive: new Date('2026-09-12T00:00:00Z'), clientId: null });
    const hit = pre.exceptions.find((e) => e.kind === 'BELOW_PREVAILING_WAGE');
    expect(hit?.associateId).toBe(worker.id);
    expect(hit?.severity).toBe('BLOCKING');

    const sign = await agent.post(`/certified-payroll/projects/${projectId}/weeks/${WEEK}/sign`).send({ signatureName: 'Pat Payroll', signerTitle: 'Payroll Officer', fringeStatement: 'CASH', attest: true });
    expect(sign.status).toBe(409);
    expect(sign.body.error?.code ?? sign.body.code).toBe('week_has_exceptions');
  });

  it('signs the WH-347 with the paid week, keeps it as signed, and exports the eCPR XML', async () => {
    const { agent } = await payrollPerson();
    const { projectId, worker } = await caProject(agent);
    await prisma.compensationRecord.updateMany({ where: { associateId: worker.id }, data: { amount: 55 } });
    const run = await prisma.payrollRun.create({ data: { periodStart: new Date('2026-08-29T00:00:00Z'), periodEnd: new Date('2026-09-11T00:00:00Z'), status: 'FINALIZED' } });
    await prisma.payrollItem.create({
      data: { payrollRunId: run.id, associateId: worker.id, hoursWorked: 45, hourlyRate: 55, grossPay: 2612.5, federalWithholding: 300, fica: 162, medicare: 38, stateWithholding: 100, netPay: 2012.5 },
    });

    const sign = await agent.post(`/certified-payroll/projects/${projectId}/weeks/${WEEK}/sign`).send({ signatureName: 'Pat Payroll', signerTitle: 'Payroll Officer', fringeStatement: 'CASH', attest: true });
    expect(sign.status).toBe(200);
    expect(sign.body.payrollNumber).toBe(2); // the week ending Aug 29 is number 1
    expect(sign.body.pdfHash).toMatch(/^[0-9a-f]{64}$/);

    const report = await prisma.certifiedPayrollReport.findFirstOrThrow({ where: { projectId } });
    expect(report.status).toBe('SIGNED');
    const snap = report.snapshot as { rows: Array<{ grossThisProject: number; deductions: { fica: number; withholding: number; total: number }; net: number; idLast4: string }> };
    expect(snap.rows[0]!.grossThisProject).toBe(2612.5);
    expect(snap.rows[0]!.deductions).toMatchObject({ fica: 200, withholding: 400, total: 600 });
    expect(snap.rows[0]!.net).toBe(2012.5);
    expect(snap.rows[0]!.idLast4).toBe('4321');

    // A signed week is the record as signed, even if pay changes later.
    await prisma.compensationRecord.updateMany({ where: { associateId: worker.id }, data: { amount: 99 } });
    const again = await agent.get(`/certified-payroll/projects/${projectId}/weeks/${WEEK}`);
    expect(again.body.week.rows[0].rate).toBe(55);
    expect((await agent.post(`/certified-payroll/projects/${projectId}/weeks/${WEEK}/sign`).send({ signatureName: 'Pat Payroll', signerTitle: 'Payroll Officer', fringeStatement: 'CASH', attest: true })).status).toBe(409);

    const pdf = await agent.get(`/certified-payroll/projects/${projectId}/weeks/${WEEK}/wh347.pdf`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(pdf.status).toBe(200);
    const text = pdfText(pdf.body as Buffer);
    expect(text).toContain('Civic Center Retrofit');
    expect(text).toContain('Rosa Lopez');
    expect(text).toContain('Electrician');
    expect(text).toContain('2612.50');
    expect(text).toContain('Pat Payroll');
    expect(text).toMatch(/Statement of Compliance/i);

    const xml = await agent.get(`/certified-payroll/projects/${projectId}/weeks/${WEEK}/ecpr.xml`);
    expect(xml.status).toBe(200);
    const body = xml.text;
    expect(body.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(balanced(body)).toBe(true);
    expect(body).toContain('<CPR:projectID>2026-123456</CPR:projectID>');
    expect(body).toContain('<CPR:payrollNum>2</CPR:payrollNum>');
    expect(body).toContain(`<CPR:forWeekEnding>${WEEK}</CPR:forWeekEnding>`);
    expect(body).toContain('<CPR:day2><CPR:date>2026-08-31</CPR:date><CPR:straightHours>8.00</CPR:straightHours><CPR:overtimeHours>1.00</CPR:overtimeHours></CPR:day2>');
    expect(body).toContain('<CPR:craft>Electrician</CPR:craft>');
    expect(body).toContain('<CPR:netWagesPaid>2012.50</CPR:netWagesPaid>');

    const submitted = await agent.post(`/certified-payroll/projects/${projectId}/weeks/${WEEK}/submitted`).send({ submittedTo: 'DIR eCPR', confirmation: 'ECPR-889' });
    expect(submitted.status).toBe(200);
    const list = await agent.get('/certified-payroll/projects');
    expect(list.body.projects[0].weeksDue).toBeGreaterThan(0); // other ended weeks are still open
  });

  it('flags apprentices over the ratio and renders a WH-347 grid', async () => {
    const project = {
      id: 'p', tenantId: null, name: 'Bridge', contractNumber: null, agency: null, awardingBody: null, wageDeterminationNumber: null, dirProjectId: null, siteId: 's', clientId: null,
      addressLine1: null, city: null, county: null, state: 'OR', zip: null, startDate: new Date('2026-01-01'), endDate: null, weekEndsOn: 6, fringeMode: 'PLAN',
      payrollOfficerName: null, payrollOfficerTitle: null, status: 'ACTIVE', createdById: null, createdAt: new Date(), updatedAt: new Date(),
    };
    const a1 = await createAssociate({ firstName: 'Ana', lastName: 'One' });
    const a2 = await createAssociate({ firstName: 'Ben', lastName: 'Two' });
    const site = await prisma.site.create({ data: { name: 'Bridge', timezone: 'America/Los_Angeles' } });
    for (const a of [a1, a2]) {
      await prisma.timeEntry.create({ data: { associateId: a.id, locationId: site.id, clockInAt: new Date('2026-08-31T15:00:00Z'), clockOutAt: new Date('2026-08-31T23:00:00Z'), status: 'APPROVED' } });
    }
    const rate = { id: 'r', tenantId: null, projectId: 'p', classification: 'Laborer', baseRate: 30 as never, fringeRate: 8 as never, apprenticesPerJourneyman: 1 as never, effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveTo: null, createdAt: new Date() };
    const worker = (id: string) => ({ id, tenantId: null, projectId: 'p', associateId: id, classification: 'Laborer', isApprentice: true, apprenticeRegistration: 'OR-1', apprenticeLevelPercent: 60 as never, startedOn: new Date('2026-01-01T00:00:00Z'), endedOn: null, createdAt: new Date() });
    const week = await computeCertifiedWeek(prisma, { ...project, siteId: site.id, rates: [rate], workers: [worker(a1.id), worker(a2.id)], site: { timezone: 'America/Los_Angeles' } }, WEEK);
    const ratio = week.exceptions.find((e) => e.kind === 'APPRENTICE_RATIO');
    expect(ratio?.associateIds?.sort()).toEqual([a1.id, a2.id].sort());
    // Fringe paid to plans: an apprentice's cash floor is 60% of the base only.
    expect(week.rows[0]!.requiredRate).toBe(18);

    const pdf = await renderWh347Pdf({ employer: { legalName: 'Alto Builders', addressLine1: null, city: null, state: null, zip: null }, project: { name: 'Bridge', contractNumber: null, addressLine1: null, city: null, state: 'OR' }, payrollNumber: 1, isFinal: true, week, statement: { signatureName: null, signerTitle: null, signedAt: null, fringeStatement: null, exceptionsText: null } });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdfText(pdf)).toContain('Ana One');
  });

  it('splits overtime by the week everywhere and by the day in California', () => {
    expect(splitOvertime([10, 10, 10, 10, 10, 0, 0], false)).toEqual({ straight: [10, 10, 10, 10, 0, 0, 0], overtime: [0, 0, 0, 0, 10, 0, 0] });
    expect(splitOvertime([10, 10, 10, 10, 10, 0, 0], true).overtime.reduce((a, b) => a + b, 0)).toBe(10);
  });
});

describe('contractors', () => {
  async function contractor(first: string, tin: string | null, type: 'CONTRACTOR_1099_INDIVIDUAL' | 'CONTRACTOR_1099_BUSINESS' = 'CONTRACTOR_1099_INDIVIDUAL') {
    const a = await createAssociate({ firstName: first, lastName: 'Contractor' });
    await prisma.associate.update({ where: { id: a.id }, data: { employmentType: type, tinEncrypted: tin ? encryptString(tin) : null, addressLine1: '1 Main St', city: 'Sacramento', state: 'CA', zip: '95814' } });
    return a;
  }

  it('round-trips a Pub 2108A TIN-matching file and checks one payee through a provider', async () => {
    const { agent } = await payrollPerson();
    const jane = await contractor('Jane', '123456789');
    const omar = await contractor('Omar', '987654321');
    await contractor('Nota', null);

    const batch = await agent.post('/contractors/tin-match/batches').send({});
    expect(batch.status).toBe(201);
    expect(batch.body.requestedCount).toBe(2);
    const file = await agent.get(`/contractors/tin-match/batches/${batch.body.id}/request.txt`);
    expect(file.status).toBe(200);
    const lines = file.text.split('\r\n');
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(l).toMatch(/^[123];\d{9};[A-Z0-9 &-]+;R\d{6}$/);
    expect(lines.some((l) => l.startsWith('2;123456789;JANE CONTRACTOR;'))).toBe(true);

    const results = lines.map((l) => (l.includes('123456789') ? `${l};0` : `${l};3`)).join('\r\n');
    expect(parseTinMatchResultsFile(results).size).toBe(2);
    const loaded = await agent.post(`/contractors/tin-match/batches/${batch.body.id}/results`).send({ text: results });
    expect(loaded.status).toBe(200);
    expect(loaded.body.summary).toMatchObject({ MATCHED: 1, MISMATCH: 1, missing: 0 });
    const janeP = await prisma.contractorProfile.findFirstOrThrow({ where: { associateId: jane.id } });
    const omarP = await prisma.contractorProfile.findFirstOrThrow({ where: { associateId: omar.id } });
    expect(janeP.tinMatchStatus).toBe('MATCHED');
    expect(omarP.tinMatchStatus).toBe('MISMATCH');
    expect(omarP.tinMatchCode).toBe(3);

    // The request file never carries anything but type, TIN, name and our row number.
    expect(buildTinMatchRequestFile([{ accountNumber: 'R1', tinType: 2, tin: '123-45-6789', name: 'José Núñez, Jr.' }])).toBe('2;123456789;JOSE NUNEZ JR;R1');

    setTinMatchProviderForTests({ name: 'Mock', check: async () => 0 });
    const check = await agent.post(`/contractors/profiles/${omar.id}/tin-check`).send({});
    expect(check.status).toBe(200);
    expect(check.body.status).toBe('MATCHED');
    setTinMatchProviderForTests(null);
    expect((await agent.post(`/contractors/profiles/${omar.id}/tin-check`).send({})).status).toBe(409);
  });

  it('runs the B-notice timeline: deadlines, backup withholding at the deadline, a W-9 answers the first, not the second', async () => {
    const { agent } = await payrollPerson();
    const pat = await contractor('Pat', '111223333');
    const { user: patUser } = await createUser({ role: 'ASSOCIATE', associateId: pat.id });

    const logged = await agent.post(`/contractors/profiles/${pat.id}/b-notices`).send({ irsNoticeKind: 'CP2100', irsNoticeReceivedOn: '2026-09-01', tinLast4OnNotice: '3333' });
    expect(logged.status).toBe(201);
    expect(logged.body).toMatchObject({ kind: 'FIRST', sendBy: '2026-09-22', backupBy: '2026-10-13' });
    const pdf = await agent.get(`/contractors/b-notices/${logged.body.id}/letter.pdf`);
    expect(pdf.status).toBe(200);
    expect((await agent.post(`/contractors/b-notices/${logged.body.id}/sent`).send({})).status).toBe(200);

    expect(await applyDueBackupWithholding(prisma, new Date('2026-10-12T12:00:00Z'))).toBe(0);
    expect(await applyDueBackupWithholding(prisma, new Date('2026-10-14T12:00:00Z'))).toBe(1);
    const p1 = await prisma.contractorProfile.findFirstOrThrow({ where: { associateId: pat.id } });
    expect(p1).toMatchObject({ backupWithholding: true, backupReason: 'B_NOTICE' });

    // The contractor signs a corrected W-9: the first notice is answered and withholding stops.
    const me = await loginAs(patUser.email);
    const w9 = await me.post('/me/w9').send({
      legalName: 'Pat Contractor', taxClassification: 'INDIVIDUAL', addressLine1: '1 Main St', city: 'Sacramento', state: 'CA', zip: '95814',
      tinType: 'SSN', tin: '111-22-3334', signatureName: 'Pat Contractor', certify: true,
    });
    expect(w9.status).toBe(200);
    expect(w9.body.tinLast4).toBe('3334');
    const p2 = await prisma.contractorProfile.findFirstOrThrow({ where: { associateId: pat.id } });
    expect(p2).toMatchObject({ backupWithholding: false, w9Status: 'SIGNED', tinLast4: '3334', tinMatchStatus: 'NOT_CHECKED' });
    expect((await prisma.bNotice.findFirstOrThrow({ where: { id: logged.body.id } })).resolution).toBe('W9_RECEIVED');
    const mine = await me.get('/me/w9');
    expect(mine.body).toMatchObject({ required: true, status: 'SIGNED', backupWithholding: false });
    expect(JSON.stringify(mine.body)).not.toContain('111223334');
    expect((await prisma.financialChange.count({ where: { associateId: pat.id, kind: 'SSN' } }))).toBe(1);

    const second = await agent.post(`/contractors/profiles/${pat.id}/b-notices`).send({ irsNoticeReceivedOn: '2027-10-01' });
    expect(second.body.kind).toBe('SECOND');
    const refused = await agent.post(`/contractors/b-notices/${second.body.id}/resolve`).send({ resolution: 'W9_RECEIVED' });
    expect(refused.status).toBe(409);
    expect((await agent.post(`/contractors/b-notices/${second.body.id}/resolve`).send({ resolution: 'SSA_VALIDATION' })).status).toBe(200);
  });

  it('withholds 24% on payment runs, needs a second approver, and reports it in 1099 Box 4 and the state export', async () => {
    const first = await payrollPerson();
    const second = await payrollPerson();
    const noTin = await contractor('Nia', null);
    const good = await contractor('Gus', '222334444');

    const run = await first.agent.post('/contractors/payment-runs').send({ name: 'October invoices', payDate: '2026-10-16' });
    expect(run.status).toBe(201);
    const p1 = await first.agent.post(`/contractors/payment-runs/${run.body.id}/payments`).send({ associateId: noTin.id, description: 'Install', amount: 1000, workState: 'CA', stateWithheld: 50 });
    expect(p1.status).toBe(201);
    expect(p1.body).toMatchObject({ backupWithheld: 240, netAmount: 710, backupReason: 'NO_TIN' });
    const p2 = await first.agent.post(`/contractors/payment-runs/${run.body.id}/payments`).send({ associateId: good.id, description: 'Design', amount: 500, workState: 'CA' });
    expect(p2.body).toMatchObject({ backupWithheld: 0, netAmount: 500 });

    const self = await first.agent.post(`/contractors/payment-runs/${run.body.id}/approve`).send({});
    expect(self.status).toBe(403);
    expect((await second.agent.post(`/contractors/payment-runs/${run.body.id}/approve`).send({})).status).toBe(200);
    expect((await second.agent.post(`/contractors/payment-runs/${run.body.id}/paid`).send({ paymentMethod: 'ACH', reference: 'BATCH-1' })).status).toBe(200);

    const nec = await aggregateF1099NecPayments(prisma, noTin.id, 2026);
    expect(nec.box1NonemployeeCompensation).toBe(1000);
    expect(nec.box4FitWithheld).toBe(240);
    expect(nec.stateLines.find((l) => l.state === 'CA')).toMatchObject({ stateIncome: 1000, stateTaxWithheld: 50 });

    // State filing: CF/SF only where the state participates.
    expect((await first.agent.put('/contractors/state-filing/TX').send({ cfsf: true, directFiling: false })).status).toBe(400);
    expect((await first.agent.put('/contractors/state-filing/CA').send({ cfsf: true, directFiling: true, payerStateId: '123-4567-8' })).status).toBe(200);
    const states = await first.agent.get('/contractors/state-filing');
    expect(states.body.cfsfStates).toContain('CA');
    expect(states.body.states.find((s: { state: string }) => s.state === 'TX')).toMatchObject({ cfsf: false, directFiling: false, noIncomeTax: true });

    const csv = await first.agent.get('/contractors/state-filing/CA/export.csv?taxYear=2026');
    expect(csv.status).toBe(200);
    const rows = csv.text.trim().split('\r\n');
    expect(rows[0]).toContain('Recipient TIN');
    const gus = rows.find((r) => r.includes('222334444'));
    expect(gus).toContain('123-4567-8');
    expect(gus).toContain('500.00');
    expect(rows.find((r) => r.includes('Nia Contractor'))).toContain('1000.00,240.00,1000.00,50.00');

    const ye = await first.agent.get('/contractors/year-end?taxYear=2026');
    expect(ye.status).toBe(200);
    const nia = ye.body.rows.find((r: { associateId: string }) => r.associateId === noTin.id);
    expect(nia).toMatchObject({ necBox1: 1000, necBox4: 240, needsNec: true });
    expect(nia.issues).toContain('No TIN');
  });

  it('withholds 24% backup on hourly contractor pay with no TIN', async () => {
    const c = await contractor('Hal', null);
    const client = await createClient();
    await prisma.timeEntry.create({ data: { associateId: c.id, clientId: client.id, clockInAt: new Date('2026-09-01T15:00:00Z'), clockOutAt: new Date('2026-09-01T23:00:00Z'), status: 'APPROVED' } });
    const result = await aggregatePayrollProjection(prisma, {
      periodStart: new Date('2026-08-29T00:00:00Z'),
      periodEndExclusive: new Date('2026-09-12T00:00:00Z'),
      clientId: null,
      defaultRate: 25,
      hourlyRateOverride: new Map([[c.id, 25]]),
    });
    const item = result.items.find((i) => i.associateId === c.id)!;
    expect(item.grossPay).toBe(200);
    expect(item.federalIncomeTax).toBe(48);
    expect(item.netPay).toBe(152);
  });
});
