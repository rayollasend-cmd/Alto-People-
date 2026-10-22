import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { flushPendingAudits } from '../../lib/audit.js';
import { purgeExpiredIncidentEvidence } from '../../lib/robotIncidentRetention.js';
import { agent, loginAs } from '../../../test/http.js';
import { createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * Audit 2026-10-21: reportIncident stamps retainUntil five years out and nothing
 * read it. The sweep removes the copied evidence — samples, events, people on
 * shift — once that date passes, keeps the report, and says so on the row.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await flushPendingAudits();
});

describe('robot incident evidence retention', () => {
  it('removes the evidence past retainUntil, keeps the report, leaves younger incidents alone', async () => {
    const client = await createClient('Harbor Hotel');
    const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const robot = await prisma.worker.create({ data: { type: 'ROBOT', name: 'Servi 9', ownerUserId: hr.id, status: 'ACTIVE', capabilities: ['food-service'] } });
    const evidence = { samples: [{ at: '2021-01-01T10:00:00.000Z', status: 'WORKING', batteryPct: 50, x: 1, y: 1, currentTask: null, errorCode: null }], events: [{ id: 'e', kind: 'ERROR', at: '2021-01-01T10:30:00.000Z', by: null, shiftId: null, note: 'bump' }], peopleOnShift: [{ associateId: 'a', name: 'Ana', shiftId: 's' }] };
    const old = await prisma.robotIncident.create({
      data: { workerId: robot.id, locationId: site.id, kind: 'NEAR_MISS', occurredAt: new Date('2021-01-01T11:00:00Z'), description: 'Clipped a cart', reportedByUserId: hr.id, retainUntil: new Date('2026-01-01'), ...evidence },
    });
    const young = await prisma.robotIncident.create({
      data: { workerId: robot.id, locationId: site.id, kind: 'NEAR_MISS', occurredAt: new Date(), description: 'Near the pool', reportedByUserId: hr.id, retainUntil: new Date('2031-10-21'), ...evidence },
    });

    const r = await purgeExpiredIncidentEvidence(prisma, null, new Date('2026-10-21T12:00:00Z'));
    expect(r.purged).toBe(1);

    const purged = await prisma.robotIncident.findUniqueOrThrow({ where: { id: old.id } });
    expect(purged.evidencePurgedAt).not.toBeNull();
    expect(purged.samples).toEqual([]);
    expect(purged.events).toEqual([]);
    expect(purged.peopleOnShift).toEqual([]);
    // The report itself stays.
    expect(purged.description).toBe('Clipped a cart');
    expect(purged.kind).toBe('NEAR_MISS');

    const kept = await prisma.robotIncident.findUniqueOrThrow({ where: { id: young.id } });
    expect(kept.evidencePurgedAt).toBeNull();
    expect(Array.isArray(kept.samples) && (kept.samples as unknown[]).length).toBe(1);

    // A second pass does nothing more (idempotent).
    expect((await purgeExpiredIncidentEvidence(prisma, null, new Date('2026-10-22T12:00:00Z'))).purged).toBe(0);

    // The record says the evidence is gone.
    const api = await loginAs(agent(), hr.email);
    const detail = await api.get(`/robots/incidents/${old.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.evidencePurgedAt).toEqual(expect.any(String));
    expect(detail.body.sampleCount).toBe(0);
    expect((await api.get(`/robots/incidents/${young.id}`)).body.evidencePurgedAt).toBeNull();
  });
});
