import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { claimAdjustmentsForStatement, onPayrollFinalized, onPayrollVoided } from '../../lib/payBillLink.js';
import { computeStatementSnapshot } from '../../lib/clientStatement.js';
import { reconcilePayPeriod, __resetUnbilledGapCache } from '../../lib/payBillRecon.js';
import { decideApprovalRequest } from '../../lib/approvalRequests.js';
import { estimateTakeHome } from '../../lib/takeHome.js';
import { notifyClockOutEarnings } from '../../lib/associateEarnings.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { setTenantProfile, invalidateTenantProfile } from '../../lib/tenantProfile.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { startOfWeekUTC } from '../../lib/timeAnomalies.js';
import { pinMidweekNoon } from '../../../test/clock.js';

/**
 * BEYOND — the pay ↔ bill link: retro pay rebilled by contract, premiums
 * billed by contract, margin per paycheck and the payroll-to-invoice
 * reconciliation, and continuous take-home pay.
 */

const DAY = 86_400_000;
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

beforeEach(async () => {
  await truncateAll();
  invalidateTenantProfile();
  __resetUnbilledGapCache();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function card(clientId: string, position: string, payRate: number, billRate: number) {
  await prisma.shiftRateDefault.create({ data: { clientId, position, payRate, billRate, effectiveFrom: d('2026-01-01') } });
}

/** An approved shift worked: `hours` from `start` at a client in a role. */
async function work(associateId: string, clientId: string, start: Date, hours: number, position: string, opts: { siteId?: string; billRate?: number } = {}) {
  const end = new Date(start.getTime() + hours * 3_600_000);
  const shift = await prisma.shift.create({
    data: { clientId, locationId: opts.siteId ?? null, position, startsAt: start, endsAt: end, status: 'COMPLETED', assignedAssociateId: associateId, ...(opts.billRate ? { hourlyRate: opts.billRate } : {}) },
  });
  return prisma.timeEntry.create({
    data: { associateId, clientId, locationId: opts.siteId ?? null, shiftId: shift.id, clockInAt: start, clockOutAt: end, status: 'APPROVED' },
  });
}

async function terms(clientId: string, t: { retroRebill?: string; overtimeBilling?: string; premiumRules?: Record<string, unknown>; defaultMarkupPct?: number | null }) {
  await prisma.clientBillingTerms.create({
    data: { clientId, effectiveFrom: d('2026-01-01'), retroRebill: t.retroRebill ?? 'REVIEW', overtimeBilling: t.overtimeBilling ?? 'MULTIPLIED', premiumRules: (t.premiumRules ?? {}) as object, defaultMarkupPct: t.defaultMarkupPct ?? null },
  });
}

async function run(periodStart: string, periodEnd: string, status: 'FINALIZED' | 'DISBURSED' = 'FINALIZED') {
  return prisma.payrollRun.create({ data: { periodStart: d(periodStart), periodEnd: d(periodEnd), status, kind: 'REGULAR', totalGross: 0, totalTax: 0, totalNet: 0, finalizedAt: new Date() } });
}

async function item(runId: string, associateId: string, gross: number, earnings: Array<{ kind: string; hours?: number; rate?: number; amount: number; notes?: string }>, extra: Record<string, number> = {}) {
  return prisma.payrollItem.create({
    data: {
      payrollRunId: runId,
      associateId,
      hoursWorked: earnings.reduce((s, e) => s + (e.hours ?? 0), 0),
      hourlyRate: 20,
      grossPay: gross,
      federalWithholding: 0,
      netPay: gross,
      status: 'PENDING',
      taxState: 'FL',
      ...extra,
      earnings: { create: earnings.map((e) => ({ kind: e.kind as 'REGULAR', hours: e.hours ?? null, rate: e.rate ?? null, amount: e.amount, notes: e.notes ?? null })) },
    },
  });
}

/** A back-dated raise ($20 → $22) paid as $20 of retro on a later run, for 10h worked at the client. */
async function retroWorld(retroRebill: 'AUTO' | 'REVIEW' | 'NEVER') {
  const { user: finance } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
  const client = await createClient('Coastal');
  const rosa = await createAssociate({ firstName: 'Rosa', lastName: 'Diaz' });
  await card(client.id, 'Picker', 20, 30);
  await terms(client.id, { retroRebill });
  await work(rosa.id, client.id, new Date('2026-04-14T13:00:00Z'), 10, 'Picker');
  const source = await run('2026-04-13', '2026-04-19', 'DISBURSED');
  const sourceItem = await item(source.id, rosa.id, 200, [{ kind: 'REGULAR', hours: 10, rate: 20, amount: 200 }]);
  const raise = await prisma.compensationRecord.create({ data: { associateId: rosa.id, effectiveFrom: d('2026-04-01'), payType: 'HOURLY', amount: 22, reason: 'MERIT' } });
  const statement = await prisma.clientStatement.create({ data: { clientId: client.id, periodStart: d('2026-04-13'), periodEnd: d('2026-04-19'), status: 'FINAL', number: 1042, snapshot: {} } });
  const paid = await run('2026-04-20', '2026-04-26');
  const paidItem = await item(paid.id, rosa.id, 20, [{ kind: 'RETRO', amount: 20 }]);
  const retro = await prisma.retroPayAdjustment.create({
    data: { associateId: rosa.id, compensationRecordId: raise.id, sourcePayrollItemId: sourceItem.id, regularHours: 10, oldRate: 20, newRate: 22, amount: 20, status: 'PAID', paidRunId: paid.id, paidItemId: paidItem.id, paidAt: new Date() },
  });
  return { finance, client, rosa, paid, paidItem, retro, statement };
}

describe('retro pay rebills the client', () => {
  it('AUTO: the back pay × the rate card markup on the days worked, on the next statement, citing the original statement and the paycheck — audited on both sides, once', async () => {
    const w = await retroWorld('AUTO');
    const r = await onPayrollFinalized(prisma, w.paid.id, w.finance.id);
    expect(r.retro).toBe(1);
    const [adj] = await prisma.billingAdjustment.findMany({ where: { kind: 'RETRO' } });
    // $20 back pay × (30 / 20) = $30 billed.
    expect(adj).toMatchObject({ status: 'READY', clientId: w.client.id, payrollItemId: w.paidItem.id, associateId: w.rosa.id });
    expect(Number(adj.amount)).toBe(30);
    expect(Number(adj.payAmount)).toBe(20);
    expect(adj.originalStatementIds).toEqual([w.statement.id]);
    expect(adj.basis).toContain('1.500 bill-rate markup');
    // Idempotent: a second pass writes nothing.
    expect((await onPayrollFinalized(prisma, w.paid.id, w.finance.id)).retro).toBe(0);
    expect(await prisma.billingAdjustment.count()).toBe(1);
    await flushPendingAudits();
    const actions = (await prisma.auditLog.findMany({ where: { action: { in: ['billing.adjustment_created', 'payroll.retro_rebill_linked'] } } })).map((a) => `${a.action}:${a.entityType}`);
    expect(actions.sort()).toEqual(['billing.adjustment_created:BillingAdjustment', 'payroll.retro_rebill_linked:RetroPayAdjustment']);
  });

  it('REVIEW: waits for Finance — approving puts it on the bill, rejecting voids it with the reason', async () => {
    const w = await retroWorld('REVIEW');
    await onPayrollFinalized(prisma, w.paid.id, w.finance.id);
    const adj = await prisma.billingAdjustment.findFirstOrThrow({ where: { kind: 'RETRO' } });
    expect(adj.status).toBe('PENDING_REVIEW');
    const approval = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: adj.approvalId! } });
    expect(approval).toMatchObject({ kind: 'BILLING_ADJUSTMENT', status: 'PENDING', approverCapability: 'process:payroll' });
    expect(approval.title).toBe('Rebill $30.00 to Coastal');
    // A second person decides (the finalizer asked).
    const { user: other } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    await decideApprovalRequest(prisma, approval.id, { id: other.id, role: other.role } as never, { decision: 'APPROVE' });
    expect((await prisma.billingAdjustment.findUniqueOrThrow({ where: { id: adj.id } })).status).toBe('READY');
  });

  it('NEVER: nothing is rebilled and the skip says why', async () => {
    const w = await retroWorld('NEVER');
    const r = await onPayrollFinalized(prisma, w.paid.id, w.finance.id);
    expect(r.retro).toBe(0);
    expect(r.skipped[0].reason).toContain('does not rebill retro pay');
    expect(await prisma.billingAdjustment.count()).toBe(0);
  });
});

describe('premiums bill by contract', () => {
  it('the engine’s double-time line bills only the premium beyond the overtime rate — its hours are already on the statement as overtime', async () => {
    const { user: finance } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const a = await createClient('Coastal DT');
    await card(a.id, 'Picker', 20, 30);
    await terms(a.id, { premiumRules: { DOUBLE_TIME: { mode: 'BILL_MARKUP' } } });
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Diaz' });
    await work(ana.id, a.id, new Date('2026-05-05T13:00:00Z'), 14, 'Picker');
    const r = await run('2026-05-04', '2026-05-10');
    // Paid by the labor-rules engine (a live California day): 8 regular, 4 overtime at $30, 2 double time at $40.
    await item(r.id, ana.id, 360, [
      { kind: 'REGULAR', hours: 8, rate: 20, amount: 160 },
      { kind: 'OVERTIME', hours: 4, rate: 30, amount: 120 },
      { kind: 'DOUBLE_TIME', hours: 2, rate: 40, amount: 80, notes: 'Double time' },
    ]);
    await onPayrollFinalized(prisma, r.id, finance.id);
    const rows = await prisma.billingAdjustment.findMany({ where: { kind: 'PREMIUM', clientId: a.id } });
    // $80 − 2 h × $30 = $20 of premium, × 1.5 markup = $30 (not $80 × 1.5 = $120 on top of the hours billed).
    expect(rows.map((x) => [x.ruleKey, Number(x.payAmount), Number(x.amount)])).toEqual([['DOUBLE_TIME', 20, 30]]);
  });

  it('double time at the markup, meal premiums at cost + 10%, holiday not billable, predictability to the exact store — and the predictability pay line is never billed twice', async () => {
    const { user: finance } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const a = await createClient('Coastal');
    const b = await createClient('Harbor');
    const siteB = await prisma.site.create({ data: { clientId: b.id, name: 'Harbor 12' } });
    await card(a.id, 'Picker', 20, 30);
    await card(b.id, 'Packer', 20, 26);
    await terms(a.id, { premiumRules: { DOUBLE_TIME: { mode: 'BILL_MARKUP' }, MEAL_REST: { mode: 'AT_COST', markupPct: 10 }, HOLIDAY: { mode: 'NOT_BILLABLE' } } });
    await terms(b.id, { premiumRules: { PREDICTABILITY: { mode: 'AT_COST', markupPct: 0 } } });
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Ruiz' });
    // Half the period's hours at each client.
    await work(ana.id, a.id, new Date('2026-05-05T13:00:00Z'), 10, 'Picker');
    await work(ana.id, b.id, new Date('2026-05-06T13:00:00Z'), 10, 'Packer', { siteId: siteB.id });
    const r = await run('2026-05-04', '2026-05-10');
    await item(r.id, ana.id, 555, [
      { kind: 'REGULAR', hours: 20, rate: 20, amount: 400 },
      { kind: 'DOUBLE_TIME', hours: 2, rate: 40, amount: 60 },
      { kind: 'HOLIDAY', hours: 2, rate: 20, amount: 40 },
      { kind: 'PREMIUM', hours: 1, rate: 15, amount: 15, notes: 'Meal period premium (CA)' },
      { kind: 'PREMIUM', hours: 2, rate: 20, amount: 40, notes: 'Predictability pay — shift changed 2026-05-06' },
    ]);
    await prisma.scheduleChangePremium.create({ data: { associateId: ana.id, siteId: siteB.id, workDate: d('2026-05-06'), change: 'MOVED', noticeDays: 1, premiumHours: 2, rule: 'Fair workweek: 2h predictability pay', payrollRunId: r.id } });

    await onPayrollFinalized(prisma, r.id, finance.id);
    const rows = await prisma.billingAdjustment.findMany({ where: { kind: 'PREMIUM' }, orderBy: { amount: 'desc' } });
    const byRule = Object.fromEntries(rows.map((x) => [`${x.clientId === a.id ? 'A' : 'B'}:${x.ruleKey}`, Number(x.amount)]));
    // A: half of $60 × 1.5 = $45; half of $15 × 1.10 = $8.25. Holiday not billable. B: $40 predictability at cost.
    expect(byRule).toEqual({ 'A:DOUBLE_TIME': 45, 'A:MEAL_REST': 8.25, 'B:PREDICTABILITY': 40 });
    expect(rows.find((x) => x.ruleKey === 'DOUBLE_TIME')!.label).toContain('Double time — Ana Ruiz');

    // The statement carries them; the first to finalize claims them, the next draft does not.
    const snap = await computeStatementSnapshot(prisma, a.id, d('2026-05-04'), d('2026-05-11'));
    expect(snap.adjustments?.map((x) => x.amount).sort()).toEqual([45, 8.25].sort());
    expect(snap.totals.adjustmentsAmount).toBe(53.25);
    expect(snap.totals.amount).toBeCloseTo(snap.totals.hoursAmount! + 53.25, 2);
    const st = await prisma.clientStatement.create({ data: { clientId: a.id, periodStart: d('2026-05-04'), periodEnd: d('2026-05-10'), snapshot: snap as object } });
    const claimed = await claimAdjustmentsForStatement(prisma, st.id, snap);
    expect(claimed.adjustments).toHaveLength(2);
    expect(await prisma.billingAdjustment.count({ where: { billedStatementId: st.id, status: 'BILLED' } })).toBe(2);
    const later = await computeStatementSnapshot(prisma, a.id, d('2026-05-11'), d('2026-05-18'));
    expect(later.adjustments).toBeUndefined();

    // Voiding the payroll: unbilled lines void, billed lines reverse on the next bill.
    const v = await onPayrollVoided(prisma, r.id, finance.id);
    expect(v).toEqual({ voided: 1, reversed: 2 });
    const reversals = await prisma.billingAdjustment.findMany({ where: { kind: 'REVERSAL' } });
    expect(reversals.map((x) => Number(x.amount)).sort((p, q) => p - q)).toEqual([-45, -8.25]);
  });

  it('a contract that bills overtime at straight time prices the over-40 hours at the bill rate', async () => {
    const c = await createClient('Straight Co');
    await terms(c.id, { overtimeBilling: 'STRAIGHT' });
    const ben = await createAssociate();
    for (let i = 0; i < 5; i++) await work(ben.id, c.id, new Date(Date.UTC(2026, 5, 8 + i, 13)), 9, 'Picker', { billRate: 30 });
    const snap = await computeStatementSnapshot(prisma, c.id, d('2026-06-06'), d('2026-06-13'));
    expect(snap.overtimeBilling).toBe('STRAIGHT');
    expect(snap.totals.hoursAmount).toBe(45 * 30);
    expect(snap.lines.some((l) => l.label.includes('straight time per contract'))).toBe(true);
  });
});

describe('margin per paycheck and the reconciliation', () => {
  async function reconWorld() {
    const client = await createClient('Coastal');
    await card(client.id, 'Picker', 20, 30);
    const rosa = await createAssociate({ firstName: 'Rosa', lastName: 'Diaz' });
    const today = d(new Date().toISOString().slice(0, 10));
    const start = new Date(today.getTime() - 40 * DAY);
    const end = new Date(start.getTime() + 13 * DAY);
    const ymd = (x: Date) => x.toISOString().slice(0, 10);
    // 10h on a finalized statement, 10h on none (a month ago: a gap, not "not yet").
    await work(rosa.id, client.id, new Date(start.getTime() + DAY + 13 * 3_600_000), 10, 'Picker');
    await work(rosa.id, client.id, new Date(start.getTime() + 8 * DAY + 13 * 3_600_000), 10, 'Picker');
    await prisma.clientStatement.create({ data: { clientId: client.id, periodStart: start, periodEnd: new Date(start.getTime() + 6 * DAY), status: 'FINAL', number: 7, snapshot: {} } });
    const r = await run(ymd(start), ymd(end));
    await item(r.id, rosa.id, 400, [{ kind: 'REGULAR', hours: 20, rate: 20, amount: 400 }], { employerFica: 24.8, employerMedicare: 5.8 });
    return { client, rosa, start, end, ymd };
  }

  it('billed, employer cost (wages + taxes + the rest of the burden) and margin; hours paid vs billed; the unbilled pay with its reason', async () => {
    const w = await reconWorld();
    const report = await reconcilePayPeriod(prisma, { periodStart: w.start, periodEnd: w.end, runWhere: { tenantId: ALTO_TENANT_ID } });
    expect(report.hours).toEqual({ paid: 20, billed: 10, onDraft: 0, unbilled: 10 });
    const [check] = report.paychecks;
    // 10h × $30 billed; cost $400 + $30.60 taxes + ($48 burden − $30.60) = $448.
    expect(check).toMatchObject({ clientName: 'Coastal', hours: 20, wages: 400, employerTaxes: 30.6, burden: 17.4, cost: 448, billed: 300, pending: 0, margin: -148 });
    expect(check.statements.map((s) => s.number)).toEqual([7]);
    expect(report.unbilled).toEqual([expect.objectContaining({ kind: 'HOURS', hours: 10, payAmount: 200, reason: 'NO_STATEMENT', clientName: 'Coastal' })]);
    expect(report.totals.gapPay).toBe(200);
  });

  it('a two-client week: the reconciliation prices each client’s hours exactly as its statement billed them — the overtime once, on the hours that ran past 40', async () => {
    const a = await createClient('Coastal A');
    const b = await createClient('Harbor B');
    await card(a.id, 'Picker', 20, 30);
    await card(b.id, 'Picker', 20, 30);
    const rosa = await createAssociate({ firstName: 'Rosa', lastName: 'Two' });
    const weekStart = startOfWeekUTC(new Date(Date.now() - 40 * DAY));
    const ymd = (x: Date) => x.toISOString().slice(0, 10);
    // Saturday–Tuesday 8 h at A (32), Wednesday–Thursday 8 h at B: 48 h, the last 8 overtime — all at B.
    for (let i = 0; i < 4; i++) await work(rosa.id, a.id, new Date(weekStart.getTime() + i * DAY + 9 * 3_600_000), 8, 'Picker');
    for (let i = 4; i < 6; i++) await work(rosa.id, b.id, new Date(weekStart.getTime() + i * DAY + 9 * 3_600_000), 8, 'Picker');
    const end = new Date(weekStart.getTime() + 6 * DAY);
    for (const c of [a, b]) await prisma.clientStatement.create({ data: { clientId: c.id, periodStart: d(ymd(weekStart)), periodEnd: d(ymd(end)), status: 'FINAL', number: c.id === a.id ? 11 : 12, snapshot: {} } });
    const r = await run(ymd(weekStart), ymd(end));
    await item(r.id, rosa.id, 1040, [
      { kind: 'REGULAR', hours: 40, rate: 20, amount: 800 },
      { kind: 'OVERTIME', hours: 8, rate: 30, amount: 240 },
    ]);
    const report = await reconcilePayPeriod(prisma, { periodStart: d(ymd(weekStart)), periodEnd: d(ymd(end)), runWhere: { tenantId: ALTO_TENANT_ID } });
    const billedTo = (name: string) => report.paychecks.find((p) => p.clientName === name)!.billed;
    const [snapA, snapB] = await Promise.all([a, b].map((c) => computeStatementSnapshot(prisma, c.id, d(ymd(weekStart)), new Date(end.getTime() + DAY))));
    // A: 32 × $30. B: 8 × $30 + 8 × $45. (Before, A was also billed the 8 overtime hours at 1.5×.)
    expect(snapA!.totals.hoursAmount).toBe(960);
    expect(snapB!.totals.hoursAmount).toBe(600);
    expect(billedTo('Coastal A')).toBe(960);
    expect(billedTo('Harbor B')).toBe(600);
  });

  it('the Finance desk and the Inbox: "$200.00 of billable pay is not on any statement"; a store-bound account is refused company-wide margin', async () => {
    const w = await reconWorld();
    const { user: finance } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const a = await loginAs(agent(), finance.email);
    const res = await a.get(`/pay-bill/reconciliation?periodStart=${w.ymd(w.start)}&periodEnd=${w.ymd(w.end)}`);
    expect(res.status).toBe(200);
    expect(res.body.totals.gapPay).toBe(200);
    expect((await a.get('/pay-bill/periods')).body.periods).toHaveLength(1);
    const inbox = await a.get('/me/inbox');
    const src = inbox.body.sources.find((s: { key: string }) => s.key === 'unbilled-pay');
    expect(src).toMatchObject({ count: 1, description: '$200.00 of billable pay is not on any statement.', path: '/finance/pay-bill' });

    const site = await prisma.site.create({ data: { clientId: w.client.id, name: 'Coastal 1' } });
    const { user: bound } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    await prisma.user.update({ where: { id: bound.id }, data: { scopeSiteIds: [site.id] } });
    const b = await loginAs(agent(), bound.email);
    expect((await b.get(`/pay-bill/reconciliation?periodStart=${w.ymd(w.start)}&periodEnd=${w.ymd(w.end)}`)).status).toBe(403);
  });

  it('contract terms: Finance sets them from a date (audited); billing is hidden where there are no clients', async () => {
    const client = await createClient('Coastal');
    const { user: finance } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const a = await loginAs(agent(), finance.email);
    expect((await a.get(`/pay-bill/clients/${client.id}/terms`)).body.current).toMatchObject({ retroRebill: 'REVIEW', overtimeBilling: 'MULTIPLIED', id: null });
    const body = {
      effectiveFrom: '2026-07-01',
      retroRebill: 'AUTO',
      overtimeBilling: 'STRAIGHT',
      defaultMarkupPct: 35,
      premiumRules: { DOUBLE_TIME: { mode: 'BILL_MARKUP' }, MEAL_REST: { mode: 'AT_COST', markupPct: 5 }, PREDICTABILITY: { mode: 'NOT_BILLABLE' }, HOLIDAY: { mode: 'NOT_BILLABLE' }, SHIFT_DIFFERENTIAL: { mode: 'AT_COST', markupPct: 0 } },
    };
    const put = await a.put(`/pay-bill/clients/${client.id}/terms`).send(body);
    expect(put.status).toBe(201);
    expect(put.body.current).toMatchObject({ retroRebill: 'AUTO', overtimeBilling: 'STRAIGHT', defaultMarkupPct: 35, effectiveFrom: '2026-07-01' });
    expect((await a.put(`/pay-bill/clients/${client.id}/terms`).send({ ...body, retroRebill: 'NEVER' })).status).toBe(200);
    await flushPendingAudits();
    expect((await prisma.auditLog.findMany({ where: { entityType: 'ClientBillingTerms' }, orderBy: { createdAt: 'asc' } })).map((x) => x.action)).toEqual(['billing.terms_set', 'billing.terms_corrected']);
    // An executive reads but cannot write.
    const { user: exec } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
    const e = await loginAs(agent(), exec.email);
    expect((await e.get(`/pay-bill/clients/${client.id}/terms`)).status).toBe(200);
    expect((await e.put(`/pay-bill/clients/${client.id}/terms`).send(body)).status).toBe(403);

    await setTenantProfile(ALTO_TENANT_ID, { businessModel: 'DIRECT_EMPLOYER', resetToDefaults: true }, finance.id);
    expect((await a.get(`/pay-bill/clients/${client.id}/terms`)).status).toBe(404);
    expect((await a.get('/pay-bill/running-cost')).status).toBe(200);
    await setTenantProfile(ALTO_TENANT_ID, { businessModel: 'WORKFORCE_PROVIDER', resetToDefaults: true }, finance.id);
  });

  it('ready adjustments can go out on a statement of their own', async () => {
    const w = await retroWorld('AUTO');
    await onPayrollFinalized(prisma, w.paid.id, w.finance.id);
    const a = await loginAs(agent(), w.finance.email);
    const res = await a.post(`/pay-bill/clients/${w.client.id}/adjustment-statement`);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ amount: 30, adjustments: 1 });
    const st = await prisma.clientStatement.findUniqueOrThrow({ where: { id: res.body.statementId } });
    expect(st.snapshot).toMatchObject({ adjustmentsOnly: true, totals: { amount: 30, hoursAmount: 0 } });
    const list = await a.get('/pay-bill/adjustments?status=READY');
    expect(list.body.adjustments[0]).toMatchObject({ amount: 30, clientName: 'Coastal', originalStatements: [{ number: 1042 }] });
  });
});

describe('running payroll cost per store', () => {
  it('this week so far at each store, loaded with the burden, inside the caller’s reach', async () => {
    pinMidweekNoon();
    const client = await createClient('Coastal');
    const s1 = await prisma.site.create({ data: { clientId: client.id, name: 'Coastal 1' } });
    const s2 = await prisma.site.create({ data: { clientId: client.id, name: 'Coastal 2' } });
    const ana = await createAssociate();
    await prisma.compensationRecord.create({ data: { associateId: ana.id, effectiveFrom: d('2026-01-01'), payType: 'HOURLY', amount: 20, reason: 'HIRE' } });
    const start = new Date(Date.now() - 6 * 3_600_000);
    await prisma.timeEntry.create({ data: { associateId: ana.id, clientId: client.id, locationId: s1.id, clockInAt: start, clockOutAt: new Date(start.getTime() + 5 * 3_600_000), status: 'COMPLETED' } });
    const ben = await createAssociate();
    await prisma.timeEntry.create({ data: { associateId: ben.id, clientId: client.id, locationId: s2.id, clockInAt: new Date(Date.now() - 2 * 3_600_000), status: 'ACTIVE' } });
    const { user: finance } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const res = await (await loginAs(agent(), finance.email)).get('/pay-bill/running-cost');
    expect(res.status).toBe(200);
    const one = res.body.stores.find((s: { siteName: string }) => s.siteName === 'Coastal 1');
    expect(one).toMatchObject({ hours: 5, wages: 100, loadedCost: 112, onClockNow: 0 });
    expect(res.body.totals.onClockNow).toBe(1);

    const { user: bound } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    await prisma.user.update({ where: { id: bound.id }, data: { scopeSiteIds: [s1.id] } });
    const mine = await (await loginAs(agent(), bound.email)).get('/pay-bill/running-cost');
    expect(mine.body.stores.map((s: { siteName: string }) => s.siteName)).toEqual(['Coastal 1']);
  });
});

describe('continuous net pay', () => {
  it('the week’s gross through the tax engine, less a week of the last check’s deductions and the early pay already drawn', async () => {
    const ana = await createAssociate();
    await prisma.associate.update({ where: { id: ana.id }, data: { state: 'FL' } });
    await prisma.w4Submission.create({ data: { associateId: ana.id, filingStatus: 'SINGLE' } });
    // A biweekly check with $60 pre-tax benefits (no retirement): $30 a week.
    const r = await run('2026-09-26', '2026-10-09');
    await item(r.id, ana.id, 800, [{ kind: 'REGULAR', hours: 40, rate: 20, amount: 800 }], { preTaxDeductions: 60 });
    await prisma.earnedWageAdvance.create({ data: { associateId: ana.id, periodStart: d('2026-10-10'), periodEnd: d('2026-10-23'), amountCents: 5000, earnedNetCents: 20000, availableCents: 10000, status: 'PAID', paidAt: new Date() } });
    const t = await estimateTakeHome(prisma, ana.id, 500, new Date('2026-10-18T12:00:00Z'));
    expect(t.basis).toBe('W4');
    expect(t.deductions).toBe(30);
    expect(t.advances).toBe(50);
    expect(t.socialSecurity).toBe(29.14); // 6.2% of $470
    expect(t.stateIncomeTax).toBe(0); // Florida
    expect(t.federalIncomeTax).toBeGreaterThan(0);
    expect(t.net).toBeCloseTo(500 - t.taxes - 30 - 50, 2);

    // A contractor has nothing withheld.
    const cy = await createAssociate();
    await prisma.associate.update({ where: { id: cy.id }, data: { employmentType: 'CONTRACTOR_1099_INDIVIDUAL' } });
    expect(await estimateTakeHome(prisma, cy.id, 500)).toMatchObject({ basis: 'NO_WITHHOLDING', taxes: 0, net: 500 });
  });

  it('on the associate’s pay hero and in the clock-out push', async () => {
    pinMidweekNoon();
    const ana = await createAssociate();
    await prisma.w4Submission.create({ data: { associateId: ana.id, filingStatus: 'SINGLE' } });
    const { user } = await createUser({ role: 'ASSOCIATE', associateId: ana.id });
    const entry = await prisma.timeEntry.create({ data: { associateId: ana.id, clockInAt: new Date(Date.now() - 5 * 3_600_000), clockOutAt: new Date(), status: 'COMPLETED' } });
    const res = await (await loginAs(agent(), user.email)).get('/time/me/earnings');
    expect(res.status).toBe(200);
    expect(res.body.takeHome.net).toBeGreaterThan(0);
    expect(res.body.takeHome.net).toBeLessThan(res.body.earnedSoFar);
    await notifyClockOutEarnings(prisma, entry.id);
    await flushPendingNotifications();
    const n = await prisma.notification.findFirstOrThrow({ where: { recipientUserId: user.id, category: 'earnings' } });
    expect(n.body).toMatch(/About \$\d+\.\d{2} take-home so far this week\./);
  });
});
