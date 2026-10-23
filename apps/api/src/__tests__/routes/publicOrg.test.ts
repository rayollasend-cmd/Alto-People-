import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { prisma, truncateAll } from '../../../test/db.js';
import { withPlatformScope } from '../../lib/tenant.js';

/**
 * /login/<slug> names the organization (F500 G5): GET /auth/org/:slug answers
 * its public face — the name and a logo link when one is on file — and a
 * plain 404 for an unknown or suspended address. Nothing else comes back.
 */

const T2 = '00000000-0000-4000-8000-0000000000c2';
const app = () => createApp();
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

beforeEach(async () => {
  await truncateAll();
  await prisma.tenant.create({ data: { id: T2, slug: 'harbor-staffing', name: 'Harbor Staffing' } });
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('GET /auth/org/:slug', () => {
  it('answers the name and no logo, then the logo link once one is on file — nothing else', async () => {
    const res = await request(app()).get('/auth/org/Harbor-Staffing');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ org: { name: 'Harbor Staffing', slug: 'harbor-staffing', logoUrl: null } });

    await withPlatformScope(() =>
      prisma.orgSetting.create({ data: { id: 'harbor-org', tenantId: T2, logoBytes: PNG, logoContentType: 'image/png', logoUpdatedAt: new Date('2026-10-01T00:00:00Z') } }),
    );
    const withLogo = await request(app()).get('/auth/org/harbor-staffing');
    expect(withLogo.body.org.logoUrl).toBe(`/auth/org/harbor-staffing/logo?v=${new Date('2026-10-01T00:00:00Z').getTime()}`);
    expect(Object.keys(withLogo.body.org).sort()).toEqual(['logoUrl', 'name', 'slug']);
    const logo = await request(app()).get('/auth/org/harbor-staffing/logo');
    expect(logo.status).toBe(200);
    expect(logo.headers['content-type']).toBe('image/png');
  });

  it('is a 404 for an unknown address, a malformed one and a suspended organization', async () => {
    expect((await request(app()).get('/auth/org/nobody-here')).status).toBe(404);
    expect((await request(app()).get('/auth/org/not%20a%20slug')).status).toBe(404);
    await prisma.tenant.update({ where: { id: T2 }, data: { status: 'SUSPENDED' } });
    expect((await request(app()).get('/auth/org/harbor-staffing')).status).toBe(404);
    expect((await request(app()).get('/auth/org/harbor-staffing/logo')).status).toBe(404);
  });
});
