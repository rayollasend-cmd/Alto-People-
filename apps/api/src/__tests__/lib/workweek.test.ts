import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { refreshBranding } from '../../lib/branding.js';
import { splitWeeklyOvertime } from '../../lib/payroll.js';
import { companyWorkweek, endOfWeekUTC, orgDateKey, startOfWeekForSite, startOfWeekInZone, startOfWeekUTC } from '../../lib/timeAnomalies.js';
import { agent, loginAs } from '../../../test/http.js';
import { createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * The company workweek (Brief 1A-2): one setting for the start day and the
 * company time zone, read by every weekly number; each site's hours turn
 * at midnight in the site's own zone, so Dune Lakes and Alabama run on
 * Central time without moving Florida's week.
 */

beforeEach(async () => {
  await truncateAll();
  await refreshBranding(prisma);
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('the company week', () => {
  it('is Saturday in Eastern time until the setting says otherwise, and the setting moves every helper', async () => {
    expect(companyWorkweek()).toEqual({ weekStartsOn: 6, timezone: 'America/New_York' });
    const wed = new Date('2026-04-15T15:00:00.000Z');
    expect(startOfWeekUTC(wed).toISOString()).toBe('2026-04-11T04:00:00.000Z'); // Saturday 00:00 EDT
    expect(endOfWeekUTC(wed).toISOString()).toBe('2026-04-18T04:00:00.000Z');

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const admin = await loginAs(agent(), hr.email);
    const saved = await admin.patch('/admin/org/settings').send({ weekStartsOn: 1, timezone: 'America/Chicago' });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ weekStartsOn: 1, timezone: 'America/Chicago' });
    expect(companyWorkweek()).toEqual({ weekStartsOn: 1, timezone: 'America/Chicago' });
    expect(startOfWeekUTC(wed).toISOString()).toBe('2026-04-13T05:00:00.000Z'); // Monday 00:00 CDT
    expect(orgDateKey(new Date('2026-04-15T04:30:00.000Z'))).toBe('2026-04-14'); // 23:30 Central the night before
    expect((await admin.patch('/admin/org/settings').send({ weekStartsOn: 7 })).status).toBe(400);
  });

  it('a Central site turns its week at midnight Central: a Friday-night punch belongs to the ending week', () => {
    // 23:30 Central on Friday 2026-04-17 = 04:30 UTC Saturday = 00:30 Eastern Saturday.
    const fridayNightCentral = new Date('2026-04-18T04:30:00.000Z');
    expect(startOfWeekInZone(fridayNightCentral, 'America/New_York').toISOString()).toBe('2026-04-18T04:00:00.000Z'); // Eastern: already the new week
    expect(startOfWeekInZone(fridayNightCentral, 'America/Chicago').toISOString()).toBe('2026-04-11T05:00:00.000Z'); // Central: still the old week
    expect(startOfWeekForSite(fridayNightCentral, 'America/Chicago').toISOString()).toBe('2026-04-11T05:00:00.000Z');
    expect(startOfWeekForSite(fridayNightCentral, null).toISOString()).toBe(startOfWeekUTC(fridayNightCentral).toISOString());
  });

  it('payroll overtime buckets hours by the week as the site sees it', () => {
    // 40 approved hours Mon–Fri at a Central site, then a 4-hour shift that starts 23:00 Central Friday.
    const central = { timezone: 'America/Chicago' };
    const day = (d: string, startHourCentral: number, hours: number) => ({
      status: 'APPROVED',
      clockInAt: new Date(`${d}T${String(startHourCentral + 5).padStart(2, '0')}:00:00.000Z`), // CDT = UTC-5
      clockOutAt: new Date(`${d}T${String(startHourCentral + 5 + hours).padStart(2, '0')}:00:00.000Z`),
      location: central,
    });
    const week = ['2026-04-13', '2026-04-14', '2026-04-15', '2026-04-16', '2026-04-17'].map((d) => day(d, 8, 8));
    const lateFriday = { status: 'APPROVED', clockInAt: new Date('2026-04-18T04:00:00.000Z'), clockOutAt: new Date('2026-04-18T08:00:00.000Z'), location: central };
    // Seen from Central, the late shift is Friday: 44 hours in one week, 4 of them overtime.
    expect(splitWeeklyOvertime([...week, lateFriday])).toEqual({ regularHours: 40, overtimeHours: 4 });
    // The same hours stamped as an Eastern site: the late shift is Saturday, the next week — no overtime.
    const eastern = [...week, lateFriday].map((e) => ({ ...e, location: { timezone: 'America/New_York' } }));
    expect(splitWeeklyOvertime(eastern)).toEqual({ regularHours: 44, overtimeHours: 0 });
  });
});
