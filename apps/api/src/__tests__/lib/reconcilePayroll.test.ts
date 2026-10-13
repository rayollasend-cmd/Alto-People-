import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ACTIVE_COUNT_SITES } from '../../lib/activeInventory.js';
import { columnMapFromArg, parseCsv, parsePayrollCsv, platformSide, reconcile, reconcileCsv, reconcileMarkdown, runReconciliation } from '../../lib/reconcilePayroll.js';
import { createAssociate, createClient, prisma, truncateAll } from '../../../test/db.js';

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
  const site = await prisma.location.findFirstOrThrow({ where: { clientId: client.id } });
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
    expect(result.missingColumns).toEqual(['employeeNumber']);
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

describe('the inventory', () => {
  it('names files that exist, each with a rule', () => {
    expect(ACTIVE_COUNT_SITES.length).toBeGreaterThan(5);
    for (const s of ACTIVE_COUNT_SITES) {
      expect(existsSync(join(process.cwd(), '..', '..', s.file)), s.file).toBe(true);
      expect(s.rule.length).toBeGreaterThan(10);
    }
  });
});
