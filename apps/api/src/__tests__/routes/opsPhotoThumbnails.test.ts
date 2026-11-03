import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import sharp from 'sharp';
import { createApp } from '../../app.js';
import { DEFAULT_TEST_PASSWORD, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { getBlobStore } from '../../lib/blobStore.js';

/**
 * SOP evidence photos come in list sizes (`?size=128|640`): a WebP that fits
 * the box, made once and kept beside the upload. The floor feed and the store
 * portal show a grid of them, and the full phone photos (often MB each) used
 * to take ~0.9 s apiece (Nov 2026). The link that opens a photo stays full size.
 */

const app = () => createApp();

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`loginAs failed: ${r.status}`);
  return a;
}

/** A landscape phone-sized JPEG. */
const bigJpeg = () =>
  sharp({ create: { width: 2000, height: 1500, channels: 3, background: { r: 200, g: 120, b: 40 } } }).jpeg().toBuffer();

/** Passes the upload's magic check but isn't an image sharp can read. */
const unreadablePng = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0x00, 0x00, 0x00, 0x0d]),
  Buffer.from('IHDR'),
  Buffer.from([0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00]),
  Buffer.from([0x1f, 0x15, 0xc4, 0x89]),
]);

async function photoOnTask(file: Buffer, filename: string, contentType: string) {
  const client = await createClient('Front Beach 218');
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id });
  const lead = await loginAs(sup.email);
  const open = await lead.post('/ops/shifts/open').send({ position: 'GM Closing Shift' });
  expect(open.status).toBe(201);
  const detail = await lead.get(`/ops/shifts/${open.body.shiftId}`);
  const task = (detail.body.tasks as Array<{ id: string; responseType: string }>).find((t) => t.responseType === 'PHOTO')!;
  const up = await lead.post(`/ops/tasks/${task.id}/photos`).attach('file', file, { filename, contentType });
  expect(up.status).toBe(201);
  const row = await prisma.opsTaskPhoto.findUniqueOrThrow({ where: { id: up.body.photo.id } });
  return { client, site, lead, photoId: row.id, key: row.s3Key };
}

describe('evidence photo sizes', () => {
  it('?size=640 and ?size=128 are WebPs that fit the box, made once and kept; the full photo is unchanged', async () => {
    const original = await bigJpeg();
    const { lead, photoId, key } = await photoOnTask(original, 'zone.jpg', 'image/jpeg');

    const tile = await lead.get(`/ops/photos/${photoId}?size=640`).buffer(true);
    expect(tile.status).toBe(200);
    expect(tile.headers['content-type']).toBe('image/webp');
    expect(tile.headers['x-content-type-options']).toBe('nosniff');
    expect(tile.headers['cache-control']).toBe('private, max-age=86400, immutable');
    // The whole picture, longer side 640 — the page crops it, not the server.
    expect(await sharp(tile.body as Buffer).metadata()).toMatchObject({ width: 640, height: 480, format: 'webp' });
    expect((tile.body as Buffer).length).toBeLessThan(original.length);
    expect(await getBlobStore().exists(`${key}.fit640.webp`)).toBe(true);

    const thumb = await lead.get(`/ops/photos/${photoId}?size=128`).buffer(true);
    expect(await sharp(thumb.body as Buffer).metadata()).toMatchObject({ width: 128, height: 96, format: 'webp' });

    // Asked again, the kept copy answers — the same bytes.
    const again = await lead.get(`/ops/photos/${photoId}?size=640`).buffer(true);
    expect(Buffer.compare(again.body as Buffer, tile.body as Buffer)).toBe(0);

    const full = await lead.get(`/ops/photos/${photoId}`).buffer(true);
    expect(full.headers['content-type']).toBe('image/jpeg');
    expect(Buffer.compare(full.body as Buffer, original)).toBe(0);

    // A size not on the list is the original, not a made-to-order resize.
    const odd = await lead.get(`/ops/photos/${photoId}?size=300`).buffer(true);
    expect(odd.headers['content-type']).toBe('image/jpeg');
  });

  it('a photo sharp cannot read falls back to the original instead of failing the tile', async () => {
    const { lead, photoId } = await photoOnTask(unreadablePng, 'proof.png', 'image/png');
    const res = await lead.get(`/ops/photos/${photoId}?size=640`).buffer(true);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(res.body as Buffer, unreadablePng)).toBe(0);
  });

  it('the store portal gets the same sizes, for its own store only', async () => {
    const { client, site, photoId } = await photoOnTask(await bigJpeg(), 'zone.jpg', 'image/jpeg');
    const { user: manager } = await createUser({ role: 'CLIENT_PORTAL', clientId: client.id });
    await prisma.user.update({ where: { id: manager.id }, data: { locationId: site.id } });
    const portal = await loginAs(manager.email);

    const tile = await portal.get(`/client-portal/ops/photos/${photoId}?size=640`).buffer(true);
    expect(tile.status).toBe(200);
    expect(tile.headers['content-type']).toBe('image/webp');
    expect(await sharp(tile.body as Buffer).metadata()).toMatchObject({ width: 640, height: 480 });

    const other = await createClient('Other Store');
    const { user: stranger } = await createUser({ role: 'CLIENT_PORTAL', clientId: other.id });
    expect((await (await loginAs(stranger.email)).get(`/client-portal/ops/photos/${photoId}?size=640`)).status).toBe(404);
  });
});
