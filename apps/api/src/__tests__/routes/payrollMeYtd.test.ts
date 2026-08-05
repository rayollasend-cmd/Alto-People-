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
 * GET /payroll/me/items/:id/ytd
 *
 * The reason this endpoint exists: /payroll/me/items is capped at 50 rows, so
 * the client used to sum YTD from whatever it had loaded and silently
 * understated the tax and net columns for anyone with more stubs than that.
 * The case worth pinning is therefore explicitly >50 paystubs.
 */

const app = () => createApp();

async function seedAssociateWithUser() {
  const client = await createClient();
  const associate = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
  const { user } = await createUser({ role: 'ASSOCIATE' });
  await prisma.user.update({
    where: { id: user.id },
    data: { associateId: associate.id },
  });
  const token = signSession({
    sub: user.id,
    role: user.role,
    ver: user.tokenVersion,
  });
  return { client, associate, cookie: `alto.session=${token}` };
}

async function run(clientId: string, disbursedAt: Date) {
  return prisma.payrollRun.create({
    data: {
      clientId,
      periodStart: disbursedAt,
      periodEnd: disbursedAt,
      status: 'DISBURSED',
      disbursedAt,
    },
  });
}

/** One DISBURSED paystub: $100 gross, $10 FIT, $6.20 FICA, $80 net. */
async function stub(
  associateId: string,
  clientId: string,
  disbursedAt: Date,
  status: 'DISBURSED' | 'PENDING' = 'DISBURSED',
) {
  const r = await run(clientId, disbursedAt);
  return prisma.payrollItem.create({
    data: {
      payrollRunId: r.id,
      associateId,
      hoursWorked: 10,
      hourlyRate: 10,
      grossPay: 100,
      federalWithholding: 10,
      fica: 6.2,
      medicare: 1.45,
      stateWithholding: 2,
      netPay: 80.35,
      status,
      disbursedAt: status === 'DISBURSED' ? disbursedAt : null,
      earnings: {
        create: [{ kind: 'REGULAR', hours: 10, rate: 10, amount: 100 }],
      },
    },
  });
}

let ctx: Awaited<ReturnType<typeof seedAssociateWithUser>>;

beforeEach(async () => {
  await truncateAll();
  ctx = await seedAssociateWithUser();
});

const ytdFor = async (id: string, cookie: string) => {
  const res = await request(app())
    .get(`/payroll/me/items/${id}/ytd`)
    .set('Cookie', [cookie]);
  return res;
};

describe('GET /payroll/me/items/:id/ytd', () => {
  it('sums past the 50-row list cap', async () => {
    // 60 weekly stubs in one year — more than /me/items will ever return.
    const ids: string[] = [];
    for (let i = 0; i < 60; i++) {
      const d = new Date(Date.UTC(2026, 0, 2 + i * 3, 12));
      ids.push((await stub(ctx.associate.id, ctx.client.id, d)).id);
    }
    const res = await ytdFor(ids[ids.length - 1], ctx.cookie);
    expect(res.status).toBe(200);
    expect(res.body.paystubCount).toBe(60);
    expect(res.body.gross).toBeCloseTo(6000, 2);
    expect(res.body.federalWithholding).toBeCloseTo(600, 2);
    expect(res.body.netPay).toBeCloseTo(4821, 2);
    expect(res.body.byKind.REGULAR).toBeCloseTo(6000, 2);
  });

  it('is as-of the paystub, not the whole year', async () => {
    const a = await stub(ctx.associate.id, ctx.client.id, new Date(Date.UTC(2026, 0, 5, 12)));
    const b = await stub(ctx.associate.id, ctx.client.id, new Date(Date.UTC(2026, 5, 5, 12)));
    await stub(ctx.associate.id, ctx.client.id, new Date(Date.UTC(2026, 11, 5, 12)));

    expect((await ytdFor(a.id, ctx.cookie)).body.paystubCount).toBe(1);
    expect((await ytdFor(b.id, ctx.cookie)).body.paystubCount).toBe(2);
  });

  it('does not bleed across calendar years', async () => {
    await stub(ctx.associate.id, ctx.client.id, new Date(Date.UTC(2025, 11, 30, 12)));
    const jan = await stub(ctx.associate.id, ctx.client.id, new Date(Date.UTC(2026, 0, 6, 12)));

    const res = await ytdFor(jan.id, ctx.cookie);
    expect(res.body.year).toBe(2026);
    expect(res.body.paystubCount).toBe(1);
    expect(res.body.gross).toBeCloseTo(100, 2);
  });

  it('excludes stubs that are not disbursed', async () => {
    await stub(ctx.associate.id, ctx.client.id, new Date(Date.UTC(2026, 0, 5, 12)), 'PENDING');
    const paid = await stub(ctx.associate.id, ctx.client.id, new Date(Date.UTC(2026, 0, 12, 12)));

    expect((await ytdFor(paid.id, ctx.cookie)).body.paystubCount).toBe(1);
  });

  it("404s on another associate's paystub rather than leaking it", async () => {
    const other = await createAssociate({ firstName: 'John', lastName: 'Smith' });
    const theirs = await stub(other.id, ctx.client.id, new Date(Date.UTC(2026, 0, 5, 12)));

    expect((await ytdFor(theirs.id, ctx.cookie)).status).toBe(404);
  });
});
