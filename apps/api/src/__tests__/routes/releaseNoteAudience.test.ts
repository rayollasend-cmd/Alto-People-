import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * What's new, by audience (F500 G5): the platform's first notes tagged three
 * worker-only lines "ALL", so a client's store manager read "Confirm a shift
 * with one tap". The data migration re-tags them ASSOCIATE; a client then
 * reads only what is theirs, and an associate still reads all three.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const SQL = readFileSync(join(__dirname, '../../../prisma/migrations/20270131140810_release_note_worker_audience/migration.sql'), 'utf8');

describe('release note audiences', () => {
  it('re-tags the worker-only lines, so a client never reads them and an associate does', async () => {
    await prisma.releaseNote.create({
      data: {
        day: new Date('2026-09-03T00:00:00Z'),
        publishedAt: new Date('2026-09-03T12:00:00Z'),
        items: [
          { audience: 'ALL', en: 'Set your profile photo with a proper position-and-zoom step — Settings → Profile photo.', es: null },
          { audience: 'ALL', en: 'Confirm a shift with one tap, right from the schedule list.', es: null },
          { audience: 'ALL', en: 'Your clock-in number now lives on your Home screen — tap to reveal.', es: null },
        ],
      },
    });
    await prisma.$executeRawUnsafe(SQL);
    const note = await prisma.releaseNote.findFirstOrThrow();
    expect((note.items as Array<{ audience: string }>).map((i) => i.audience)).toEqual(['ALL', 'ASSOCIATE', 'ASSOCIATE']);

    const client = await createClient('Coastal');
    const { user: portal } = await createUser({ role: 'CLIENT_PORTAL', clientId: client.id });
    const seen = await (await loginAs(agent(), portal.email)).get('/release-notes');
    expect(seen.status).toBe(200);
    expect(JSON.stringify(seen.body)).not.toMatch(/Confirm a shift|clock-in number/);
    expect(JSON.stringify(seen.body)).toMatch(/profile photo/);
  });
});
