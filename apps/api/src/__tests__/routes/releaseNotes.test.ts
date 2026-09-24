import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { createUser, DEFAULT_TEST_PASSWORD, prisma, truncateAll } from '../../../test/db.js';
import { flushPendingAudits } from '../../lib/audit.js';

/**
 * Release notes: an admin writes one, every reader's card shows the
 * bullets for their audience in their language, and drafts stay behind
 * the editor gate.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(createApp());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) {
    throw new Error(`loginAs(${email}) failed: ${r.status} ${JSON.stringify(r.body)}`);
  }
  return a;
}

const NOTE = {
  day: '2026-10-01',
  published: true,
  items: [
    { audience: 'ALL', en: 'Faster schedule loads.', es: 'El horario carga más rápido.' },
    { audience: 'ADMIN', en: 'Bulk approve from the queue.', es: null },
    { audience: 'DRIVER', en: 'Routes show pickup order.', es: 'Las rutas muestran el orden de recogida.' },
  ],
};

describe('release notes', () => {
  it('each audience gets its own bullets; drafts stay with editors', async () => {
    const admin = await loginAs((await createUser({ role: 'HR_ADMINISTRATOR' })).user.email);
    const created = await admin.post('/release-notes').send(NOTE);
    expect(created.status).toBe(201);
    expect(created.body.note.items).toHaveLength(3);
    const draft = await admin.post('/release-notes').send({ ...NOTE, day: '2026-10-08', published: false });
    expect(draft.status).toBe(201);

    const associate = await loginAs((await createUser({ role: 'ASSOCIATE' })).user.email);
    const mine = await associate.get('/release-notes');
    expect(mine.status).toBe(200);
    expect(mine.body.canEdit).toBe(false);
    // The draft is invisible; the published note carries only ALL bullets.
    expect(mine.body.notes).toHaveLength(1);
    expect(mine.body.notes[0].items.map((i: { en: string }) => i.en)).toEqual(['Faster schedule loads.']);

    const driver = await loginAs((await createUser({ role: 'DRIVER' })).user.email);
    const latest = await driver.get('/release-notes/latest');
    expect(latest.body.note.items.map((i: { audience: string }) => i.audience)).toEqual(['ALL', 'DRIVER']);

    const editorView = await admin.get('/release-notes');
    expect(editorView.body.canEdit).toBe(true);
    expect(editorView.body.notes).toHaveLength(2);
    expect(editorView.body.notes[0].publishedAt).toBeNull();
    expect(editorView.body.notes[1].items).toHaveLength(3);

    await flushPendingAudits();
    const audits = await prisma.auditLog.findMany({ where: { entityType: 'ReleaseNote' }, orderBy: { createdAt: 'asc' } });
    expect(audits.map((a) => a.action)).toEqual(['release_note.published', 'release_note.drafted']);
  });

  it('a note with nothing for a reader is skipped by /latest', async () => {
    const admin = await loginAs((await createUser({ role: 'HR_ADMINISTRATOR' })).user.email);
    await admin.post('/release-notes').send({ day: '2026-10-05', published: true, items: [{ audience: 'ADMIN', en: 'Admin only.', es: null }] });
    await admin.post('/release-notes').send({ day: '2026-10-01', published: true, items: [{ audience: 'ALL', en: 'For everyone.', es: null }] });
    const associate = await loginAs((await createUser({ role: 'ASSOCIATE' })).user.email);
    const latest = await associate.get('/release-notes/latest');
    expect(latest.body.note.day).toBe('2026-10-01');
  });

  it('writes are gated and validated; publishing stamps once', async () => {
    const associate = await loginAs((await createUser({ role: 'ASSOCIATE' })).user.email);
    expect((await associate.post('/release-notes').send(NOTE)).status).toBe(403);

    const admin = await loginAs((await createUser({ role: 'HR_ADMINISTRATOR' })).user.email);
    expect((await admin.post('/release-notes').send({ ...NOTE, items: [] })).status).toBe(400);
    expect((await admin.post('/release-notes').send({ ...NOTE, day: '10/01/2026' })).status).toBe(400);

    const created = await admin.post('/release-notes').send({ ...NOTE, published: false });
    const id = created.body.note.id as string;
    const published = await admin.patch(`/release-notes/${id}`).send({ ...NOTE, published: true });
    expect(published.status).toBe(200);
    const stamp = published.body.note.publishedAt as string;
    expect(stamp).toBeTruthy();
    const again = await admin.patch(`/release-notes/${id}`).send({ ...NOTE, day: '2026-10-02', published: true });
    expect(again.body.note.publishedAt).toBe(stamp);
    expect(again.body.note.day).toBe('2026-10-02');

    expect((await admin.delete(`/release-notes/${id}`)).status).toBe(200);
    expect((await admin.delete(`/release-notes/${id}`)).status).toBe(404);
  });
});
