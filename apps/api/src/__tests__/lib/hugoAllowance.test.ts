import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { HugoAllowanceError, HugoNoModelError, MICROS_PER_USD, allowanceClassOf, allowanceStatus, allowanceUsedLine, assertAllowance, chargeModelCall, costMicrosOf, modelServes } from '../../lib/hugoAllowance.js';
import { createAssociate, createUser, prisma, truncateAll } from '../../../test/db.js';
import { associatesOffTheModel, letAssociatesUseTheModel } from '../../../test/hugoModel.js';

// The model's machinery, driven by an associate: allowed for this file (by default an associate's Hugo never calls it).
letAssociatesUseTheModel();

/**
 * Each person's allowance for Hugo's thinking (owner, 2026-10-29): $1 for
 * associates, drivers and floor/shift supervisors over a 30-day cycle that
 * begins with their first use; $10 for the office over the company's
 * calendar month. Charged per call from its tokens, rounded up.
 */
const DAY = 86_400_000;

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const floorUser = async () => {
  const a = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
  return (await createUser({ role: 'ASSOCIATE', associateId: a.id, email: `ana-${a.id.slice(0, 6)}@example.com` })).user;
};
const flash = (inputTokens: number, outputTokens: number, cachedTokens = 0) => ({ tier: 'fast' as const, model: 'deepseek-flash', inputTokens, cachedTokens, outputTokens });

describe('who gets what', () => {
  it('associates, drivers and floor/shift supervisors are the floor; everyone else Hugo serves is the office', () => {
    for (const r of ['ASSOCIATE', 'DRIVER', 'SHIFT_SUPERVISOR', 'FLOOR_SUPERVISOR'] as const) expect(allowanceClassOf(r)).toBe('floor');
    for (const r of ['HR_ADMINISTRATOR', 'OPERATIONS_MANAGER', 'WORKFORCE_MANAGER', 'FINANCE_ACCOUNTANT', 'MANAGER', 'EXECUTIVE_CHAIRMAN', 'TRANSPORTATION_DIRECTOR'] as const) expect(allowanceClassOf(r)).toBe('staff');
  });

  it('costs are rounded up, at the tier’s price per million tokens', () => {
    // flash: $0.30 in, $0.006 cached, $1.20 out per million → millionths of a dollar per token.
    expect(costMicrosOf(flash(1000, 100, 2000))).toBe(Math.ceil(1000 * 0.3 + 2000 * 0.006 + 100 * 1.2));
    expect(costMicrosOf({ tier: 'deep', inputTokens: 1, cachedTokens: 0, outputTokens: 0 })).toBe(2); // 1.32 → 2
  });
});

describe('whose Hugo never calls the model (owner, 2026-10-30)', () => {
  it('an associate’s, by default — refused before anything is sent, and so is an account that can’t be found; a supervisor’s and the office’s are not', async () => {
    associatesOffTheModel();
    expect(modelServes('ASSOCIATE')).toBe(false);
    // The hat worn counts as much as the account's own role.
    expect(modelServes('SHIFT_SUPERVISOR', 'ASSOCIATE')).toBe(false);
    expect(modelServes('SHIFT_SUPERVISOR', 'DRIVER')).toBe(true);
    expect(modelServes('HR_ADMINISTRATOR')).toBe(true);
    const ana = await floorUser();
    await expect(assertAllowance(ana.id)).rejects.toBeInstanceOf(HugoNoModelError);
    await expect(assertAllowance('00000000-0000-4000-8000-0000000000aa')).rejects.toBeInstanceOf(HugoNoModelError);
    const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', email: 'sup-model@example.com' });
    await expect(assertAllowance(sup.id)).resolves.toMatchObject({ allowanceClass: 'floor', exhausted: false });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'hr-model@example.com' });
    await expect(assertAllowance(hr.id)).resolves.toMatchObject({ allowanceClass: 'staff', exhausted: false });
  });
});

describe('the floor: $1 over a 30-day cycle from first use', () => {
  it('the first charge begins the cycle; used up, the next call is refused until 30 days after it began', async () => {
    const ana = await floorUser();
    const t0 = new Date('2026-10-01T15:00:00Z');
    expect((await allowanceStatus(ana.id, t0)).spentMicros).toBe(0);
    await chargeModelCall({ userId: ana.id, purpose: 'chat' }, flash(2000, 300), t0);
    const profile = await prisma.hugoProfile.findFirstOrThrow({ where: { userId: ana.id } });
    expect(profile.allowanceCycleStartedAt?.toISOString()).toBe(t0.toISOString());

    // Spend past the dollar ten days in.
    const t10 = new Date(t0.getTime() + 10 * DAY);
    await chargeModelCall({ userId: ana.id, purpose: 'goal' }, flash(2_000_000, 400_000), t10);
    const used = await allowanceStatus(ana.id, t10);
    expect(used.exhausted).toBe(true);
    expect(used.capMicros).toBe(MICROS_PER_USD);
    await expect(assertAllowance(ana.id, t10)).rejects.toBeInstanceOf(HugoAllowanceError);
    await expect(assertAllowance(ana.id, t10)).rejects.toMatchObject({ renewsAt: new Date(t0.getTime() + 30 * DAY) });

    // Thirty days after the cycle began, a new one starts with the next use.
    const t31 = new Date(t0.getTime() + 31 * DAY);
    const fresh = await assertAllowance(ana.id, t31);
    expect(fresh.spentMicros).toBe(0);
    await chargeModelCall({ userId: ana.id, purpose: 'chat' }, flash(1000, 100), t31);
    expect((await prisma.hugoProfile.findFirstOrThrow({ where: { userId: ana.id } })).allowanceCycleStartedAt?.toISOString()).toBe(t31.toISOString());
  });

  it('one person’s spending never touches another’s allowance', async () => {
    const ana = await floorUser();
    const ben = await floorUser();
    const now = new Date();
    await chargeModelCall({ userId: ana.id, purpose: 'chat' }, flash(4_000_000, 0), now);
    expect((await allowanceStatus(ana.id, now)).exhausted).toBe(true);
    expect((await allowanceStatus(ben.id, now)).spentMicros).toBe(0);
  });
});

describe('the office: $10 over the company’s calendar month', () => {
  it('counts from the first of the month in the company’s zone and renews on the next first', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'hr@example.com' });
    // Oct 31, 11 PM Eastern (8 PM Pacific) is already Nov 1 in UTC — still October for the company.
    const lateOct = new Date('2026-11-01T03:00:00Z');
    const s = await allowanceStatus(hr.id, lateOct);
    expect(s.allowanceClass).toBe('staff');
    expect(s.capMicros).toBe(10 * MICROS_PER_USD);
    expect(s.periodStart.getTime()).toBeLessThan(new Date('2026-10-02T00:00:00Z').getTime());
    expect(s.renewsAt.getTime()).toBeGreaterThan(lateOct.getTime());
    expect(s.renewsAt.getTime()).toBeLessThan(new Date('2026-11-02T00:00:00Z').getTime());
    // Spent in October; November starts clean.
    await chargeModelCall({ userId: hr.id, purpose: 'chat' }, { tier: 'deep', model: 'deepseek-v4-pro', inputTokens: 3_000_000, cachedTokens: 0, outputTokens: 2_000_000 }, lateOct);
    expect((await allowanceStatus(hr.id, lateOct)).exhausted).toBe(true);
    expect((await allowanceStatus(hr.id, new Date(s.renewsAt.getTime() + 60_000))).spentMicros).toBe(0);
    // Staff have no cycle row: the month is the period.
    expect(await prisma.hugoProfile.count({ where: { userId: hr.id } })).toBe(0);
  });
});

describe('what he says when it is used up', () => {
  it('names what still works and the day it renews, in six languages', () => {
    const at = new Date('2026-11-27T18:00:00Z');
    expect(allowanceUsedLine('en', at)).toMatch(/until Fri, Nov 27 I can only answer the basics/);
    for (const lang of ['es', 'tr', 'ht', 'pt', 'uk'] as const) expect(allowanceUsedLine(lang, at).length).toBeGreaterThan(40);
  });
});
