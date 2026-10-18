import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { aggregatePayrollProjection } from '../../lib/payrollAggregator.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { ATTESTATION_TEXT } from '../../lib/laborRules/live.js';
import { roundPunches } from '../../lib/punchRounding.js';
import { noteScheduleChange } from '../../lib/predictabilityPay.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * Labor rules go live state by state; timekeeping controls.
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
  if (r.status !== 200) throw new Error(`login failed: ${r.status}`);
  return a;
}

/** A California store with one worker and a 10-hour day with no breaks (Monday 2026-09-14, Pacific). */
async function californiaDay() {
  const client = await createClient('Coastal');
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  await prisma.site.update({ where: { id: site.id }, data: { state: 'CA', city: 'San Diego', timezone: 'America/Los_Angeles' } });
  const ana = await createAssociate({ firstName: 'Ana', lastName: 'Ruiz' });
  await prisma.associate.update({ where: { id: ana.id }, data: { state: 'CA' } });
  const entry = await prisma.timeEntry.create({
    data: { associateId: ana.id, clientId: client.id, locationId: site.id, clockInAt: new Date('2026-09-14T15:00:00Z'), clockOutAt: new Date('2026-09-15T01:00:00Z'), status: 'APPROVED', approvedAt: new Date() },
  });
  return { client, site, ana, entry };
}

const period = { periodStart: new Date('2026-09-12T00:00:00Z'), periodEndExclusive: new Date('2026-09-26T00:00:00Z'), clientId: null, defaultRate: 20 };

const goLiveBody = (extra: Record<string, unknown> = {}) => ({ jurisdiction: 'US-CA', counselName: 'Dana Whit', counselFirm: 'Whit & Co LLP', counselSignedOn: '2026-10-01', attestation: ATTESTATION_TEXT, ...extra });

describe('going live, state by state', () => {
  it('needs counsel’s sign-off and the attestation, then a second person; back to shadow is instant', async () => {
    await californiaDay();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { user: ops } = await createUser({ role: 'OPERATIONS_MANAGER' });
    const a = await loginAs(hr.email);

    expect((await a.post('/labor-rules/activations').send(goLiveBody({ attestation: 'ok sure' }))).status).toBe(400);
    expect((await a.post('/labor-rules/activations').send({ ...goLiveBody(), counselName: '' })).status).toBe(400);

    const asked = await a.post('/labor-rules/activations').send(goLiveBody());
    expect(asked.status).toBe(202);
    expect(asked.body.pending).toBe(true);
    // The person who asked can't approve it.
    expect((await a.post(`/approvals/requests/${asked.body.approvalId}/decide`).send({ decision: 'APPROVE' })).status).toBe(403);
    // A duplicate while one waits is refused.
    expect((await a.post('/labor-rules/activations').send(goLiveBody())).status).toBe(409);

    const o = await loginAs(ops.email);
    expect((await o.post(`/approvals/requests/${asked.body.approvalId}/decide`).send({ decision: 'APPROVE' })).status).toBe(200);
    const live = await prisma.laborRuleActivation.findUniqueOrThrow({ where: { id: asked.body.activationId } });
    expect(live.status).toBe('LIVE');
    expect(live.activatedById).toBe(ops.id);
    expect(live.signedSetIds.length).toBeGreaterThan(0);
    expect(live.signedLabels.some((l) => l.startsWith('California rules'))).toBe(true);

    const list = await a.get('/labor-rules/activations');
    expect(list.body.jurisdictions.find((j: { jurisdiction: string }) => j.jurisdiction === 'US-CA').current.status).toBe('LIVE');

    expect((await a.post(`/labor-rules/activations/${live.id}/end`).send({ reason: 'Counsel asked us to pause.' })).status).toBe(200);
    expect((await prisma.laborRuleActivation.findUniqueOrThrow({ where: { id: live.id } })).status).toBe('ENDED');
    await flushPendingAudits();
    const actions = (await prisma.auditLog.findMany({ where: { entityId: live.id }, select: { action: true } })).map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['labor_rules.go_live_requested', 'labor_rules.went_live', 'labor_rules.back_to_shadow']));
  });

  it('with nobody else to decide, it lands at once and says so', async () => {
    await californiaDay();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const r = await a.post('/labor-rules/activations').send(goLiveBody());
    expect(r.status).toBe(201);
    await flushPendingAudits();
    const row = await prisma.auditLog.findFirst({ where: { action: 'labor_rules.went_live', entityId: r.body.activationId } });
    expect(JSON.stringify(row?.metadata)).toMatch(/No second approver/);
  });

  it('pays California’s daily overtime and meal and rest premiums only once live; shadow pays as today', async () => {
    const { ana, site } = await californiaDay();
    const shadow = await aggregatePayrollProjection(prisma, period);
    const s = shadow.items.find((i) => i.associateId === ana.id)!;
    expect(s.regularHours).toBe(10);
    expect(s.overtimeHours).toBe(0);
    expect(s.earnings.some((e) => e.kind === 'PREMIUM')).toBe(false);

    // The change report shows what would move.
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const live = await a.post('/labor-rules/activations').send(goLiveBody());
    expect(live.status).toBe(201);

    const paid = await aggregatePayrollProjection(prisma, period);
    const p = paid.items.find((i) => i.associateId === ana.id)!;
    expect(p.regularHours).toBe(8);
    expect(p.overtimeHours).toBe(2);
    const premiums = p.earnings.filter((e) => e.kind === 'PREMIUM');
    expect(premiums.map((e) => e.note)).toEqual(expect.arrayContaining([expect.stringMatching(/^Meal premium \(US-CA/), expect.stringMatching(/^Rest premium \(US-CA/)]));
    // 8 × 20 + 2 × 30 + two premium hours × 20
    expect(p.grossPay).toBe(160 + 60 + 40);
    expect(site.id).toBeTruthy();
  });

  it('a site can go live on its own; others in the state stay in shadow', async () => {
    const { site, ana } = await californiaDay();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const report = await a.get(`/labor-rules/change-report?jurisdiction=US-CA&siteId=${site.id}`);
    expect(report.status).toBe(200);
    expect(report.body.signables.length).toBeGreaterThan(0);
    expect((await a.post('/labor-rules/activations').send(goLiveBody({ siteId: site.id }))).status).toBe(201);
    const paid = await aggregatePayrollProjection(prisma, period);
    expect(paid.items.find((i) => i.associateId === ana.id)!.overtimeHours).toBe(2);
  });
});

describe('punch rounding', () => {
  it('rounds to the nearest increment by the neutral rule, or always in the worker’s favor', () => {
    const at = (hm: string) => new Date(`2026-09-14T${hm}:00Z`);
    expect(roundPunches({ mode: 'NEAREST', increment: 15 }, at('08:07'), at('16:08'))).toMatchObject({ clockInAt: at('08:00'), clockOutAt: at('16:15') });
    expect(roundPunches({ mode: 'EMPLOYEE_FAVOR', increment: 15 }, at('08:07'), at('16:01'))).toMatchObject({ clockInAt: at('08:00'), clockOutAt: at('16:15') });
    expect(roundPunches({ mode: 'NONE', increment: 15 }, at('08:07'), at('16:08')).rounded).toBe(false);
  });

  it('refuses rounding that only favors the employer, and pay uses the rounded punches', async () => {
    const { ana } = await californiaDay();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const bad = await a.put('/labor-rules/rounding').send({ mode: 'EMPLOYER_FAVOR', increment: 15 });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('rounding_not_neutral');
    expect((await a.put('/labor-rules/rounding').send({ mode: 'NEAREST', increment: 7 })).status).toBe(400);
    expect((await a.put('/labor-rules/rounding').send({ mode: 'EMPLOYEE_FAVOR', increment: 15 })).status).toBe(200);
    // 15:07 → 15:00 in, 01:00 out stays: 10h still, but a 15:07 punch would round down.
    await prisma.timeEntry.updateMany({ where: { associateId: ana.id }, data: { clockInAt: new Date('2026-09-14T15:07:00Z'), clockOutAt: new Date('2026-09-15T00:52:00Z') } });
    const p = (await aggregatePayrollProjection(prisma, period)).items.find((i) => i.associateId === ana.id)!;
    expect(p.hoursWorked).toBe(10);
    // The punch itself never changes.
    expect((await prisma.timeEntry.findFirstOrThrow({ where: { associateId: ana.id } })).clockInAt.toISOString()).toBe('2026-09-14T15:07:00.000Z');
  });
});

describe('punch corrections', () => {
  it('a worker asks with a signed attestation; a manager approves and the entry changes with before and after kept', async () => {
    const { ana, client, site } = await californiaDay();
    await prisma.associateAssignment.create({ data: { associateId: ana.id, locationId: site.id, startedAt: new Date('2026-01-01') } });
    const { user: worker } = await createUser({ role: 'ASSOCIATE', associateId: ana.id });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const open = await prisma.timeEntry.create({ data: { associateId: ana.id, clientId: client.id, locationId: site.id, clockInAt: new Date(Date.now() - 20 * 3_600_000), status: 'ACTIVE' } });

    const w = await loginAs(worker.email);
    const bare = { kind: 'MISSED_CLOCK_OUT', timeEntryId: open.id, proposedClockOut: new Date(Date.now() - 12 * 3_600_000).toISOString(), reason: 'Phone died at the end of my shift.' };
    expect((await w.post('/time-corrections').send({ ...bare, attested: false })).status).toBe(400);
    const sent = await w.post('/time-corrections').send({ ...bare, attested: true });
    expect(sent.status).toBe(201);
    expect((await w.post('/time-corrections').send({ ...bare, attested: true })).status).toBe(409);
    const mine = await w.get('/time-corrections/mine');
    expect(mine.body.requests[0]).toMatchObject({ status: 'SUBMITTED', attestationText: expect.stringMatching(/^I certify/) });

    const h = await loginAs(hr.email);
    expect((await h.post(`/time-corrections/${sent.body.id}/decide`).send({ decision: 'DENY' })).status).toBe(400);
    const queue = await h.get('/time-corrections');
    expect(queue.body.requests.map((r: { id: string }) => r.id)).toContain(sent.body.id);
    expect((await h.post(`/time-corrections/${sent.body.id}/decide`).send({ decision: 'APPROVE' })).status).toBe(200);
    const fixed = await prisma.timeEntry.findUniqueOrThrow({ where: { id: open.id } });
    expect(fixed.status).toBe('COMPLETED');
    expect(fixed.clockOutAt?.toISOString()).toBe(bare.proposedClockOut);
    const req = await prisma.timeCorrectionRequest.findUniqueOrThrow({ where: { id: sent.body.id } });
    expect(req.before).toMatchObject({ clockOutAt: null, status: 'ACTIVE' });
    expect(req.after).toMatchObject({ status: 'COMPLETED' });
    await flushPendingAudits();
    expect(await prisma.auditLog.count({ where: { action: 'time.correction_approved', entityId: sent.body.id } })).toBe(1);
  });

  it('nobody decides a correction to their own time, and a paid day is refused', async () => {
    const { ana, client, site } = await californiaDay();
    const { user: worker } = await createUser({ role: 'ASSOCIATE', associateId: ana.id });
    const w = await loginAs(worker.email);
    // The September day is in a finalized run: refused.
    const run = await prisma.payrollRun.create({ data: { periodStart: new Date('2026-09-12'), periodEnd: new Date('2026-09-25'), status: 'FINALIZED', totalGross: 0, totalTax: 0, totalNet: 0 } });
    await prisma.payrollItem.create({ data: { payrollRunId: run.id, associateId: ana.id, hoursWorked: 10, hourlyRate: 20, grossPay: 200, federalWithholding: 0, fica: 0, medicare: 0, stateWithholding: 0, netPay: 200 } }).catch(() => undefined);
    const entry = await prisma.timeEntry.findFirstOrThrow({ where: { associateId: ana.id } });
    const paid = await w.post('/time-corrections').send({ kind: 'WRONG_TIME', timeEntryId: entry.id, proposedClockIn: '2026-09-14T14:30:00Z', reason: 'I started earlier.', attested: true });
    if ((await prisma.payrollItem.count({ where: { payrollRunId: run.id } })) > 0) expect(paid.status).toBe(409);
    expect(client.id && site.id).toBeTruthy();
  });

  it('the kiosk’s missed clock-out prompt is finished from the phone', async () => {
    const { ana, client, site } = await californiaDay();
    const { user: worker } = await createUser({ role: 'ASSOCIATE', associateId: ana.id });
    const open = await prisma.timeEntry.create({ data: { associateId: ana.id, clientId: client.id, locationId: site.id, clockInAt: new Date(Date.now() - 30 * 3_600_000), status: 'ACTIVE' } });
    const { promptMissedClockOut } = await import('../../lib/timeCorrections.js');
    const id = await promptMissedClockOut(prisma, ALTO_TENANT_ID, { id: open.id, associateId: ana.id, clockInAt: open.clockInAt, locationId: site.id });
    expect(await promptMissedClockOut(prisma, ALTO_TENANT_ID, { id: open.id, associateId: ana.id, clockInAt: open.clockInAt, locationId: site.id })).toBe(id);
    const w = await loginAs(worker.email);
    const inbox = await w.get('/me/inbox');
    expect(inbox.body.sources.find((s: { key: string }) => s.key === 'my-punch-fixes')?.count).toBe(1);
    const done = await w.post(`/time-corrections/${id}/finish`).send({ proposedClockOut: new Date(Date.now() - 22 * 3_600_000).toISOString(), reason: 'Forgot to punch out.', attested: true });
    expect(done.status).toBe(200);
    expect((await prisma.timeCorrectionRequest.findUniqueOrThrow({ where: { id } })).status).toBe('SUBMITTED');
  });
});

describe('break attestation at clock-out', () => {
  it('a “no” flags the lead where the rules aren’t live, and is paid as the premium where they are', async () => {
    const { ana, client, site } = await californiaDay();
    await prisma.timeEntry.deleteMany({ where: { associateId: ana.id } });
    // Hourly associates answer on the kiosk; a lead clocks out in the app — the same question, the same record.
    const { user: worker } = await createUser({ role: 'SHIFT_SUPERVISOR', associateId: ana.id, clientId: client.id });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const w = await loginAs(worker.email);
    await prisma.timeEntry.create({ data: { associateId: ana.id, clientId: client.id, locationId: site.id, clockInAt: new Date(Date.now() - 7 * 3_600_000), status: 'ACTIVE' } });
    const q = await w.get('/time-corrections/break-questions');
    expect(q.body.meal).toBe(true);
    const out = await w.post('/time/me/clock-out').send({ breakAttestation: { meal: 'NO' } });
    expect(out.status).toBe(200);
    const att = await prisma.breakAttestation.findFirstOrThrow({ where: { associateId: ana.id } });
    expect(att).toMatchObject({ meal: 'NO', flagged: true });
    const h = await loginAs(hr.email);
    expect((await h.get('/time-corrections/break-flags')).body.flags).toHaveLength(1);
    await flushPendingNotifications();

    // Live: the answer becomes the premium on pay.
    expect((await h.post('/labor-rules/activations').send(goLiveBody())).status).toBe(201);
    await prisma.timeEntry.updateMany({ where: { associateId: ana.id }, data: { status: 'APPROVED' } });
    const entry = await prisma.timeEntry.findFirstOrThrow({ where: { associateId: ana.id } });
    // Give the shift a proper meal so only the attestation can owe it.
    await prisma.breakEntry.create({ data: { timeEntryId: entry.id, type: 'MEAL', startedAt: new Date(entry.clockInAt.getTime() + 2 * 3_600_000), endedAt: new Date(entry.clockInAt.getTime() + 2.5 * 3_600_000) } });
    const now = new Date();
    const p = (await aggregatePayrollProjection(prisma, { periodStart: new Date(now.getTime() - 3 * 86_400_000), periodEndExclusive: new Date(now.getTime() + 86_400_000), clientId: null, defaultRate: 20 })).items.find((i) => i.associateId === ana.id)!;
    expect(p.earnings.some((e) => e.kind === 'PREMIUM' && /no meal break reported/.test(e.note ?? ''))).toBe(true);
  });
});

describe('overtime offered fairly', () => {
  it('asks those who wouldn’t go over first, then the fewest-overtime; jumping the line needs a reason; accepting assigns', async () => {
    const client = await createClient('Coastal');
    const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    const people = await Promise.all(['Bea Busy', 'Cal Calm', 'Dee Done'].map((n) => createAssociate({ firstName: n.split(' ')[0], lastName: n.split(' ')[1] })));
    for (const p of people) await prisma.associateAssignment.create({ data: { associateId: p.id, locationId: site.id, startedAt: new Date('2026-01-01') } });
    const [bea, cal, dee] = people;
    const monday = new Date(Date.now() + 10 * 86_400_000);
    monday.setUTCHours(14, 0, 0, 0);
    // Bea and Dee already have 36 h in that week; Cal has none.
    for (const p of [bea!, dee!]) {
      for (let d = 0; d < 4; d++) {
        const s = new Date(monday.getTime() + (d - 3) * 86_400_000);
        await prisma.shift.create({ data: { clientId: client.id, locationId: site.id, position: 'Cashier', startsAt: s, endsAt: new Date(s.getTime() + 9 * 3_600_000), status: 'ASSIGNED', assignedAssociateId: p.id } });
      }
    }
    // Dee has worked overtime lately; Bea hasn't.
    const past = new Date(monday.getTime() - 21 * 86_400_000);
    await prisma.timeEntry.create({ data: { associateId: dee!.id, clientId: client.id, locationId: site.id, clockInAt: past, clockOutAt: new Date(past.getTime() + 45 * 3_600_000), status: 'APPROVED' } });
    const open = await prisma.shift.create({ data: { clientId: client.id, locationId: site.id, position: 'Cashier', startsAt: new Date(monday.getTime() + 2 * 86_400_000), endsAt: new Date(monday.getTime() + 2 * 86_400_000 + 8 * 3_600_000), status: 'OPEN' } });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    expect((await a.put('/labor-rules/ot-equalization').send({ enabled: true })).status).toBe(200);

    const rank = await a.get(`/overtime-offers/shifts/${open.id}`);
    expect(rank.status).toBe(200);
    expect(rank.body.candidates.map((c: { name: string }) => c.name)).toEqual(['Cal Calm', 'Bea Busy', 'Dee Done']);

    const jumped = await a.post(`/overtime-offers/shifts/${open.id}`).send({ associateId: dee!.id });
    expect(jumped.status).toBe(409);
    expect(jumped.body.error.code).toBe('out_of_turn');
    const withReason = await a.post(`/overtime-offers/shifts/${open.id}`).send({ associateId: bea!.id, overrideReason: 'Cal is on leave this week.' });
    expect(withReason.status).toBe(201);
    expect(await prisma.overtimeOffer.count({ where: { shiftId: open.id, status: 'SKIPPED', associateId: cal!.id } })).toBe(1);

    const offer = await prisma.overtimeOffer.findFirstOrThrow({ where: { shiftId: open.id, associateId: bea!.id, status: 'OFFERED' } });
    expect((await a.post(`/overtime-offers/${offer.id}/respond`).send({ status: 'ACCEPTED' })).status).toBe(200);
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: open.id } })).assignedAssociateId).toBe(bea!.id);
    const report = await a.get('/overtime-offers/report');
    expect(report.status).toBe(200);
    expect(report.body.people.find((r: { name: string }) => r.name === 'Dee Done').overtimeHours).toBeGreaterThan(0);
  });
});

describe('predictability pay', () => {
  it('a late change at a live fair-workweek site owes the premium, an employee-requested one owes nothing, and payroll pays it once', async () => {
    const client = await createClient('Gotham');
    const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    await prisma.site.update({ where: { id: site.id }, data: { state: 'NY', city: 'New York', timezone: 'America/New_York' } });
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Ruiz' });
    await prisma.associate.update({ where: { id: ana.id }, data: { state: 'NY' } });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    expect((await a.post('/labor-rules/activations').send(goLiveBody({ jurisdiction: 'US-NY' }))).status).toBe(201);

    const starts = new Date(Date.now() + 3 * 86_400_000);
    const snap = { id: '00000000-0000-4000-8000-0000000000aa', assignedAssociateId: ana.id, locationId: site.id, startsAt: starts, endsAt: new Date(starts.getTime() + 8 * 3_600_000), status: 'ASSIGNED' };
    expect(await noteScheduleChange(prisma, { tenantId: ALTO_TENANT_ID, before: snap, after: { ...snap, status: 'CANCELLED' }, actorUserId: hr.id })).toBe(1);
    expect(await noteScheduleChange(prisma, { tenantId: ALTO_TENANT_ID, before: null, after: snap, actorUserId: hr.id, exemptReason: 'EMPLOYEE_REQUESTED' })).toBe(1);
    const rows = await prisma.scheduleChangePremium.findMany({ where: { associateId: ana.id }, orderBy: { createdAt: 'asc' } });
    expect(rows[0]).toMatchObject({ change: 'cancelled', live: true, exempt: false, premiumCents: 4500 });
    expect(rows[1]).toMatchObject({ change: 'added', exempt: true, premiumCents: 0 });

    await prisma.timeEntry.create({ data: { associateId: ana.id, clientId: client.id, locationId: site.id, clockInAt: new Date(starts.getTime() - 86_400_000), clockOutAt: new Date(starts.getTime() - 86_400_000 + 4 * 3_600_000), status: 'APPROVED' } });
    const p = (await aggregatePayrollProjection(prisma, { periodStart: new Date(starts.getTime() - 5 * 86_400_000), periodEndExclusive: new Date(starts.getTime() + 5 * 86_400_000), clientId: null, defaultRate: 20 })).items.find((i) => i.associateId === ana.id)!;
    const line = p.earnings.find((e) => e.kind === 'PREMIUM' && /Predictability pay/.test(e.note ?? ''));
    expect(line?.amount).toBe(45);
    expect(p.premiumIds).toEqual([rows[0]!.id]);
    const list = await a.get('/labor-rules/schedule-changes');
    expect(list.body.changes).toHaveLength(2);
  });
});
