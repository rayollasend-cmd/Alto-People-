import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildShiftsTile,
  localFieldglassOnTime,
  localNoShowRate,
  localShiftLeadPresence,
  localTemperatureLogsWithPhotos,
} from '../../routes/complianceScorecard.js';
import { fieldglassDueAt } from '../../lib/fieldglassDesk.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * The Shifts tile's four local signals, each computed from the schema
 * instead of the "Coming soon" placeholders that sat on the client-facing
 * card for good. MOD sign-off has no record in Alto and is no longer on
 * the local card at all.
 */

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const since = () => new Date(Date.now() - 30 * DAY);

describe('shift signals from local data', () => {
  it('no-show rate = no-call no-shows / ended assigned shifts (null with nothing ended)', async () => {
    const client = await createClient();
    const a = await createAssociate();
    expect(await localNoShowRate(since())).toBeNull();
    const ended = (d: number, noShow = false) =>
      prisma.shift.create({
        data: {
          clientId: client.id,
          assignedAssociateId: a.id,
          position: 'Stocker',
          startsAt: new Date(Date.now() - d * DAY - 8 * HOUR),
          endsAt: new Date(Date.now() - d * DAY),
          status: 'COMPLETED',
          publishedAt: new Date(Date.now() - d * DAY - DAY),
          ...(noShow ? { noShowRecordedAt: new Date(Date.now() - d * DAY) } : {}),
        },
      });
    await ended(1);
    await ended(2);
    await ended(3);
    await ended(4, true);
    // A shift still ahead is not judged.
    await prisma.shift.create({
      data: { clientId: client.id, assignedAssociateId: a.id, position: 'Stocker', startsAt: new Date(Date.now() + DAY), endsAt: new Date(Date.now() + DAY + 8 * HOUR), status: 'ASSIGNED' },
    });
    expect(await localNoShowRate(since())).toBe(25);
    const other = await createClient();
    expect(await localNoShowRate(since(), other.id)).toBeNull();
  });

  it('shift lead present = store-days with a shift in an isLead position', async () => {
    const client = await createClient();
    const a = await createAssociate();
    const b = await createAssociate();
    const site = await prisma.site.create({ data: { clientId: client.id, name: 'Store 101' } });
    await prisma.shiftPosition.create({ data: { clientId: client.id, name: 'Shift Lead', isLead: true } });
    const worked = (d: number, position: string, who: string) =>
      prisma.shift.create({
        data: {
          clientId: client.id,
          locationId: site.id,
          assignedAssociateId: who,
          position,
          startsAt: new Date(Date.now() - d * DAY - 8 * HOUR),
          endsAt: new Date(Date.now() - d * DAY),
          status: 'COMPLETED',
        },
      });
    // Day 1: a lead and a stocker. Day 2: stockers only.
    await worked(1, 'Shift Lead', a.id);
    await worked(1, 'Stocker', b.id);
    await worked(2, 'Stocker', a.id);
    await worked(2, 'Stocker', b.id);
    expect(await localShiftLeadPresence(since())).toBe(50);
    expect(await localShiftLeadPresence(since(), client.id)).toBe(50);
  });

  it('temperature logs with photos = DONE temperature items carrying a photo on closed SOP runs', async () => {
    const client = await createClient();
    const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR' });
    const shift = await prisma.opsShift.create({
      data: {
        clientId: client.id,
        department: 'Frozen & Dairy',
        departments: ['Frozen & Dairy'],
        period: 'MORNING',
        position: 'F&D Morning',
        dateKey: new Date().toISOString().slice(0, 10),
        status: 'CLOSED',
        openedById: sup.id,
        openedAt: new Date(Date.now() - 9 * HOUR),
        closedAt: new Date(Date.now() - HOUR),
      },
    });
    const temp = (status: 'DONE' | 'OPEN', photo: boolean) =>
      prisma.opsTask.create({
        data: {
          opsShiftId: shift.id,
          title: 'Walk-in cooler temp',
          responseType: 'TEMPERATURE',
          required: true,
          status,
          ...(status === 'DONE' ? { completedAt: new Date(), completedById: sup.id, answerNumber: 36 } : {}),
          ...(photo ? { photos: { create: { s3Key: 'k', filename: 'gauge.jpg', mimeType: 'image/jpeg', size: 10 } } } : {}),
        },
      });
    await temp('DONE', true);
    await temp('DONE', false);
    await temp('OPEN', false);
    // A check item is not a temperature log.
    await prisma.opsTask.create({ data: { opsShiftId: shift.id, title: 'Sweep', responseType: 'CHECK', status: 'DONE' } });
    expect(await localTemperatureLogsWithPhotos(since())).toBe(33.3);
    const other = await createClient();
    expect(await localTemperatureLogsWithPhotos(since(), other.id)).toBeNull();
  });

  it('fieldglass on time = timesheets entered before Monday 2pm Pacific, never-entered weeks count once due', async () => {
    const client = await createClient();
    const a = await createAssociate();
    const b = await createAssociate();
    // The most recent Saturday at least two weeks back, so its Monday deadline is in the past.
    const sat = new Date(Date.now() - 14 * DAY);
    sat.setUTCDate(sat.getUTCDate() - ((sat.getUTCDay() + 1) % 7));
    sat.setUTCHours(0, 0, 0, 0);
    const weekStart = new Date(sat.toISOString().slice(0, 10) + 'T00:00:00Z');
    const weekEnd = new Date(weekStart.getTime() + 6 * DAY).toISOString().slice(0, 10);
    const deadline = fieldglassDueAt(weekEnd);
    expect(deadline.getTime()).toBeLessThan(Date.now());
    await prisma.fieldglassTimesheet.createMany({
      data: [
        { weekStart, associateId: a.id, clientId: client.id, enteredAt: new Date(deadline.getTime() - HOUR), enteredHours: 40 },
        { weekStart, associateId: b.id, clientId: client.id, enteredAt: new Date(deadline.getTime() + HOUR), enteredHours: 40 },
      ],
    });
    expect(await localFieldglassOnTime(since())).toBe(50);
    // A week whose deadline is still ahead is not judged.
    const ahead = new Date(Date.now() + 7 * DAY);
    await prisma.fieldglassTimesheet.create({ data: { weekStart: new Date(ahead.toISOString().slice(0, 10) + 'T00:00:00Z'), associateId: a.id, clientId: client.id } });
    expect(await localFieldglassOnTime(since())).toBe(50);
  });

  it('the local tile carries five live signals and no MOD sign-off placeholder', async () => {
    const tile = await buildShiftsTile(null);
    expect(tile.signals.map((s) => s.key)).toEqual(['FILL_RATE', 'NO_SHOW_RATE', 'SHIFT_LEAD_PRESENT', 'TEMPERATURE_LOGS', 'FIELDGLASS_TIMESHEETS']);
    expect(tile.signals.every((s) => s.status === 'live')).toBe(true);
    expect(tile.signals.some((s) => (s.reason ?? '').includes('Coming soon') || (s.reason ?? '').includes('ASN Nexus'))).toBe(false);
    expect(tile.severity).toBe('ok');
  });
});
