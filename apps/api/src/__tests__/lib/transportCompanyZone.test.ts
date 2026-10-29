import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma, truncateAll } from '../../../test/db.js';
import { __resetBrandingCacheForTests, ensureBrandingLoaded } from '../../lib/branding.js';
import { ALTO_TENANT_ID, runWithTenant } from '../../lib/tenant.js';
import { serviceDateFor } from '../../lib/transport.js';
import { tomorrowKey } from '../../lib/transportReadiness.js';
import { dayBounds, driverCredentialStatus } from '../../lib/transportDrivers.js';

/**
 * CODE-14 (deep audit 2026-10-29): transport's "today" and its fallback zone
 * were New York, hard-coded. They are the company's zone now
 * (companyWorkweek().timezone), and a credential that lapses today is not
 * "expired" in the evening because UTC has rolled over.
 */

// 05:30 UTC on Oct 29 is 22:30 on Oct 28 in Los Angeles (PDT) and 01:30 on Oct 29 in New York.
const AT = new Date('2026-10-29T05:30:00.000Z');

beforeEach(async () => {
  await truncateAll();
  __resetBrandingCacheForTests();
  await prisma.orgSetting.upsert({
    where: { tenantId: ALTO_TENANT_ID },
    create: { id: 'singleton', tenantId: ALTO_TENANT_ID, timezone: 'America/Los_Angeles' },
    update: { timezone: 'America/Los_Angeles' },
  });
  await runWithTenant(ALTO_TENANT_ID, 'job', () => ensureBrandingLoaded(prisma, ALTO_TENANT_ID));
});

afterAll(async () => {
  __resetBrandingCacheForTests();
  await prisma.$disconnect();
});

const inAlto = <T>(fn: () => T) => runWithTenant(ALTO_TENANT_ID, 'job', fn);

describe('transport reads the company’s zone', () => {
  it('a ride with no site zone falls on the company’s day', async () => {
    expect(await inAlto(() => serviceDateFor(AT, null))).toBe('2026-10-28');
    // A site's own zone still wins.
    expect(await inAlto(() => serviceDateFor(AT, 'America/New_York'))).toBe('2026-10-29');
  });

  it('"tomorrow" is the day after the company’s today', async () => {
    expect(await inAlto(() => tomorrowKey(AT))).toBe('2026-10-29');
  });

  it('a service day’s bounds default to the company’s zone', async () => {
    const { from } = await inAlto(() => dayBounds('2026-10-28'));
    expect(from.toISOString()).toBe('2026-10-28T07:00:00.000Z');
  });

  it('a licence that lapses today is due, not expired, at 10:30 PM Pacific', async () => {
    const status = await inAlto(() =>
      driverCredentialStatus({ licenceExpiresAt: new Date('2026-10-28T00:00:00.000Z'), dotMedicalRequired: false, dotMedicalExpiresAt: null }, AT),
    );
    expect(status.problems.filter((p) => p.expired)).toEqual([]);
  });
});
