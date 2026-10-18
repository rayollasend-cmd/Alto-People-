import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { cashForecast } from '../../lib/cashForecast.js';
import { runStatementDunning, stageDue, dueDateFor } from '../../lib/statementDunning.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * Finance's desk: the hold queue in the Inbox and the overview, the cash
 * forecast, invoicing terms with the dunning cadence, and the guided close
 * with the unsupported-state guard.
 */

const app = () => createApp();
const DAY = 86_400_000;

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

const ymd = (d: Date) => d.toISOString().slice(0, 10);

describe('the hold queue reaches the Inbox and the overview', () => {
  it('counts pending and held changes for Finance only', async () => {
    const a = await createAssociate();
    await prisma.financialChange.create({ data: { associateId: a.id, kind: 'BANK_ACCOUNT', source: 'SELF', status: 'PENDING', newSummary: 'x', riskFlags: [], riskScore: 0, highRisk: false } });
    await prisma.financialChange.create({ data: { associateId: a.id, kind: 'W4', source: 'SELF', status: 'HELD', newSummary: 'y', riskFlags: [], riskScore: 5, highRisk: true } });
    await prisma.financialChange.create({ data: { associateId: a.id, kind: 'HOME_ADDRESS', source: 'SELF', status: 'VERIFIED', newSummary: 'z', riskFlags: [], riskScore: 0, highRisk: false } });
    const { user: finance } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const inbox = await (await loginAs(finance.email)).get('/me/inbox');
    expect(inbox.status).toBe(200);
    const src = (inbox.body.sources as Array<{ key: string; count: number; path: string }>).find((s) => s.key === 'financial-changes');
    expect(src).toMatchObject({ count: 2, path: '/payroll/financial-changes' });

    const overview = await (await loginAs(finance.email)).get('/finance/overview');
    expect(overview.status).toBe(200);
    expect(overview.body.financialChanges).toEqual({ pending: 1, held: 1, open: 2 });
    expect(Array.isArray(overview.body.cash?.weeks)).toBe(true);

    const { user: hr } = await createUser({ role: 'SHIFT_SUPERVISOR' });
    const other = await (await loginAs(hr.email)).get('/me/inbox');
    expect((other.body.sources as Array<{ key: string }>).some((s) => s.key === 'financial-changes')).toBe(false);
  });
});

describe('cash forecast', () => {
  it('lines up payroll, deposits, remittances and receivables by week', async () => {
    const client = await createClient('Front Beach');
    const now = new Date();
    await prisma.payrollSchedule.create({ data: { name: 'Biweekly', frequency: 'BIWEEKLY', anchorDate: new Date(now.getTime() - 10 * DAY), payDateOffsetDays: 5 } });
    await prisma.taxDeposit.create({
      data: { kind: 'FED_941', scheduleUsed: 'MONTHLY', periodLabel: 'test payday', liabilityDate: now, dueDate: new Date(now.getTime() + 10 * DAY), amount: 1200, breakdown: {} },
    });
    await prisma.clientStatement.create({
      data: {
        clientId: client.id,
        periodStart: new Date(now.getTime() - 14 * DAY),
        periodEnd: new Date(now.getTime() - 8 * DAY),
        number: 7,
        status: 'FINAL',
        finalizedAt: new Date(now.getTime() - 7 * DAY),
        dueAt: new Date(now.getTime() + 5 * DAY),
        snapshot: { totals: { amount: 3000, hours: 100, regularHours: 100, otHours: 0 } },
      },
    });
    const f = await cashForecast(now);
    expect(f.weeks).toHaveLength(4);
    const kinds = f.lines.map((l) => l.kind);
    expect(kinds).toContain('TAX_DEPOSIT');
    expect(kinds).toContain('RECEIVABLE');
    expect(f.lines.find((l) => l.kind === 'RECEIVABLE')).toMatchObject({ amount: 3000, confidence: 'scheduled' });
    expect(f.lines.find((l) => l.kind === 'TAX_DEPOSIT' && l.label.includes('test payday'))).toMatchObject({ amount: -1200 });
    expect(f.weeks[3].cumulative).toBe(f.totals.net);
    const { user: finance } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const r = await (await loginAs(finance.email)).get('/finance/cash-forecast?weeks=2');
    expect(r.status).toBe(200);
    expect(r.body.weeks).toHaveLength(2);
  });
});

describe('invoicing terms and the dunning cadence', () => {
  it('a finalized statement falls due on the client terms with the standing PO', async () => {
    const client = await createClient('Sandestin');
    const { user: finance } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(finance.email);
    // Terms live on the client record, so whoever manages clients sets them.
    const patched = await (await loginAs(hr.email)).patch(`/clients/${client.id}`).send({ poNumber: 'PO-4471', paymentTermsDays: 15 });
    expect(patched.status).toBe(200);
    const st = await prisma.clientStatement.create({
      data: {
        clientId: client.id,
        periodStart: new Date('2026-09-05T00:00:00Z'),
        periodEnd: new Date('2026-09-11T00:00:00Z'),
        status: 'DRAFT',
        snapshot: { totals: { amount: 500, hours: 20, regularHours: 20, otHours: 0 } },
      },
    });
    const fin = await agent.post(`/clients/${client.id}/statements/${st.id}/finalize`);
    expect(fin.status).toBe(200);
    expect(fin.body.poNumber).toBe('PO-4471');
    const expectedDue = ymd(dueDateFor(new Date(fin.body.finalizedAt), 15));
    expect(fin.body.dueAt).toBe(expectedDue);

    const terms = await agent.patch(`/clients/${client.id}/statements/${st.id}`).send({ dueAt: '2026-12-01', poNumber: 'PO-9' });
    expect(terms.status).toBe(200);
    expect(terms.body).toMatchObject({ dueAt: '2026-12-01', poNumber: 'PO-9', reminderStage: 0 });

    // Finance sets the client's standing terms itself.
    const own = await agent.patch(`/clients/${client.id}/billing-terms`).send({ poNumber: 'PO-5000', paymentTermsDays: 45 });
    expect(own.status).toBe(200);
    expect(own.body).toEqual({ poNumber: 'PO-5000', paymentTermsDays: 45 });
  });

  it('reminds at each stage once, and not while paused', async () => {
    expect(stageDue(new Date('2026-10-20T00:00:00Z'), new Date('2026-10-17T12:00:00Z'))).toBe(1);
    expect(stageDue(new Date('2026-10-20T00:00:00Z'), new Date('2026-10-20T12:00:00Z'))).toBe(2);
    expect(stageDue(new Date('2026-10-20T00:00:00Z'), new Date('2026-11-05T12:00:00Z'))).toBe(4);
    expect(stageDue(new Date('2026-10-20T00:00:00Z'), new Date('2026-10-01T12:00:00Z'))).toBe(0);

    const client = await createClient('Pier Park');
    await prisma.client.update({ where: { id: client.id }, data: { contactEmail: 'ap@pierpark.example' } });
    const { user: portal } = await createUser({ role: 'CLIENT_PORTAL', clientId: client.id });
    const now = new Date();
    const st = await prisma.clientStatement.create({
      data: {
        clientId: client.id,
        periodStart: new Date(now.getTime() - 40 * DAY),
        periodEnd: new Date(now.getTime() - 34 * DAY),
        number: 12,
        status: 'FINAL',
        finalizedAt: new Date(now.getTime() - 33 * DAY),
        dueAt: new Date(now.getTime() - 8 * DAY),
        snapshot: { totals: { amount: 2500, hours: 80, regularHours: 80, otHours: 0 } },
      },
    });
    const first = await runStatementDunning(now);
    expect(first).toMatchObject({ sent: 1, skippedPaused: 0 });
    await flushPendingNotifications();
    const after = await prisma.clientStatement.findUniqueOrThrow({ where: { id: st.id } });
    expect(after.reminderStage).toBe(3);
    const reminder = await prisma.clientStatementReminder.findUnique({ where: { statementId_stage: { statementId: st.id, stage: 3 } } });
    expect(reminder?.recipients).toBe(2);
    const bell = await prisma.notification.findFirst({ where: { recipientUserId: portal.id, category: 'portal.statement_reminder' } });
    expect(bell?.subject).toContain('7 days past due');

    // Same stage again: nothing.
    expect((await runStatementDunning(now)).sent).toBe(0);

    // Paused: the next stage waits.
    const { user: finance } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const agent = await loginAs(finance.email);
    const paused = await agent.post(`/clients/${client.id}/dunning/pause`).send({ note: 'Disputing the OT line' });
    expect(paused.status).toBe(200);
    const later = new Date(now.getTime() + 10 * DAY);
    expect(await runStatementDunning(later)).toMatchObject({ sent: 0, skippedPaused: 1 });
    const resumed = await agent.delete(`/clients/${client.id}/dunning/pause`);
    expect(resumed.status).toBe(200);
    expect((await runStatementDunning(later)).sent).toBe(1);
    const status = await agent.get(`/clients/${client.id}/dunning`);
    expect(status.body.paused).toBeNull();
    expect(status.body.reminders).toHaveLength(2);
  });
});

describe('the guided close', () => {
  async function seedDraft(state: string) {
    const client = await createClient();
    const associate = await createAssociate({ firstName: 'Pat', lastName: 'Nguyen' });
    await prisma.associate.update({ where: { id: associate.id }, data: { state } });
    await prisma.compensationRecord.create({ data: { associateId: associate.id, effectiveFrom: new Date('2026-01-01T00:00:00Z'), payType: 'HOURLY', amount: 20, reason: 'HIRE' } });
    await prisma.timeEntry.create({
      data: { associateId: associate.id, clientId: client.id, clockInAt: new Date('2026-04-14T13:00:00Z'), clockOutAt: new Date('2026-04-14T17:00:00Z'), status: 'APPROVED' },
    });
    const { user: finance } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const agent = await loginAs(finance.email);
    const created = await agent.post('/payroll/runs').send({ periodStart: '2026-04-13', periodEnd: '2026-04-19' });
    expect(created.status).toBe(201);
    return { agent, runId: created.body.id as string };
  }

  const step = (body: { steps: Array<{ key: string; state: string }> }, key: string) => body.steps.find((s) => s.key === key)?.state;

  it('walks the steps and blocks finalizing on an unsupported state', async () => {
    const { agent, runId } = await seedDraft('AR');
    const close = await agent.get(`/payroll/runs/${runId}/close`);
    expect(close.status).toBe(200);
    expect(close.body.steps.map((s: { key: string }) => s.key)).toEqual(['readiness', 'exceptions', 'payPreview', 'approve', 'review', 'disburse', 'deposits', 'quickbooks']);
    expect(close.body.steps[0].state).toBe('blocked');
    expect(close.body.readiness.unsupportedState[0]).toContain('AR');
    expect(step(close.body, 'approve')).toBe('blocked');

    const fin = await agent.post(`/payroll/runs/${runId}/finalize`);
    expect(fin.status).toBe(409);
    expect(fin.body.error.code).toBe('unsupported_state');
  });

  it('a covered state finalizes and the steps move on', async () => {
    const { agent, runId } = await seedDraft('FL');
    const fin = await agent.post(`/payroll/runs/${runId}/finalize`);
    expect(fin.status).toBe(200);
    const close = await agent.get(`/payroll/runs/${runId}/close`);
    expect(step(close.body, 'approve')).toBe('done');
    // Finalized, not yet signed: the review is next and the payout waits for it.
    expect(step(close.body, 'review')).toBe('current');
    expect(step(close.body, 'disburse')).toBe('blocked');
    expect(step(close.body, 'quickbooks')).toBe('skip');
  });
});
