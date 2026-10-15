import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { recordShadowRun, runLaborShadowSweep } from '../../lib/laborRules/index.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * Brief 2-2 step 3 — the engine in shadow.
 *
 *   (The golden fixtures' shadow, with no database, is in engine.test.ts.)
 *   A finalized run is recomputed
 *   once and recorded; a site whose override adds daily overtime shows the
 *   difference with the engine's reason and the money it would move; pay is
 *   never touched. The Rules routes list the runs and one run's people.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function world(state: string, hoursByDay: number[] = [10, 10, 8, 8, 8]) {
  const c = await createClient('Shadow Resort');
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: c.id } });
  await prisma.site.update({ where: { id: site.id }, data: { state, timezone: 'America/New_York' } });
  const a = await createAssociate({ firstName: 'Sam', lastName: 'Shadow' });
  // Monday to Friday of the week of Sat 3 Oct 2026; by default 44 hours.
  const days = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'];
  for (const [i, d] of days.entries()) {
    const start = new Date(`${d}T12:00:00Z`);
    const hours = hoursByDay[i]!;
    await prisma.timeEntry.create({ data: { associateId: a.id, clientId: c.id, locationId: site.id, clockInAt: start, clockOutAt: new Date(start.getTime() + hours * 3_600_000), status: 'APPROVED' } });
  }
  const run = await prisma.payrollRun.create({ data: { clientId: c.id, periodStart: new Date('2026-10-03T00:00:00Z'), periodEnd: new Date('2026-10-09T00:00:00Z'), status: 'FINALIZED', finalizedAt: new Date() } });
  await prisma.payrollItem.create({ data: { payrollRunId: run.id, associateId: a.id, hoursWorked: hoursByDay.reduce((x, y) => x + y, 0), hourlyRate: 20, grossPay: 0, federalWithholding: 0, netPay: 0 } });
  return { site, a, run };
}

describe('a finalized run in shadow', () => {
  it('Florida: recomputed once, no difference, pay untouched', async () => {
    const { run } = await world('FL');
    const before = await prisma.payrollItem.findFirstOrThrow({ where: { payrollRunId: run.id } });
    expect(await runLaborShadowSweep(prisma, new Date('2026-10-15T12:00:00Z'))).toBe(1);
    const shadow = await prisma.laborShadowRun.findUniqueOrThrow({ where: { payrollRunId: run.id } });
    expect(shadow).toMatchObject({ associates: 1, differences: 0 });
    expect(Number(shadow.amountDifference)).toBe(0);
    expect(await recordShadowRun(prisma, run.id)).toBeNull();
    expect(await runLaborShadowSweep(prisma, new Date('2026-10-15T12:00:00Z'))).toBe(0);
    expect(await prisma.payrollItem.findFirstOrThrow({ where: { payrollRunId: run.id } })).toEqual(before);
  });

  it('a site override adding daily overtime shows the difference, its reason and its money', async () => {
    // 38 hours: no weekly overtime was paid, but two 10-hour days owe 4 daily overtime hours under the override.
    const { run, site } = await world('FL', [10, 10, 6, 6, 6]);
    await prisma.laborRuleSet.create({
      data: { tenantId: ALTO_TENANT_ID, level: 'SITE', jurisdiction: 'SITE', siteId: site.id, effectiveFrom: new Date('2026-01-01T00:00:00Z'), version: 1, params: { overtime: { dailyThreshold: 8, dailyMultiplier: 1.5 } }, source: 'Union contract §7', sourceDate: new Date('2026-01-01T00:00:00Z') },
    });
    const rec = await recordShadowRun(prisma, run.id);
    expect(rec?.differences).toBe(1);
    const diff = await prisma.laborShadowDiff.findFirstOrThrow({ where: { shadowRunId: rec!.id } });
    expect(Number(diff.paidRegular)).toBe(38);
    expect(Number(diff.paidOvertime)).toBe(0);
    expect(Number(diff.engineRegular)).toBe(34);
    expect(Number(diff.engineOvertime)).toBe(4);
    // 4 hours × $20 × 0.5 more than was paid.
    expect(Number(diff.amountDifference)).toBe(40);
    expect(diff.reasons).toEqual(expect.arrayContaining([expect.stringContaining('(daily), SITE 2026-01-01 v1')]));
  });

  it('the Rules routes list the shadow runs and one run’s people', async () => {
    const { run } = await world('FL');
    await recordShadowRun(prisma, run.id);
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const admin = await loginAs(agent(), user.email);
    const list = await admin.get('/labor-rules/shadow');
    expect(list.status).toBe(200);
    expect(list.body.runs).toEqual([expect.objectContaining({ payrollRunId: run.id, differences: 0, associates: 1 })]);
    const one = await admin.get(`/labor-rules/shadow/${list.body.runs[0].id}`);
    expect(one.body.differences).toEqual([]);
  });
});
