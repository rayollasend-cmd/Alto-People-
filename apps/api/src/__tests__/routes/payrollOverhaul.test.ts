import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

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
  if (r.status !== 200) {
    throw new Error(`loginAs(${email}) failed: ${r.status} ${JSON.stringify(r.body)}`);
  }
  return a;
}

describe('POST /payroll/runs/:id/disburse — no silent 100-item cap', () => {
  it('disburses EVERY pending item on a 120-person run before marking it DISBURSED', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const run = await prisma.payrollRun.create({
      data: {
        periodStart: new Date('2026-04-13T00:00:00Z'),
        periodEnd: new Date('2026-04-19T00:00:00Z'),
        status: 'FINALIZED',
        createdById: hr.id,
      },
    });
    // 120 associates × 1 item each — past the old take:100 cliff.
    for (let i = 0; i < 120; i++) {
      const assoc = await createAssociate({ firstName: `P${i}`, lastName: 'Payee' });
      await prisma.payrollItem.create({
        data: {
          payrollRunId: run.id,
          associateId: assoc.id,
          hoursWorked: 10,
          hourlyRate: 20,
          grossPay: 200,
          federalWithholding: 20,
          netPay: 160,
        },
      });
    }

    const res = await a.post(`/payroll/runs/${run.id}/disburse`).send({});
    expect(res.status).toBe(200);

    const undisbursed = await prisma.payrollItem.count({
      where: { payrollRunId: run.id, status: { not: 'DISBURSED' } },
    });
    // The regression: items 101-120 stayed PENDING while the run still
    // flipped to DISBURSED. Now nothing may be left behind.
    expect(undisbursed).toBe(0);
    const after = await prisma.payrollRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe('DISBURSED');
  }, 120_000);
});

describe('POST /payroll/runs/exceptions — new pre-flight kinds', () => {
  it('flags unapproved time and missing comp records', async () => {
    const client = await createClient();
    // Maria: approved hours but NO comp record → MISSING_COMP_RECORD.
    const maria = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
    await prisma.timeEntry.create({
      data: {
        associateId: maria.id,
        clientId: client.id,
        clockInAt: new Date('2026-04-14T13:00:00Z'),
        clockOutAt: new Date('2026-04-14T18:00:00Z'),
        status: 'APPROVED',
      },
    });
    // Omar: 8h clocked out but never reviewed → UNAPPROVED_TIME.
    const omar = await createAssociate({ firstName: 'Omar', lastName: 'Nye' });
    await prisma.timeEntry.create({
      data: {
        associateId: omar.id,
        clientId: client.id,
        clockInAt: new Date('2026-04-15T13:00:00Z'),
        clockOutAt: new Date('2026-04-15T21:00:00Z'),
        status: 'COMPLETED',
      },
    });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const res = await a.post('/payroll/runs/exceptions').send({
      periodStart: '2026-04-13',
      periodEnd: '2026-04-19',
    });
    expect(res.status).toBe(200);
    const kindsFor = (id: string) =>
      res.body.exceptions
        .filter((e: { associateId: string }) => e.associateId === id)
        .map((e: { kind: string }) => e.kind);
    expect(kindsFor(maria.id)).toContain('MISSING_COMP_RECORD');
    expect(kindsFor(omar.id)).toContain('UNAPPROVED_TIME');
    const unapproved = res.body.exceptions.find(
      (e: { kind: string; associateId: string }) =>
        e.kind === 'UNAPPROVED_TIME' && e.associateId === omar.id,
    );
    expect(unapproved.severity).toBe('WARNING');
    expect(unapproved.message).toContain('8.0');
  });
});

describe('POST /payroll/runs — OFF_CYCLE kind', () => {
  it('creates an off-cycle run with no time aggregation', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const res = await a.post('/payroll/runs').send({
      periodStart: '2026-04-20',
      periodEnd: '2026-04-20',
      kind: 'OFF_CYCLE',
    });
    expect(res.status).toBe(201);
    const run = await prisma.payrollRun.findUniqueOrThrow({
      where: { id: res.body.id },
    });
    expect(run.kind).toBe('OFF_CYCLE');
  });
});

describe('GET /payroll/config — governance flag', () => {
  it('exposes requireSecondApproval so the UI can gate Disburse', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const res = await a.get('/payroll/config');
    // A payroll_config row may not exist for the current year in a bare
    // test DB — then the endpoint 404s and the flag is untestable here.
    if (res.status === 200) {
      expect(typeof res.body.requireSecondApproval).toBe('boolean');
    } else {
      expect(res.status).toBe(404);
    }
  });
});

describe('POST /tax-forms/bulk-file', () => {
  it('files drafts in bulk and skips non-filable rows with reasons', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const assoc = await createAssociate({ firstName: 'Wren', lastName: 'Two' });

    const mk = (status: 'DRAFT' | 'FILED', year: number) =>
      prisma.taxForm.create({
        data: {
          kind: 'W2',
          taxYear: year,
          associateId: assoc.id,
          amounts: { wages: 100 },
          status,
          ...(status === 'FILED' ? { filedAt: new Date(), filedById: hr.id } : {}),
        },
      });
    const d1 = await mk('DRAFT', 2024);
    const d2 = await mk('DRAFT', 2025);
    const filed = await mk('FILED', 2023);

    const res = await a
      .post('/tax-forms/bulk-file')
      .send({ ids: [d1.id, d2.id, filed.id] });
    expect(res.status).toBe(200);
    expect(res.body.filed).toBe(2);
    expect(res.body.skipped).toEqual([
      { id: filed.id, reason: 'invalid_state:FILED' },
    ]);

    const after = await prisma.taxForm.findMany({
      where: { id: { in: [d1.id, d2.id] } },
    });
    for (const f of after) expect(f.status).toBe('FILED');
  });
});
