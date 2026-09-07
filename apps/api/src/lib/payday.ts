/**
 * Next-payday math shared by the Finance cockpit and the Workforce
 * command center — both portals count down to the same sacred date.
 */

const DAY_MS = 86_400_000;

/** Next pay date for a schedule: anchorDate treated as a period end;
 *  period ends advance by the frequency; payday = periodEnd + offset. */
export function nextPayDate(
  s: { frequency: string; anchorDate: Date; payDateOffsetDays: number },
  now: Date,
): Date | null {
  const stepDays =
    s.frequency === 'WEEKLY' ? 7 : s.frequency === 'BIWEEKLY' ? 14 : null;
  if (stepDays !== null) {
    const t = new Date(s.anchorDate);
    // Jump close, then walk — bounded either way.
    const behind = Math.floor((now.getTime() - t.getTime()) / (stepDays * DAY_MS));
    if (behind > 0) t.setUTCDate(t.getUTCDate() + behind * stepDays);
    let pay = new Date(t.getTime() + s.payDateOffsetDays * DAY_MS);
    for (let i = 0; i < 5 && pay <= now; i++) {
      t.setUTCDate(t.getUTCDate() + stepDays);
      pay = new Date(t.getTime() + s.payDateOffsetDays * DAY_MS);
    }
    return pay > now ? pay : null;
  }
  if (s.frequency === 'MONTHLY' || s.frequency === 'SEMIMONTHLY') {
    const t = new Date(s.anchorDate);
    const stepMonths = s.frequency === 'MONTHLY' ? 1 : 0;
    for (let i = 0; i < 40; i++) {
      const pay = new Date(t.getTime() + s.payDateOffsetDays * DAY_MS);
      if (pay > now) return pay;
      if (stepMonths) t.setUTCMonth(t.getUTCMonth() + 1);
      else t.setUTCDate(t.getUTCDate() + 15); // semimonthly ≈ 15-day walk
    }
  }
  return null;
}

/** Soonest upcoming payday across the active schedules, or null. */
export async function soonestPayday(
  prisma: {
    payrollSchedule: {
      findMany: (args: {
        where: { isActive: boolean; deletedAt: null };
        select: {
          name: true;
          frequency: true;
          anchorDate: true;
          payDateOffsetDays: true;
        };
      }) => Promise<
        Array<{
          name: string;
          frequency: string;
          anchorDate: Date;
          payDateOffsetDays: number;
        }>
      >;
    };
  },
  now: Date,
): Promise<{ date: string; schedule: string } | null> {
  const schedules = await prisma.payrollSchedule.findMany({
    where: { isActive: true, deletedAt: null },
    select: {
      name: true,
      frequency: true,
      anchorDate: true,
      payDateOffsetDays: true,
    },
  });
  let payday: { date: string; schedule: string } | null = null;
  for (const s of schedules) {
    const d = nextPayDate(s, now);
    if (d && (!payday || d < new Date(payday.date))) {
      payday = { date: d.toISOString(), schedule: s.name };
    }
  }
  return payday;
}
