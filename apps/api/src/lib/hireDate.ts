import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * A person's hire date, from ONE source (PEOPLE-10).
 *
 *   One person used to show up to five start dates: the directory read the
 *   application's planned start, the Employment tab the employment spell,
 *   E-Verify and tenure the Associate row. The hire date is the employment
 *   record's: the open spell's hire date (a rehire's latest spell), else the
 *   newest spell's; else Associate.hireDate (set at the same approval); else
 *   — not hired yet — the application's planned start. Every surface that
 *   says "hired" or "start date" reads this.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export type HireDateSource = 'employment' | 'hire' | 'application';
export interface HireDate {
  /** YYYY-MM-DD (a date column: no zone). */
  date: string;
  source: HireDateSource;
}

// eslint-disable-next-line no-restricted-syntax -- UTC on purpose: Employment/Associate/Application dates are @db.Date columns (UTC midnight)
const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** The hire date of each person, by the one rule. `planned` is the application start the caller already holds (id → date). */
export async function hireDatesFor(db: Db, associateIds: string[], planned: Map<string, Date | null> = new Map()): Promise<Map<string, HireDate | null>> {
  const out = new Map<string, HireDate | null>();
  if (associateIds.length === 0) return out;
  const [spells, people] = await Promise.all([
    db.employment.findMany({
      where: { associateId: { in: associateIds } },
      select: { associateId: true, hireDate: true, endDate: true },
      orderBy: { hireDate: 'desc' },
    }),
    db.associate.findMany({ where: { id: { in: associateIds } }, select: { id: true, hireDate: true } }),
  ]);
  // Rows come newest first: the first open spell is the newest open one; else the newest.
  const spell = new Map<string, { date: Date; open: boolean }>();
  for (const s of spells) {
    const cur = spell.get(s.associateId);
    if (!cur || (!cur.open && s.endDate === null)) spell.set(s.associateId, { date: s.hireDate, open: s.endDate === null });
  }
  const hired = new Map(people.map((p) => [p.id, p.hireDate]));
  for (const id of associateIds) {
    const e = spell.get(id)?.date;
    const h = hired.get(id);
    const p = planned.get(id);
    out.set(id, e ? { date: ymd(e), source: 'employment' } : h ? { date: ymd(h), source: 'hire' } : p ? { date: ymd(p), source: 'application' } : null);
  }
  return out;
}
