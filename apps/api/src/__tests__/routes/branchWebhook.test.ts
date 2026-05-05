import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createHmac, randomUUID } from 'node:crypto';
import { createApp } from '../../app.js';
import {
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

const app = () => createApp();

const SECRET = process.env.BRANCH_WEBHOOK_SECRET!;

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

function sign(body: string): string {
  return createHmac('sha256', SECRET).update(body, 'utf8').digest('hex');
}

function postWebhook(body: object, opts: { signature?: string | false } = {}) {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.signature !== false) {
    headers['x-branch-signature'] = opts.signature ?? sign(raw);
  }
  return request(app())
    .post('/branch/webhook')
    .set(headers)
    .send(raw);
}

interface SeedOpts {
  paymentId?: string;
  itemStatus?: 'PENDING' | 'DISBURSED' | 'HELD';
  runStatus?: 'FINALIZED' | 'DISBURSED';
  netPay?: number;
  hrAdmins?: number;
}

async function seedRunWithPendingItem(opts: SeedOpts = {}) {
  const client = await createClient();
  const associate = await createAssociate({
    firstName: 'Maria',
    lastName: 'Lopez',
    email: `m-${Math.random().toString(36).slice(2, 8)}@example.com`,
  });
  const run = await prisma.payrollRun.create({
    data: {
      clientId: client.id,
      periodStart: new Date('2026-04-13T00:00:00Z'),
      periodEnd: new Date('2026-04-19T23:59:59Z'),
      status: opts.runStatus ?? 'FINALIZED',
      totalGross: 975.66,
      totalTax: 169.64,
      totalNet: opts.netPay ?? 806.02,
      totalEmployerTax: 91.14,
    },
  });
  const item = await prisma.payrollItem.create({
    data: {
      payrollRunId: run.id,
      associateId: associate.id,
      hoursWorked: 44,
      hourlyRate: 21.21,
      grossPay: 975.66,
      federalWithholding: 95.0,
      fica: 60.49,
      medicare: 14.15,
      stateWithholding: 0,
      employerFica: 60.49,
      employerMedicare: 14.15,
      employerFuta: 3.0,
      employerSuta: 13.5,
      ytdWages: 6500,
      ytdMedicareWages: 6500,
      netPay: opts.netPay ?? 806.02,
      taxState: 'FL',
      status: opts.itemStatus ?? 'PENDING',
      disbursementRef: opts.paymentId ?? `branch-pay-${randomUUID()}`,
    },
  });
  for (let i = 0; i < (opts.hrAdmins ?? 1); i++) {
    await createUser({ role: 'HR_ADMINISTRATOR' });
  }
  return { client, associate, run, item };
}

describe('POST /branch/webhook — signature gating', () => {
  it('returns 401 on bad signature, no DB write', async () => {
    const { item } = await seedRunWithPendingItem();
    const res = await postWebhook(
      { id: 'evt_1', event: 'payment.completed', payment: { id: item.disbursementRef!, status: 'COMPLETED' } },
      { signature: 'deadbeef' },
    );
    expect(res.status).toBe(401);
    const events = await prisma.branchWebhookEvent.count();
    expect(events).toBe(0);
    const refreshed = await prisma.payrollItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(refreshed.status).toBe('PENDING');
  });

  it('returns 401 when signature header is missing entirely', async () => {
    const { item } = await seedRunWithPendingItem();
    const res = await postWebhook(
      { id: 'evt_2', event: 'payment.completed', payment: { id: item.disbursementRef!, status: 'COMPLETED' } },
      { signature: false },
    );
    expect(res.status).toBe(401);
  });
});

describe('POST /branch/webhook — payload validation', () => {
  it('returns 400 on missing top-level event id', async () => {
    const { item } = await seedRunWithPendingItem();
    const res = await postWebhook({
      event: 'payment.completed',
      payment: { id: item.disbursementRef!, status: 'COMPLETED' },
    });
    expect(res.status).toBe(400);
  });

  it('logs IGNORED + returns 200 for unknown payment id', async () => {
    await seedRunWithPendingItem();
    const res = await postWebhook({
      id: 'evt_unknown',
      event: 'payment.completed',
      payment: { id: 'branch-pay-not-ours', status: 'COMPLETED' },
    });
    expect(res.status).toBe(200);
    expect(res.body.ignored).toBe('unknown_payment_id');
    const ev = await prisma.branchWebhookEvent.findUnique({ where: { branchEventId: 'evt_unknown' } });
    expect(ev?.status).toBe('IGNORED');
    expect(ev?.notes).toContain('unknown_payment_id');
  });
});

describe('POST /branch/webhook — idempotency', () => {
  it('returns 200 ignored:duplicate on second delivery, no double-processing', async () => {
    const { item } = await seedRunWithPendingItem();
    const body = {
      id: 'evt_dupe',
      event: 'payment.completed',
      payment: { id: item.disbursementRef!, status: 'COMPLETED' as const },
    };

    const r1 = await postWebhook(body);
    expect(r1.status).toBe(200);
    const r2 = await postWebhook(body);
    expect(r2.status).toBe(200);
    expect(r2.body.ignored).toBe('duplicate');

    const attempts = await prisma.payrollDisbursementAttempt.count({
      where: { payrollItemId: item.id },
    });
    expect(attempts).toBe(1); // only the first delivery created an attempt row
    const events = await prisma.branchWebhookEvent.count({ where: { branchEventId: 'evt_dupe' } });
    expect(events).toBe(1);
  });
});

describe('POST /branch/webhook — payment.completed', () => {
  it('flips PayrollItem PENDING → DISBURSED and logs SUCCESS attempt', async () => {
    const { item } = await seedRunWithPendingItem();
    const res = await postWebhook({
      id: 'evt_completed',
      event: 'payment.completed',
      payment: { id: item.disbursementRef!, status: 'COMPLETED' },
    });
    expect(res.status).toBe(200);
    const refreshed = await prisma.payrollItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(refreshed.status).toBe('DISBURSED');
    expect(refreshed.disbursedAt).not.toBeNull();
    const attempt = await prisma.payrollDisbursementAttempt.findFirstOrThrow({
      where: { payrollItemId: item.id },
    });
    expect(attempt.status).toBe('SUCCESS');
    expect(attempt.provider).toBe('BRANCH');
  });

  it('rolls up FINALIZED run → DISBURSED when last item lands', async () => {
    const { run, item } = await seedRunWithPendingItem();
    const res = await postWebhook({
      id: 'evt_rollup',
      event: 'payment.completed',
      payment: { id: item.disbursementRef!, status: 'COMPLETED' },
    });
    expect(res.status).toBe(200);
    const refreshedRun = await prisma.payrollRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(refreshedRun.status).toBe('DISBURSED');
    expect(refreshedRun.disbursedAt).not.toBeNull();
  });

  it('does NOT roll up the run while OTHER items are still PENDING', async () => {
    const { client, run, item } = await seedRunWithPendingItem();
    // Seed a second associate's PENDING item on the same run.
    const a2 = await createAssociate({
      firstName: 'Bob',
      lastName: 'Brown',
      email: `b-${Math.random().toString(36).slice(2, 8)}@example.com`,
    });
    await prisma.payrollItem.create({
      data: {
        payrollRunId: run.id,
        associateId: a2.id,
        hoursWorked: 40,
        hourlyRate: 20,
        grossPay: 800,
        federalWithholding: 0,
        fica: 49.6,
        medicare: 11.6,
        stateWithholding: 0,
        employerFica: 49.6,
        employerMedicare: 11.6,
        employerFuta: 4.8,
        employerSuta: 21.6,
        ytdWages: 0,
        ytdMedicareWages: 0,
        netPay: 738.8,
        taxState: 'FL',
        status: 'PENDING',
        disbursementRef: `branch-pay-other-${randomUUID()}`,
      },
    });

    await postWebhook({
      id: 'evt_partial',
      event: 'payment.completed',
      payment: { id: item.disbursementRef!, status: 'COMPLETED' },
    });
    const refreshedRun = await prisma.payrollRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(refreshedRun.status).toBe('FINALIZED');
    expect(refreshedRun.disbursedAt).toBeNull();
    void client; // unused
  });
});

describe('POST /branch/webhook — payment.failed / RETURNED', () => {
  it('flips PENDING → HELD with R01 mapped to "Insufficient funds"', async () => {
    const { item } = await seedRunWithPendingItem();
    const res = await postWebhook({
      id: 'evt_failed',
      event: 'payment.failed',
      payment: {
        id: item.disbursementRef!,
        status: 'FAILED',
        failure_reason: 'R01',
      },
    });
    expect(res.status).toBe(200);
    const refreshed = await prisma.payrollItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(refreshed.status).toBe('HELD');
    expect(refreshed.failureReason).toBe('Insufficient funds');
  });

  it('handles RETURNED status the same as FAILED, with mapped reason', async () => {
    const { item } = await seedRunWithPendingItem();
    const res = await postWebhook({
      id: 'evt_returned',
      event: 'payment.returned',
      payment: {
        id: item.disbursementRef!,
        status: 'RETURNED',
        failure_reason: 'R10',
      },
    });
    expect(res.status).toBe(200);
    const refreshed = await prisma.payrollItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(refreshed.status).toBe('HELD');
    expect(refreshed.failureReason).toBe('Customer advises not authorized');
  });

  it('falls back to generic message for unknown ACH return codes', async () => {
    const { item } = await seedRunWithPendingItem();
    await postWebhook({
      id: 'evt_unknown_code',
      event: 'payment.returned',
      payment: { id: item.disbursementRef!, status: 'RETURNED', failure_reason: 'R99' },
    });
    const refreshed = await prisma.payrollItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(refreshed.failureReason).toContain('R99');
    expect(refreshed.failureReason).toContain('Contact associate');
  });

  it('fans out IN_APP notifications to every active HR admin with a deeplink', async () => {
    const { item, run } = await seedRunWithPendingItem({ hrAdmins: 2 });
    await postWebhook({
      id: 'evt_notify',
      event: 'payment.failed',
      payment: { id: item.disbursementRef!, status: 'FAILED', failure_reason: 'R02' },
    });
    const notifs = await prisma.notification.findMany({
      where: { category: 'payroll.payment_failed' },
    });
    // 2 HR admins seeded explicitly; the seedRunWithPendingItem default
    // already created 1 — so we expect ≥ 2 total. Assert ≥ 2 to stay
    // robust if the seed helper changes the default count.
    expect(notifs.length).toBeGreaterThanOrEqual(2);
    for (const n of notifs) {
      expect(n.body).toContain('Maria Lopez');
      expect(n.body).toContain('Bank account closed'); // R02 mapping
      expect(n.linkUrl).toBe(`/payroll?run=${run.id}`);
      expect(n.channel).toBe('IN_APP');
    }
  });
});
