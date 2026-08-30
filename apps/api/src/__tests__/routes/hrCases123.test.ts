import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Role } from '@prisma/client';
import { createApp } from '../../app.js';
import { signSession } from '../../lib/jwt.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import {
  createAssociate,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

const app = () => createApp();

function cookieFor(user: { id: string; role: Role; tokenVersion: number }) {
  const token = signSession({
    sub: user.id,
    role: user.role,
    ver: user.tokenVersion,
  });
  return `alto.session=${token}`;
}

/** An associate (with an ACTIVE user) plus an HR admin to receive fan-outs. */
async function setup() {
  const associate = await createAssociate({ firstName: 'Ana', lastName: 'Reyes' });
  const { user: assocUser } = await createUser({
    role: 'ASSOCIATE',
    email: associate.email,
    associateId: associate.id,
  });
  const { user: admin } = await createUser({ role: 'HR_ADMINISTRATOR' });
  return { associate, assocUser, admin };
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('hr-case notification deep links', () => {
  it('filing a case notifies admins with a link to that exact case', async () => {
    const { assocUser, admin } = await setup();

    const res = await request(app())
      .post('/hr-cases')
      .set('Cookie', [cookieFor(assocUser)])
      .send({
        category: 'PAYROLL',
        subject: 'Time entry Wed, Jul 2 (9:00–17:00)',
        description:
          'My break was shorter than recorded\n\nOpen the entry: /time-attendance?entry=abc',
      });
    expect(res.status).toBe(201);
    const caseId = res.body.id as string;
    await flushPendingNotifications();

    const note = await prisma.notification.findFirst({
      where: {
        channel: 'IN_APP',
        category: 'hr-cases',
        recipientUserId: admin.id,
      },
    });
    expect(note).not.toBeNull();
    // Deep-links to the case drawer, not the bare queue.
    expect(note?.linkUrl).toBe(`/hr-cases?case=${caseId}`);
  });

  it('an HR reply notifies the associate with a link to that case', async () => {
    const { associate, assocUser, admin } = await setup();
    const c = await prisma.hrCase.create({
      data: {
        associateId: associate.id,
        category: 'PAYROLL',
        subject: 'Missing hours',
        description: 'I worked but this entry is missing time',
      },
    });

    const res = await request(app())
      .post(`/hr-cases/${c.id}/comments`)
      .set('Cookie', [cookieFor(admin)])
      .send({ body: 'Looking into it.', internalNote: false });
    expect(res.status).toBe(201);
    await flushPendingNotifications();

    const note = await prisma.notification.findFirst({
      where: {
        channel: 'IN_APP',
        category: 'hr-cases',
        recipientUserId: assocUser.id,
      },
    });
    expect(note).not.toBeNull();
    expect(note?.subject).toBe('New reply on your HR case');
    expect(note?.linkUrl).toBe(`/hr-cases?case=${c.id}`);
  });

  it('resolving notifies the associate with a link to that case', async () => {
    const { associate, assocUser, admin } = await setup();
    const c = await prisma.hrCase.create({
      data: {
        associateId: associate.id,
        category: 'PAYROLL',
        subject: 'Missing hours',
        description: 'I worked but this entry is missing time',
      },
    });

    const res = await request(app())
      .patch(`/hr-cases/${c.id}`)
      .set('Cookie', [cookieFor(admin)])
      .send({ status: 'RESOLVED', resolution: 'Hours added.' });
    expect(res.status).toBe(200);
    await flushPendingNotifications();

    const note = await prisma.notification.findFirst({
      where: {
        channel: 'IN_APP',
        category: 'hr-cases',
        recipientUserId: assocUser.id,
      },
    });
    expect(note).not.toBeNull();
    expect(note?.subject).toBe('Your HR case was resolved');
    expect(note?.body).toContain('Hours added.');
    expect(note?.linkUrl).toBe(`/hr-cases?case=${c.id}`);
  });
});
