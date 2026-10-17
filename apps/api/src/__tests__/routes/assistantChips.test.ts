import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { ensureBuiltInAgents } from '../../lib/agents.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * The chips under the assistant's intro come from the tool list — the same
 * list the model is handed — so every chip is a question the registry can
 * answer right now, and a tool that is not open to the person is not a chip.
 */

const app = () => createApp();

beforeEach(async () => {
  await truncateAll();
  await createUser({ role: 'HR_ADMINISTRATOR', email: 'owner@example.com' });
  await ensureBuiltInAgents(prisma, ALTO_TENANT_ID);
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`login failed: ${r.status}`);
  return a;
}

describe('GET /hugo — the chips', () => {
  it('every chip is answered by the registry itself, never by the fallback intro', async () => {
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
    const { user } = await createUser({ role: 'ASSOCIATE', associateId: ana.id });
    const agent = await loginAs(user.email);

    const me = await agent.get('/hugo');
    expect(me.status).toBe(200);
    expect(me.body.can.length).toBeGreaterThan(0);
    for (const chip of me.body.can as Array<{ key: string; example: string }>) {
      const asked = await agent.post('/hugo/ask').send({ text: chip.example });
      expect(asked.status).toBe(200);
      // The chip's own intent answers it — not HELP, not a hand-off.
      expect(asked.body.intent).toBe(chip.key);
      expect(asked.body.source).toBe('rules');
    }
  });

  it('a desk sees only the desk tools; an associate only their own', async () => {
    const admin = await loginAs('owner@example.com');
    const adminChips = (await admin.get('/hugo')).body.can.map((c: { key: string }) => c.key);
    expect(adminChips).toContain('DESK');
    expect(adminChips).not.toContain('PAYDAY');
    expect(adminChips).not.toContain('SCHEDULE');

    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
    const { user } = await createUser({ role: 'ASSOCIATE', associateId: ana.id });
    const chips = (await (await loginAs(user.email)).get('/hugo')).body.can.map((c: { key: string }) => c.key);
    expect(chips).not.toContain('DESK');
    expect(chips).not.toContain('COVERAGE');
    expect(chips).toContain('PAYDAY');
  });
});
