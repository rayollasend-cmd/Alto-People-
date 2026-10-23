import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { createUser, prisma, truncateAll } from '../../../test/db.js';
import { generatePasswordResetToken } from '../../lib/passwordResetToken.js';

/**
 * GET /auth/reset-password/:token (F500 G5): the reset page asks whether its
 * link still works before anyone types two 12-character passwords. It never
 * consumes the token: 200 with the masked email while it works, 410 once it
 * expired or was used, 404 for a token that was never issued.
 */

const app = () => createApp();
beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function issue(userId: string, over: { expiresAt?: Date; consumedAt?: Date | null } = {}) {
  const t = generatePasswordResetToken();
  await prisma.passwordResetToken.create({
    data: { tokenHash: t.hash, userId, expiresAt: over.expiresAt ?? new Date(Date.now() + 30 * 60_000), consumedAt: over.consumedAt ?? null },
  });
  return t.raw;
}

describe('the reset link check', () => {
  it('a working link answers with the masked email and stays usable', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'maria.lopez@example.com' });
    const raw = await issue(user.id);
    const r = await request(app()).get(`/auth/reset-password/${raw}`);
    expect(r.status).toBe(200);
    expect(r.body.email).toBe('m***@example.com');
    expect(JSON.stringify(r.body)).not.toContain('maria.lopez');
    // Not consumed: the reset itself still works.
    const done = await request(app()).post('/auth/reset-password').send({ token: raw, newPassword: 'a-brand-new-password-1' });
    expect(done.status).toBeLessThan(300);
  });

  it('an expired or used link is 410; a link that was never issued is 404', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const expired = await issue(user.id, { expiresAt: new Date(Date.now() - 60_000) });
    const used = await issue(user.id, { consumedAt: new Date() });
    const e = await request(app()).get(`/auth/reset-password/${expired}`);
    expect(e.status).toBe(410);
    expect(e.body.error.code).toBe('link_expired');
    expect(JSON.stringify(e.body)).not.toContain('@');
    expect((await request(app()).get(`/auth/reset-password/${used}`)).status).toBe(410);
    expect((await request(app()).get(`/auth/reset-password/${'x'.repeat(43)}`)).status).toBe(404);
    expect((await request(app()).get('/auth/reset-password/short')).status).toBe(404);
  });
});
