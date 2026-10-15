import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Prisma } from '@prisma/client';
import { createApp } from '../../app.js';
import { env } from '../../config/env.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { listRoutes } from '../../lib/routeInventory.js';
import { runSecurityAlerts } from '../../lib/securityAlerts.js';
import { agent, loginAs } from '../../../test/http.js';
import { createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * Brief 2-5 step 7 — alerting from the audit trail, the evidence CI posts,
 * and the export sweep.
 *
 *   Ten failed sign-ins from one address, an admin turning two-step off and
 *   an account given an admin role each raise one alert, delivered to the
 *   operator's admins (never twice in the hour). CI posts the dependency
 *   scan with its token. Every parameter-free CSV route, called by an admin,
 *   leaves an export row on the audit trail.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const row = (action: string, metadata: Prisma.InputJsonObject, entityId = 'x', actorUserId: string | null = null) => ({ actorUserId, clientId: null, action, entityType: 'User', entityId, metadata });

describe('the alert rules', () => {
  it('raise one alert per rule and key an hour, delivered to the operator’s admins', async () => {
    const { user: admin } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { user: mgr } = await createUser({ role: 'MANAGER' });
    for (let i = 0; i < 10; i++) await prisma.auditLog.create({ data: row('auth.login_failed', { ip: '203.0.113.9', email: `x${i}@example.com`, reason: 'wrong_password' }) });
    await prisma.auditLog.create({ data: row('auth.mfa_disabled', {}, mgr.id) });
    await prisma.auditLog.create({ data: row('admin.user_updated', { changes: { role: { from: 'ASSOCIATE', to: 'HR_ADMINISTRATOR' } } }, 'u-1', admin.id) });
    await prisma.auditLog.create({ data: row('auth.login_failed', { ip: '203.0.113.10', email: 'one@example.com', reason: 'wrong_password' }) });

    expect(await runSecurityAlerts(prisma)).toBe(3);
    const alerts = await prisma.securityAlert.findMany({ orderBy: { rule: 'asc' } });
    expect(alerts.map((a) => a.rule).sort()).toEqual(['FAILED_SIGNINS_IP', 'MFA_OFF_ADMIN', 'PRIVILEGE_CHANGE']);
    expect(alerts.every((a) => a.deliveredTo.includes(`user:${admin.id}`))).toBe(true);
    expect(alerts.find((a) => a.rule === 'FAILED_SIGNINS_IP')!.key).toBe('203.0.113.9');
    expect(await runSecurityAlerts(prisma)).toBe(0); // the same keys within the hour
  });
});

describe('evidence from CI', () => {
  it('records a control’s result with the ingest token, and refuses without it', async () => {
    const saved = env.EVIDENCE_INGEST_TOKEN;
    (env as Record<string, unknown>).EVIDENCE_INGEST_TOKEN = 't'.repeat(40);
    try {
      const app = createApp();
      const body = { control: 'dependency-scanning', status: 'PASS', summary: 'No high or critical advisory.', details: { counts: { high: 0 } } };
      expect((await request(app).post('/admin/compliance-evidence/ingest').send(body)).status).toBe(401);
      expect((await request(app).post('/admin/compliance-evidence/ingest').set('Authorization', `Bearer ${'u'.repeat(40)}`).send(body)).status).toBe(401);
      const ok = await request(app).post('/admin/compliance-evidence/ingest').set('Authorization', `Bearer ${'t'.repeat(40)}`).send(body);
      expect(ok.status).toBe(201);
      expect((await prisma.complianceEvidence.findUniqueOrThrow({ where: { id: ok.body.id } })).collectedBy).toBe('ci');
      expect((await request(app).post('/admin/compliance-evidence/ingest').set('Authorization', `Bearer ${'t'.repeat(40)}`).send({ ...body, control: 'access-review' })).status).toBe(400);
    } finally {
      (env as Record<string, unknown>).EVIDENCE_INGEST_TOKEN = saved;
    }
  });
});

describe('the export sweep', () => {
  it('every parameter-free CSV route an admin can call leaves an export row', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const admin = await loginAs(agent(), user.email);
    const routes = listRoutes(createApp()).filter((r) => r.method === 'GET' && /\.csv$/.test(r.path) && !/:[A-Za-z]/.test(r.path));
    expect(routes.length).toBeGreaterThanOrEqual(3);
    let exported = 0;
    for (const r of routes) {
      await flushPendingAudits();
      const before = await prisma.auditLog.count({ where: { actorUserId: user.id } });
      const res = await admin.get(r.path);
      if (res.status !== 200 || !/csv/.test(String(res.headers['content-type'] ?? ''))) continue;
      exported += 1;
      await flushPendingAudits();
      // The audit floor's export row, or the route's own richer row: either way, one more.
      expect(await prisma.auditLog.count({ where: { actorUserId: user.id } }), `no audit row for ${r.path}`).toBeGreaterThan(before);
    }
    expect(exported).toBeGreaterThan(0);
  });
});
