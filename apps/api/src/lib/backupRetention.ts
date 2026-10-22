/**
 * Backup retention — SOC 2 decision 4 (docs/soc2-controls-investigation.md):
 * keep 35 daily dumps and 12 monthly ones, delete the rest. Pure over the
 * object keys so scripts/db-backup.ts can plan the prune and the test can
 * prove the rule without a bucket.
 *
 * Keys look like db/alto-2026-10-21T04-00.dump.enc with a sibling
 * db/alto-2026-10-21T04-00.manifest.json; the stamp is the dump's UTC
 * minute. A day's newest dump is that day's daily; a month's earliest dump
 * is that month's monthly. Anything not kept by either rule is pruned —
 * both the dump and its manifest.
 */

export const DAILY_KEEP = 35;
export const MONTHLY_KEEP = 12;

const STAMP = /^db\/alto-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})\.(dump\.enc|manifest\.json)$/;

export interface BackupObject {
  key: string;
  stamp: string;
  day: string;
  month: string;
}

/** The dump objects (manifests ride with their dump), newest first. */
export function parseBackupKeys(keys: string[]): BackupObject[] {
  const out: BackupObject[] = [];
  for (const key of keys) {
    const m = STAMP.exec(key);
    if (!m || m[4] !== 'dump.enc') continue;
    const stamp = `${m[1]}T${m[2]}-${m[3]}`;
    out.push({ key, stamp, day: m[1]!, month: m[1]!.slice(0, 7) });
  }
  return out.sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));
}

export interface PrunePlan {
  keep: string[];
  /** Keys to delete: dumps and their manifests. */
  remove: string[];
  dailyKept: number;
  monthlyKept: number;
}

/**
 * Which dumps to keep: the newest per day for the 35 most recent days that
 * have a dump, plus the earliest per month for the 12 most recent months
 * that have one (the monthly set overlaps the daily set for this month).
 */
export function planBackupPrune(keys: string[], opts: { dailyKeep?: number; monthlyKeep?: number } = {}): PrunePlan {
  const dailyKeep = opts.dailyKeep ?? DAILY_KEEP;
  const monthlyKeep = opts.monthlyKeep ?? MONTHLY_KEEP;
  const dumps = parseBackupKeys(keys);
  const newestPerDay = new Map<string, BackupObject>();
  const earliestPerMonth = new Map<string, BackupObject>();
  for (const d of dumps) {
    if (!newestPerDay.has(d.day)) newestPerDay.set(d.day, d); // sorted newest first
    earliestPerMonth.set(d.month, d); // the last one seen for a month is its earliest
  }
  const days = [...newestPerDay.keys()].sort().reverse().slice(0, dailyKeep);
  const months = [...earliestPerMonth.keys()].sort().reverse().slice(0, monthlyKeep);
  const keepStamps = new Set<string>();
  for (const day of days) keepStamps.add(newestPerDay.get(day)!.stamp);
  for (const month of months) keepStamps.add(earliestPerMonth.get(month)!.stamp);
  const keep: string[] = [];
  const remove: string[] = [];
  for (const d of dumps) {
    const manifest = d.key.replace(/\.dump\.enc$/, '.manifest.json');
    if (keepStamps.has(d.stamp)) keep.push(d.key, manifest);
    else remove.push(d.key, manifest);
  }
  return { keep, remove, dailyKept: days.length, monthlyKept: months.length };
}
