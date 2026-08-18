import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { signSession } from '../../lib/jwt.js';
import {
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * Export filter coverage for POST /time/admin/export.csv.
 *
 * These filters are all where-clause work, which unit tests on the web side
 * can't reach: they assert the request body, not the rows that come back.
 * `anomaliesOnly` in particular queries a `Json?` column, where a wrong
 * predicate fails silently by returning everything or nothing.
 */

const app = () => createApp();
const HOUR = 60 * 60 * 1000;

async function adminCookie(): Promise<string> {
  const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const token = signSession({
    sub: user.id,
    role: user.role,
    ver: user.tokenVersion,
  });
  return `alto.session=${token}`;
}

/** Window wide enough to hold every fixture entry below. */
const FROM = new Date(Date.now() - 48 * HOUR).toISOString();
const TO = new Date(Date.now() + 24 * HOUR).toISOString();

async function entryFor(
  associateId: string,
  clientId: string,
  anomalies: string[] | null,
  hoursAgo: number,
) {
  return prisma.timeEntry.create({
    data: {
      associateId,
      clientId,
      clockInAt: new Date(Date.now() - hoursAgo * HOUR),
      clockOutAt: new Date(Date.now() - (hoursAgo - 8) * HOUR),
      status: 'COMPLETED',
      // null exercises the SQL-NULL branch: rows predating the column have
      // no array at all, and must not be mistaken for "has anomalies".
      ...(anomalies === null ? {} : { anomalies }),
    },
  });
}

let cookie: string;
let maria: { id: string };
let john: { id: string };
let client: { id: string };

beforeEach(async () => {
  await truncateAll();
  cookie = await adminCookie();
  client = await createClient();
  maria = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
  john = await createAssociate({ firstName: 'John', lastName: 'Smith' });

  await entryFor(maria.id, client.id, ['MISSED_PUNCH'], 40);
  await entryFor(maria.id, client.id, [], 30);
  await entryFor(john.id, client.id, ['GEOFENCE_VIOLATION_IN'], 20);
  await entryFor(john.id, client.id, null, 10);
});

async function exportCsv(body: Record<string, unknown>): Promise<string> {
  const res = await request(app())
    .post('/time/admin/export.csv')
    .set('Cookie', [cookie])
    .send({ from: FROM, to: TO, ...body });
  expect(res.status).toBe(200);
  return res.text;
}

/** Data rows only — the first line is the header. */
function rows(csv: string): string[] {
  return csv.trim().split('\n').slice(1).filter(Boolean);
}

describe('POST /time/admin/export.csv filters', () => {
  it('exports every entry in the range when unfiltered', async () => {
    const csv = await exportCsv({});
    expect(rows(csv)).toHaveLength(4);
    // Punches ship as site-local wall time + an explicit timezone column
    // ALONGSIDE the raw UTC instants — the UTC-only export contradicted
    // every screen by the full zone offset.
    expect(csv.split('\n')[0]).toBe(
      'clockInLocal,clockOutLocal,timezone,clockInUtc,clockOutUtc,grossMinutes,netMinutes,breakMinutes,associate,client,job,status,rejectionReason',
    );
    // No location on these fixtures → org default zone labels the rows.
    expect(csv).toContain('America/New_York');
  });

  it('anomaliesOnly keeps flagged entries and drops empty and null ones', async () => {
    const csv = await exportCsv({ anomaliesOnly: true });
    const data = rows(csv);
    expect(data).toHaveLength(2);
    expect(csv).toContain('Maria Lopez');
    expect(csv).toContain('John Smith');
    // Maria's second entry ([]) and John's second (NULL) must be gone; each
    // associate therefore appears exactly once.
    expect(data.filter((r) => r.includes('Maria Lopez'))).toHaveLength(1);
    expect(data.filter((r) => r.includes('John Smith'))).toHaveLength(1);
  });

  it('scopes to a single associate', async () => {
    const csv = await exportCsv({ associateId: maria.id });
    expect(rows(csv)).toHaveLength(2);
    expect(csv).not.toContain('John Smith');
  });

  it('filters by free-text name across both name parts', async () => {
    const csv = await exportCsv({ search: 'maria lopez' });
    expect(rows(csv)).toHaveLength(2);
    expect(csv).not.toContain('John Smith');
  });

  it('shiftWindow narrows to one shift window, and "none" to unmatched punches', async () => {
    // Today at a fixed UTC hour — always inside the FROM..TO range, and
    // with no Location on the entries the window key falls back to UTC,
    // so the expected keys are deterministic year-round.
    const utcToday = (h: number) => {
      const d = new Date();
      d.setUTCHours(h, 0, 0, 0);
      return d;
    };
    const morning = await prisma.shift.create({
      data: {
        clientId: client.id,
        position: 'Associate',
        startsAt: utcToday(6),
        endsAt: utcToday(14),
        status: 'OPEN',
      },
    });
    const afternoon = await prisma.shift.create({
      data: {
        clientId: client.id,
        position: 'Associate',
        startsAt: utcToday(14),
        endsAt: utcToday(22),
        status: 'OPEN',
      },
    });
    await prisma.timeEntry.create({
      data: {
        associateId: maria.id,
        clientId: client.id,
        shiftId: morning.id,
        clockInAt: utcToday(6),
        clockOutAt: utcToday(14),
        status: 'COMPLETED',
      },
    });
    await prisma.timeEntry.create({
      data: {
        associateId: john.id,
        clientId: client.id,
        shiftId: afternoon.id,
        clockInAt: utcToday(14),
        clockOutAt: utcToday(22),
        status: 'COMPLETED',
      },
    });

    // 6:00–14:00 UTC = the "360-840" window: only Maria's shift-tied punch.
    const morningCsv = await exportCsv({ shiftWindow: '360-840' });
    expect(rows(morningCsv)).toHaveLength(1);
    expect(morningCsv).toContain('Maria Lopez');
    expect(morningCsv).not.toContain('John Smith');

    // "none" = punches with no matched shift: exactly the 4 base fixtures.
    const noneCsv = await exportCsv({ shiftWindow: 'none' });
    expect(rows(noneCsv)).toHaveLength(4);
  });

  it('composes search AND anomaliesOnly instead of dropping one', async () => {
    // Both filters build clauses that used to be spread as separate `AND`
    // keys — object spread kept only the last, silently widening the file.
    const csv = await exportCsv({ search: 'lopez', anomaliesOnly: true });
    const data = rows(csv);
    expect(data).toHaveLength(1);
    expect(csv).toContain('Maria Lopez');
    expect(csv).not.toContain('John Smith');
  });
});
