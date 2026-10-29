import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_TEST_PASSWORD, createAssociate, createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';

/**
 * The account language holds the app's six associate languages (deep audit
 * ASSOC-11): a Portuguese reader's choice is kept, so the messages that speak
 * Portuguese (rides, call-outs, the assistant) reach them in it; emails and
 * WhatsApp fall back to English where they have no Portuguese.
 */
beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('PATCH /auth/me/language', () => {
  it('keeps any of the six, answers it on /auth/me, clears with null, refuses anything else', async () => {
    const a1 = await createAssociate();
    const { user } = await createUser({ role: 'ASSOCIATE', email: a1.email, associateId: a1.id });
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);
    for (const lang of ['ht', 'pt', 'uk', 'es']) {
      expect((await a.patch('/auth/me/language').send({ language: lang })).status).toBe(204);
      expect((await a.get('/auth/me')).body.user.language).toBe(lang);
    }
    expect((await a.patch('/auth/me/language').send({ language: 'xx' })).status).toBe(400);
    expect((await a.patch('/auth/me/language').send({ language: null })).status).toBe(204);
    expect((await a.get('/auth/me')).body.user.language).toBeNull();
  });
});
