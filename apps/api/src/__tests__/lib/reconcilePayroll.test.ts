import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ACTIVE_COUNT_SITES } from '../../lib/activeInventory.js';
import { columnMapFromArg, parseCsv, parsePayrollCsv, persistReconciliation, platformSide, reconcile, reconcileCsv, reconcileMarkdown, runReconciliation } from '../../lib/reconcilePayroll.js';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createClient, prisma, truncateAll, createUser } from '../../../test/db.js';

/**
 * Reconciliation report (Brief 1A-1).
 *
 *   The platform side is what the payroll engine would pay; a payroll
 *   export is read through the column map; every nonzero difference is a
 *   line with its cause; the totals carry the variance; the inventory of
 *   active-count computations is printed and points at files that exist.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const START = '2026-09-26';
const END = '2026-10-09';
const NOW = new Date('2026-10-10T15:00:00.000Z');

async function world() {
  const client = await createClient('Coastal Resort');
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  const mk = async (first: string, last: string, email: string, rate: number) => {
    const a = await createAssociate({ firstName: first, lastName: last, email });
    await prisma.associateAssignment.create({ data: { associateId: a.id, locationId: site.id, startedAt: new Date('2026-05-01') } });
    await prisma.compensationRecord.create({ data: { associateId: a.id, payType: 'HOURLY', amount: rate, currency: 'USD', reason: 'HIRE', effectiveFrom: new Date('2026-05-01T00:00:00Z') } });
    return a;
  };
  const entry = (associateId: string, day: string, hours: number, status: 'APPROVED' | 'COMPLETED' | 'REJECTED' = 'APPROVED') =>
    prisma.timeEntry.create({
      data: { associateId, clientId: client.id, clockInAt: new Date(`${day}T13:00:00.000Z`), clockOutAt: new Date(`${day}T${String(13 + hours).padStart(2, '0')}:00:00.000Z`), status },
    });
  const ana = await mk('Ana', 'Lopez', 'ana@example.com', 16);
  const bo = await mk('Bo', 'Chen', 'bo@example.com', 15);
  const cy = await mk('Cy', 'Diaz', 'cy@example.com', 18);
  // Ana: 8 + 8 approved. Bo: 8 approved + 4 waiting for approval. Cy: nothing this period, separated.
  await entry(ana.id, '2026-09-28', 8);
  await entry(ana.id, '2026-09-29', 8);
  await entry(bo.id, '2026-09-30', 8);
  await entry(bo.id, '2026-10-01', 4, 'COMPLETED');
  await prisma.associate.update({ where: { id: cy.id }, data: { separatedAt: new Date('2026-09-20T00:00:00Z') } });
  return { client, site, ana, bo, cy };
}

describe('the platform side', () => {
  it('pays what the engine pays, names the rate source, counts pending entries and classifies status', async () => {
    const w = await world();
    const p = await platformSide(prisma, { start: START, end: END }, NOW);
    const by = Object.fromEntries(p.rows.map((r) => [r.email, r]));
    expect(by['ana@example.com']).toMatchObject({ hours: 16, rate: 16, rateSource: 'COMP', compRate: 16, gross: 256, pendingEntries: 0, status: 'ACTIVE' });
    expect(by['bo@example.com']).toMatchObject({ hours: 8, rate: 15, gross: 120, pendingEntries: 1, status: 'ACTIVE' });
    expect(by['cy@example.com']).toMatchObject({ hours: 0, rateSource: 'NONE', compRate: 18, status: 'SEPARATED' });
    expect(p.headcount).toMatchObject({ activeByDefinition: 2, paidByPlatform: 2, onFile: 3, windowDays: 14 });
    expect(p.totals).toEqual({ hours: 24, gross: 376 });
    void w;
  });
});

describe('the payroll export', () => {
  it('reads quoted CSV through the column map and reports the columns it could not find', () => {
    expect(parseCsv('a,b\n"x, y","he said ""hi"""\n')).toEqual([['a', 'b'], ['x, y', 'he said "hi"']]);
    const csv = 'Email,First Name,Last Name,Reg Hours,OT Hours,Rate,Gross Pay,Status\nana@example.com,Ana,Lopez,"1,6.0",0,$16.00,"$256.00",Active\n';
    const map = columnMapFromArg('hours=Reg Hours,overtimeHours=OT Hours,gross=Gross Pay');
    const { rows, missingColumns } = parsePayrollCsv(csv, map);
    expect(missingColumns).toEqual(['employeeNumber']);
    expect(rows[0]).toMatchObject({ email: 'ana@example.com', name: 'Ana Lopez', hours: 16, rate: 16, gross: 256, status: 'Active', line: 2 });
  });

  it('tries the usual header names when a default is absent, and never reads a total-hours column as regular hours', () => {
    const csv = 'Email Address,Employee ID,First Name,Last Name,Regular Hours,OT Hours,Total Hours,Pay Rate,Gross Pay,Employee Status\nana@example.com,1042,Ana,Lopez,40,4,44,$16.00,"$736.00",Active\n';
    const { rows, missingColumns } = parsePayrollCsv(csv);
    expect(missingColumns).toEqual([]);
    expect(rows[0]).toMatchObject({ email: 'ana@example.com', employeeNumber: '1042', hours: 44, rate: 16, gross: 736, status: 'Active' });
    // An explicit --map is taken at its word: no fallback behind it.
    const mapped = parsePayrollCsv(csv, columnMapFromArg('hours=Straight Time'));
    expect(mapped.missingColumns).toEqual(['hours']);
  });
});

describe('the comparison', () => {
  it('lists every nonzero variance with its cause, totals both sides, and ranks the causes', async () => {
    await world();
    const csv = [
      'Email,First Name,Last Name,Hours,Rate,Gross,Status',
      'ana@example.com,Ana,Lopez,16,16,256,Active', // matches
      'bo@example.com,Bo,Chen,12,15,180,Active', // payroll paid the 4 unapproved hours
      'cy@example.com,Cy,Diaz,8,18,144,Active', // separated on the platform, paid by payroll
      'dee@example.com,Dee,Park,20,15,300,Active', // not on the platform
    ].join('\n');
    const { result, csv: out, markdown } = await runReconciliation(prisma, { start: START, end: END, payrollCsv: csv, now: NOW });
    expect(result.payrollProvided).toBe(true);
    // This export has no employee number and no overtime column; both are reported, nothing else.
    expect(result.missingColumns).toEqual(['employeeNumber', 'overtimeHours']);
    expect(result.lines).toHaveLength(4);
    const by = Object.fromEntries(result.lines.map((l) => [l.key, l]));
    expect(by['ana@example.com'].causes).toEqual([]);
    expect(by['bo@example.com']).toMatchObject({ hoursDiff: -4, grossDiff: -60, causes: ['Hours differ and the platform has unapproved time entries'] });
    expect(by['cy@example.com']).toMatchObject({ hoursDiff: -8, platformStatus: 'SEPARATED', causes: expect.arrayContaining(['Separated on the platform but paid hours']) });
    expect(by['dee@example.com']).toMatchObject({ platformHours: null, payrollHours: 20, causes: ['On payroll, not found on the platform'] });
    expect(result.variances.map((v) => v.key).sort()).toEqual(['bo@example.com', 'cy@example.com', 'dee@example.com']);
    expect(result.totals).toEqual({
      headcount: { platformActive: 2, platformPaid: 2, payrollPaid: 4, variance: -2 },
      hours: { platform: 24, payroll: 56, variance: -32 },
      gross: { platform: 376, payroll: 880, variance: -504 },
    });
    expect(result.topCauses[0]).toMatchObject({ lines: 1 });
    expect(result.topCauses.length).toBeGreaterThanOrEqual(3);
    expect(out.split('\n')[0]).toBe('key,name,platformHours,payrollHours,hoursDiff,platformRate,payrollRate,rateDiff,platformGross,payrollGross,grossDiff,platformStatus,payrollStatus,causes');
    expect(markdown).toContain('| Total gross | $376.00 | $880.00 | $-504.00 |');
    expect(markdown).toContain('Definition of active');
  });

  it('runs platform-only when there is no export, and says so', async () => {
    await world();
    const { result, markdown } = await runReconciliation(prisma, { start: START, end: END, now: NOW });
    expect(result.payrollProvided).toBe(false);
    expect(result.variances).toEqual([]);
    expect(markdown).toContain('No payroll export was given');
    const r = reconcile(await platformSide(prisma, { start: START, end: END }, NOW), null);
    expect(reconcileCsv(r).split('\n')).toHaveLength(5);
    expect(reconcileMarkdown(r, await platformSide(prisma, { start: START, end: END }, NOW))).toContain('| Paid this period | 2 | — | — |');
  });
});

describe('the self-check', () => {
  it('reconciles the engine of today against the finalized runs for the period: zero variance, and the snapshot says what it compared', async () => {
    await world();
    // No finalized run yet: nothing to compare, and it says so.
    const empty = await runReconciliation(prisma, { start: START, end: END, now: NOW, selfCheck: true });
    expect(empty.result.payrollProvided).toBe(false);
    expect(empty.result.payrollSource).toBeNull();

    // The platform's own run for the period, finalized.
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(agent(), hr.email);
    const run = await a.post('/payroll/runs').send({ periodStart: START, periodEnd: END });
    expect(run.status).toBe(201);
    await prisma.payrollRun.update({ where: { id: run.body.id }, data: { status: 'FINALIZED' } });

    const { result } = await runReconciliation(prisma, { start: START, end: END, now: NOW, selfCheck: true });
    expect(result.payrollProvided).toBe(true);
    expect(result.payrollSource).toBe('platform-runs');
    expect(result.variances).toEqual([]);
    expect(result.totals.hours.variance).toBe(0);
    expect(result.totals.gross.variance).toBe(0);
    expect(result.totals.headcount.variance).toBe(0);

    const id = await persistReconciliation(prisma, result, (await runReconciliation(prisma, { start: START, end: END, now: NOW, selfCheck: true })).platform, NOW);
    const snap = await prisma.reconciliationSnapshot.findUniqueOrThrow({ where: { id } });
    expect(snap.payrollProvided).toBe(true);
    expect(snap.varianceLines).toBe(0);
    expect(Number(snap.payrollHours)).toBe(Number(snap.platformHours));
    expect(snap.notes).toMatch(/Self-check/);
    expect(snap.notes).toMatch(/Synchros/);
    // The Headcount screen reads it.
    const overview = await a.get('/headcount/overview');
    expect(overview.body.reconciliation).toMatchObject({ payrollProvided: true, varianceLines: 0 });
  });

  it('Brief 2-1b: a direct employer with no clients reconciles too — client-less time at a site, zero variance', async () => {
    // A property with no client, one team member placed there, approved hours with no client on them.
    const site = await prisma.site.create({ data: { name: 'The Grand Hotel', clientId: null, type: 'PROPERTY', timezone: 'America/Chicago' } });
    const tess = await createAssociate({ firstName: 'Tess', lastName: 'Member', email: 'tess@example.com' });
    await prisma.associateAssignment.create({ data: { associateId: tess.id, locationId: site.id, startedAt: new Date('2026-05-01') } });
    await prisma.compensationRecord.create({ data: { associateId: tess.id, payType: 'HOURLY', amount: 17, currency: 'USD', reason: 'HIRE', effectiveFrom: new Date('2026-05-01T00:00:00Z') } });
    for (const day of ['2026-09-28', '2026-09-29']) {
      await prisma.timeEntry.create({
        data: { associateId: tess.id, clientId: null, locationId: site.id, clockInAt: new Date(`${day}T13:00:00.000Z`), clockOutAt: new Date(`${day}T21:00:00.000Z`), status: 'APPROVED' },
      });
    }

    const platform = await platformSide(prisma, { start: START, end: END }, NOW);
    const row = platform.rows.find((r) => r.associateId === tess.id);
    expect(row, 'the client-less hours are on the platform side').toBeTruthy();
    expect(row!.hours).toBe(16);

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(agent(), hr.email);
    const run = await a.post('/payroll/runs').send({ periodStart: START, periodEnd: END });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    await prisma.payrollRun.update({ where: { id: run.body.id }, data: { status: 'FINALIZED' } });

    const { result } = await runReconciliation(prisma, { start: START, end: END, now: NOW, selfCheck: true });
    expect(result.payrollProvided).toBe(true);
    expect(result.variances).toEqual([]);
    expect(result.totals.hours.variance).toBe(0);
    expect(result.totals.gross.variance).toBe(0);
    expect(result.totals.headcount.variance).toBe(0);
  });
});

describe('the inventory', () => {
  it('names files that exist, each with a rule', () => {
    expect(ACTIVE_COUNT_SITES.length).toBeGreaterThan(5);
    for (const s of ACTIVE_COUNT_SITES) {
      expect(existsSync(join(process.cwd(), '..', '..', s.file)), s.file).toBe(true);
      expect(s.rule.length).toBeGreaterThan(10);
    }
  });
});
