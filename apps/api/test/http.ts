import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../src/app.js';
import { DEFAULT_TEST_PASSWORD } from './db.js';

export function makeApp() {
  return createApp();
}

export function agent(): TestAgent<Test> {
  return request.agent(createApp());
}

/** Logs `agent` in as `email` and returns it (cookie set). Throws on non-200. */
export async function loginAs(
  a: TestAgent<Test>,
  email: string,
  password = DEFAULT_TEST_PASSWORD
): Promise<TestAgent<Test>> {
  const res = await a.post('/auth/login').send({ email, password });
  if (res.status !== 200) {
    throw new Error(
      `loginAs(${email}) failed: status=${res.status} body=${JSON.stringify(res.body)}`
    );
  }
  return a;
}
