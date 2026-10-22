import { describe, expect, it } from 'vitest';
import { DAILY_KEEP, MONTHLY_KEEP, parseBackupKeys, planBackupPrune } from '../../lib/backupRetention.js';

/** SOC 2 decision 4: 35 daily + 12 monthly; everything else pruned, manifests with their dumps. */

const key = (day: string, hm = '04-00') => `db/alto-${day}T${hm}.dump.enc`;
const manifest = (day: string, hm = '04-00') => `db/alto-${day}T${hm}.manifest.json`;
const dayOf = (d: Date) => d.toISOString().slice(0, 10);

describe('planBackupPrune', () => {
  it('keeps the newest 35 daily dumps and the first dump of each of the last 12 months', () => {
    const keys: string[] = [];
    const start = new Date('2026-10-21T00:00:00Z');
    for (let i = 0; i < 400; i += 1) {
      const d = new Date(start.getTime() - i * 86_400_000);
      keys.push(key(dayOf(d)), manifest(dayOf(d)));
    }
    const plan = planBackupPrune(keys);
    expect(plan.dailyKept).toBe(DAILY_KEEP);
    expect(plan.monthlyKept).toBe(MONTHLY_KEEP);
    // Yesterday is a daily; 100 days ago is neither a daily nor a first-of-month; Dec 1 2025 is a monthly.
    expect(plan.keep).toContain(key('2026-10-20'));
    expect(plan.keep).toContain(manifest('2026-10-20'));
    expect(plan.remove).toContain(key('2026-07-13'));
    expect(plan.remove).toContain(manifest('2026-07-13'));
    expect(plan.keep).toContain(key('2025-12-01'));
    // Older than 12 months of monthlies: gone.
    expect(plan.remove).toContain(key('2025-10-01'));
    expect(plan.keep.length + plan.remove.length).toBe(keys.length);
    // 35 dailies + 12 monthlies, minus the overlap (this month's first is also within the 35 days? Oct 1 is 20 days back → yes).
    expect(plan.keep.length / 2).toBe(DAILY_KEEP + MONTHLY_KEEP - 1);
  });

  it('two dumps on one day: the newer is the daily; the month keeps its earliest; unknown keys are ignored', () => {
    const keys = [key('2026-10-21', '04-00'), key('2026-10-21', '18-00'), manifest('2026-10-21', '04-00'), manifest('2026-10-21', '18-00'), key('2026-10-03'), 'db/other.txt', 'uploads/x.bin'];
    const plan = planBackupPrune(keys, { dailyKeep: 1, monthlyKeep: 1 });
    expect(plan.keep).toEqual(expect.arrayContaining([key('2026-10-21', '18-00'), manifest('2026-10-21', '18-00'), key('2026-10-03')]));
    expect(plan.remove).toEqual([key('2026-10-21', '04-00'), manifest('2026-10-21', '04-00')]);
    expect(parseBackupKeys(keys).map((k) => k.stamp)).toEqual(['2026-10-21T18-00', '2026-10-21T04-00', '2026-10-03T04-00']);
  });

  it('an empty bucket plans nothing', () => {
    expect(planBackupPrune([])).toEqual({ keep: [], remove: [], dailyKept: 0, monthlyKept: 0 });
  });
});
